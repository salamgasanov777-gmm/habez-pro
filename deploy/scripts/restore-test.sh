#!/bin/bash
# Проверка, что копия восстанавливается: расшифровать, проверить базу,
# поднять на ней отдельный экземпляр API на 127.0.0.1:4001 (production-режим)
# и убедиться, что он отвечает и видит товары. Боевую базу не трогает.
#
#   deploy/scripts/restore-test.sh                       последняя локальная daily-копия
#   deploy/scripts/restore-test.sh /path/hgz-….tar.age   конкретная копия
#
# Нужен приватный ключ age (HGZ_RESTORE_IDENTITY). Если его на сервере нет —
# запускать с компьютера владельца, где ключ есть, скачав копию.
set -euo pipefail

DEST="${HGZ_BACKUP_DIR:-/var/backups/hgz}"
IDENTITY="${HGZ_RESTORE_IDENTITY:-}"
PING="${HGZ_BACKUP_PING_URL:-}"
APP="${HGZ_APP_DIR:-/srv/hgz/current}"
PORT="${HGZ_RESTORE_PORT:-4001}"
FILE="${1:-$(ls -1t "$DEST"/daily/hgz-*.tar.age 2>/dev/null | head -1 || true)}"

ping() { [ -n "$PING" ] && curl -fsS -m 10 "$PING$1" >/dev/null 2>&1 || true; }
fail() { echo "✗ $*" >&2; logger -t hgz-restore-test -p user.err "$*"; ping "/restore/fail"; exit 1; }

[ -n "$FILE" ] && [ -f "$FILE" ] || fail "копия не найдена: ${FILE:-нет daily-копий в $DEST}"
[ -n "$IDENTITY" ] && [ -f "$IDENTITY" ] || fail "нет приватного ключа age (HGZ_RESTORE_IDENTITY) — тест выполняется там, где ключ есть"

umask 077
WORK="$(mktemp -d /tmp/hgz-restore.XXXXXX)"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Расшифровать и распаковать.
age -d -i "$IDENTITY" -o "$WORK/backup.tar" "$FILE" || fail "не расшифровывается: неверный ключ или повреждённый файл"
tar -C "$WORK" -xf "$WORK/backup.tar"
[ -f "$WORK/hgz.db" ] || fail "в архиве нет hgz.db"
[ -f "$WORK/uploads.tar" ] && tar -C "$WORK" -xf "$WORK/uploads.tar"
mkdir -p "$WORK/uploads"

# 2. База цела и содержит то, что обещает манифест.
check="$(sqlite3 "$WORK/hgz.db" "PRAGMA integrity_check;")"
[ "$check" = "ok" ] || fail "integrity_check: $check"
orders="$(sqlite3 "$WORK/hgz.db" "SELECT COUNT(*) FROM orders;")"
products="$(sqlite3 "$WORK/hgz.db" "SELECT COUNT(*) FROM products;")"
if [ -f "$WORK/MANIFEST" ]; then
  m_orders="$(grep '^orders=' "$WORK/MANIFEST" | cut -d= -f2)"
  [ "$orders" = "$m_orders" ] || fail "заказов в базе $orders, в манифесте $m_orders"
fi
[ "$products" -gt 0 ] || fail "в копии нет товаров"

# 3. Поднять API на копии в production-режиме (секрет — одноразовый, только для теста).
(
  cd "$APP/api"
  NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" LOG_LEVEL=warn \
  DATABASE_FILE="$WORK/hgz.db" UPLOAD_DIR="$WORK/uploads" \
  JWT_SECRET="restore-test-$(head -c 32 /dev/urandom | base64 | tr -d '/+=')" \
  PAYMENT_PROVIDER=none VAPID_SUBJECT=mailto:restore-test@invalid \
  PUBLIC_URL="http://127.0.0.1:$PORT" WEB_URL="http://127.0.0.1:$PORT" CORS_ORIGINS="http://127.0.0.1:$PORT" \
  node src/server.js >"$WORK/server.log" 2>&1
) &
PID=$!

for i in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >"$WORK/health.json" 2>/dev/null; then break; fi
  sleep 1
done
grep -q '"status":"ok"' "$WORK/health.json" 2>/dev/null || { cat "$WORK/server.log" >&2; fail "API на копии не отвечает"; }
api_products="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/catalog/products?limit=1" | grep -o '"total":[0-9]*' | cut -d: -f2)"
[ "${api_products:-0}" -gt 0 ] || fail "API на копии не видит товары"

msg="копия $(basename "$FILE") восстанавливается: товаров $products, заказов $orders, API отвечает"
echo "✓ $msg"
logger -t hgz-restore-test "$msg"
ping "/restore"
