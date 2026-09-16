#!/bin/bash
# Резервная копия Habez Gips: база (согласованно, при работающем сервере),
# загрузки, ключи push и файл окружения — одним зашифрованным архивом,
# локально и в удалённое хранилище. Запускается от root по таймеру
# hgz-backup.timer или руками:
#
#   deploy/scripts/backup.sh daily      ночная (+ weekly по воскресеньям, + monthly 1-го числа)
#   deploy/scripts/backup.sh manual     перед обновлением/миграцией — в manual/, не удаляется автоматически
#
# Настройки — /etc/hgz/backup.env (см. deploy/backup.env.example). Файл
# читается и при запуске руками, не только через systemd; переменные,
# переданные в окружении, имеют приоритет. Без HGZ_BACKUP_AGE_RECIPIENT
# копия НЕ делается: незашифрованные копии с телефонами покупателей никуда
# не кладём.
set -euo pipefail

BACKUP_ENV="${HGZ_BACKUP_ENV:-/etc/hgz/backup.env}"
if [ -f "$BACKUP_ENV" ]; then
  # Только строки вида ИМЯ=значение из файла root:0600; уже заданное в
  # окружении не перекрываем (так systemd и ручной запуск ведут себя одинаково).
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    name="${line%%=*}"; value="${line#*=}"
    case "$name" in HGZ_[A-Z0-9_]*) ;; *) continue ;; esac
    value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
    if [ -z "${!name:-}" ]; then export "$name=$value"; fi
  done < "$BACKUP_ENV"
fi

KIND="${1:-daily}"
DB="${DATABASE_FILE:-/var/lib/hgz/hgz.db}"
DATA_DIR="$(dirname "$DB")"
ENV_FILE="${HGZ_ENV_FILE:-/etc/hgz/hgz.env}"
DEST="${HGZ_BACKUP_DIR:-/var/backups/hgz}"
KEEP_DAILY="${HGZ_BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${HGZ_BACKUP_KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${HGZ_BACKUP_KEEP_MONTHLY:-12}"
RECIPIENT="${HGZ_BACKUP_AGE_RECIPIENT:-}"
REMOTE="${HGZ_BACKUP_REMOTE:-}"
PING="${HGZ_BACKUP_PING_URL:-}"
STAMP="$(date '+%Y-%m-%d_%H-%M')"
NAME="hgz-${STAMP}.tar.age"

ping() { [ -n "$PING" ] && curl -fsS -m 10 --retry 3 "$PING$1" >/dev/null 2>&1 || true; }
fail() { echo "✗ $*" >&2; logger -t hgz-backup -p user.err "$*"; ping "/fail"; exit 1; }

[ -f "$DB" ] || fail "нет базы: $DB"
[ -n "$RECIPIENT" ] || fail "не задан HGZ_BACKUP_AGE_RECIPIENT — незашифрованные копии не делаем"
command -v age >/dev/null || fail "не установлен age (apt install age)"
command -v sqlite3 >/dev/null || fail "не установлен sqlite3 (apt install sqlite3)"

umask 077
mkdir -p "$DEST"/{daily,weekly,monthly,manual,tmp}
WORK="$(mktemp -d "$DEST/tmp/work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. Согласованная копия базы при работающем сервере. WAL сбрасываем, чтобы
#    в копию попало всё подтверждённое; VACUUM INTO — атомарный снимок.
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sqlite3 "$DB" "VACUUM INTO '$WORK/hgz.db';"

# 2. Копия обязана открываться и быть целой.
check="$(sqlite3 "$WORK/hgz.db" "PRAGMA integrity_check;")"
[ "$check" = "ok" ] || fail "копия повреждена: $check"
orders="$(sqlite3 "$WORK/hgz.db" "SELECT COUNT(*) FROM orders;")"
products="$(sqlite3 "$WORK/hgz.db" "SELECT COUNT(*) FROM products;")"
users="$(sqlite3 "$WORK/hgz.db" "SELECT COUNT(*) FROM users;")"

# 3. Число заказов не может уменьшиться по сравнению с прошлой копией.
last_file="$DEST/last-counts"
if [ -f "$last_file" ]; then
  prev_orders="$(cut -d' ' -f1 "$last_file")"
  if [ "$orders" -lt "$prev_orders" ]; then
    logger -t hgz-backup -p user.warning "заказов стало меньше: было $prev_orders, стало $orders — проверьте базу"
    echo "! заказов стало меньше: было $prev_orders, стало $orders" >&2
  fi
