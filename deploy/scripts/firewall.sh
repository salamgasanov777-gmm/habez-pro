#!/bin/bash
# Файрвол: наружу только 80/443 и SSH. Порт 4000 приложения не открывается —
# оно и так слушает лишь 127.0.0.1, но правило «всё остальное закрыто» его
# дополнительно страхует.
#
#   sudo deploy/scripts/firewall.sh                 SSH отовсюду, с ограничением частоты
#   sudo deploy/scripts/firewall.sh 203.0.113.5     SSH только с этого адреса (ваш статический IP)
set -euo pipefail
SSH_FROM="${1:-}"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp comment 'Caddy http -> https, ACME'
ufw allow 443/tcp comment 'Caddy https'
if [ -n "$SSH_FROM" ]; then
  ufw allow from "$SSH_FROM" to any port 22 proto tcp comment 'SSH только с этого адреса'
else
  ufw limit 22/tcp comment 'SSH с ограничением частоты'
fi
ufw --force enable
ufw status verbose
echo
echo "Проверка снаружи (с другого компьютера) — порт 4000 отвечать не должен:"
echo "  curl -m 3 http://$(hostname -I 2>/dev/null | awk '{print $1}'):4000/api/health"
