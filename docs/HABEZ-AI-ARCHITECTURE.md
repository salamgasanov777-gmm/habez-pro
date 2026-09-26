# Habez AI Agent — аудит и архитектурный план

Составлен 24 сентября 2026 по состоянию `main` = `5b49b18`; в тот же день
дополнен разделами 14-bis и 14-ter по итогам фаз 1 и 2 (слой знаний и
характеристики товаров написаны; разделы 1–14 оставлены как были — это
замысел, 14-bis и 14-ter описывают сделанное).
Это рабочий документ проекта: на его основе ведётся поэтапная разработка.

Каждый вывод о существующем проекте сопровождается ссылкой на файл, таблицу
или маршрут. Где чего-то нет — написано «**Не обнаружено**».

---

## 1. Executive Summary

Habez Pro — работающий каталог с заказами и панелью управления: Fastify 5 +
SQLite + React, 6 786 строк кода, 78 тестов, зелёный CI, готовая схема
развёртывания. Это хороший фундамент: мультитенантность, роли, журнал
изменений, полнотекстовый поиск, сравнение товаров, выгрузка в CSV, push —
всё это переиспользуется для Habez AI без переделок.

Ключевой вывод аудита: **данных о собственной продукции достаточно для
первого этапа AI, данных о рынке нет вообще**. В базе 56 товаров с
характеристиками, но 0 строк об остатках, 0 о себестоимости, 0 о регионах,
0 о дилерах как о субъектах, 1 заказ. Структур для конкурентов, рынка,
источников информации **не обнаружено ни одной**. Значит, Habez AI — это на
80 % не «подключить LLM», а построить базу знаний о рынке и механизм
проверки достоверности; чат — верхушка.

Предлагаемая архитектура: **Habez AI как отдельный модуль внутри того же
приложения** (`api/src/ai/*`, `web/src/ai/*`, таблицы с префиксом `ai_`),
без отдельного сервиса и без новой базы. LLM — через OpenRouter
(по правилу из `~/.claude/CLAUDE.md`), tool calling по собственным данным,
полнотекстовый поиск вместо векторного на старте. В центре — таблица
`ai_facts` с источником, датой, статусом проверки и уровнем доверия:
**AI не имеет права утверждать то, что не привязано к факту с источником**.

Сроки: MVP (база знаний + продукты + конкуренты + чат) — Фазы 1–5.
Автоматический мониторинг (Фаза 7) требует сервера из этапа 1B: на
компьютере владельца ежедневные задания не живут.

---

## 2. Текущая архитектура Habez Pro

### 2.1 Репозиторий

| Слой | Где | Чем |
|---|---|---|
| Сервер | `api/src/` (3 475 строк) | Fastify 5, ESM, Node ≥ 22.5 (`api/package.json`) |
| Витрина и панель | `web/src/` (3 311 строк) | React 18, react-router 7, Vite 6, без менеджера состояния |
| База | `api/src/db/schema.sql` | SQLite через встроенный `node:sqlite` (`api/src/db/index.js`) |
| Развёртывание | `deploy/`, `DEPLOY.md` | systemd, Caddy, скрипты копий и мониторинга |
| CI | `.github/workflows/ci.yml` | Node 22, `npm ci`, audit, 78 тестов, обе сборки, `bash -n` |
| Документация | `README.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/CHANGES.md`, `docs/AUDIT-2026-09-15.md`, `docs/STAGE1B-PLAN.md` | 1 861 строка |

Зависимостей минимум: сервер — 8 пакетов (`fastify`, `@fastify/*`, `zod`,
`web-push`), витрина — 4 (`react`, `react-dom`, `react-router-dom`,
`qrcode-generator`). Криптография — стандартная библиотека Node
(`api/src/lib/crypto.js`): scrypt, HMAC-JWT, ничего внешнего.

### 2.2 Сервер

- `api/src/server.js` — сборка приложения: CORS по списку, cookie, multipart
  (10 МБ), rate-limit 300 запросов в минуту на `ip:tenant`, заголовки
  безопасности хуком `onSend`, единый обработчик ошибок, раздача
  `/uploads/` и собранной витрины, `setNotFoundHandler` (API → JSON,
  витрина → `index.html`).
- Плагины: `plugins/tenant.js` — резолв компании по домену → заголовку →
  умолчанию; `plugins/auth.js` — Bearer-JWT, `requireAuth(minRole)`;
  `plugins/fp.js` — мини-замена `fastify-plugin`.
- Маршруты (`api/src/routes/`): `catalog`, `cart`, `orders`, `payments`,
  `leads`, `auth`, `account`, `push`, `health`, `admin` (398 строк — самый
  большой файл).
- Сервисы (`api/src/services/`): `catalog.js` (сборка карточек, `decorate`,
  `reindexProduct`), `pricing.js` (уровни цен и объёмные пороги),
  `orders.js` (статусы, `orderView`), `cart.js`.
- Библиотеки (`api/src/lib/`): `crypto`, `notify` (push + Telegram,
  маскирование ПД), `push` (VAPID), `money`, `errors`, `demo-users`.

### 2.3 Данные

Схема — `api/src/db/schema.sql`, 25 таблиц + FTS5. Все бизнес-таблицы несут
`tenant_id`. Миграции — список шагов в `api/src/db/migrate.js` (4 шага,
идемпотентные, `--check` для `deploy.sh`, `--fresh` запрещён в production).

Фактическое наполнение рабочей базы (`api/var/hgz.db`, локальный стенд):

| Таблица | Строк | Комментарий |
|---|---|---|
| `products` | 56 | 49 с ГОСТ, 56 со `spec_tables`, 33 с калькулятором, **2 с артикулом**, **0 с заполненным `attributes`** |
| `variants` | 61 | фасовки |
| `prices` | 61 | только `tier='retail'`, **29 с суммой**, остальные «по запросу»; дилерских цен в боевых данных нет |
| `media` | 56 | **только `kind='photo'`**; документов и сертификатов нет |
| `categories` | 14 | от гипсовой штукатурки до профилей |
| `stock` | **0** | остатков нет |
| `orders` / `order_items` | 1 / 1 | тестовый |
| `leads` | 0 | |
| `search_log` | 4 | запросы посетителей, в том числе без результата |
| `audit_log` | 0 | на боевом сервере будет заполняться |

### 2.4 Аутентификация и роли

`api/src/plugins/auth.js`: линейный порядок ролей
`customer(1) → dealer(2) → manager(3) → admin(4) → owner(5)`.
Access-токен 15 минут в памяти вкладки, refresh в httpOnly-cookie, в базе —
хеш (`docs/SECURITY.md`). Вся панель закрыта одним хуком
(`api/src/routes/admin.js:31`), отдельные маршруты поднимают планку до
`admin`. Владельца не может изменить администратор.

### 2.5 Витрина и панель

- Витрина: `web/src/pages/` — `Catalog`, `Product`, `Cart`, `Checkout`,
  `Compare`, `Favorites`, `Account`, `Login`, `Privacy`, `LegalDoc`.
- Панель: `web/src/admin/` — `Dashboard`, `ProductsAdmin`, `ProductEditor`,
  `OrdersAdmin`, `LeadsAdmin`, `UsersAdmin`, `SettingsAdmin`, `AuditAdmin`,
  `PushCard`; навигация — массив `NAV` в `web/src/admin/AdminApp.jsx:13`,
  пункты с `admin: true` скрыты от менеджера.
- Панель загружается отдельным чанком (`AdminApp-*.js`, 42 КБ) — витрина
  не тяжелеет.
- Общее состояние — `web/src/store.jsx` (контекст, без Redux).
- Единственная точка обращения к данным — `web/src/lib/api.js`: тихое
  обновление токена при 401, режим `STANDALONE` для GitHub Pages.

### 2.6 Фоновые задачи, интеграции, конфигурация

- **Фоновых задач внутри приложения не обнаружено**: ни `setInterval`, ни
  очередей, ни планировщика. Всё периодическое — systemd-таймеры в
  `deploy/systemd/` (копии 03:10, мониторинг каждые 5 минут).
- Исходящие запросы всего в трёх местах: Telegram (`api/src/lib/notify.js:10`),
  ЮKassa (`api/src/payments/yookassa.js:15`), демо-вебхук
  (`api/src/routes/payments.js:129`). HTTP-клиента нет — используется
  встроенный `fetch`.
- Конфигурация — 32 переменные, все читаются в одном месте
  (`api/src/config.js`), в production жёсткие проверки (нет `JWT_SECRET`,
  относительные пути, `mock`-оплата, демо-учётки → сервер не стартует).