fi

# 4. Архив: база, загрузки, ключи push, окружение (там JWT_SECRET — поэтому
#    только внутри зашифрованного архива).
[ -f "$DATA_DIR/vapid.json" ] && cp "$DATA_DIR/vapid.json" "$WORK/"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$WORK/hgz.env"
if [ -d "$DATA_DIR/uploads" ]; then tar -C "$DATA_DIR" -cf "$WORK/uploads.tar" uploads; fi
printf 'created=%s\norders=%s\nproducts=%s\nusers=%s\nhost=%s\n' "$STAMP" "$orders" "$products" "$users" "$(hostname)" > "$WORK/MANIFEST"

# 5. Шифрование: без приватного ключа владельца архив не прочитать.
tar -C "$WORK" -cf - MANIFEST hgz.db $( [ -f "$WORK/vapid.json" ] && echo vapid.json ) $( [ -f "$WORK/hgz.env" ] && echo hgz.env ) $( [ -f "$WORK/uploads.tar" ] && echo uploads.tar ) \
  | age -r "$RECIPIENT" -o "$WORK/$NAME"

# 6. Разложить по поколениям.
place() { cp "$WORK/$NAME" "$DEST/$1/$NAME"; chmod 600 "$DEST/$1/$NAME"; }
case "$KIND" in
  manual) place manual ;;
  daily)
    place daily
    [ "$(date +%u)" = "7" ] && place weekly
    [ "$(date +%d)" = "01" ] && place monthly
    ;;
  *) fail "неизвестный вид копии: $KIND (daily|manual)" ;;
esac
echo "$orders $products $users" > "$last_file"

# 7. Удалённая копия. Ключ хранилища — только на запись (одно право
#    PutObject, см. backup.env.example): удалить копии с сервера нельзя,
#    чистит их политика хранения самого хранилища. Поэтому rclone запускается
#    так, чтобы ему не требовались List/Head/Get: назначение не проверяется
#    ни до загрузки (--no-check-dest), ни после (--s3-no-head), бакет не
#    проверяется (--s3-no-check-bucket), файл до 1 ГБ уходит одним PUT
#    (для multipart нужны бы ещё права на составную загрузку). Целостность
#    гарантирует сам S3: rclone передаёт Content-MD5, сервер сверяет.
if [ -n "$REMOTE" ] && [ "$KIND" = "daily" ]; then
  command -v rclone >/dev/null || fail "не установлен rclone"
  RCLONE_OPTS=(--no-check-dest --s3-no-check-bucket --s3-no-head --s3-no-head-object --s3-upload-cutoff 1G --retries 5 --low-level-retries 10)
  rclone copyto "${RCLONE_OPTS[@]}" "$DEST/daily/$NAME" "$REMOTE/daily/$NAME" || fail "не удалось отправить копию в $REMOTE"
  [ "$(date +%u)" = "7" ] && { rclone copyto "${RCLONE_OPTS[@]}" "$DEST/daily/$NAME" "$REMOTE/weekly/$NAME" || true; }
  [ "$(date +%d)" = "01" ] && { rclone copyto "${RCLONE_OPTS[@]}" "$DEST/daily/$NAME" "$REMOTE/monthly/$NAME" || true; }
fi

# 8. Локальная ротация (manual не трогаем).
# Пустое поколение (weekly/monthly в первые дни) — не ошибка: без этого
# pipefail ронял скрипт после уже сделанной копии.
rotate() {
  local files; files="$(ls -1t "$DEST/$1"/hgz-*.tar.age 2>/dev/null || true)"
  [ -n "$files" ] || return 0
  echo "$files" | tail -n +"$(( $2 + 1 ))" | xargs -r rm -f
}
rotate daily "$KEEP_DAILY"; rotate weekly "$KEEP_WEEKLY"; rotate monthly "$KEEP_MONTHLY"

size="$(du -h "$DEST/${KIND/daily/daily}/$NAME" 2>/dev/null | cut -f1)"
msg="копия $NAME ($size): заказов $orders, товаров $products, пользователей $users; локально $(ls -1 "$DEST/daily" | wc -l) daily"
echo "✓ $msg"
logger -t hgz-backup "$msg"
ping ""
