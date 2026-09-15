# Развёртывание на сервере

Инструкция для одного VPS с Ubuntu 24.04. Команды выполняются по порядку;
после каждого блока написано, как проверить, что получилось. Всё, что здесь
описано, лежит готовыми файлами в папке `deploy/`.

```
Интернет → catalog.habez-gips.ru → Caddy (:80/:443, HTTPS) → 127.0.0.1:4000
         → Node 22 (systemd, пользователь hgz, код в /srv/hgz/current)
         → /var/lib/hgz/hgz.db (SQLite) · /var/lib/hgz/uploads · /var/lib/hgz/vapid.json
         → копии: /var/backups/hgz → зашифрованно → удалённое хранилище
```

| Что | Где | Из интернета |
|---|---|---|
| Код (релизы) | `/srv/hgz/releases/*`, симлинк `/srv/hgz/current` | нет |
| Настройки и секреты | `/etc/hgz/hgz.env` (0640 root:hgz), `/etc/hgz/backup.env` (0600 root) | нет |
| База, загрузки, ключи push | `/var/lib/hgz` (0750 hgz:hgz) | нет (файлы) |
| API + витрина | `127.0.0.1:4000` | только через Caddy |
| Caddy | `:80`, `:443` | да |
| Копии | `/var/backups/hgz` (0700 root) + удалённое хранилище | нет |

---

## Что понадобится

| Что | Зачем | Кто оформляет | Порядок цен |
|---|---|---|---|
| VPS: 2 vCPU, 2 ГБ, 40 ГБ SSD, Ubuntu 24.04 (минимум 1/1/20) | сервер | завод | 300–600 ₽/мес |
| Поддомен `catalog.habez-gips.ru` (A-запись на IP сервера) | адрес | тот, кто ведёт домен завода | 0 ₽ |
| Почта завода (адрес + SMTP или ящик) | контакт для push-служб, письма мониторинга | завод | 0 ₽ |
| S3-совместимое хранилище для копий (версионирование, ключ только на запись) | копии вне сервера | завод | десятки ₽/мес |
| Ключ шифрования копий (`age-keygen`) | без него копии не прочитать | владелец, приватную часть — в сейф | 0 ₽ |

Онлайн-оплаты нет (`PAYMENT_PROVIDER=none`): заказы оплачиваются менеджеру
или по счёту. SMS-вход выключен до договора с SMS-провайдером.

---

