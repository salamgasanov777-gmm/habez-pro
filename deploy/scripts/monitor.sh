#!/bin/bash
# Минимальный мониторинг: служба, диск, память, база, свежесть копии, HTTP.
# Печатает строки «OK …» / «WARN …», при любом WARN — код выхода 1 и текст
# тревоги в journald (и в HGZ_ALERT_CMD, если задана). Раз в 5 минут по
# таймеру hgz-monitor.timer.
set -uo pipefail

DB="${DATABASE_FILE:-/var/lib/hgz/hgz.db}"
DEST="${HGZ_BACKUP_DIR:-/var/backups/hgz}"
URL="${HGZ_PUBLIC_URL:-http://127.0.0.1:4000}"
DISK_WARN="${HGZ_DISK_WARN_PCT:-80}"
MEM_WARN_MB="${HGZ_NODE_RSS_WARN_MB:-600}"
BACKUP_MAX_AGE_H="${HGZ_BACKUP_MAX_AGE_H:-26}"
ALERT_CMD="${HGZ_ALERT_CMD:-}"
problems=()
note() { echo "OK   $*"; }
warn() { echo "WARN $*"; problems+=("$*"); }

# Служба
if systemctl is-active --quiet hgz; then note "служба hgz активна"; else warn "служба hgz не активна: $(systemctl is-active hgz)"; fi
restarts="$(systemctl show hgz -p NRestarts --value 2>/dev/null || echo 0)"
[ "${restarts:-0}" -gt 5 ] && warn "служба перезапускалась $restarts раз с загрузки"

# Диск
for path in "$(dirname "$DB")" "$DEST" /; do
  [ -d "$path" ] || continue
  pct="$(df -P "$path" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ "${pct:-0}" -ge "$DISK_WARN" ]; then warn "диск $path занят на ${pct}%"; else note "диск $path: ${pct}%"; fi
done

# Память процесса и системы
pid="$(systemctl show hgz -p MainPID --value 2>/dev/null || echo 0)"
if [ "${pid:-0}" -gt 0 ]; then
  rss_mb=$(( $(awk '/VmRSS/ {print $2}' /proc/"$pid"/status 2>/dev/null || echo 0) / 1024 ))
  if [ "$rss_mb" -gt "$MEM_WARN_MB" ]; then warn "node занимает ${rss_mb} МБ"; else note "node: ${rss_mb} МБ"; fi
fi
avail_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 9999)"
[ "$avail_mb" -lt 150 ] && warn "свободной памяти ${avail_mb} МБ"
load="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)"
cores="$(nproc 2>/dev/null || echo 1)"
awk -v l="$load" -v c="$cores" 'BEGIN { exit !(l > 2*c) }' && warn "load average $load при $cores ядрах"

# База
if [ -f "$DB" ]; then
  if r="$(sqlite3 "$DB" "PRAGMA quick_check;" 2>&1)" && [ "$r" = "ok" ]; then note "база открывается, quick_check ok"; else warn "база: $r"; fi
  wal="$DB-wal"; if [ -f "$wal" ]; then wal_mb=$(( $(stat -c %s "$wal") / 1048576 )); [ "$wal_mb" -gt 100 ] && warn "WAL вырос до ${wal_mb} МБ — зависший читатель?"; fi
  perms="$(stat -c %a "$DB")"; [ "$perms" = "640" ] || [ "$perms" = "600" ] || warn "права на базу $perms (ожидается 640)"
else
  warn "нет файла базы $DB"
fi

# Свежесть копии
last="$(ls -1t "$DEST"/daily/hgz-*.tar.age 2>/dev/null | head -1 || true)"
if [ -n "$last" ]; then
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  if [ "$age_h" -gt "$BACKUP_MAX_AGE_H" ]; then warn "последняя копия старше ${age_h} ч"; else note "копия $(basename "$last"), ${age_h} ч назад"; fi
else
  warn "нет ни одной daily-копии в $DEST"
fi

# HTTP
if body="$(curl -fsS -m 5 "$URL/api/health" 2>&1)"; then
  echo "$body" | grep -q '"status":"ok"' && note "API отвечает: $URL" || warn "API отвечает не ok: $body"
  echo "$body" | grep -q '"paymentProvider":"none"' || warn "провайдер оплаты не none: $body"
else
  warn "API не отвечает на $URL/api/health: $body"
fi
case "$URL" in https://*)
  exp="$(echo | openssl s_client -servername "${URL#https://}" -connect "${URL#https://}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "$exp" ]; then days=$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 )); [ "$days" -lt 14 ] && warn "сертификат истекает через $days дн." || note "сертификат: $days дн."; fi ;;
esac

# Ошибки приложения за последний час
errs="$(journalctl -u hgz -p err --since -1h --no-pager -q 2>/dev/null | wc -l)"
[ "$errs" -gt 20 ] && warn "$errs ошибок в журнале за час"

if [ "${#problems[@]}" -gt 0 ]; then
  text="Habez Gips — $(hostname): $(printf '%s; ' "${problems[@]}")"
  logger -t hgz-monitor -p user.warning "$text"
  [ -n "$ALERT_CMD" ] && printf '%s\n' "$text" | sh -c "$ALERT_CMD" || true
  exit 1
fi
exit 0