- Интеграции: push (VAPID, `api/src/lib/push.js`), Telegram (выключен),
  ЮKassa (выключена, `PAYMENT_PROVIDER=none`), SMS (`log`), 1С — **не обнаружено**.

---

## 3. Что уже готово и пригодится AI

| Готовое | Где | Как использует AI |
|---|---|---|
| Мультитенантность | `plugins/tenant.js`, `tenant_id` во всех таблицах | все AI-таблицы получают `tenant_id` по тому же правилу |
| Роли с порядком | `plugins/auth.js` (`RANK`) | разграничение доступа к себестоимости и марже без новой системы прав |
| Журнал изменений | `audit_log`, функция `audit()` в `routes/admin.js:17` | готовый образец неизменяемой истории для `ai_fact_history` |
| Полнотекстовый поиск | `products_fts` (FTS5, unicode61), `services/catalog.js:128` | поиск по своим товарам как инструмент агента — **без векторной базы** |
| Сравнение товаров | `GET /api/catalog/compare`, `pages/Compare.jsx` | тот же механизм — сравнение «наш товар ↔ товар конкурента» |
| Уровни цен | `services/pricing.js` (`retail/dealer/vip`, `min_qty`) | основа для РРЦ и анализа ценовой лестницы |
| Карточка товара | `products.badges/spec_tables/sections/tasks/calc` | готовый структурированный источник характеристик для AI |
| Выгрузка CSV | `GET /api/admin/export/prices.csv` | образец выгрузки отчётов AI в Excel |
| Push-уведомления | `lib/push.js`, `push_subscriptions` | канал доставки тревог (alerts) на телефон менеджера |
| Журнал поиска | `search_log`, «чего не нашли» в сводке (`routes/admin.js:60`) | первый настоящий рыночный сигнал: спрос, которого нет в каталоге |
| Панель со сводкой | `admin/Dashboard.jsx`, `GET /api/admin/stats` | образец и место для виджетов AI |
| Валидация Zod | во всех маршрутах | проверка структурированного ответа LLM теми же схемами |
| Транзакции | `tx()` с `BEGIN IMMEDIATE` (`db/index.js:70`) | безопасная запись пачек фактов |
| systemd-таймеры | `deploy/systemd/*.timer` | тот же механизм для ежедневного мониторинга |
| Тесты и CI | `api/test/*` (78), `.github/workflows/ci.yml` | новые модули проверяются тем же способом |

---

## 4. Что можно переиспользовать напрямую

**Таблицы:** `tenants`, `users`, `categories`, `products`, `variants`,
`prices`, `media`, `stock`, `orders`, `order_items`, `leads`, `search_log`,
`audit_log`. Ничего из них менять не нужно — AI читает.

**API:** `/api/catalog/*` (каталог, карточка, сравнение, расчёт),
`/api/admin/stats`, `/api/admin/products`, `/api/admin/orders`,
`/api/admin/leads`, `/api/admin/export/prices.csv`, `/api/auth/*`.

**Frontend:** `web/src/lib/api.js` (клиент с обновлением токена),
`store.jsx`, `components/Modal.jsx`, `Icons.jsx`, `ProductCard.jsx`,
`ProductLink.jsx`, стили `styles/app.css`, разметка панели
(`admin/AdminApp.jsx`) — новый раздел добавляется одним пунктом в `NAV`.

**Серверные образцы:** `requireAuth`, `audit()`, обработчик ошибок,
`tx()`, схема миграций, маскирование ПД в журнале (`lib/notify.js`).

---

## 5. Чего нет (проверено, не предполагается)

### 5.1 Продукты
- `sku` заполнен **у 2 товаров из 56** — артикульной системы фактически нет.
- `attributes` (нормализованные поля для фильтров) — **пусто у всех 56**:
  характеристики лежат только в свободных `badges`/`spec_tables`, машинного
  сравнения «прочность 2 МПа ↔ 2,5 МПа» на них не построить без разбора текста.
- `media.kind` — только `photo`. **Документы, сертификаты, инструкции,
  паспорта качества — не обнаружено.**
- Себестоимость — **не обнаружено** (ни таблицы, ни поля).
- РРЦ — **не обнаружено** (есть `retail/dealer/vip`, но это не РРЦ).

### 5.2 Производство
- Завод как сущность — **не обнаружено** (есть только реквизиты компании
  в `tenants`: `legal_name`, `inn`, `settings.ogrn`, `settings.director`).
- Производственные мощности, линии, ограничения по фасовкам, план/факт
  выпуска — **не обнаружено**.

### 5.3 Продажи
- Клиенты — есть `users` (3 строки) и `orders` (1), истории продаж нет.
- Дилеры как субъекты — **не обнаружено**: `dealer` есть только как роль
  пользователя и уровень цены; ни адреса, ни региона, ни договора, ни
  объёмов.
- Регионы — **не обнаружено ни одной таблицы или поля** (кроме свободного
  `orders.delivery_address`).
- Скидки — только `promo_codes` (1 тестовая строка).
- Остатки — таблица `stock` есть, **строк 0**.
- История продаж и отгрузок — **не обнаружено**, обмена с 1С нет.

### 5.4 Маркетинг
- Акции, кампании, промо-материалы, новости — **не обнаружено** (кроме
  `promo_codes`).

### 5.5 Конкуренты и рынок
**Не обнаружено ничего:** ни производителей, ни заводов, ни брендов, ни
конкурентных продуктов, ни их цен, ни дилеров, ни регионов, ни источников,
ни рыночных наблюдений. Поиск по всему коду и схеме
(`competitor|конкурент|market|рынок|бренд`) даёт только совпадения в словах
вроде `marketplace` в комментариях — предметных структур нет.

### 5.6 AI
- Ни модуля, ни таблиц, ни ключей, ни зависимостей — **не обнаружено**.
- Векторного поиска, эмбеддингов, RAG — **не обнаружено**.
- Планировщика задач внутри приложения — **не обнаружено**.

---

## 6. Предлагаемая архитектура Habez AI

### 6.1 Принцип: модуль, а не отдельный сервис

```
Habez Pro (один процесс Node, одна база SQLite)
├── api/src/routes/…            существующее, не трогаем
├── api/src/ai/
│   ├── routes/                 /api/ai/* — чат, наблюдения, рекомендации
│   ├── agents/                 промпты + наборы инструментов (данные, не процессы)
│   ├── tools/                  функции доступа к данным (только наши, только SQL)
│   ├── llm/                    клиент OpenRouter, стриминг, учёт стоимости
│   ├── knowledge/              факты, источники, проверка, история
│   ├── ingest/                 сбор, нормализация, сравнение с текущим
│   └── jobs/                   очередь задач (таблица) + воркер под systemd
└── web/src/ai/                 раздел «Habez AI» в панели
```

Почему не отдельный сервис: одна машина (2 ГБ), одна база, один деплой,
одна система резервных копий и мониторинга — всё это уже настроено этапом 1.
Отдельный сервис добавил бы сеть, вторую очередь и вторую точку отказа,
не дав ничего, что нужно заводу сегодня.

### 6.2 Граница с работающим функционалом

1. AI читает существующие таблицы, **никогда не пишет в них**. Всё, что
   создаёт AI, живёт в таблицах `ai_*`.
2. Маршруты AI — отдельный префикс `/api/ai/*`, регистрируется как ещё один
   плагин в `server.js`; при выключенном флаге `AI_ENABLED` не регистрируется
   вовсе (как `payments` при `PAYMENT_PROVIDER=none`).
3. Новый раздел в панели — один пункт в `NAV` (`admin/AdminApp.jsx`),
   загружается отдельным чанком. Витрина не меняется ни на байт.
4. Тяжёлые задачи (мониторинг, разбор страниц) — **не** в веб-процессе:
   отдельный воркер `node src/ai/jobs/worker.js`, запускаемый таймером
   systemd, как `backup.sh`. Иначе один долгий запрос к LLM подвесит каталог.
5. Отдельный лимит запросов на `/api/ai/*` (чат дорогой) и отдельный
   дневной бюджет в настройках.

### 6.3 Поток данных

```
Источники (сайты производителей, прайсы, дилеры, ручной ввод, наши данные)
   ↓  ingest/fetch      только публичные страницы, robots.txt, лимит частоты
Снимок (raw HTML/PDF на диск + хеш в ai_source_snapshots)
   ↓  ingest/parse      парсер под каждый источник + LLM-извлечение с JSON-схемой
Кандидаты фактов (значение, единица, ссылка на снимок)
   ↓  knowledge/diff    сравнение с текущими фактами
Изменения (цена выросла, появился товар, исчезла фасовка)
   ↓  Fact Checker      правила + LLM-проверка + порог доверия
ai_facts (+ ai_fact_history)   ← единственный источник правды для AI
   ↓
ai_market_observations → ai_alerts → push менеджеру
   ↓
Агенты (чат, аналитика) → ответ ТОЛЬКО со ссылками на ai_facts
   ↓
ai_recommendations → подтверждение человеком → ai_decisions
```

