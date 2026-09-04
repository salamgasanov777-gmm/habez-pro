# Развёртывание

Инструкция рассчитана на человека, который не работает с серверами каждый день.
Команды выполняются по порядку; после каждого блока написано, как проверить,
что всё получилось.

---

## Что понадобится

| Что | Зачем | Кто оформляет | Порядок цен |
|---|---|---|---|
| Домен | адрес сайта | завод, на юрлицо | 200–1500 ₽ в год |
| VPS, 2 ГБ памяти | сервер | завод | 300–600 ₽ в месяц |
| SSL-сертификат | замок в браузере | выпускается бесплатно | 0 ₽ |
| ЮKassa | приём оплаты | завод, договор и проверка | комиссия 2,8–3,5 % |
| SMS-агрегатор | коды для входа | завод, договор | 3–5 ₽ за SMS |

Пока договоров нет, система работает: оплата в демо-режиме, коды входа —
в журнале сервера. Каталог, заявки и панель управления при этом полноценные.

---

## Вариант 1. Один сервер, без Docker

**1. Установить Node.js 22**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

**2. Положить код и собрать**

```bash
sudo mkdir -p /srv/hgz && sudo chown $USER /srv/hgz
cd /srv/hgz
# скопировать сюда содержимое папки HGZ_pro (git clone или rsync)
cd api && npm ci --omit=dev && cd ../web && npm ci && npm run build
```

`web/dist` собран — API отдаёт витрину сам, отдельный веб-сервер для неё не нужен.

**3. Настроить окружение**

```bash
cd /srv/hgz/api
cp .env.example .env
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"   # секрет для JWT
nano .env
```

Обязательно заполнить:

```
NODE_ENV=production
PUBLIC_URL=https://catalog.habez.ru
WEB_URL=https://catalog.habez.ru
CORS_ORIGINS=https://catalog.habez.ru
JWT_SECRET=<строка из команды выше>
COOKIE_SECURE=true
```

**4. Создать базу и перенести каталог**

```bash
npm run migrate && npm run seed
```

Без `--demo-prices`: настоящих цен у нас нет, товары получат «цена по запросу».

**5. Сменить пароль администратора**

Сразу после первого входа в панели: Пользователи → администратор → задать пароль.
Пароли из README действуют только на демо-стенде.

**6. Запустить как службу**

```bash
sudo tee /etc/systemd/system/hgz.service > /dev/null <<'UNIT'
[Unit]
Description=HGZ Pro API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/hgz/api
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

sudo chown -R www-data:www-data /srv/hgz
sudo systemctl enable --now hgz
systemctl status hgz
```

