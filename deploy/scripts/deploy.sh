#!/bin/bash
# Обновление боевого сервера до тега/ветки из GitHub с откатом одной командой.
# Релизы лежат в /srv/hgz/releases/<имя>, служба смотрит на симлинк /srv/hgz/current.
#
#   deploy/scripts/deploy.sh v1.0.1          выпустить тег v1.0.1
#   deploy/scripts/deploy.sh main            выпустить текущий main
#   deploy/scripts/deploy.sh --rollback      вернуть предыдущий релиз
#
# Простой ≈ 1–2 с (перезапуск службы); при миграциях — на время миграции.
set -euo pipefail

ROOT="${HGZ_ROOT:-/srv/hgz}"
REPO="${HGZ_REPO:-https://github.com/salamgasanov777-gmm/habez-pro.git}"
SITE="${HGZ_PUBLIC_URL:-}"
USER_SVC="${HGZ_USER:-hgz}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${1:?тег, ветка или --rollback}"

say() { echo "→ $*"; }
health() { curl -fsS -m 5 http://127.0.0.1:4000/api/health | grep -q '"status":"ok"'; }
switch_to() {
  ln -sfn "$1" "$ROOT/current.new" && mv -Tf "$ROOT/current.new" "$ROOT/current"
  systemctl restart hgz
  for i in $(seq 1 20); do health && return 0; sleep 1; done
  return 1
}

if [ "$REF" = "--rollback" ]; then
  prev="$(cat "$ROOT/previous" 2>/dev/null || true)"
  [ -n "$prev" ] && [ -d "$prev" ] || { echo "нет предыдущего релиза"; exit 1; }
  say "откат на $prev"
  switch_to "$prev" && { echo "✓ откачено на $(basename "$prev")"; exit 0; } || { echo "✗ после отката API не отвечает — смотрите journalctl -u hgz"; exit 1; }
fi

mkdir -p "$ROOT/releases"
NEW="$ROOT/releases/$(date '+%Y%m%d-%H%M')-$(echo "$REF" | tr '/' '-')"

say "ручная копия базы перед обновлением"
"$HERE/backup.sh" manual

say "клонирую $REF в $NEW"
git clone -q --depth 1 --branch "$REF" "$REPO" "$NEW"
ln -sfn /etc/hgz/hgz.env "$NEW/api/.env"   # config.js читает .env, если есть; содержимое — из /etc/hgz

say "устанавливаю зависимости и собираю витрину (служба работает)"
( cd "$NEW/api" && npm ci --omit=dev --no-audit --no-fund --silent )
( cd "$NEW/web" && npm ci --no-audit --no-fund --silent && npm run build --silent )
chmod +x "$NEW"/deploy/scripts/*.sh
chown -R "$USER_SVC:$USER_SVC" "$NEW"

# Есть ли непримененные миграции? (schema.sql применяется --check безопасно: только CREATE IF NOT EXISTS)
pending="$(cd "$NEW/api" && sudo -u "$USER_SVC" bash -c 'set -a; . /etc/hgz/hgz.env; set +a; node src/db/migrate.js --check' 2>/dev/null || echo 1)"

current="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
[ -n "$current" ] && echo "$current" > "$ROOT/previous"

if [ "${pending:-1}" != "0" ]; then
  say "есть миграции: останавливаю службу на время миграции"
  systemctl stop hgz
  ( cd "$NEW/api" && sudo -u "$USER_SVC" bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run migrate --silent' )
fi

say "переключаю релиз и перезапускаю"
if switch_to "$NEW"; then
  if [ -n "$SITE" ]; then "$HERE/smoke.sh" "$SITE" || { echo "✗ smoke не прошёл — откатываю"; switch_to "$(cat "$ROOT/previous")"; exit 1; }; fi
  echo "✓ выпущен $(basename "$NEW")"
else
  echo "✗ API не отвечает после обновления — откатываю"
  switch_to "$(cat "$ROOT/previous")" && echo "откат выполнен" || echo "откат не помог: journalctl -u hgz -n 100"
  exit 1
fi

say "оставляю три последних релиза"
ls -1dt "$ROOT"/releases/*/ | tail -n +4 | xargs -r rm -rf