---

## 7. Предлагаемая структура базы знаний

Все таблицы — SQLite, те же правила, что в `schema.sql`: `tenant_id`,
целые числа для денег (копейки), даты строкой, JSON в `TEXT`.
Префиксы: `ai_` — всё, что относится к знаниям и агентам.

### 7.1 Источники и достоверность (ядро)

**`ai_sources`** — откуда вообще берутся сведения
`id · tenant_id · kind · name · url · domain · owner_company_id · trust_base (0–100) · robots_allowed · terms_note · status · created_at · last_checked_at`
`kind`: `habez_internal` · `habez_official` · `manufacturer_official` ·
`dealer_official` · `marketplace` · `price_list` · `news_media` ·
`manual_research` · `ai_inference` — ровно те семь уровней из задания
(+ разделение дилер/маркетплейс).

**`ai_source_snapshots`** — что именно мы видели и когда
`id · source_id · url · fetched_at · http_status · content_hash · storage_path · content_type · parser · parser_version · bytes`
Сырые файлы — на диск в `/var/lib/hgz/ai/snapshots/ГГГГ/ММ/<hash>`, в базе
только путь и хеш: база остаётся маленькой, снимок доказывает происхождение.

**`ai_facts`** — центральная таблица; **всё, что знает AI, лежит здесь**
`id · tenant_id · subject_type · subject_id · attribute · value_text ·
value_num · value_unit · value_json · currency · region_id ·
observed_at · valid_from · valid_to · source_id · snapshot_id ·
origin (habez|official|dealer|external|monitoring|ai_inference|assumption) ·
status (unverified|verified|disputed|outdated|rejected) ·
confidence (0–100) · verified_by_user_id · verified_at · verify_note ·
recheck_after · supersedes_fact_id · created_by (user|agent) · created_at`
`subject_type`: `product` · `variant` · `competitor_product` · `company` ·
`region` · `market`.

**`ai_fact_history`** — неизменяемая история (как `audit_log`)
`id · fact_id · change_kind (created|value_changed|status_changed|verified|rejected|superseded) ·
old_value · new_value · old_status · new_status · actor (user_id|agent) ·
source_id · created_at`

**`ai_fact_conflicts`** — два источника спорят
`id · fact_a_id · fact_b_id · kind · resolution (pending|a|b|both_wrong|manual) · resolved_by · note`

### 7.2 Конкуренты и рынок

**`ai_companies`** — одна таблица на всех: заводы, производители, дилеры, сети
`id · tenant_id · kind (manufacturer|plant|dealer|distributor|retail_chain|marketplace) ·
is_self (1 для Хабезского завода) · name · legal_name · inn · website ·
hq_region_id · size_hint · status · notes · created_at`

**`ai_brands`** — `id · company_id · name · notes`

**`ai_competitor_products`**
`id · tenant_id · company_id · brand_id · our_category_id → categories.id ·
our_analog_product_id → products.id · name · sku · gost · segment (эконом|стандарт|премиум) ·
status (active|discontinued|unknown) · first_seen_at · last_seen_at`

**`ai_competitor_packs`** — фасовки конкурента
`id · competitor_product_id · pack_size · pack_unit · weight_kg · barcode`

**`ai_product_specs`** — нормализованные характеристики, **и наши, и чужие**
`id · tenant_id · subject_type (product|competitor_product) · subject_id ·
attribute_key (strength_mpa, setting_time_min, consumption_kg_m2, …) ·
value_num · value_text · unit · fact_id`
Это же решает дыру из §5.1: сюда переносятся характеристики наших товаров
из `badges`/`spec_tables` — без изменения самих товаров.

**`ai_regions`** — `id · name · kind (district|region|city) · parent_id · code`

**`ai_company_regions`** — присутствие: `company_id · region_id · role (sells|produces|delivers) · fact_id`

**`ai_price_observations`** — наблюдения цен (и конкурентов, и наши)
`id · tenant_id · subject_type · subject_id · seller_company_id · region_id ·
price_kind (retail|dealer|rrp|promo|marketplace) · amount · currency ·
qty_basis · pack_note · observed_at · source_id · snapshot_id · url · fact_id`

**`ai_market_observations`** — событие рынка
`id · tenant_id · kind (price_change|new_product|product_gone|new_dealer|promo|assortment_change|new_plant|regional_change|news) ·
title · summary · severity (info|notable|important) · subject_type · subject_id ·
company_id · region_id · detected_at · source_id · fact_ids (JSON) ·
status (new|reviewed|archived|false_positive) · reviewed_by · reviewed_at`

**`ai_dealer_candidates`** — потенциальные дилеры
`id · tenant_id · company_id · region_id · score · rationale · evidence_fact_ids ·
status (new|contacted|negotiating|signed|rejected) · linked_user_id → users.id · created_at`

### 7.3 Внутренние данные Habez, которых пока нет

**`ai_product_costs`** — себестоимость (**конфиденциально**)
`id · tenant_id · variant_id → variants.id · cost_amount · currency ·
period_from · period_to · source (1c|manual|estimate) · entered_by · note · created_at`

**`ai_price_policies`** — РРЦ и правила
`id · tenant_id · variant_id · region_id · rrp_amount · min_dealer_amount ·
valid_from · valid_to · approved_by · note`

**`ai_sales_facts`** — история продаж (агрегаты, из 1С или из отчётов)
`id · tenant_id · period_month · product_id · variant_id · region_id ·
dealer_company_id · qty · amount · source (1c|manual|orders) · loaded_at`
Пока 1С нет — наполняется из `orders`/`order_items` и ручных выгрузок.

**`ai_promotions`** — акции (наши и конкурентов: `company_id` = `is_self` или чужая)
`id · tenant_id · company_id · title · kind (discount|bundle|gift|bonus) ·
value · scope_json (товары/категории) · region_id · starts_at · ends_at ·
source_id · status`

**`ai_decisions`** — история решений завода
`id · tenant_id · topic · decision · rationale · made_by · made_at ·
linked_recommendation_id · outcome_note`

### 7.4 Агенты, диалоги, рекомендации

**`ai_conversations`** — `id · tenant_id · user_id · title · created_at · archived_at`
**`ai_messages`** — `id · conversation_id · role (user|assistant|tool|system) · content ·
tool_name · tool_args · tool_result_ref · model · tokens_in · tokens_out ·
cost_micro · latency_ms · created_at`
**`ai_citations`** — `id · message_id · fact_id · source_id · snippet` —
каждое утверждение ответа привязано к факту; без этого ответ считается мнением.
**`ai_runs`** — запуск агента: `id · tenant_id · agent · trigger (chat|job|schedule) ·
input_json · status · started_at · finished_at · cost_micro · error`
**`ai_jobs`** — очередь (воркер забирает `BEGIN IMMEDIATE`, как `tx()`):
`id · tenant_id · kind · payload_json · run_after · attempts · status · locked_at · last_error`
**`ai_monitoring_targets`** — что наблюдаем: `id · tenant_id · source_id ·
subject_type · subject_id · url · parser · frequency (daily|weekly|monthly) ·
enabled · last_run_at · next_run_at · failures`
**`ai_monitoring_runs`** — `id · target_id · started_at · finished_at · status ·
items · changes · error`
**`ai_recommendations`** — `id · tenant_id · kind (pricing|assortment|promo|dealer|region|product) ·
title · body · confidence · based_on_fact_ids · agent · created_at ·
status (draft|proposed|accepted|rejected|implemented) · decided_by · decided_at · decision_note`
**`ai_alerts`** — `id · tenant_id · observation_id · recommendation_id · severity ·
title · channel (panel|push) · sent_at · read_at · read_by`
**`ai_feedback`** — `id · message_id · recommendation_id · user_id · rating (up|down) · comment · created_at`
**`ai_prompts`** — версии инструкций агентов: `id · agent · version · body ·
status (draft|active|retired) · approved_by · approved_at` — **агент не может
писать в эту таблицу** (см. §13).
**`ai_settings`** — `tenant_id · key · value_json` (модель, бюджет в день,
частоты, список разрешённых доменов).
**`ai_knowledge_chunks`** — *только при необходимости* (Фаза 9):
`id · subject_type · subject_id · text · embedding BLOB · model · updated_at`.

