# Этап 1B — план первого production-развёртывания

Составлен 16 сентября 2026 по состоянию `main` = `751a32b` (CI: success).
Ничего из этого документа **ещё не выполнено**: сервера нет, DNS не менялся,
секреты не создавались. Команды даны для Ubuntu 24.04 LTS; выполняются
по порядку, после каждого блока — проверка. Базовая инструкция — `DEPLOY.md`;
здесь — уточнения, найденные при ревью, и порядок «от чистой Ubuntu до
первого боевого заказа».

---

## 1. Что показал разбор репозитория (`751a32b`)

| Что | Состояние | Примечание |
|---|---|---|
| `DEPLOY.md` | разделы 1–16, актуален после 1A-5; SSH через `sshd_config.d`, fail2ban через journald, restore-test.timer не включается, `HGZ_PUBLIC_URL` в `backup.env.example` — приведены в соответствие с этим планом | |
| `deploy/systemd/hgz.service` | `User=hgz`, `127.0.0.1:4000`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/hgz`, `UMask=0027` | `StartLimit*` в `[Service]` — известная MEDIUM, на запуск не влияет |
| `hgz-backup.timer` 03:10 · `hgz-monitor.timer` 5 мин · `hgz-restore-test.timer` 1-го числа | от root, `EnvironmentFile=-/etc/hgz/backup.env` | restore-test.timer включать только если ключ на сервере (§10) |
| `deploy/Caddyfile` | `catalog.habez-gips.ru`, CSP, `/assets/*` год, тело 12 МБ, JSON-лог с ротацией | `caddy validate` — только на сервере |
| `deploy/scripts/*` | backup / restore-test / deploy / smoke / monitor / firewall, 78 тестов | firewall.sh считает SSH = 22 |
| `.github/workflows/ci.yml` | Node 22, `npm ci`, audit high, тесты, обе сборки, `bash -n` | зелёный на `751a32b` |
| `api/src/config.js` | production не стартует без `JWT_SECRET`, абсолютных `DATABASE_FILE`/`UPLOAD_DIR` вне checkout, при `PAYMENT_PROVIDER=mock`, при демо-учётках | защита, не ошибка |
| База | `/var/lib/hgz/hgz.db`, WAL, `synchronous=FULL`, `BEGIN IMMEDIATE`; `--fresh` в production запрещён | |
| Загрузки | `/var/lib/hgz/uploads/<tenant>/<uuid>.ext`, отдаёт Node по `/uploads/` | Caddy к файлам не обращается |
| Ключи push | `/var/lib/hgz/vapid.json` (0600), создаются при первом старте, входят в копию | `VAPID_SUBJECT` = почта завода |
| `deploy/hgz.env.example` | все значения, кроме `JWT_SECRET`, `PUBLIC_URL`/`WEB_URL`/`CORS_ORIGINS`, `VAPID_SUBJECT` | `PORT`, `HOST`, пути — уже правильные |
| `npm run create-owner -- почта` | единственный способ получить первую учётную запись; пароль печатается один раз | запускать после smoke |
| `export-catalog` → `import-catalog` | только каталог; проверено: без users/orders, dry-run не пишет, повторный импорт без дублей | локальная база сейчас: 56 товаров, 29 настоящих цен, `demoPrices=false` |
| Cookie | `secure` = `COOKIE_SECURE` (в примере `true`), `sameSite=lax`, `httpOnly` | за Caddy с HTTPS — верно |

**Проект соответствует конфигурации** Ubuntu 24.04 + 2 vCPU + 2 ГБ + 40 ГБ +
Node 22 + Caddy + SQLite + systemd. Node ≥ 22.13 обязателен (`node:sqlite`
без флага); NodeSource `setup_22.x` даёт нужную версию. Сборка витрины
(`vite build`) укладывается в ~300 МБ памяти, тесты — в ~200 МБ.

---

## 2. Диск: сколько чего

| Что | Сейчас | Резерв на 40 ГБ |
|---|---|---|
| Ubuntu 24.04 + обновления + Node + Caddy + rclone/age | ~4 ГБ | 6 ГБ |
| Приложение: релиз = `node_modules` api 29 МБ + web 49 МБ + `dist` 4 МБ ≈ 85 МБ; хранятся 3 релиза + кеш npm | ~0,3 ГБ | 1 ГБ |
| SQLite (`hgz.db` + `-wal`) | 1 МБ (56 товаров); заказ ≈ 2–5 КБ | 1 ГБ — хватит на годы |
| Загрузки (фото/PDF из панели, до 10 МБ файл) | 0 | 5–8 ГБ |
| Локальные копии: **каждый архив = база + все загрузки**; по умолчанию 14 daily + 8 weekly + 12 monthly + manual ≈ 35 архивов | 35 × ~1 МБ | 10 ГБ, **см. предупреждение** |
| Журналы: journald 500 МБ (§6 DEPLOY.md), Caddy 50 МБ × 14 = 0,7 ГБ | | 1,5 ГБ |
| Свободно (monitor.sh тревожит при 80 %) | | **≥ 8 ГБ всегда** |

**Предупреждение про копии.** Архив содержит полный `uploads/`. При 1 ГБ
загрузок 35 локальных архивов — это 35 ГБ, диск кончится. Правило: пока
загрузки < 200 МБ — умолчания подходят; больше — в `/etc/hgz/backup.env`
уменьшить `HGZ_BACKUP_KEEP_DAILY=7`, `HGZ_BACKUP_KEEP_WEEKLY=4`,
`HGZ_BACKUP_KEEP_MONTHLY=3` (удалённых копий это не касается — их срок
задаёт lifecycle бакета). Инкрементное копирование загрузок — отдельная
задача после запуска.

---

## 3. Топология

```
Интернет
  └─ catalog.habez-gips.ru  (A-запись → IP VPS)
       └─ Caddy :80 → 308 → :443  (Let's Encrypt, HSTS от приложения, CSP от Caddy, лог JSON)
            └─ reverse_proxy 127.0.0.1:4000   (X-Forwarded-*, приложение верит только loopback)
                 └─ Node 22 · systemd hgz.service · User=hgz · /srv/hgz/current/api
                      ├─ /var/lib/hgz/hgz.db          SQLite WAL (0640 hgz:hgz)
                      ├─ /var/lib/hgz/uploads/        файлы панели (0750/0640)
                      ├─ /var/lib/hgz/vapid.json      ключи push (0600)
                      └─ /srv/hgz/current/web/dist    витрина (только чтение)
                 ← /etc/hgz/hgz.env (0640 root:hgz) — настройки и JWT_SECRET

Копии (root, hgz-backup.timer 03:10)
  /var/lib/hgz  ─VACUUM INTO + tar─▶  age -r <публичный ключ владельца>  ─▶  /var/backups/hgz/{daily,weekly,monthly,manual}
                                                                          └▶ rclone (ключ только PutObject) ─▶ S3-бакет hgz-backups/{daily,weekly,monthly}
Расшифровать может только приватный ключ владельца (не на сервере).
```

Порт 4000 наружу не виден (слушает 127.0.0.1 + ufw «всё закрыто»). SQLite —
файл, сети у него нет. Копии читаются только root.

---

## 4. Первичная настройка Ubuntu 24.04 (команды — не выполнять сейчас)

Подключение первый раз — тем пользователем и ключом, что дал хостер
(обычно `root` или `ubuntu`). Все команды ниже — с `sudo`.

**4.1 Обновление, имя, время**

```bash
sudo apt-get update && sudo apt-get -y upgrade && sudo apt-get -y autoremove
```

```bash
sudo hostnamectl set-hostname catalog
```

```bash
sudo timedatectl set-timezone Europe/Moscow && timedatectl
```

Если ядро обновилось — `sudo reboot`, подождать минуту, зайти снова.

**4.2 Пользователь службы `hgz`** (без входа, без пароля, домашний каталог — данные)

```bash
sudo useradd --system --home /var/lib/hgz --shell /usr/sbin/nologin hgz
```

**4.3 Пакеты**

```bash
sudo apt-get install -y git curl sqlite3 age rclone ufw fail2ban unattended-upgrades ca-certificates
```

Проверка версий (нужно: sqlite3 ≥ 3.27 для `VACUUM INTO`, rclone ≥ 1.53 для флагов из backup.sh):

```bash
sqlite3 --version && age --version && rclone version | head -1 && ufw version | head -1
```

**4.4 Node.js 22** (≥ 22.13)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs && node -v && npm -v
```

`/usr/bin/node` — именно этот путь стоит в `hgz.service`: `ls -l /usr/bin/node`.

**4.5 Caddy** (официальный репозиторий, как в DEPLOY.md §8)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
sudo apt-get update && sudo apt-get install -y caddy && caddy version
```

Caddy пока с пустым конфигом — это нормально, домен подключается в §8.

**4.6 unattended-upgrades** (обновления безопасности сами)

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

(ответить «Yes»). Проверка: `cat /etc/apt/apt.conf.d/20auto-upgrades` → две строки со значением `"1"`.

**4.7 Каталоги и права** (подробно — §7)

```bash
sudo mkdir -p /var/lib/hgz/uploads /var/backups/hgz /etc/hgz /srv/hgz/releases /var/log/caddy
```

```bash
sudo chown -R hgz:hgz /var/lib/hgz && sudo chmod 750 /var/lib/hgz /var/lib/hgz/uploads
```

```bash
sudo chmod 700 /var/backups/hgz && sudo chown root:hgz /etc/hgz && sudo chmod 750 /etc/hgz && sudo chown -R caddy:caddy /var/log/caddy
```

**4.8 journald** — ограничить журнал (DEPLOY.md §6):

```bash
sudo mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=14day\n' | sudo tee /etc/systemd/journald.conf.d/hgz.conf && sudo systemctl restart systemd-journald
```

---

## 5. SSH — не потерять доступ

**Особенность Ubuntu 24.04**, из-за которой команда `sed` из DEPLOY.md §1
может не сработать: настройки читаются сначала из
`/etc/ssh/sshd_config.d/*.conf` (там у облачных образов лежит
`50-cloud-init.conf` с `PasswordAuthentication yes`), и **первое встреченное
значение побеждает**. Поэтому свои настройки кладём в файл, который
читается раньше — `00-hgz.conf`.

1. **Узнать текущий порт и состояние** (ничего не менять):

```bash
sudo sshd -T | grep -iE '^(port|passwordauthentication|permitrootlogin|pubkeyauthentication) '
```

Запомнить порт — он нужен для firewall (§6). Порт не менять: ключ + fail2ban +
`ufw limit` дают больше, чем «нестандартный порт».

2. **Добавить свой ключ** пользователю, под которым будете входить
(если хостер уже положил его — пропустить). Публичный ключ с Mac:
`cat ~/.ssh/id_ed25519.pub` (если нет — `ssh-keygen -t ed25519`).

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAA…ваш ключ…' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

3. **Проверить вторым окном терминала**, не закрывая первое:

```bash
ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no пользователь@IP
```

Вошло без пароля → можно ужесточать. Не вошло → разбираться, первое окно
держит доступ.

4. **Отключить пароль и root** (первое окно всё ещё открыто):

```bash
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nMaxAuthTries 4\n' | sudo tee /etc/ssh/sshd_config.d/00-hgz.conf
```

```bash
sudo sshd -t && sudo systemctl restart ssh
```

(`sshd -t` — проверка синтаксиса, без ошибок печатает пусто.)

5. **Проверить снова из третьего окна**: по ключу входит; с паролем —
`ssh -o PreferredAuthentications=password пользователь@IP` → «Permission denied».
Только после этого закрывать первое окно.

6. **fail2ban** (после §6, когда firewall включён). На 24.04 нет
`/var/log/auth.log` — jail должен читать journald:

```bash
printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' | sudo tee /etc/fail2ban/jail.d/hgz.local && sudo systemctl enable --now fail2ban && sudo systemctl restart fail2ban
```

```bash
sudo systemctl status fail2ban --no-pager && sudo fail2ban-client status sshd
```

Ожидается `active (running)` и jail `sshd` с 0 забаненных. Если служба не
стартует (в 24.04 были проблемы пакета с Python 3.12) — `journalctl -u fail2ban -n 30`,
разбираемся до включения таймеров. Ваш IP не забанят при входе по ключу;
если статический IP — можно добавить `ignoreip = ваш.IP` в тот же файл.

---

## 6. Firewall

Применять **только после §5 п. 5** (ключевой вход проверен) и **из
проверенного SSH-сеанса**.

| Открыто | Кому | Зачем |
|---|---|---|
| 80/tcp | всем | Caddy: редирект на https, выпуск сертификата (ACME) |
| 443/tcp | всем | Caddy: сайт и API |
| SSH (порт из `sshd -T`) | всем с ограничением частоты, или только с вашего IP | управление |

Закрыто всё остальное: 4000 (Node слушает 127.0.0.1 — двойная защита),
SQLite (файл, портов нет), копии (файлы root), 4001 restore-test (127.0.0.1).

Если порт SSH = **22** — готовый скрипт (он делает `ufw reset` → `deny incoming` →
80/443 → `limit 22` → `enable`; между `reset` и `enable` фильтрации нет, доступ не рвётся):

```bash
sudo /srv/hgz/current/deploy/scripts/firewall.sh
```

Если порт **не 22** — скрипт **не запускать**, руками (подставить порт):

```bash
sudo ufw --force reset && sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw limit ПОРТ/tcp comment 'SSH' && sudo ufw --force enable && sudo ufw status verbose
```

Проверка сразу в новом окне: SSH входит. С Mac: `curl -m 3 http://IP:4000/api/health`
→ таймаут (порт закрыт). Скрипт `firewall.sh` требует `/srv/hgz/current`,
поэтому его очередь — после §8.2.

---

## 7. Пути и права

| Путь | owner:group | chmod | Читает | Пишет |
|---|---|---|---|---|
| `/srv/hgz` | hgz:hgz (после `chown -R hgz:hgz /srv/hgz` в §8.2, как в DEPLOY.md §3) | 755 | все | root (deploy.sh); **служба — нет** (`ProtectSystem=strict`) |
| `/srv/hgz/releases/<релиз>` и `current` | hgz:hgz (после `chown -R`) | 755/644 | все | root при выкладке; **служба — нет** (`ProtectSystem=strict`) |
| `/srv/hgz/current/api/.env` → `/etc/hgz/hgz.env` | симлинк | — | hgz по группе | никто в работе |
| `/var/lib/hgz` | hgz:hgz | 750 | hgz, root | hgz (служба, `ReadWritePaths`) |
| `/var/lib/hgz/hgz.db` (+`-wal`, `-shm`) | hgz:hgz | 640 (создаёт `UMask=0027`) | hgz, root | hgz |
| `/var/lib/hgz/uploads/<tenant>/` | hgz:hgz | 750 / файлы 640 | hgz (отдаёт по `/uploads/`), root | hgz |
| `/var/lib/hgz/vapid.json` | hgz:hgz | 600 | hgz, root | hgz (один раз) |
| `/var/lib/hgz/.npm` (кеш npm при `migrate` от hgz) | hgz:hgz | 750 | hgz | hgz (вне службы) |
| `/var/backups/hgz` | root:root | 700 | root | root (backup.sh) |
| `/etc/hgz` | root:hgz | 750 | root, hgz | root |
| `/etc/hgz/hgz.env` | root:hgz | 640 | root, hgz (systemd, `sudo -u hgz`) | root |
| `/etc/hgz/backup.env` | root:root | 600 | root | root |
| `/var/log/caddy` | caddy:caddy | 755 | caddy, root | caddy |

**Совместимость с `hgz.service`:** служба пишет только в `/var/lib/hgz`
(база, WAL, загрузки, vapid.json) — это и есть `ReadWritePaths`. Код в
`/srv/hgz` и `/etc/hgz/hgz.env` ей нужны только для чтения — `ProtectSystem=strict`
это разрешает. `UMask=0027` даёт новым файлам 640, каталогам 750 — Caddy к
ним не обращается, читать больше некому. `PrivateTmp` — свой `/tmp`, приложение
им не пользуется. `/var/lib/hgz` как домашний каталог `hgz` под `ProtectHome`
не попадает (защищаются `/home`, `/root`, `/run/user`). Проверка на сервере —
`systemd-analyze verify` и `systemd-analyze security hgz` (§11).

---

## 8. Первое развёртывание — точный порядок

Предусловия: §4–5 выполнены, firewall — после 8.2. DNS ещё **не** обязателен
до 8.9. Локальная база с Mac **не копируется**. Демо-пользователи **не
попадают** (их нет ни в seed, ни в экспорте; сервер откажется стартовать,
если они есть). Владелец создаётся **последним**, когда API уже работает.

**8.1 Код (первый релиз — `initial`)**

```bash
sudo git clone --depth 1 --branch main https://github.com/salamgasanov777-gmm/habez-pro.git /srv/hgz/releases/initial && sudo ln -sfn /srv/hgz/releases/initial /srv/hgz/current
```

Лучше выпускать тег (`v1.0.0`), а не `main`: `--branch v1.0.0`. Тег ставит
Claude Code с Mac по вашей команде до этого шага.

**8.2 Зависимости и сборка витрины**

```bash
cd /srv/hgz/current && sudo npm --prefix api ci --omit=dev --no-audit --no-fund && sudo npm --prefix web ci --no-audit --no-fund && sudo npm --prefix web run build
```

```bash
sudo chmod +x /srv/hgz/current/deploy/scripts/*.sh && sudo chown -R hgz:hgz /srv/hgz && ls /srv/hgz/current/web/dist/index.html
```

Теперь можно §6 (firewall).

**8.3 Настройки** (`/etc/hgz/hgz.env`, секрет — §9)

```bash
sudo cp /srv/hgz/current/deploy/hgz.env.example /etc/hgz/hgz.env && sudo chown root:hgz /etc/hgz/hgz.env && sudo chmod 640 /etc/hgz/hgz.env
```

```bash
sudo nano /etc/hgz/hgz.env
```

Заполнить: `JWT_SECRET=` (из §9), `PUBLIC_URL`/`WEB_URL`/`CORS_ORIGINS` =
`https://catalog.habez-gips.ru`, `VAPID_SUBJECT=mailto:почта@завода`.
Остальное уже верно. Связать с приложением:

```bash
sudo ln -sfn /etc/hgz/hgz.env /srv/hgz/current/api/.env
```

**8.4 База: схема и заводской сид** (43 товара, цены «по запросу», **0 пользователей**)

```bash
cd /srv/hgz/current/api && sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run migrate && npm run seed'
```

```bash
sudo -u hgz sqlite3 /var/lib/hgz/hgz.db "SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM users;" && ls -l /var/lib/hgz
```

→ `43`, `0`; `hgz.db` принадлежит `hgz:hgz`, права `-rw-r-----`.

**8.5 Перенос каталога** (56 товаров, 29 цен, реквизиты). На Mac — Claude Code,
перед экспортом проверяет, что база та самая (не после `npm run reset`):

```bash
sqlite3 ~/Desktop/HGZ_pro/api/var/hgz.db "SELECT COUNT(*) FROM prices WHERE amount IS NOT NULL AND tier='retail'; SELECT json_extract(settings,'$.demoPrices') FROM tenants;"
```

→ `29` и `0`. Затем:

```bash
cd ~/Desktop/HGZ_pro/api && npm run export-catalog -- /tmp/catalog-export.json && scp /tmp/catalog-export.json пользователь@IP:/tmp/
```

На сервере — сначала прогон без записи, потом импорт:

```bash
cd /srv/hgz/current/api && sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run import-catalog -- /tmp/catalog-export.json --dry-run'
```

```bash
cd /srv/hgz/current/api && sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run import-catalog -- /tmp/catalog-export.json' && rm /tmp/catalog-export.json
```

Проверка: `products` → 56, `prices WHERE amount IS NOT NULL AND tier='retail'` → 29, `users` → 0.
Фото товаров лежат в собранной витрине (`web/dist/products`), переносить не надо.

**8.6 Служба**

```bash
sudo cp /srv/hgz/current/deploy/systemd/hgz.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemd-analyze verify /etc/systemd/system/hgz.service
```

```bash
sudo systemctl enable --now hgz && sleep 2 && systemctl status hgz --no-pager && curl -s http://127.0.0.1:4000/api/health
```

→ `{"status":"ok","env":"production",…,"products":56,"paymentProvider":"none"}`.
Если статус `failed` — `journalctl -u hgz -n 50`: config.js пишет по-русски,
чего не хватает.

**8.7 Caddy — пока без домена не трогать.** Сначала DNS.

**8.8 DNS.** У регистратора: `A catalog → IP VPS`, TTL 300 (и `AAAA`, если у
VPS есть IPv6 — иначе не добавлять). Проверка с Mac: `dig +short catalog.habez-gips.ru` = IP.

**8.9 Caddy и HTTPS** (порты 80/443 уже открыты в §6)

```bash
sudo cp /srv/hgz/current/deploy/Caddyfile /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

```bash
sudo systemctl enable --now caddy && sudo systemctl reload caddy && sleep 20 && sudo journalctl -u caddy -n 20 --no-pager | grep -iE 'certificate|error' 
```

Сертификат выпускается за ~1 минуту. Проверка с Mac:

```bash
curl -sI https://catalog.habez-gips.ru/api/health | grep -iE '^(HTTP|strict|content-security|x-frame)' && curl -sI http://catalog.habez-gips.ru/api/health | head -1
```

→ `HTTP/2 200`, три заголовка, и `308` на http.

Резолв компании по домену (иначе берётся `DEFAULT_TENANT` — тоже работает):

```bash
sudo -u hgz sqlite3 /var/lib/hgz/hgz.db "UPDATE tenants SET host='catalog.habez-gips.ru' WHERE slug='habez';"
```

**8.10 Smoke**

```bash
/srv/hgz/current/deploy/scripts/smoke.sh https://catalog.habez-gips.ru
```

Все строки `OK`, в конце «✓ smoke: всё в порядке». Любой `FAIL` — разбирать
до следующего шага.

**8.11 Владелец** — только теперь

```bash
cd /srv/hgz/current/api && sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run create-owner -- director@habez-gips.ru'
```

Пароль печатается один раз — записать. Сайт → «Вход» → Панель → Пользователи →
себя → новый пароль (12+ символов). Менеджеры регистрируются на сайте по
почте, владелец ставит им роль `manager`.

**8.12 Приёмка**: вход владельца · смена пароля · «Уведомления о заказах» на
телефоне (сайт установлен иконкой на iPhone) · тестовый заказ с чужого
телефона → push пришёл → заказ в панели → статус → удалить тестовый заказ ·
открыть PDF/фото из карточки (§11, CSP) · §10 копии.

**8.13 Таймеры** (мониторинг и копии) — §10.

---

## 9. Секреты

Всё генерируется **на сервере**, в репозиторий не попадает, в чат не
вставляется. Что нужно при `PAYMENT_PROVIDER=none`:

| Секрет | Как получить | Где живёт | Копия |
|---|---|---|---|
| `JWT_SECRET` | на сервере: `openssl rand -base64 48` (или `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) | только `/etc/hgz/hgz.env` (0640 root:hgz) | сейчас — в зашифрованной копии (`hgz.env` в архиве, известная MEDIUM). Потеря не страшна: новый секрет → все входят заново, гостевые ссылки на заказы перестают работать |
| Ключ шифрования копий (age) | **на Mac**: `age-keygen -o ~/hgz-backup-key.txt` → строка `# public key: age1…` идёт в `backup.env`; файл с `AGE-SECRET-KEY-…` — в менеджер паролей и распечатку в сейф | публичная часть: `/etc/hgz/backup.env`; приватная: **никогда на сервере** | без него копии — мусор; хранить в двух местах |
| VAPID (push) | создаётся сам при первом старте | `/var/lib/hgz/vapid.json` (0600 hgz) | входит в каждую копию; в `hgz.env` не задавать |
| Ключ S3 «только запись» | панель хранилища: ключ с политикой `s3:PutObject` на `hgz-backups/*` | `rclone config` от root → `/root/.config/rclone/rclone.conf` (0600) | второй ключ «только чтение» — у владельца на Mac для проверки и restore-test |

Не нужны и не создаются: `YOOKASSA_*`, ключи SMS-провайдера, `TELEGRAM_*`,
SMTP-пароль (`EMAIL_PROVIDER=log`), `VAPID_PUBLIC/PRIVATE_KEY`, `COOKIE_DOMAIN`.

Тревоги мониторинга (`HGZ_ALERT_CMD`) на первом этапе не настраиваются:
почтового отправителя на сервере нет. Вместо этого — внешняя проверка
`https://catalog.habez-gips.ru/api/health` раз в 5 минут (UptimeRobot,
бесплатно, регистрирует владелец) — она же шлёт письмо/пуш, когда сайт лёг.

---

## 10. Копии — до первого боевого заказа

Что известно: **реальный S3 с write-only ключом не проверялся**, `restore-test.sh`
на Ubuntu не запускался, `age`/`rclone` на Mac не установлены (нужны для
проверки копии с Mac: `brew install age rclone`).

Порядок:

1. **Ключ age** на Mac (§9), публичный — в `backup.env`.
2. **Хранилище**: бакет `hgz-backups` (версионирование включить, lifecycle:
   `daily/` 14 дней, `weekly/` 56, `monthly/` 365), два ключа: «запись»
   (сервер) и «чтение» (Mac).
3. **На сервере** `rclone config` от root: тип `s3`, провайдер вашего
   хранилища, ключ «запись», имя remote `hgz-s3`.

```bash
sudo rclone config
```

4. **backup.env**:

```bash
sudo cp /srv/hgz/current/deploy/backup.env.example /etc/hgz/backup.env && sudo chmod 600 /etc/hgz/backup.env && sudo nano /etc/hgz/backup.env
```

Заполнить `HGZ_BACKUP_AGE_RECIPIENT=age1…`, `HGZ_BACKUP_REMOTE=hgz-s3:hgz-backups`;
`HGZ_PUBLIC_URL=https://catalog.habez-gips.ru` уже в примере (нужна
monitor.sh для проверки HTTPS и срока сертификата) — оставить, если домен тот же.
`HGZ_BACKUP_PING_URL` — если заведёте healthchecks.io.

5. **Первая копия руками** (скрипт сам читает backup.env):

```bash
sudo /srv/hgz/current/deploy/scripts/backup.sh daily && sudo ls -la /var/backups/hgz/daily
```

Ожидается «✓ копия hgz-…tar.age (…): заказов 0, товаров 56, пользователей 1…».
Если rclone ругается на 403 — политика ключа не write-only-совместима
(см. `backup.env.example`): смотрим текст ошибки, **не** расширяем права
до Delete.

6. **Проверка, что копия в хранилище** — с Mac ключом «чтение»
(`rclone config` на Mac, remote `hgz-s3-ro`):

```bash
rclone ls hgz-s3-ro:hgz-backups/daily
```

7. **restore-test** — там, где есть приватный ключ. Рекомендуемый вариант —
**на Mac** (ключ не покидает владельца):

```bash
rclone copy hgz-s3-ro:hgz-backups/daily/hgz-ДАТА.tar.age /tmp/ && HGZ_RESTORE_IDENTITY=~/hgz-backup-key.txt HGZ_APP_DIR=~/Desktop/HGZ_pro HGZ_RESTORE_PORT=4001 ~/Desktop/HGZ_pro/deploy/scripts/restore-test.sh /tmp/hgz-ДАТА.tar.age
```

Ожидается «✓ копия … восстанавливается: товаров 56, заказов 0, API отвечает».
Это одновременно и первая проверка «age настоящий → расшифровка → база цела →
API на копии поднимается». Вариант на сервере (ключ временно в
`/root/.config/hgz/age-identity.txt`, после теста удалить) — только если Mac
недоступен.

8. **Таймеры**: копии и монитор — включить; restore-test — **не включать**,
пока ключ не на сервере (иначе каждое 1-е число будет «провал»):

```bash
sudo cp /srv/hgz/current/deploy/systemd/hgz-{backup,monitor,restore-test}.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hgz-backup.timer hgz-monitor.timer && systemctl list-timers --no-pager | grep hgz
```

9. **Монитор руками**:

```bash
sudo /srv/hgz/current/deploy/scripts/monitor.sh
```

Все строки `OK` (копия «0 ч назад», сертификат «~89 дн.»).

10. Утром после первой ночи: `sudo ls -la /var/backups/hgz/daily` — появился
файл 03:10–03:20; `journalctl -t hgz-backup -n 5`.

---

## 11. Проверки только на VPS (Linux-only)

| # | Проверка | Команда / что ожидать |
|---|---|---|
| 1 | Unit-файлы | `sudo systemd-analyze verify /etc/systemd/system/hgz*.{service,timer}` — пусто; смотреть предупреждение про `StartLimitIntervalSec` в `[Service]` |
| 2 | Sandbox службы | `sudo systemd-analyze security hgz` — оценка; служба реально стартует под `SystemCallFilter`/`RestrictAddressFamilies`; `journalctl -u hgz` без `EPERM`/`EACCES` |
| 3 | Служба | `systemctl status hgz`, `systemctl show hgz -p NRestarts` = 0 через сутки |
| 4 | Caddyfile | `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` |
| 5 | HTTPS | `curl -sI https://…/api/health` → `HTTP/2 200`; SSL Labs — A/A+; `openssl s_client` показывает Let's Encrypt |
| 6 | Редирект | `curl -sI http://…/` → `308`, `Location: https://…` |
| 7 | Заголовки | HSTS, CSP, X-Frame-Options DENY, nosniff; **Cache-Control на `/assets/*.js` — один заголовок или два?** (известная MEDIUM: `curl -sI https://…/assets/index-*.js \| grep -i cache-control`) |
| 8 | CSP и PDF | загрузить в панели PDF, открыть из карточки в Chrome (Mac), Safari (iPhone) — открывается. Если Chrome показывает пустую страницу — CSP на `/uploads` (MEDIUM), решаем после запуска |
| 9 | Витрина | главная, карточка `/p/…` по прямой ссылке, поиск, корзина, заявка с галочкой согласия → заказ виден в панели |
| 10 | Push | «Уведомления о заказах» на iPhone (сайт установлен иконкой) → тестовый заказ → уведомление пришло |
| 11 | UFW | `sudo ufw status verbose` — 80, 443, SSH; с Mac `curl -m 3 http://IP:4000/api/health` — таймаут |
| 12 | fail2ban | `sudo fail2ban-client status sshd`; 6 неверных попыток с чужого адреса → бан (проверить осторожно, не со своего IP) |
| 13 | Таймеры | `systemctl list-timers \| grep hgz` — backup 03:10, monitor каждые 5 мин |
| 14 | age | `backup.sh daily` завершился ✓; файл `.tar.age` не читается `tar -tf` (зашифрован) |
| 15 | rclone write-only | копия появилась в бакете; `rclone ls` с серверным ключом даёт 403 (это правильно) |
| 16 | restore-test | §10 п. 7 — «✓ … восстанавливается» |
| 17 | Node | `node -v` ≥ 22.13; `npm --prefix /srv/hgz/current/api test` **не** запускать на сервере (dev-зависимостей нет) — тесты гоняет CI |
| 18 | Health/smoke | `curl 127.0.0.1:4000/api/health`; `smoke.sh https://…` — всё OK |
| 19 | Монитор | `monitor.sh` — всё OK; `journalctl -t hgz-monitor` пуст |
| 20 | Обновление | после первого тега: `sudo HGZ_PUBLIC_URL=https://catalog.habez-gips.ru /srv/hgz/current/deploy/scripts/deploy.sh v1.0.1` → «✓ выпущен», затем `--rollback` → «✓ откачено» → снова deploy. Это проверяет весь цикл ещё до боевых заказов |
| 21 | Логи | `journalctl -u hgz -n 50` — нет телефонов/имён покупателей (маскирование), `/var/log/caddy/access.log` растёт и ротируется |

---

## 12. Чего не делать на этапе 1B

PostgreSQL · ЮKassa/онлайн-оплата · учёт остатков · ESLint · Playwright ·
редизайн (в том числе мобильный) · новые функции · оптимизация
производительности без измерений · Telegram/SMS/1С.

---

## 13. Известные вопросы после базового запуска (не блокеры)

Разобрать отдельными коммитами, по одному:

- карта статусов заказа и отдельный статус оплаты (`new → confirmed → processing → shipped → completed / cancelled`; `unpaid / pending / paid / refunded`; способ `cash / invoice`);
- QR-код и «скопировать ссылку» в витрине ведут на github.io (`web/src/lib/site.js`) — на VPS нужен домен;
- Caddy: дубль `Cache-Control` на `/assets/*` → `header @assets >Cache-Control`;
- CSP и PDF из `/uploads` (Chrome-просмотрщик);
- `StartLimitIntervalSec/Burst` → в `[Unit]`; комментарий про `Environment=` в `hgz.service`;
- `hgz-restore-test.timer` против ключа не на сервере; пинги `/restore` для healthchecks;
- monitor.sh: `journalctl -p err` не видит pino (`"level":50`);
- backup.sh: `trap ERR` для пинга `/fail`; `hgz.env` в архиве (секреты отдельно или не копировать); `flock` против одновременного deploy; `tar` «file changed as we read it»;
- root открывает боевую SQLite (`runuser -u hgz`);
- firewall.sh: порт SSH из `sshd -T`;
- `COOKIE_SECURE` — сейчас `true` в примере и верно за HTTPS; при локальной отладке на сервере по http вход не сработает — это ожидаемо, не менять;
- размер локальных копий при росте `uploads/` (§2);
- `engines >=22.13`, `KEEP_*=0`, `npm audit` в CI как обязательный шаг.

---

## 14. Итоговый документ

### A. Что купить/получить

| Что | Параметры | Кто |
|---|---|---|
| VPS | Ubuntu 24.04 LTS, 2 vCPU, 2 ГБ, 40 ГБ SSD, публичный IPv4, вход по SSH-ключу; регион РФ или ближайший | завод |
| Поддомен | `catalog.habez-gips.ru` → A-запись на IP VPS (TTL 300) | тот, кто ведёт `habez-gips.ru` |
| Почта завода | адрес для `VAPID_SUBJECT` и писем Let's Encrypt/хостера; SMTP не нужен | завод |
| S3-совместимое хранилище | бакет `hgz-backups`, версионирование + lifecycle, два ключа: «только PutObject» и «только чтение» | завод |
| Ключ шифрования копий | `age-keygen` на Mac; приватная часть — в сейф и менеджер паролей | владелец |
| Внешний мониторинг | UptimeRobot (бесплатно) на `https://catalog.habez-gips.ru/api/health` | владелец |

### B. Что делает владелец сам

1. Купить VPS, при заказе указать свой публичный SSH-ключ (или получить пароль root и сразу перейти на ключ по §5).
2. Дать Claude Code: IP, пользователя для входа, порт SSH (если хостер задал не 22).
3. Заказать A-запись `catalog` у администратора домена и сообщить, когда сделано.
4. Сообщить почту завода для `VAPID_SUBJECT`.
5. Создать бакет и два ключа S3; ключ «запись» ввести в `rclone config` на сервере **самому** (Claude открывает терминал и говорит, что вводить; секрет в чат не вставляется); ключ «чтение» — в `rclone config` на Mac.
6. Сгенерировать age-ключ на Mac, публичную строку передать; приватную — сохранить в двух местах.
7. Ввести `JWT_SECRET` в `/etc/hgz/hgz.env` (команда генерации даётся, значение в чат не попадает).
8. Запустить `create-owner` со своей почтой, записать пароль, сменить его в панели.
9. Зарегистрировать UptimeRobot.
10. Подтвердить реквизиты для витрины/политики (ОАО, ИНН 0910003701, ОГРН 1020900752311) и список менеджеров.

### C. Что делает Claude Code (после получения доступа)

Только по шагам и с отчётом после каждого:
- поставить тег релиза на Mac (`v1.0.0`) по команде владельца;
- §4 (пакеты, пользователь, каталоги, journald), §5 п. 1–5 (SSH: настройка и проверка, без смены порта), §6 (firewall — из проверенного сеанса), §5 п. 6 (fail2ban);
- §8.1–8.6 (код, сборка, `hgz.env` без секрета — секрет вводит владелец, migrate/seed, экспорт-импорт каталога с Mac, служба);
- после DNS: §8.9 (Caddy, HTTPS), 8.10 (smoke), проверки §11;
- §10 п. 4–5, 8–10 (backup.env, первая копия, таймеры, монитор) — ключи вводит владелец;
- restore-test на Mac после `brew install age rclone` (с разрешения);
- отчёт по чек-листам E и G.

Не делает: не создаёт секреты за владельца, не меняет DNS, не включает restore-test.timer без ключа, не ставит ничего сверх §4, не трогает приложение №1.

### D. Полная последовательность (от чистой Ubuntu до сайта)

1. Владелец: VPS + IP + ключ → 2. §4.1–4.8 Ubuntu → 3. §5 SSH (ключ, второй сеанс, ужесточение, проверка) → 4. §8.1–8.2 код и сборка → 5. §6 firewall → 6. §5.6 fail2ban → 7. §8.3 `hgz.env` + `JWT_SECRET` (владелец) → 8. §8.4 migrate + seed → 9. §8.5 экспорт на Mac → импорт (dry-run, затем боевой) → 10. §8.6 служба, health на 127.0.0.1 → 11. §8.8 DNS (владелец/админ домена) → 12. §8.9 Caddy, HTTPS, `tenants.host` → 13. §8.10 smoke → 14. §11 проверки 1–9, 11–13, 17–19, 21 → 15. §8.11 владелец (create-owner, смена пароля) → 16. §8.12 приёмка (push, тестовый заказ, PDF) → 17. §10 копии: age, S3, backup.env, первая копия, проверка в бакете, restore-test на Mac, таймеры, монитор → 18. §11 п. 20 — пробное обновление и откат → 19. UptimeRobot → 20. чек-лист E → первый боевой заказ.

### E. Чек-лист перед первым боевым заказом (всё — PASS)

- [ ] `systemctl is-active hgz caddy fail2ban ufw` → все `active`; `NRestarts=0`
- [ ] `https://catalog.habez-gips.ru` открывается, сертификат Let's Encrypt, http → 308
- [ ] `smoke.sh https://…` — «✓ smoke: всё в порядке»
- [ ] `/api/health`: `env=production`, `paymentProvider=none`, `products=56`
- [ ] в базе `users` = 1 (владелец), демо-учёток нет, пароль владельца сменён
- [ ] витрина: карточка по прямой ссылке, поиск, корзина, заявка → в панели
- [ ] push на телефон менеджера приходит на тестовый заказ; тестовый заказ удалён
- [ ] PDF и фото из карточки открываются (Chrome + Safari iPhone)
- [ ] `ufw status`: только 80, 443, SSH; 4000 снаружи недоступен
- [ ] `fail2ban-client status sshd` — jail работает
- [ ] `backup.sh daily` ✓, файл в `/var/backups/hgz/daily`, файл в бакете (виден ключом «чтение»)
- [ ] `restore-test.sh` на копии из бакета — «✓ … восстанавливается»
- [ ] приватный age-ключ — в сейфе и менеджере паролей (проверено: расшифровывает)
- [ ] `hgz-backup.timer`, `hgz-monitor.timer` активны; `monitor.sh` — всё OK
- [ ] `deploy.sh v…` и `--rollback` пробно прошли
- [ ] UptimeRobot следит за `/api/health`, письмо о недоступности приходит
- [ ] журнал без персональных данных; journald ≤ 500 МБ; диск свободен ≥ 8 ГБ
- [ ] реквизиты в витрине и `/privacy` подтверждены владельцем

### F. Откат и восстановление

| Сбой | Действие |
|---|---|
| Новый релиз не отвечает / smoke FAIL | `deploy.sh` откатывает сам; вручную: `sudo /srv/hgz/current/deploy/scripts/deploy.sh --rollback` → «✓ откачено» → `smoke.sh` |
| Миграция упала при обновлении | `deploy.sh` (1A-5) не переключает `current` и запускает службу снова на старом коде; прочитать вывод; база **не** откачена — оценить по `sqlite3 … "SELECT name FROM migrations"`; при необходимости — DEPLOY.md §13D |
| Служба не стартует после правки `hgz.env` | `journalctl -u hgz -n 50` — config.js называет переменную; исправить, `systemctl restart hgz` |
| Сертификат не выпустился | `journalctl -u caddy`; проверить DNS (`dig`), 80/443 в ufw; повторить `systemctl reload caddy` |
| База повреждена | DEPLOY.md §13B: stop → `integrity_check` → `.recover` → сравнить с копией → повреждённый файл переименовать, не удалять |
| Случайно удалены заказы | DEPLOY.md §13C: `backup.sh manual` → копия до удаления во временный файл → вернуть строки через `ATTACH` |
| Сервер потерян | DEPLOY.md §13A: новый VPS → §4–8 этого плана → DNS → из копии `hgz.db`, `vapid.json`, `uploads/` в `/var/lib/hgz`, `hgz.env` в `/etc/hgz` → migrate → start → smoke → §10 заново. Потеря ≤ 1 суток |
| Потерян приватный age-ключ | копии нечитаемы: **сразу** `age-keygen` заново, новый публичный в `backup.env`, `backup.sh manual`, и с этого момента хранить ключ в двух местах |
| Потерян `JWT_SECRET` | новый секрет в `hgz.env`, `systemctl restart hgz`; все входят заново |
| Заблокировали себя firewall/SSH | консоль VPS в панели хостера (VNC) → `ufw disable` или правка `/etc/ssh/sshd_config.d/00-hgz.conf` |

### G. Блокеры

**CRITICAL — без этого запуск невозможен:**
- нет VPS (IP, SSH-доступ);
- нет A-записи `catalog.habez-gips.ru` (без неё нет HTTPS, а `COOKIE_SECURE=true` и push требуют HTTPS);
- нет `JWT_SECRET` в `hgz.env` (сервер не стартует — так задумано).

**HIGH — до первого боевого заказа:**
- копии: S3 write-only на реальном хранилище не проверен; restore-test на реальной копии не выполнялся; age-ключ не создан;
- владелец создан, пароль сменён, демо-учёток нет;
- push-уведомления на телефон менеджера проверены (иначе заказы никто не увидит: Telegram/SMS не подключены);
- внешний мониторинг (UptimeRobot) — единственный канал тревог, `HGZ_ALERT_CMD` пуст;
- пробный `deploy.sh` + `--rollback` пройден до боевых данных;
- SSH на 24.04: убедиться, что `sshd -T` показывает `passwordauthentication no` (drop-in cloud-init).

**MEDIUM — можно после запуска (§13):** Cache-Control, CSP/PDF, StartLimit,
restore-test.timer, healthchecks-пинги, счётчик ошибок, root+SQLite, порт SSH
в firewall.sh, QR/PUBLIC_URL, `hgz.env` в архиве, карта статусов заказа,
размер локальных копий при росте uploads.

**LOW:** flock, tar race, `engines`, `KEEP_*=0`, `npm audit` как обязательный
шаг CI, ИНН/ОГРН в тексте политики.