**7. Домен и HTTPS**

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/hgz > /dev/null <<'CONF'
server {
  server_name catalog.habez.ru;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
CONF
sudo ln -sf /etc/nginx/sites-available/hgz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d catalog.habez.ru
```

Проверка: `curl https://catalog.habez.ru/api/health` → `{"status":"ok",...}`.

---

## Вариант 2. Docker

```bash
cd /srv/hgz
cp api/.env.example .env && nano .env      # те же обязательные поля
docker compose up -d --build
docker compose exec api npm run migrate
docker compose exec api npm run seed
```

База лежит в томе `hgz-data`, загруженные файлы — в `hgz-uploads`.

---

## Подключение оплаты (ЮKassa)

1. Завод заключает договор и проходит проверку в ЮKassa.
2. В личном кабинете ЮKassa: **Интеграция → Ключи API** — идентификатор магазина
   и секретный ключ.
3. В `.env`:
   ```
   PAYMENT_PROVIDER=yookassa
   YOOKASSA_SHOP_ID=xxxxxx
   YOOKASSA_SECRET_KEY=live_xxxxxxxxxxxx
   YOOKASSA_VAT_CODE=1
   ```
   `YOOKASSA_VAT_CODE` — ставка НДС для чека: 1 — без НДС, 2 — 0 %, 3 — 10 %,
   4 — 20 %. Значение подскажет бухгалтерия завода; от него зависит правильность
   чека по 54-ФЗ.
4. Там же, в разделе HTTP-уведомлений, указать адрес:
   `https://catalog.habez.ru/api/payments/webhook/yookassa`
   и включить события `payment.succeeded` и `payment.canceled`.
5. `sudo systemctl restart hgz`.

Уведомления ЮKassa не подписаны, поэтому телу запроса система не верит: получив
уведомление, она сама перезапрашивает платёж по его идентификатору и меняет
статус заказа только после ответа ЮKassa. Подделать «оплату» подставным запросом
на вебхук нельзя.

---

## Подключение SMS

В `api/src/lib/notify.js` функция `sendSms` — единственное место, которое нужно
дописать под выбранного агрегатора (SMS.ru, Devino, МТС Exolve). После этого
`SMS_PROVIDER=<имя>` в `.env`. Пока стоит `log`, коды пишутся в журнал сервера
(`journalctl -u hgz -f`) — этого хватает для приёмки, но не для клиентов.

## Уведомления менеджерам в Telegram

Быстрый способ получать заказы и заявки без почты:

1. Создать бота у `@BotFather`, получить токен.
2. Создать группу «Заказы ХГЗ», добавить туда бота, узнать `chat_id`.
3. В `.env`: `TELEGRAM_BOT_TOKEN=...`, `TELEGRAM_CHAT_ID=...`, перезапустить службу.

---

## Резервные копии

Вся база — один файл. Ежедневная копия в 3 часа ночи:

```bash
sudo tee /etc/cron.daily/hgz-backup > /dev/null <<'SH'
#!/bin/sh
DEST=/var/backups/hgz
mkdir -p $DEST
sqlite3 /srv/hgz/api/var/hgz.db ".backup '$DEST/hgz-$(date +%F).db'"
tar czf $DEST/uploads-$(date +%F).tgz -C /srv/hgz/api/var uploads
find $DEST -mtime +30 -delete
SH
sudo chmod +x /etc/cron.daily/hgz-backup
```

Копии должны уезжать с сервера — на другой диск или в облако. Резервная копия,
лежащая на том же сервере, не спасает от потери сервера.

**Проверка восстановления** — раз в квартал: скопировать файл базы на тестовый
стенд, запустить, открыть каталог. Непроверенной копии не существует.

---

## Обновление

```bash
cd /srv/hgz && git pull
cd api && npm ci --omit=dev && npm run migrate
cd ../web && npm ci && npm run build
sudo systemctl restart hgz
```

Миграции идемпотентны: повторный запуск ничего не ломает.

---

## Переход на PostgreSQL

Нужен, когда установка перерастает один сервер или появляется потребность в
репликации. Меняется один слой:

1. `api/src/db/index.js` — вместо `node:sqlite` драйвер `pg` с тем же
   интерфейсом `all / get / run / insert / update / tx`.
2. `schema.sql` — типы: `INTEGER PRIMARY KEY` → `BIGSERIAL PRIMARY KEY`,
   `TEXT DEFAULT (datetime('now'))` → `TIMESTAMPTZ DEFAULT now()`.
3. Поиск: FTS5 → `tsvector` с индексом GIN (`services/catalog.js`, функция `ftsQuery`).
4. `json_each` в фильтре по задачам → оператор `?` для `jsonb`.

Маршруты и интерфейс не затрагиваются: SQL нигде не размазан по компонентам.

---

## Вторая компания в той же установке

```bash
cd /srv/hgz/api
node -e "
import('./src/db/index.js').then(({insert}) => {
  insert('tenants', {
    slug: 'dealer-stroybaza',
    host: 'catalog.stroybaza.ru',
    name: 'СтройБаза',
    theme: JSON.stringify({ accent: '#2f6b3d' }),
    settings: JSON.stringify({ currency: 'RUB', showPrices: false, orderPrefix: 'СБ' })
  });
  console.log('готово');
});"
```

Дальше — направить домен на тот же сервер и выпустить сертификат
(`sudo certbot --nginx -d catalog.stroybaza.ru`). Резолв идёт по домену:
клиенты, заказы и цены разных компаний друг друга не видят.