### 7.5 Связи

```
tenants 1─* всё
products 1─* variants 1─* prices/stock          (существующее)
products 1─1 ai_competitor_products.our_analog_product_id
categories 1─* ai_competitor_products.our_category_id
ai_companies 1─* ai_brands 1─* ai_competitor_products 1─* ai_competitor_packs
ai_companies *─* ai_regions   через ai_company_regions
ai_competitor_products 1─* ai_price_observations *─1 ai_regions
ai_sources 1─* ai_source_snapshots 1─* ai_facts 1─* ai_fact_history
ai_facts *─* ai_market_observations (через fact_ids)
ai_market_observations 1─* ai_alerts
ai_recommendations *─* ai_facts (based_on) → ai_decisions
ai_conversations 1─* ai_messages 1─* ai_citations → ai_facts
users 1─* ai_conversations · ai_recommendations.decided_by · ai_facts.verified_by
variants 1─* ai_product_costs · ai_price_policies   (конфиденциально)
```

---

## 8. Система AI subagents

Агент = **инструкция (`ai_prompts`) + разрешённый набор инструментов +
разрешённый набор данных**. Отдельных процессов нет; оркестратор вызывает
их последовательно в одном запросе или ставит задачу в `ai_jobs`.

| Агент | Назначение | Данные | Задачи | **Запрещено** | Связи |
|---|---|---|---|---|---|
| **AI Orchestrator** | разбирает вопрос, выбирает агентов, собирает ответ, следит за бюджетом | все, через агентов | маршрутизация, план, сборка ответа с цитатами | обращаться к внешним сайтам, писать факты напрямую, отвечать без цитат | со всеми |
| **Habez Product Agent** | знает нашу продукцию | `products`, `variants`, `prices`, `media`, `ai_product_specs`, `products_fts` | карточки, характеристики, расход, подбор аналога | называть цену, если её нет; видеть себестоимость (только через Pricing с правом owner) | Competitor, Pricing, Marketing |
| **Competitor Agent** | продукция и заводы конкурентов | `ai_companies`, `ai_competitor_products`, `ai_product_specs`, `ai_price_observations` | сравнение, карта конкурентов, изменения ассортимента | выдумывать характеристики; утверждать без `fact_id` | Product, Pricing, Research, Fact Checker |
| **Market Research Agent** | рынок в целом | `ai_market_observations`, `ai_facts`, `search_log` | обзор изменений, новые игроки, региональные сдвиги | самостоятельно ходить в интернет вне разрешённых источников | Research, Competitor, Dealer |
| **Pricing Agent** | цены и ценовая позиция | `prices`, `ai_price_observations`, `ai_price_policies`, `ai_product_costs` (owner), `ai_sales_facts` | позиционирование, коридор цены, эффект изменения | менять цены в `prices`; показывать себестоимость роли ниже owner; обещать результат | Product, Competitor, Sales Analytics |
| **Dealer Agent** | дилерская сеть | `ai_companies`, `ai_company_regions`, `ai_dealer_candidates`, `leads(kind='dealer')`, `users(role='dealer')` | покрытие регионов, кандидаты, пересечения с конкурентами | собирать персональные данные людей; писать письма и звонить | Market Research, Sales Analytics |
| **Sales Analytics Agent** | наши продажи | `orders`, `order_items`, `ai_sales_facts`, `stock`, `search_log` | динамика, ABC, сезонность, спрос без предложения | выдавать прогноз как факт при малой выборке (сейчас 1 заказ) | Pricing, Marketing |
| **Marketing Agent** | акции и продвижение | `ai_promotions`, `ai_market_observations`, `ai_sales_facts`, каталог | идеи акций, ответ на акцию конкурента, тексты | публиковать что-либо; менять витрину | Pricing, Sales Analytics |
| **Research Agent** | разовое исследование по заданию человека | `ai_sources`, внешние страницы **через ingest** | план → сбор → черновик фактов | записывать факты минуя Fact Checker; ходить на домены вне белого списка | Fact Checker, Data Quality |
| **Fact Checker Agent** | проверка и статус фактов | `ai_facts`, `ai_source_snapshots`, `ai_fact_conflicts` | сверка со снимком, поиск противоречий, присвоение `status`/`confidence`, постановка на перепроверку | придумывать источник; повышать доверие без снимка; утверждать `verified` для `origin='ai_inference'` | все |
| **Data Quality Agent** | здоровье базы знаний | все `ai_*` + каталог | ищет устаревшее (`recheck_after`), пустые характеристики, дубли компаний, товары без цены и фото | удалять данные; исправлять значения без подтверждения | Fact Checker, Orchestrator |

Два правила для всех: (1) ответ без `fact_id` помечается как мнение;
(2) ни один агент не пишет в таблицы работающего каталога.

---

## 9. Система источников и проверки (принцип достоверности)

Уровни `ai_sources.kind` и базовое доверие `trust_base`:

| Уровень | Пример | `trust_base` | Может стать `verified` |
|---|---|---|---|
| `habez_internal` | прайс завода, данные владельца | 95 | да, автоматически |
| `habez_official` | сайт habez-gips.ru | 90 | да |
| `manufacturer_official` | сайт конкурента, его каталог PDF | 80 | да, при наличии снимка |
| `dealer_official` | сайт дилера, его прайс | 60 | да, при 2 независимых источниках |
| `marketplace` | маркетплейс, агрегатор | 45 | только как наблюдение цены |
| `news_media` | отраслевые новости | 40 | нет, только наблюдение |
| `manual_research` | владелец или менеджер внёс руками | 85 | да, с именем внёсшего |
| `ai_inference` | вывод модели | **≤ 30** | **никогда** |

Каждый факт хранит: `source_id`, `snapshot_id` (URL + дата + хеш файла),
`observed_at`, `verified_at`, `recheck_after`, `status`, `confidence`,
`origin`. Изменение любого поля пишет строку в `ai_fact_history` — история
никогда не перезаписывается.

**Три правила, защищающие от выдачи предположения за факт:**
1. `origin='ai_inference'` и `origin='assumption'` не могут получить
   `status='verified'` — ограничение проверяется в коде и тестом.
2. Ответ агента собирается из фактов: текст с числом без `ai_citations`
   не выводится как утверждение, а помечается «оценка AI».
3. Интерфейс показывает у каждого числа значок источника и дату;
   по клику — карточка факта: откуда, когда, кем подтверждено.

Срок годности: цена — 30 дней, ассортимент — 90, характеристики — 365,
состав дилеров — 180. По истечении `recheck_after` факт переходит в
`outdated` и попадает в очередь Data Quality.

---

## 10. Постоянное обновление знаний

**Конвейер:** `ai_monitoring_targets` → `jobs/worker.js` (fetch) →
`ai_source_snapshots` → парсер (CSS-селекторы под источник; PDF и сложные
страницы — LLM с JSON-схемой) → нормализация (единицы, фасовки, валюта) →
diff с текущими `ai_facts` → Fact Checker → запись фактов и
`ai_market_observations` → `ai_alerts` → push.

| Режим | Как запускается | Что делает |
|---|---|---|
| Ежедневно (03:40, после копии) | `hgz-ai-daily.timer` | цены наблюдаемых товаров конкурентов, акции, наличие |
| Еженедельно (пн 04:10) | `hgz-ai-weekly.timer` | ассортимент, новые товары, новые дилеры, новости отрасли |
| Ежемесячно | `hgz-ai-monthly.timer` | перепроверка фактов с истёкшим `recheck_after`, чистка дублей |
| Вручную | кнопка «Исследовать» в панели → `ai_jobs` | Research Agent по заданию человека |

Как распознаются события:
- **Изменение цены** — новое `ai_price_observation` по тому же
  `subject_id + seller + region` отличается от последнего более чем на
  порог (по умолчанию 2 %) → `market_observation(kind='price_change')`.
- **Новый продукт** — в листинге источника появился артикул/название, для
  которого нет `ai_competitor_products` → создаётся со `status='unknown'`
  и ставится на проверку человеку.
- **Новый дилер** — на сайте конкурента в разделе «где купить» появилась
  компания, которой нет в `ai_companies` → `dealer_candidate`.
- **Акция** — на странице найден маркер скидки/срока → `ai_promotions`.
- **Исчезновение** — товар не встречался N прогонов подряд →
  `product_gone` (не удаляем, помечаем).

Правила поведения робота: только публичные страницы; `robots.txt`
уважается; не чаще 1 запроса в 5 секунд к домену; свой User-Agent с
контактом завода; персональные данные не собираются; всё сохраняется
снимком для доказуемости. Домены — по белому списку в `ai_settings`.

