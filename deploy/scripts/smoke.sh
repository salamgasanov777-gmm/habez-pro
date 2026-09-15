#!/bin/bash
# Дымовая проверка боевого сайта после запуска или обновления. Только чтение
# и заведомо отклоняемые запросы — ничего не создаёт и не меняет.
#
#   deploy/scripts/smoke.sh https://catalog.habez-gips.ru
set -uo pipefail
BASE="${1:?адрес сайта, например https://catalog.habez-gips.ru}"
fails=0
ok() { echo "OK   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }
expect() { local want="$1" name="$2"; shift 2; local got; got="$(code "$@")"; [ "$got" = "$want" ] && ok "$name → $got" || bad "$name → $got (ожидали $want)"; }

# Здоровье и режим
health="$(curl -fsS -m 10 "$BASE/api/health" 2>/dev/null || true)"
echo "$health" | grep -q '"status":"ok"' && ok "api/health" || bad "api/health: $health"
echo "$health" | grep -q '"env":"production"' && ok "NODE_ENV=production" || bad "не production: $health"
echo "$health" | grep -q '"paymentProvider":"none"' && ok "PAYMENT_PROVIDER=none" || bad "провайдер оплаты не none"

# Витрина и каталог
curl -fsS -m 10 "$BASE/" | grep -q '<div id="root">' && ok "витрина отдаётся" || bad "витрина не отдаётся"
expect 200 "manifest" "$BASE/manifest.webmanifest"
meta="$(curl -fsS -m 10 "$BASE/api/catalog/meta" 2>/dev/null || true)"
echo "$meta" | grep -q '"onlinePayment":false' && ok "витрина без онлайн-оплаты" || bad "onlinePayment не false"
echo "$meta" | grep -q '"phoneLogin":false' && ok "вход по SMS выключен" || bad "phoneLogin не false"
total="$(echo "$meta" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)"
[ "${total:-0}" -gt 0 ] && ok "товаров в каталоге: $total" || bad "в каталоге нет товаров"
expect 200 "карточка первого товара" "$BASE/api/catalog/products?limit=1"

# Заголовки безопасности
hdr="$(curl -sI -m 10 "$BASE/api/health")"
for h in "strict-transport-security" "x-frame-options: DENY" "x-content-type-options: nosniff" "content-security-policy"; do
  echo "$hdr" | grep -qi "$h" && ok "заголовок $h" || bad "нет заголовка $h"
done
expect 301 "http→https" "http://${BASE#https://}/api/health" 2>/dev/null || true

# Вход и панель: только отказы
expect 401 "демо-пароль не работает" -X POST -H 'content-type: application/json' -d '{"email":"admin@habez.local","password":"admin12345"}' "$BASE/api/auth/login"
expect 401 "панель без входа" "$BASE/api/admin/stats"
expect 401 "смена статуса без входа" -X PATCH -H 'content-type: application/json' -d '{"status":"paid"}' "$BASE/api/admin/orders/1"
expect 503 "вход по SMS отключён" -X POST -H 'content-type: application/json' -d '{"phone":"+79280000000"}' "$BASE/api/auth/otp/request"

# Заказы и оплата: только отклоняемые запросы
expect 400 "заказ без согласия отклонён" -X POST -H 'content-type: application/json' -d '{"customer":{"name":"Проверка","phone":"+79280000000"}}' "$BASE/api/orders"
expect 404 "демо-вебхук оплаты не существует" -X POST -H 'content-type: application/json' -d '{"object":{"id":"x","status":"succeeded"}}' "$BASE/api/payments/webhook/mock"
expect 404 "демо-страница банка не существует" "$BASE/api/payments/mock/x"
expect 400 "платёж создать нельзя" -X POST -H 'content-type: application/json' -d '{"orderNumber":"ХГЗ-0000-0000"}' "$BASE/api/payments/create"
expect 404 "чужой заказ по номеру закрыт" "$BASE/api/orders/ХГЗ-0000-0000"

echo; [ "$fails" = 0 ] && { echo "✓ smoke: всё в порядке"; exit 0; } || { echo "✗ smoke: проблем — $fails"; exit 1; }