## 1. Подготовка Ubuntu 24.04

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y git curl sqlite3 age rclone ufw fail2ban unattended-upgrades ca-certificates
sudo timedatectl set-timezone Europe/Moscow
```

SSH: только по ключу, root по паролю закрыт.

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Проверка: новое подключение по ключу работает; `ssh -o PreferredAuthentications=password …` отвергается.

**Node.js 22** (нужен ≥ 22.13 — там `node:sqlite` без флага):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 2. Пользователь, каталоги, права

```bash
sudo useradd --system --home /var/lib/hgz --shell /usr/sbin/nologin hgz
sudo mkdir -p /var/lib/hgz/uploads /var/backups/hgz /etc/hgz /srv/hgz/releases /var/log/caddy
sudo chown -R hgz:hgz /var/lib/hgz && sudo chmod 750 /var/lib/hgz
sudo chmod 700 /var/backups/hgz
sudo chown root:hgz /etc/hgz && sudo chmod 750 /etc/hgz
```

Проверка: `ls -ld /var/lib/hgz` → `drwxr-x--- hgz hgz`. Служба и команды
от `hgz` читают настройки из `/etc/hgz/hgz.env` (root:hgz, 0640); файл
копий `/etc/hgz/backup.env` — только root (0600).

## 3. Код

```bash
sudo git clone --depth 1 --branch main https://github.com/salamgasanov777-gmm/habez-pro.git /srv/hgz/releases/initial
sudo ln -sfn /srv/hgz/releases/initial /srv/hgz/current
cd /srv/hgz/current
sudo npm --prefix api ci --omit=dev --no-audit --no-fund
sudo npm --prefix web ci --no-audit --no-fund && sudo npm --prefix web run build
sudo chmod +x deploy/scripts/*.sh
sudo chown -R hgz:hgz /srv/hgz
```

Проверка: `ls /srv/hgz/current/web/dist/index.html`.

## 4. Настройки и секреты

```bash
sudo cp /srv/hgz/current/deploy/hgz.env.example /etc/hgz/hgz.env
sudo chown root:hgz /etc/hgz/hgz.env && sudo chmod 640 /etc/hgz/hgz.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → JWT_SECRET
sudo nano /etc/hgz/hgz.env
```

Заполнить: `PUBLIC_URL`, `WEB_URL`, `CORS_ORIGINS` (= `https://catalog.habez-gips.ru`),
`JWT_SECRET` (строка из команды выше), `VAPID_SUBJECT` (почта завода).
Остальное уже правильное: `NODE_ENV=production`, `HOST=127.0.0.1`,
`DATABASE_FILE=/var/lib/hgz/hgz.db`, `UPLOAD_DIR=/var/lib/hgz/uploads`,
`PAYMENT_PROVIDER=none`, `COOKIE_SECURE=true`.

Сервер в production **не стартует**, если: нет `JWT_SECRET`; база или
загрузки лежат внутри папки с кодом; задан `PAYMENT_PROVIDER=mock`; в базе
есть демо-учётные записи с паролями из README. Это защита, не ошибка.

`config.js` читает `api/.env`, если он есть — свяжем его с общим файлом:

```bash
sudo ln -sfn /etc/hgz/hgz.env /srv/hgz/current/api/.env
```

## 5. База: только настоящие данные

Локальная база разработчика (`api/var/hgz.db`) на сервер **не копируется**:
в ней демо-пользователи и тестовые заказы. Порядок:

```bash
cd /srv/hgz/current/api
sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run migrate && npm run seed'
```

`seed` без флагов: 43 товара из заводских данных, все цены «по запросу»,
**ни одной учётной записи**. Проверка:

```bash
sudo -u hgz sqlite3 /var/lib/hgz/hgz.db "SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM users;"
```

→ `43` и `0`.

**Перенос каталога** (актуальные 56 товаров, 29 настоящих цен, фото,
реквизиты). На компьютере, где лежит рабочая база:

```bash
cd ~/Desktop/HGZ_pro/api && npm run export-catalog -- /tmp/catalog-export.json
scp /tmp/catalog-export.json сервер:/tmp/
```

Файл содержит только каталог и реквизиты компании — пользователей, заказов,
заявок в нём нет (скрипт это гарантирует и проверяется тестом). На сервере:

```bash
cd /srv/hgz/current/api
sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run import-catalog -- /tmp/catalog-export.json --dry-run'
sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run import-catalog -- /tmp/catalog-export.json'
rm /tmp/catalog-export.json
```

Проверка: `SELECT COUNT(*) FROM products` → `56`; `SELECT COUNT(*) FROM prices WHERE amount IS NOT NULL AND tier='retail'` → `29`;
`SELECT COUNT(*) FROM users` → по-прежнему `0`. Фото товаров лежат в
собранной витрине (`web/dist/products`), переносить их отдельно не нужно;
если в панели уже загружались файлы — скопировать `uploads/` командой
`rsync -a` в `/var/lib/hgz/uploads/`.

## 6. Служба

```bash
sudo cp /srv/hgz/current/deploy/systemd/hgz.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hgz
systemctl status hgz --no-pager
curl -s http://127.0.0.1:4000/api/health
```

→ `{"status":"ok","env":"production",…,"paymentProvider":"none"}`.
Служба работает от пользователя `hgz`, слушает только `127.0.0.1`, файловая
система для неё только для чтения, кроме `/var/lib/hgz` (см. `deploy/systemd/hgz.service`).

Журнал: `journalctl -u hgz -f`. Ограничить хранение:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=14day\n' | sudo tee /etc/systemd/journald.conf.d/hgz.conf
sudo systemctl restart systemd-journald
```

## 7. Файрвол

```bash
sudo /srv/hgz/current/deploy/scripts/firewall.sh                # SSH отовсюду с ограничением частоты
# или, если у вас статический IP:
sudo /srv/hgz/current/deploy/scripts/firewall.sh 203.0.113.5    # SSH только с него
```

Открыты 80, 443 и SSH; всё остальное закрыто. Порт 4000 наружу не смотрит.
Проверка с **другого** компьютера: `curl -m 3 http://IP:4000/api/health` — не отвечает.

## 8. Домен и HTTPS (Caddy)

1. У регистратора домена: запись `A catalog → IP сервера` (TTL 300).
   Проверка: `dig +short catalog.habez-gips.ru` = IP.
2. Caddy:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo cp /srv/hgz/current/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # заменить домен, если другой
sudo chown -R caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

Сертификат Let's Encrypt выпускается сам за минуту, продлевается сам,
`http://` перенаправляется на `https://`. Проверка:

```bash
curl -sI https://catalog.habez-gips.ru/api/health | grep -iE "^(strict|content-security|x-frame)"
```

и https://www.ssllabs.com/ssltest/ — оценка A/A+.

3. Резолв компании по домену (иначе берётся `DEFAULT_TENANT` — тоже работает):

```bash
sudo -u hgz sqlite3 /var/lib/hgz/hgz.db "UPDATE tenants SET host='catalog.habez-gips.ru' WHERE slug='habez';"
```

## 9. Владелец и менеджеры

Боевой сид учётных записей не создаёт. Владельца заводит **сам владелец**
(пароль печатается один раз — записать и сменить после входа):

```bash
cd /srv/hgz/current/api
sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; npm run create-owner -- director@habez-gips.ru'
```

Затем: сайт → «Вход» → почта и пароль → Панель → Пользователи → себя →
задать новый пароль (12+ символов). Менеджеры регистрируются на сайте по
почте («Создать аккаунт»), владелец в разделе «Пользователи» ставит им роль
`manager`. Если база переносится с демо-стенда (не рекомендуется), сервер
откажется стартовать, пока в ней есть `*@habez.local` с паролями из README.

## 10. Проверка после запуска

```bash
/srv/hgz/current/deploy/scripts/smoke.sh https://catalog.habez-gips.ru
```

Скрипт ничего не создаёт: проверяет здоровье, витрину, каталог, заголовки
безопасности, что демо-пароль, панель без входа, SMS-вход, демо-оплата и
чужой заказ отвергаются. Затем вручную: вход владельца, смена пароля, в
сводке панели — «Уведомления о заказах» → включить на телефоне, тестовый
заказ с чужого телефона → уведомление пришло → заказ в панели → статус →
удалить тестовый заказ.

## 11. Резервные копии

Копия делается каждую ночь в 03:10 (`deploy/scripts/backup.sh`): база
согласованным снимком (`VACUUM INTO`) при работающем сервере, проверка
целостности, загрузки, ключи push, файл окружения — всё одним архивом,
**зашифрованным** ключом владельца, локально (`/var/backups/hgz`, 14
дневных) и в удалённое хранилище (daily 14 / weekly 8 / monthly 12).

Копия только на том же сервере — не копия: отказ диска, удаление VPS или
шифровальщик уничтожат и базу, и её. Поэтому удалённое хранилище — с
версионированием, а ключ на сервере — только на запись: удалить копии с
сервера нельзя даже после взлома.

Настройка:

```bash
# 1. На своём компьютере (не на сервере): ключ шифрования. Приватную часть — распечатать, в сейф.
age-keygen -o hgz-backup-key.txt          # в файле строка "# public key: age1..." — её на сервер

# 2. На сервере: хранилище (rclone config → S3-совместимый, ключ только на запись) и настройки.
sudo rclone config
sudo cp /srv/hgz/current/deploy/backup.env.example /etc/hgz/backup.env
sudo chmod 600 /etc/hgz/backup.env
sudo nano /etc/hgz/backup.env             # HGZ_BACKUP_AGE_RECIPIENT=age1…, HGZ_BACKUP_REMOTE=…, HGZ_BACKUP_PING_URL=…

# 3. Таймеры.
sudo cp /srv/hgz/current/deploy/systemd/hgz-{backup,restore-test,monitor}.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hgz-backup.timer hgz-restore-test.timer hgz-monitor.timer

# 4. Первая копия — руками, и убедиться, что она уехала.
sudo /srv/hgz/current/deploy/scripts/backup.sh daily
sudo rclone ls hgz-s3:hgz-backups/daily
```

Без `HGZ_BACKUP_AGE_RECIPIENT` копия не делается вовсе: незашифрованные
архивы с телефонами покупателей нигде лежать не должны. Ручная копия перед
любым обновлением: `sudo deploy/scripts/backup.sh manual` (её `deploy.sh`
делает сам). Третья линия — копия с компьютера владельца (`scripts/backup-db.sh`
в iCloud) остаётся.

## 12. Проверка восстановления

Непроверенной копии не существует. Раз в месяц `hgz-restore-test.timer`
(или руками) берёт последнюю копию, расшифровывает, проверяет базу,
поднимает на ней отдельный экземпляр API на порту 4001 и убеждается, что он
отвечает и видит товары; боевую базу не трогает.

```bash
sudo HGZ_RESTORE_IDENTITY=/root/.config/hgz/age-identity.txt /srv/hgz/current/deploy/scripts/restore-test.sh
```

Приватный ключ для этого нужен там, где выполняется тест. Варианты: держать
его на сервере в `/root/.config/hgz/` (0600) — удобно, но тогда взлом root
раскрывает копии; или запускать тест с компьютера владельца, скачав копию
(`rclone copy … && HGZ_APP_DIR=~/Desktop/HGZ_pro deploy/scripts/restore-test.sh файл`).
Для завода разумен второй вариант.

## 13. Восстановление

Общее правило: **сначала копию проверить, потом подменять**.

```bash
age -d -i ключ.txt -o /tmp/r.tar hgz-2026-09-14_03-10.tar.age && mkdir -p /tmp/r && tar -C /tmp/r -xf /tmp/r.tar
sqlite3 /tmp/r/hgz.db "PRAGMA integrity_check; SELECT COUNT(*), MAX(created_at) FROM orders;"
```

**A. Сервер потерян.** Новый VPS → шаги 1–4 и 6–8 этой инструкции → DNS на
новый IP → положить из копии `hgz.db`, `vapid.json`, `uploads/` в
`/var/lib/hgz` (владелец `hgz`, база `0640`), `hgz.env` в `/etc/hgz/` →
`npm run migrate` → `systemctl start hgz` → `smoke.sh` → настроить копии
заново (шаг 11). Потеря — не больше суток.

**B. База повреждена.** `systemctl stop hgz` → `sqlite3 hgz.db "PRAGMA integrity_check"`
→ попробовать `sqlite3 hgz.db ".recover" | sqlite3 hgz-recovered.db` → сравнить с
последней копией по числу и дате заказов, взять то, что целое и новее →
повреждённый файл **переименовать** (`hgz.db.broken-дата`, вместе с `-wal/-shm`),
не удалять → положить восстановленный, `chown hgz:hgz`, `chmod 640` → `start`.

**C. Случайно удалены заказы.** Не откатывать всю базу — за это время появились
новые. `stop` → ручная копия текущей (`backup.sh manual`) → развернуть
копию до удаления во временный файл → вернуть только недостающие строки:

```sql
ATTACH '/tmp/r/hgz.db' AS old;
INSERT INTO orders      SELECT * FROM old.orders      WHERE id NOT IN (SELECT id FROM main.orders);
INSERT INTO order_items SELECT * FROM old.order_items WHERE order_id NOT IN (SELECT id FROM main.order_items) AND order_id IN (SELECT id FROM main.orders);
INSERT INTO order_events SELECT * FROM old.order_events WHERE id NOT IN (SELECT id FROM main.order_events);
INSERT INTO payments    SELECT * FROM old.payments    WHERE id NOT IN (SELECT id FROM main.payments);
```

→ `start` → проверить в панели.

**D. Откат на вчерашний день целиком.** `stop` → `backup.sh manual` (вдруг
передумаем) → вчерашняя daily-копия на место базы (`-wal/-shm` удалить),
`uploads/` — тоже из копии → `migrate` → `start` → сегодняшние заказы
вернуть из `manual`-копии через `ATTACH`, как в C.

## 14. Мониторинг

`hgz-monitor.timer` раз в 5 минут (`deploy/scripts/monitor.sh`): служба
активна, число перезапусков, диск > 80 %, память процесса, load, база
открывается (`quick_check`), размер WAL, права на базу, свежесть копии
(< 26 ч), `/api/health`, срок сертификата, ошибки в журнале за час. Тревоги —
в `journalctl -t hgz-monitor` и в команду `HGZ_ALERT_CMD` из
`/etc/hgz/backup.env` (например, `mail -s "Habez Gips" admin@…` через
`msmtp`). Снаружи — бесплатная проверка `https://…/api/health` раз в 5 минут
(UptimeRobot или аналог; регистрирует владелец), она же предупредит о
сертификате.

## 15. Обновление

```bash
sudo HGZ_PUBLIC_URL=https://catalog.habez-gips.ru /srv/hgz/current/deploy/scripts/deploy.sh v1.0.1
```

Скрипт: ручная копия базы → клон тега в новый каталог релиза → `npm ci` и
сборка витрины **при работающей службе** → если есть непримененные
миграции — остановка службы и `migrate` → переключение симлинка `current` →
`systemctl restart hgz` (простой 1–2 с) → `/api/health` → `smoke.sh`.
Если что-то не так — откат сам. Хранятся три последних релиза. Миграции
идемпотентны и только добавляют колонки/таблицы: старый код с новой базой
работает, откат кода безопасен.

## 16. Откат

```bash
sudo /srv/hgz/current/deploy/scripts/deploy.sh --rollback
```

Возвращает предыдущий релиз (симлинк + перезапуск, секунды; сеть и сборка
не нужны). База не трогается. Если обновление сопровождалось разрушающей
миграцией (у нас таких нет) — `stop` → положить `manual`-копию, снятую
`deploy.sh` перед обновлением → `start`; заказы за прошедшее время вернуть
через `ATTACH` (раздел 13C).

---

## Переход на PostgreSQL

Не нужен для текущего масштаба (один процесс, десятки записей в день). Понадобится,
когда установка перерастёт один сервер. Меняется один слой:

1. `api/src/db/index.js` — драйвер `pg` с тем же интерфейсом `all / get / run / insert / update / tx`.
2. `schema.sql` — типы: `INTEGER PRIMARY KEY` → `BIGSERIAL`, `datetime('now')` → `now()`.
3. Поиск: FTS5 → `tsvector` (`services/catalog.js`, `ftsQuery`).
4. `json_each` в фильтре по задачам → оператор `?` для `jsonb`.

## Вторая компания в той же установке

```bash
cd /srv/hgz/current/api
sudo -u hgz bash -c 'set -a; . /etc/hgz/hgz.env; set +a; node --input-type=module -e "
const { insert } = await import(\"./src/db/index.js\");
insert(\"tenants\", { slug: \"dealer-stroybaza\", host: \"catalog.stroybaza.ru\", name: \"СтройБаза\",
  theme: JSON.stringify({ accent: \"#2f6b3d\" }), settings: JSON.stringify({ currency: \"RUB\", showPrices: false, orderPrefix: \"СБ\" }) });
console.log(\"готово\");"'
```

Затем домен на тот же сервер и вторая строка `catalog.stroybaza.ru { … }` в Caddyfile.

## Docker (запасной вариант)

`docker-compose.yml` и `api/Dockerfile` остаются рабочими: `HOST=0.0.0.0`
внутри контейнера, порт опубликован только на `127.0.0.1` хоста,
`TRUST_PROXY` — подсети Docker. Для одного сервера обычная служба проще:
меньше слоёв между базой и копиями.