---

## 11. Безопасность и роли

### 11.1 Классификация данных

| Уровень | Что относится | Кто видит |
|---|---|---|
| **Public** | каталог, характеристики, фото, розничные цены, публичные факты о конкурентах (их же открытые цены) | все, в том числе публичный сайт |
| **Internal** | наблюдения рынка, сравнение с конкурентами, дилерская сеть, заявки, статистика заказов, рекомендации AI | `manager` и выше |
| **Confidential** | себестоимость, маржа, закупочные цены, дилерские цены и договорные условия, объёмы продаж по дилерам, стратегия, история решений | `admin` (дилерские цены, объёмы) и `owner` (себестоимость, маржа, стратегия) |

### 11.2 Роли — существующая линейка достаточна

`RANK` из `plugins/auth.js` уже упорядочен, новая система прав не нужна:

| Возможность | Минимальная роль |
|---|---|
| Чат AI, продукты, конкуренты, рынок, наблюдения | `manager` |
| Дилеры, кандидаты, аналитика продаж, рекомендации (чтение) | `manager` |
| Подтверждение фактов, настройка мониторинга, принятие рекомендаций | `admin` |
| Себестоимость, маржа, ценовые политики, стратегия, история решений | `owner` |
| Изменение инструкций агентов (`ai_prompts`), смена модели, бюджет | `owner` |

Технически: маршруты `/api/ai/*` закрываются хуком
`app.requireAuth("manager")` (как `routes/admin.js:31`), отдельные —
`requireAuth("admin")`/`("owner")`. **Уровень доступа проверяется не в
промпте, а в инструментах**: инструмент `get_product_cost` физически не
попадает в набор агента, если у пользователя роль ниже `owner`. Модель не
может «уговорить» себя выдать то, чего ей не передали.

Дополнительно: все обращения к AI пишутся в `audit_log` (`action='ai.query'`)
без текста персональных данных; ключ LLM — только в `/etc/hgz/hgz.env`
(0640 root:hgz), в репозиторий и в браузер не попадает; ответы LLM никогда
не исполняются как код и не подставляются в SQL — инструменты принимают
только типизированные параметры (Zod), как остальные маршруты.

---

## 12. Интерфейс

Новый пункт в `NAV` (`web/src/admin/AdminApp.jsx:13`) → `/admin/ai`,
отдельный чанк `web/src/ai/AiApp.jsx`, внутренняя навигация вкладками.

**MVP (Фазы 1–5):**
1. **Чат** — диалог, ответы с источниками под каждым числом, история
   разговоров, кнопка «показать факты».
2. **Наблюдения (Alerts + Market)** — лента изменений: цена, новый товар,
   акция; фильтр по важности; «отметить просмотренным».
3. **Конкуренты** — список компаний и их товаров, карточка конкурента,
   сравнение «наш ↔ их» на готовом механизме `/api/catalog/compare`.
4. **База знаний** — таблица фактов: источник, дата, статус, доверие;
   ручное подтверждение и правка (`admin`).
5. **Настройки AI** (`owner`) — модель, бюджет в день, белый список
   доменов, частоты мониторинга, список наблюдаемых товаров.

**Следующие этапы:**
6. **Цены** — динамика, коридор, позиция относительно конкурентов (Фаза 6).
7. **Дилеры** — карта покрытия, кандидаты (Фаза 6).
8. **Аналитика продаж** — когда появятся реальные заказы или выгрузка 1С (Фаза 6).
9. **Исследования** — постановка задачи Research Agent, отчёты (Фаза 4).
10. **Рекомендации** — список с состоянием «предложено / принято / внедрено» (Фаза 8).
11. **Продукты Habez (Products Intelligence)** — качество карточек,
    пробелы, сравнение с рынком (Фаза 2, встраивается в существующую
    страницу «Товары и цены», отдельная не нужна).

Правило подачи в интерфейсе: **факт** — обычным текстом со значком
источника; **анализ** — серым блоком «Анализ»; **рекомендация** — карточкой
с кнопками «Принять / Отклонить» и обязательной строкой «на основании N
фактов, последняя проверка ДД.ММ».

---

## 13. LLM, инструменты, RAG

**Провайдер.** OpenRouter (обязательное правило из `~/.claude/CLAUDE.md`:
прямой доступ к Anthropic недоступен без верификации). Базовый адрес
`https://openrouter.ai/api`, совместим с Anthropic API. Модель по умолчанию
`anthropic/claude-sonnet-5`; для простых задач (нормализация, разбор
страницы) — дешёвая модель, задаётся в `ai_settings`. Ключ на сервере в
`/etc/hgz/hgz.env` (`OPENROUTER_API_KEY`), на Mac — `~/.openrouter.env`.
Никаких ключей в репозитории и в браузере: запросы к модели делает только
сервер.

**Обмен.** Встроенный `fetch` (Node 22), отдельного SDK не нужно —
в проекте уже так сделано с ЮKassa и Telegram.

**Стриминг.** Ответ идёт в браузер по SSE (`text/event-stream`) из Fastify.
Замечание по развёртыванию: в `deploy/Caddyfile` для `/api/ai/chat` нужен
`flush_interval -1`, иначе прокси буферизует поток (проверяется на сервере).

**Tool calling — основной механизм, а не RAG.** Модель не получает «кучу
текста», она вызывает функции, которые возвращают строки из нашей базы:
`search_products` (FTS5), `get_product`, `get_prices`, `compare_products`,
`search_competitor_products`, `get_price_history`, `list_observations`,
`get_sales_stats`, `get_dealer_coverage`, `get_facts(subject)` и, только
для `owner`, `get_costs`. Каждый инструмент возвращает данные **вместе с
`fact_id`/источником**, чтобы ответ можно было процитировать.

**RAG и вектора.** На старте **не нужны**: 56 наших товаров и первые
сотни конкурентных — это SQL + FTS5 (`products_fts` уже работает,
`services/catalog.js:128`). Векторный поиск оправдан, когда появится корпус
свободного текста (PDF-паспорта, новости, переписка) — тогда
`ai_knowledge_chunks` с эмбеддингами в BLOB и перебором косинуса (до
~50 000 кусков на SQLite это доли секунды) либо расширение `sqlite-vec`.
Отдельная векторная база на 2 ГБ оперативной памяти не окупается.

**Структурированный вывод.** Всё, что модель извлекает из страниц,
описывается Zod-схемой и валидируется перед записью — тем же способом, что
тела запросов в `routes/*`. Невалидный ответ не попадает в базу, а
отправляется на повтор с ошибкой.

**Контекст.** Системная инструкция + краткая сводка диалога + результаты
инструментов. Полные тексты страниц в контекст не кладутся — только
извлечённые факты. Длинные диалоги сворачиваются резюме; всё хранится в
`ai_messages`.

**Стоимость.** Учёт токенов и цены на каждое сообщение (`ai_messages.cost_micro`),
дневной лимит на тенанта в `ai_settings`, при превышении — чат отвечает
«лимит исчерпан», мониторинг ставится в очередь на завтра. Ориентир: чат
(10–20 запросов в день) + ежедневный мониторинг 30–50 страниц ≈ 300–900 ₽
в месяц. Это оценка, не обязательство.

**Самообучение — безопасно (§13 задания).** Автоматически обновляются
**только данные**: новые факты (`status='unverified'`), наблюдения,
кандидаты. Требуют подтверждения человека: перевод факта в `verified`,
изменение характеристик наших товаров, добавление компании-конкурента в
«подтверждённые», принятие рекомендации, изменение `ai_prompts`, смена
модели, белый список доменов, бюджет. **Агент не имеет инструмента записи
в `ai_prompts` и `ai_settings`** — это проверяется тестом. «Улучшение
ответов» идёт через `ai_feedback` (палец вверх/вниз + комментарий):
владелец видит сводку, правит инструкцию сам, новая версия сохраняется
рядом со старой и может быть откачена.

---

## 14. Сценарии использования (факт → анализ → рекомендация)

