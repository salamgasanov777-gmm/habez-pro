-- HGZ Pro — схема данных. SQLite (совместима с Postgres при минимальной правке типов).
-- Мультитенантность: одна установка обслуживает несколько заводов/дилеров.
-- Все бизнес-таблицы несут tenant_id и изолированы на уровне запросов.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────── Тенанты и настройки ───────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,          -- habez
  host          TEXT UNIQUE,                   -- habez.example.ru (резолв по домену)
  name          TEXT NOT NULL,
  legal_name    TEXT,
  inn           TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  logo_url      TEXT,
  theme         TEXT NOT NULL DEFAULT '{}',    -- JSON: цвета, шрифт, акцент
  settings      TEXT NOT NULL DEFAULT '{}',    -- JSON: валюта, НДС, режим цен, минимальный заказ
  plan          TEXT NOT NULL DEFAULT 'pro',   -- free | pro | enterprise
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────── Пользователи и доступ ──────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT,
  phone         TEXT,
  name          TEXT,
  company       TEXT,
  inn           TEXT,
  password_hash TEXT,                          -- scrypt: salt:hash (NULL — вход только по коду)
  role          TEXT NOT NULL DEFAULT 'customer', -- customer | dealer | manager | admin | owner
  price_tier    TEXT NOT NULL DEFAULT 'retail',   -- retail | dealer | vip
  status        TEXT NOT NULL DEFAULT 'active',   -- active | pending | blocked
  email_verified INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_email ON users(tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_phone ON users(tenant_id, phone) WHERE phone IS NOT NULL;

-- Refresh-токены хранятся хешем: утечка базы не даёт войти в чужой аккаунт.
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- Одноразовые коды: вход по телефону/почте, подтверждение, сброс пароля.
CREATE TABLE IF NOT EXISTS otp_codes (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,                 -- phone | email
  destination   TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'login',
  attempts      INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_otp_lookup ON otp_codes(tenant_id, destination, purpose);

-- ─────────────────────────────── Каталог ───────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_slug ON categories(tenant_id, slug);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  slug          TEXT NOT NULL,
  sku           TEXT,
  name          TEXT NOT NULL,
  short_name    TEXT,                          -- «АКВАЛАЙТ» — для сравнения и чипов
  summary       TEXT,
  gost          TEXT,
  brand         TEXT,
  status        TEXT NOT NULL DEFAULT 'published', -- draft | published | archived
  -- Технический контент карточки. JSON вместо таблиц-справочников: структура
  -- у каждого товара своя, а читается всегда целиком одной карточкой.
  badges        TEXT NOT NULL DEFAULT '[]',    -- [{label,value}]
  sections      TEXT NOT NULL DEFAULT '[]',    -- [{title,text}]
  spec_tables   TEXT NOT NULL DEFAULT '[]',    -- [{title,rows:[[l,v]]}]
  tasks         TEXT NOT NULL DEFAULT '[]',    -- ["wet","facade"] — подбор по задаче
  calc          TEXT,                          -- {type,ratePerM2,pack,packUnit}
  attributes    TEXT NOT NULL DEFAULT '{}',    -- нормализованные поля для фильтров
  seo_title     TEXT,
  seo_description TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  views         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_slug ON products(tenant_id, slug);
CREATE INDEX IF NOT EXISTS ix_products_cat ON products(tenant_id, category_id, status);

-- Фасовка = торговая единица. Цена и остаток живут здесь, а не на товаре:
-- мешок 30 кг и мешок 5 кг — разные позиции в заказе.
CREATE TABLE IF NOT EXISTS variants (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT,
  unit          TEXT NOT NULL,                 -- «мешок 30 кг»
  pack_size     REAL,                          -- 30
  pack_unit     TEXT,                          -- кг | л
  weight_kg     REAL,
  per_pallet    INTEGER,                       -- мешков на паллете — для оптовой логистики
  barcode       TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'photo', -- photo | doc | cert
  url           TEXT NOT NULL,
  url_webp      TEXT,
  title         TEXT,
  mime          TEXT,
  bytes         INTEGER,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_media_product ON media(product_id);

-- Цена зависит от того, кто смотрит. Розница видит одну, дилер — другую.
CREATE TABLE IF NOT EXISTS prices (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  tier          TEXT NOT NULL DEFAULT 'retail',-- retail | dealer | vip
  amount        INTEGER,                       -- в копейках; NULL = «цена по запросу»
  currency      TEXT NOT NULL DEFAULT 'RUB',
  min_qty       INTEGER NOT NULL DEFAULT 1,
  valid_from    TEXT,
  valid_to      TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_prices ON prices(variant_id, tier, min_qty);

-- Push-уведомления менеджерам. Одна строка — одно устройство: у менеджера
-- может быть телефон и компьютер, оба получат заказ. Адрес (endpoint) выдаёт
-- браузер, он уникален; протухшие адреса удаляются при первой же ошибке.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_push_user ON push_subscriptions(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS stock (
  variant_id    INTEGER PRIMARY KEY REFERENCES variants(id) ON DELETE CASCADE,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL DEFAULT 0,
  reserved      INTEGER NOT NULL DEFAULT 0,
  warehouse     TEXT NOT NULL DEFAULT 'main',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Полнотекстовый поиск: FTS5 внешним содержимым, синхронизируется триггерами.
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, summary, gost, body, tokenize = 'unicode61 remove_diacritics 2'
);

-- ──────────────────────────────── Корзина ──────────────────────────────────

CREATE TABLE IF NOT EXISTS carts (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,          -- гостевая корзина в cookie
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | ordered | abandoned
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_carts_user ON carts(user_id);

CREATE TABLE IF NOT EXISTS cart_items (
  id            INTEGER PRIMARY KEY,
  cart_id       INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cart_items ON cart_items(cart_id, variant_id);

-- ──────────────────────────────── Заказы ───────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        TEXT NOT NULL,                 -- ХГЗ-2609-0042
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'new',   -- new|confirmed|paid|shipping|done|cancelled
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending|paid|refunded|failed
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  company       TEXT,
  inn           TEXT,
  delivery_type TEXT NOT NULL DEFAULT 'pickup',-- pickup | delivery
  delivery_address TEXT,
  delivery_cost INTEGER NOT NULL DEFAULT 0,
  comment       TEXT,
  subtotal      INTEGER NOT NULL DEFAULT 0,
  discount      INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'RUB',
  promo_code    TEXT,
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manager_note  TEXT,
  source        TEXT NOT NULL DEFAULT 'web',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_number ON orders(tenant_id, number);
CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(tenant_id, status, created_at);

-- Позиции копируют название и цену на момент заказа: прайс поменяется,
-- а документ по старому заказу должен остаться прежним.
CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id    INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  unit          TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  price         INTEGER NOT NULL,
  total         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  note          TEXT,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,                 -- mock | yookassa | invoice
  provider_id   TEXT,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'RUB',
  status        TEXT NOT NULL DEFAULT 'pending',
  confirmation_url TEXT,
  idempotence_key TEXT UNIQUE,
  raw           TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_payments_order ON payments(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider ON payments(provider, provider_id);

CREATE TABLE IF NOT EXISTS promo_codes (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'percent', -- percent | fixed
  value         INTEGER NOT NULL,
  min_total     INTEGER NOT NULL DEFAULT 0,
  uses_left     INTEGER,
  valid_to      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_promo ON promo_codes(tenant_id, code);

-- ───────────────────────── Заявки, избранное, аудит ────────────────────────

-- Цены у завода часто «по запросу» — заявка равноправна с заказом, а не костыль.
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'quote', -- quote | dealer | callback | question
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  company       TEXT,
  message       TEXT,
  payload       TEXT NOT NULL DEFAULT '{}',    -- корзина/товар, с которого пришла заявка
  status        TEXT NOT NULL DEFAULT 'new',   -- new | in_work | done | spam
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_leads_status ON leads(tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS favorites (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER,
  actor_id      INTEGER,
  action        TEXT NOT NULL,
  entity        TEXT,
  entity_id     TEXT,
  diff          TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(tenant_id, created_at);

-- Счётчики просмотров и поиска — для панели «что спрашивают, чего нет».
CREATE TABLE IF NOT EXISTS search_log (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL,
  query         TEXT NOT NULL,
  results       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