| Вопрос | **Факт** (из `ai_facts`) | **Анализ** | **Рекомендация** |
|---|---|---|---|
| «Сравни нашу штукатурку с конкурентами» | характеристики из `ai_product_specs` + `ai_price_observations` с датами и ссылками | где мы выше/ниже по прочности, расходу, цене за м² | какие преимущества выносить в карточку |
| «Какие цены на аналогичные продукты?» | наблюдения по региону и продавцу, дата проверки | коридор цен, наша позиция | пересмотреть цену или оставить, с оговоркой о неполноте данных |
| «Какие конкуренты появились в регионе?» | `market_observations(kind='new_dealer'|'new_plant')` | охват, пересечение с нашими дилерами | что проверить менеджеру на месте |
| «Найди потенциальных дилеров» | `ai_dealer_candidates` с источниками | покрытие, размер, пересечения | список для звонка (звонит человек) |
| «Какие продукты продвигать?» | `ai_sales_facts`, `search_log`, наблюдения спроса | спрос без предложения, сезонность | 2–3 позиции с обоснованием |
| «Предложи акцию» | акции конкурентов, наши цены, себестоимость (owner) | коридор скидки, риск маржи | вариант акции с расчётом |
| «Проанализируй изменение цены конкурента» | два наблюдения со снимками | величина, направление, вероятная причина | ответ или ожидание |
| «Что добавить в ассортимент?» | ассортимент конкурентов, пропуски у нас, `search_log` | дыры в линейке | кандидаты, с оговоркой о мощностях |
| «Какие регионы перспективны?» | покрытие дилеров, наблюдения, заказы | где нас нет, а спрос виден | приоритет с честной оценкой неполноты |

Ответ всегда заканчивается строкой вида: «Основано на 14 фактах, из них
9 подтверждены, последняя проверка 21.09.2026. Это анализ, а не гарантия
результата».

---

## 14-bis. Phase 1 — Knowledge Layer (сделано 24 сентября 2026)

Фаза 1 реализована. Ниже — что именно получилось; при расхождении с разделами
6–8 выше верен этот раздел: он описывает код, а не замысел.

### Таблицы (`api/src/ai/knowledge/schema.sql`, миграция `2026-09-ai-knowledge`)

**`ai_sources`** — откуда сведения: `source_type` (8 видов), `name`, `url`
(уникален в пределах компании), `publisher`, `description`, `trust_base`
(0–100, по умолчанию от вида), `status` (`active|paused|archived`),
`last_checked_at`, `created_by`, `created_at`, `updated_at`.

**`ai_facts`** — сами сведения: `fact_type` (10 видов), `subject_type`
(`product|variant|category|company|market`), `subject_id`, `subject_label`
(подпись на момент записи), `attribute`, тройное значение
(`value_text` / `value_num` / `value_json`) + `unit`, `source_id`,
`source_url`, `snapshot_ref` (для фазы 4), `content_hash`, `origin`,
`verification_status`, `confidence`, `observed_at`, `checked_at`,
`recheck_after`, `verified_by`, `verified_at`, `verify_note`,
`supersedes_fact_id`, `created_by`, `created_at`, `updated_at`.

Индексы: по объекту, статусу, источнику, типу+происхождению, сроку
перепроверки; уникальный — на повтор того же значения из того же источника.
Отдельной таблицы истории нет: она ведётся в существующем `audit_log`.

### Происхождение и статусы (`api/src/ai/knowledge/model.js`)

`origin`: `habez_internal` (95) · `official_manufacturer` (80) ·
`official_dealer` (60) · `external_source` (40) · `monitored` (55) ·
`ai_inference` (**20, не может быть подтверждён**) — в скобках базовое доверие.

`verification_status`: `unverified` → `verified` / `disputed` / `stale` /
`rejected`; из `verified` — в `disputed`/`stale`/`rejected` (напрямую в
`unverified` нельзя); из `rejected` — только в `unverified`/`verified`.
Переходы описаны таблицей `STATUS_TRANSITIONS` и проверяются на сервере.

Правила, закреплённые кодом и тестами:
1. `ai_inference` никогда не получает `verified` (`ORIGINS_NEVER_VERIFIED`).
2. Новый факт всегда создаётся как `unverified`, кем бы он ни был заведён.
3. Подтвердить можно только факт, у которого есть источник.
4. Правка значения снимает подтверждение (`verified` → `unverified`).
5. Факт без источника принимается только с происхождением `ai_inference`.
6. Срок перепроверки проставляется по типу факта (цена — 30 дней,
   характеристика — 365 и т. д.), по истечении факт помечается «пора
   перепроверить».

### API (`api/src/ai/routes/knowledge.js`, префикс `/api/ai`)

| Метод | Маршрут | Роль |
|---|---|---|
| GET | `/api/ai/meta` — словари и разрешённые переходы | manager |
| GET | `/api/ai/summary` — счётчики для панели | manager |
| GET | `/api/ai/sources` — список (фильтры: статус, вид, поиск) | manager |
| GET | `/api/ai/sources/:id` | manager |
| POST | `/api/ai/sources` | **admin** |
| PATCH | `/api/ai/sources/:id` (в т. ч. `checked: true`) | **admin** |
| GET | `/api/ai/facts` — список; фильтры `factType`, `subjectType`, `subjectId`, `sourceId`, `status`, `origin`, `from`, `to`, `search`, постранично | manager |
| GET | `/api/ai/facts/:id` | manager |
| GET | `/api/ai/facts/:id/history` — история из `audit_log` | manager |
| POST | `/api/ai/facts` | manager |
| PATCH | `/api/ai/facts/:id` — значение, единица, источник, доверие | manager |
| PATCH | `/api/ai/facts/:id/verification` — статус проверки | **admin** |

Раздел включается флагом `AI_ENABLED` (`api/src/config.js`); при `0`
маршруты не регистрируются вовсе — как платежи при `PAYMENT_PROVIDER=none`.

### Права

`manager` — читать всё в слое знаний, заводить и править факты.
`admin` — дополнительно: источники и статусы проверки.
`owner` — то же, что `admin` (по рангу выше).
`customer`, `dealer` и гость — доступа нет (401/403).
Себестоимость, маржа и дилерские условия в слой знаний **не попадают**:
он работает только с тем, что сам записал. Доступ AI к внутренним данным
каталога будет решаться отдельно, в фазах 5–6.

### Журнал

Пишется в существующий `audit_log` действиями `ai.fact.create`,
`ai.fact.update`, `ai.fact.verification`, `ai.source.create`,
`ai.source.update`. В карточке факта история показывается обычными словами
(«Не проверен → Подтверждён · сверено с прайсом»).

### Связь с каталогом

Второй таблицы товаров нет. Факт ссылается на существующий
`products.id` / `variants.id` / `categories.id` через `subject_type` +
`subject_id`; объект проверяется на принадлежность компании при каждой
записи (`resolveSubject` в `facts.js`). `subject_label` хранит подпись на
момент записи — переименование товара не ломает историю. Поля каталога не
дублируются: в фактах живёт то, чего в карточке нет (наблюдения, проверенные
характеристики со ссылкой на источник).

### Интерфейс (`web/src/ai/`)

Пункт «База знаний AI» в меню панели появляется, только когда раздел включён
(признак `settings.ai` в `/api/catalog/meta`). Внутри — вкладки «Факты» и
«Источники», карточка факта с историей, счётчики сверху. Стиль — существующий,
новых визуальных решений не вводилось.

### Тесты

`api/test/ai-knowledge.test.js` — 16 проверок: создание источника и факта,
запрет дублей, изоляция компаний (списки, прямой доступ, попытка сослаться
на чужой товар), права всех ролей, переходы статусов, запрет подтверждения
вывода AI, снятие подтверждения при правке, журнал, сводка и фильтры,
отсутствие маршрутов при `AI_ENABLED=0`.

---

## 14-ter. Phase 2 — Product Intelligence (сделано 24 сентября 2026)

Характеристики 56 товаров Habez приведены к машиночитаемому виду: «не менее
0,5 МПа» стало числом 0,5 с единицей MPa и признаком «не менее». Карточки
товара не менялись — это второе представление тех же данных.

### Таблица `ai_product_specs` (миграция `2026-09-ai-product-specs`)

`product_id` → существующий `products.id` (второй таблицы товаров нет),
`variant_id` для характеристик фасовки, `spec_key` из словаря, `label`,
`display_value` (исходная строка — хранится всегда), `value_num`,
`value_min`/`value_max` (диапазон), `value_bool` (ДА/НЕТ), `value_text`,
`unit_raw`, `normalized_unit`, `comparator` (`exact|min|max|range|approx`),
`source_id`/`fact_id`, `origin`, `verification_status`, `confidence`,
`imported_from` (`badge|spec_table|manual`), `source_ref`, `parse_note`,
`observed_at`, `checked_at`, `verified_by/at`, `created_by`, даты.
Уникальный индекс `(tenant_id, product_id, spec_key)` — одно значение на
свойство, иначе сравнение выбирало бы произвольное. Несколько значений
одного свойства из разных источников — в наблюдениях (раздел 14-quater).

### Нормализация (`api/src/ai/knowledge/units.js`)

Перевод только внутри одной физической величины: г→кг, мл→л, см и м→мм,
часы и сутки→минуты, годы→месяцы, кгс/см²→МПа. **Между величинами не
переводим**: мл/м² не становится кг/м² (плотность у каждого состава своя),
поэтому канонов два — `l/m2` и `kg/m2`. Канонические единицы: `kg`, `l`,
`mm`, `MPa`, `kg/m2`, `l/m2`, `l/kg`, `min`, `month`, `°C`, `%`, `cycles`,
`pcs`, `m2`, `kg/m3`.

Что распознаётся: диапазоны («3–70 мм», «от +5°C до +30°C», «-15°…+30°»),
границы («не менее», «не ранее», «не более», «около»), логические значения
(ДА/НЕТ/возможно), марки морозостойкости (F50 → 50 cycles), уточнения в
скобках («6,5–9,5 (фактически 7,5)»). У диапазона `value_num` пустой —
середина не выдумывается. Нераспознанное остаётся текстом с пояснением
в `parse_note`; числа из воздуха не берутся.

### Словарь (`api/src/ai/knowledge/spec-dictionary.js`)

72 ключа, составленных по фактическим подписям в карточках, восемь групп:
Прочность, Стойкость, Работа, Нанесение, Условия, Материал, Геометрия,
Пригодность, Основания, Покрытия. Отдельно перечислены подписи, которые
**намеренно не переносятся**: упаковка, объём, вес, количество на поддоне,
штрихкоды — всё это уже живёт в `variants`.

### Перенос (`npm run ai:import-specs`)

`--dry-run` — прогон без записи, `--report` — отчёт по качеству. Значение
берётся из таблицы технических характеристик, если есть; ярлык карточки —
запасной вариант (в таблице пишут точнее: «не менее 0,3 МПа» против «0,3 МПа»).
Расхождения сравниваются по числам, а не по написанию, и выводятся списком.
Повторный запуск не плодит дублей: совпадающее значение пропускается,
изменившееся обновляется и снимает прежнее подтверждение.

### API (роль `manager`, подтверждение — `admin`)

| Метод | Маршрут |
|---|---|
| GET | `/api/ai/spec-keys` — словарь и единицы |
| GET | `/api/ai/products` — товары со счётчиками характеристик |
| GET | `/api/ai/products/summary` |
| GET | `/api/ai/products/:id/intelligence` — карточка глазами машины |
| GET | `/api/ai/products/compare?ids=` — сравнение по числам |
| GET | `/api/ai/specs` — фильтры: товар, раздел, ключ, статус, происхождение, единица, только числовые, поиск |
| GET/POST/PATCH | `/api/ai/specs`, `/api/ai/specs/:id` |
| PATCH | `/api/ai/specs/:id/verification` — **admin** |
| GET | `/api/ai/specs/:id/history` — из `audit_log` |

### Сравнение

`/api/catalog/compare` (витрина, строки для человека) не трогали. Новый
`/api/ai/products/compare` отдаёт числа и говорит, у кого больше, — но
только когда единица у всех одна и значения не равны. «2 МПа» против
«60 мин» к сравнению не допускается.

### Результат по 56 товарам

726 записей, характеристики есть у 55 товаров из 56 (нет только у прямого
подвеса — в его карточке одни размеры). Нормализовано 635 записей (87 %):
191 одно число, 119 диапазонов, 325 логических; 91 запись осталась текстом
(цвет, основа, ГОСТ — так и должно быть). Не сопоставлено со словарём
123 строки из 1008 — редкие подписи (марка, внешний вид покрытия, условная
вязкость); 47 строк пропущены намеренно как дублирующие `variants`.

---

## 14-quater. Phase 2.2B — наблюдения и доказательства (25 сентября 2026, не применено)

Подробно: [HABEZ-AI-EVIDENCE-MODEL.md](HABEZ-AI-EVIDENCE-MODEL.md).

Уникальность `ai_product_specs` «одно значение на товар и ключ» не даёт
хранить значения карточки, технолога и паспорта рядом, различать условия
(7 / 28 суток), фасовки и заявленное / замер / норму. Поэтому добавлен
второй уровень:

- `ai_spec_observations` — наблюдение: товар × фасовка × ключ × условие,
  тип утверждения, вид и ссылка источника, дата документа, роль передавшего
  (без имени и почты), уровень доступа, проверка, жизненный цикл
  (`active` / `superseded` / `withdrawn`), `legacy_spec_id`;
- `ai_observation_relations` — «B заменяет A» и другие связи; замена
  переводит A в `superseded`, но не удаляет;
- `ai_source_type_priorities` — приоритет видов источника; пустая, пока
  владелец не утвердит порядок доверия. Без неё расхождения уходят в
  «ждёт решения», по дате ничего не выбирается.

Миграция `2026-09-ai-evidence` только добавляет таблицы. `ai_product_specs`
и её уникальный индекс не меняются: на них работают сравнение и все
маршруты фазы 2. Маршруты: `/api/ai/observations*`,
`/api/ai/products/:id/evidence`, `/api/ai/evidence/meta`. Прогон без записи:
`npm --prefix api run ai:evidence-dry-run`. В рабочей базе миграция,
перенос и исправления **не выполнялись**.

Контрольный аудит (раздел 8 документа модели): canonical-источник для AI —
**наблюдения**, `ai_product_specs` становится производной проекцией
(переходный период — гибрид). Выбор значения — только при согласии
источников или по утверждённому владельцем приоритету; дата, номер,
уверенность и статус победителя не выбирают. Маршруты наблюдений
включаются отдельно: `AI_EVIDENCE_ENABLED=1` (вместе с `AI_ENABLED=1`).

Phase 2.2C (сверка, только чтение): [HABEZ-AI-PHASE-2-2C-RECONCILIATION.md](HABEZ-AI-PHASE-2-2C-RECONCILIATION.md),
реестр — [HABEZ-AI-RECONCILIATION-REGISTER.md](HABEZ-AI-RECONCILIATION-REGISTER.md),
команда `npm --prefix api run ai:reconcile-dry-run`. Из 726 старых записей
все доказанно взяты из карточки Habez Pro, но у 654 источник выше карточки
неизвестен (исходный каталог 31.08). Перенос в наблюдения делает их
`internal`; публикуемых — 0.

Phase 2.2D (механизм сверки, в рабочей базе не выполнялся):
[HABEZ-AI-PHASE-2-2D-IMPLEMENTATION-PLAN.md](HABEZ-AI-PHASE-2-2D-IMPLEMENTATION-PLAN.md).
Решения D1–D10 закреплены кодом; `npm --prefix api run ai:reconcile-repair`
— прогон на копии; запись — только `--apply --confirm <отпечаток>`, одной
транзакцией, с журналом и откатом `--rollback`. Режим чтения старых
маршрутов — `AI_EVIDENCE_READ_MODE` (`legacy` по умолчанию / `evidence`).

Phase 3.1 (AI Agent): [HABEZ-AI-PHASE-3-1-AGENT.md](HABEZ-AI-PHASE-3-1-AGENT.md) —
`api/src/ai/agent/`, чат «Habez AI» в панели и на `/ai`, OpenRouter
(`anthropic/claude-sonnet-5`), только чтение, ссылки [E#], споры без
победителя, права public / staff / admin.

---

## 15. Roadmap

### Фаза 0 — аудит и архитектура *(этот документ)*
Готово: аудит проведён, архитектура описана, пробелы названы.
**Критерий:** владелец утвердил документ и ответил на вопросы §17.

### Фаза 1 — фундамент и база знаний
- Создаём: `api/src/ai/` (каркас), миграция с таблицами `ai_sources`,
  `ai_source_snapshots`, `ai_facts`, `ai_fact_history`, `ai_settings`,
  `ai_jobs`; сервис фактов (запись/чтение/история); флаг `AI_ENABLED`.
- Файлы: `api/src/db/migrate.js` (+шаг), `api/src/ai/knowledge/*`,
  `api/src/server.js` (регистрация плагина под флагом), `api/src/config.js`.
- API: `/api/ai/facts` (GET/POST, `admin`), `/api/ai/sources`.
- Тесты: факт нельзя записать без источника; `ai_inference` не может стать
  `verified`; история пишется на каждое изменение; при `AI_ENABLED=0`
  маршрутов нет.
- **Готово, когда:** факт заводится руками, виден в панели, история ведётся.

### Фаза 2 — знания о продукции Habez
- Создаём: `ai_product_specs`, перенос характеристик из
  `badges`/`spec_tables` в нормализованный вид (скрипт, товары не меняются);
  инструменты `search_products`, `get_product`, `compare_products`.
- Файлы: `api/src/ai/tools/products.js`, `api/src/ai/ingest/specs-from-catalog.js`.
- Тесты: перенос идемпотентен; единицы приведены; каталог не изменён.
- **Готово, когда:** по каждому товару есть машиночитаемые характеристики.

### Фаза 3 — конкуренты
- Создаём: `ai_companies`, `ai_brands`, `ai_competitor_products`,
  `ai_competitor_packs`, `ai_regions`, `ai_company_regions`,
  `ai_price_observations`; ручной ввод в панели; сравнение «наш ↔ их».
- API: `/api/ai/companies`, `/api/ai/competitor-products`, `/api/ai/compare`.
- Frontend: `web/src/ai/Competitors.jsx` на базе `pages/Compare.jsx`.
- Тесты: связь с нашим товаром; наблюдение цены требует источника.
- **Готово, когда:** 3–5 конкурентов и их ключевые позиции заведены и сравниваются.

### Фаза 4 — исследования (ручной сбор)
- Создаём: `ingest/fetch` + снимки, белый список доменов, парсер под 1–2
  источника, Research Agent и Fact Checker (без расписания, по кнопке).
- Тесты: robots.txt соблюдён; снимок сохранён; факт получил `snapshot_id`.
- **Готово, когда:** «Исследовать сайт X» даёт черновик фактов на проверку.

### Фаза 5 — чат и оркестратор
- Создаём: клиент OpenRouter, SSE, `ai_conversations/messages/citations`,
  оркестратор, инструменты Фаз 2–3, учёт стоимости и дневной лимит.
- Frontend: `web/src/ai/Chat.jsx`, пункт «Habez AI» в `NAV`.
- Deploy: `flush_interval -1` в `deploy/Caddyfile` для чата.
- Тесты: ответ без цитат помечается мнением; лимит бюджета срабатывает;
  инструмент себестоимости недоступен роли ниже `owner`.
- **Готово, когда:** менеджер спрашивает про товар и получает ответ с источниками.

### Фаза 6 — цены, дилеры, продажи
- Создаём: `ai_product_costs`, `ai_price_policies`, `ai_sales_facts`,
  `ai_dealer_candidates`; агенты Pricing, Dealer, Sales Analytics; страницы
  «Цены» и «Дилеры».
- Тесты: себестоимость не отдаётся ниже `owner` ни одним маршрутом.
- **Готово, когда:** видно позицию по цене и покрытие регионов.

### Фаза 7 — автоматический мониторинг *(требует сервера, этап 1B)*
- Создаём: `ai_monitoring_targets/runs`, `jobs/worker.js`, таймеры
  `hgz-ai-daily/weekly/monthly`, обнаружение изменений, `ai_alerts` + push.
- Тесты: повторный прогон без изменений не плодит наблюдений; ошибка
  источника не роняет прогон; порог цены соблюдается.
- **Готово, когда:** утром в панели видны вчерашние изменения рынка.

### Фаза 8 — рекомендации и поддержка решений
- Создаём: `ai_recommendations`, `ai_decisions`, `ai_feedback`; страница
  «Рекомендации» с принятием/отклонением; обратная связь.
- Тесты: рекомендация без фактов не создаётся; принятие пишет решение.
- **Готово, когда:** завод принимает или отклоняет предложения в панели.

### Фаза 9 — продвинутое
- Эмбеддинги и `ai_knowledge_chunks` (если появится корпус текстов),
  разбор PDF-паспортов, прогноз сезонности, обмен с 1С, отчёты в Excel.
- **Готово, когда:** поиск по документам отвечает быстрее ручного.

---

## 16. Риски

1. **Выдумывание фактов моделью** — главный риск. Снижается тем, что
   ответы собираются из `ai_facts` с цитатами, а `ai_inference` никогда не
   становится `verified`.
2. **Юридическая сторона сбора данных.** Публичные страницы, robots.txt,
   без персональных данных, со ссылкой на источник. Всё равно требуется
   решение владельца: какие домены разрешены.
3. **Мало собственных данных.** 1 заказ, 0 остатков, 0 себестоимости —
   «аналитика продаж» до наполнения будет пустой. Нельзя обещать выводы
   раньше данных.
4. **Качество характеристик.** `attributes` пуст, `sku` у двух товаров —
   до Фазы 2 машинное сравнение невозможно.
5. **Ресурсы сервера.** 2 ГБ и 2 ядра: LLM-запросы и парсинг только в
   отдельном воркере, иначе страдает каталог.
6. **Стоимость LLM** — контролируется лимитом; без лимита один цикл
   мониторинга может обойтись дороже месяца хостинга.
7. **Утечка конфиденциального через чат.** Разграничение — на уровне
   инструментов, не промпта; плюс запись обращений в `audit_log`.
8. **Ключ OpenRouter** — только на сервере, в `/etc/hgz/hgz.env`;
   в резервную копию он попадает (уже известная MEDIUM про `hgz.env`).
9. **Рост базы.** Снимки страниц — на диск, не в SQLite; иначе копии
   раздуются (см. §2 плана 1B про размер архивов).
10. **Расползание объёма.** 11 агентов и 11 страниц сразу не строятся:
    Фазы 1–5 дают работающий продукт, остальное — после.

---

## 17. Открытые вопросы к владельцу

1. **Конкуренты:** кого считаем основными (Кнауф, Волма, Юнис, местные
   заводы КЧР и Ставрополья)? Нужен список из 5–10 названий с сайтами.
2. **Регионы:** где завод продаёт сейчас и куда хочет? Список регионов.
3. **Дилеры:** есть ли перечень действующих дилеров (название, город,
   контакт)? В каком виде — Excel, 1С, на бумаге?
4. **Себестоимость:** существует ли она в цифрах и кто вправе её видеть в
   приложении (только вы или ещё директор)?
5. **РРЦ и дилерские цены:** есть ли утверждённая политика?
6. **Продажи:** есть ли выгрузка отгрузок за прошлые периоды (хотя бы
   помесячно по товарам)? Без неё «аналитика продаж» пустая.
7. **1С:** появился ли доступ от IT завода?
8. **Кто будет пользоваться AI:** только вы, или менеджеры тоже?
9. **Бюджет на LLM:** какой потолок в месяц считать приемлемым?
10. **Сбор данных с сайтов конкурентов:** согласовано ли это решением завода?
11. **Сроки:** что важнее в первую очередь — сравнение с конкурентами,
    цены или поиск дилеров?

## 18. Что нужно предоставить со стороны Habez Gips

| Что | Зачем | Формат |
|---|---|---|
| Список конкурентов с сайтами | Фаза 3 | 5–10 строк |
| Их прайсы, если есть на руках | первые наблюдения цен | PDF/Excel/фото |
| Список регионов продаж | привязка цен и дилеров | список |
| Список дилеров | Фаза 6, покрытие | Excel или список |
| Себестоимость по позициям | Pricing Agent, маржа | Excel, конфиденциально |
| РРЦ и дилерская политика | ценовые коридоры | документ |
| Выгрузка отгрузок за 12 месяцев | аналитика продаж | Excel из 1С |
| Паспорта качества, сертификаты, инструкции | наполнить `media` типами `doc`/`cert` | PDF |
| Артикулы (SKU) заводские | связь с 1С и сравнение | Excel |
| Доступ к 1С | автоматизация | учётная запись/выгрузка |
| Ключ OpenRouter | работа модели | вводится владельцем на сервере |
| Решение о мониторинге сайтов | юридическая сторона | устно/письмом |

---

## 19. Конкретный план следующего шага

**Сейчас ничего не разрабатываем.** Следующий шаг — ваш ответ на §17
(хотя бы пункты 1, 2, 8, 9, 10) и решение об очерёдности:

**Вариант А (рекомендую).** Сначала закончить этап 1B — поставить сервер.
Без него не будет ни ежедневного мониторинга, ни доступа менеджеров.
Habez AI начинаем с Фазы 1 сразу после запуска сайта на сервере.

**Вариант Б.** Начать Фазы 1–3 локально (база знаний, характеристики,
конкуренты вручную), сервер ставить параллельно. Чат и мониторинг всё
равно ждут сервера, но к его запуску база знаний уже будет наполнена.

**Вариант В.** Сначала закрыть MEDIUM-находки ревью 1A (Cache-Control,
CSP/PDF, systemd) и карту статусов заказа, а AI начать после.

В любом варианте первым техническим шагом Habez AI будет **Фаза 1**:
одна миграция с пятью таблицами, сервис фактов, флаг `AI_ENABLED=0` по
умолчанию — работающий каталог этого даже не заметит.
