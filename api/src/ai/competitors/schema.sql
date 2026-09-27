-- Habez AI, 3.5 Competitor Intelligence (roadmap: Phase 3 — Competitors).
-- Миграция 2026-09-ai-competitors: ТОЛЬКО новые таблицы. products,
-- ai_spec_observations, ai_facts, ai_sources и таблицы сверки не меняются.
-- Подробно — docs/HABEZ-AI-PHASE-3-5-COMPETITOR-INTELLIGENCE.md.
--
-- Общие правила (как у модели наблюдений 2.2B):
--   * строки не удаляются: lifecycle_status = withdrawn (снято человеком)
--     или superseded (заменено другим наблюдением); у наблюдений, цен и
--     аналогов удаление запрещено триггером;
--   * значение наблюдения и цены после записи не меняется — новое
--     значение = новая строка;
--   * access_level — public | internal | confidential; новое — internal;
--   * name_key — имя в нижнем регистре без кавычек (SQLite не приводит
--     кириллицу к одному регистру сам); по нему — уникальность.

-- Регион: где продаёт компания и где наблюдалась цена.
CREATE TABLE IF NOT EXISTS ai_regions (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'region',     -- country | district | region | city | other
  parent_id           INTEGER REFERENCES ai_regions(id) ON DELETE RESTRICT,
  code                TEXT,                                -- код субъекта, если известен
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',      -- active | withdrawn
  withdrawn_reason    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_regions_name ON ai_regions(tenant_id, name_key, COALESCE(parent_id, 0)) WHERE lifecycle_status = 'active';

-- Компания: производитель, владелец марки, дилер, дистрибьютор, сеть,
-- маркетплейс. Запись сама по себе НЕ делает компанию конкурентом:
-- competitor_status ставит человек (по умолчанию unknown). Наш завод здесь
-- не хранится — он в реквизитах (tenants), как в Phase 3.4.
CREATE TABLE IF NOT EXISTS ai_companies (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL,
  legal_name          TEXT,
  inn                 TEXT,
  website             TEXT,
  kind                TEXT NOT NULL DEFAULT 'unknown',     -- manufacturer | brand_owner | dealer | distributor | retail_chain | marketplace | unknown
  competitor_status   TEXT NOT NULL DEFAULT 'unknown',     -- competitor | not_competitor | unknown
  hq_region_id        INTEGER REFERENCES ai_regions(id) ON DELETE SET NULL,
  notes               TEXT,
  access_level        TEXT NOT NULL DEFAULT 'internal',
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',      -- active | withdrawn
  withdrawn_reason    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_companies_name ON ai_companies(tenant_id, name_key) WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS ix_ai_companies_kind ON ai_companies(tenant_id, kind, competitor_status);

-- Марка (торговое название). Всегда принадлежит компании; марка — не
-- компания и не завод, даже если названия совпадают.
CREATE TABLE IF NOT EXISTS ai_brands (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          INTEGER NOT NULL REFERENCES ai_companies(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL,
  notes               TEXT,
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',
  withdrawn_reason    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_brands_name ON ai_brands(tenant_id, company_id, name_key) WHERE lifecycle_status = 'active';

-- Товар конкурента. В products (витрина) не попадает никогда.
-- category_id — наш раздел каталога для сопоставления, не больше.
CREATE TABLE IF NOT EXISTS ai_competitor_products (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          INTEGER NOT NULL REFERENCES ai_companies(id) ON DELETE RESTRICT,
  brand_id            INTEGER REFERENCES ai_brands(id) ON DELETE RESTRICT,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL,
  short_name          TEXT,
  gost                TEXT,                                -- ГОСТ / ТУ, как написано в источнике
  market_status       TEXT NOT NULL DEFAULT 'unknown',     -- active | discontinued | unknown
  notes               TEXT,
  access_level        TEXT NOT NULL DEFAULT 'internal',
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',
  withdrawn_reason    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_cprod_name ON ai_competitor_products(tenant_id, company_id, name_key) WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS ix_ai_cprod_brand ON ai_competitor_products(tenant_id, brand_id);
CREATE INDEX IF NOT EXISTS ix_ai_cprod_category ON ai_competitor_products(tenant_id, category_id);

-- Фасовка товара конкурента (аналог variants).
CREATE TABLE IF NOT EXISTS ai_competitor_packs (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  competitor_product_id INTEGER NOT NULL REFERENCES ai_competitor_products(id) ON DELETE RESTRICT,
  unit_label          TEXT NOT NULL,                       -- «мешок 25 кг», как в источнике
  pack_size           REAL,
  pack_unit           TEXT,                                -- кг | л | шт | м² …
  weight_kg           REAL,
  barcode             TEXT,
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',
  withdrawn_reason    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_cpack_label ON ai_competitor_packs(tenant_id, competitor_product_id, unit_label) WHERE lifecycle_status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_cpack_barcode ON ai_competitor_packs(tenant_id, barcode) WHERE barcode IS NOT NULL AND lifecycle_status = 'active';

-- Наблюдение характеристики товара конкурента. Столбцы и смысл — как у
-- ai_spec_observations (2.2B): условие только с цитатой, тип утверждения,
-- исходная строка всегда, число — если разобралось. Источник обязателен
-- (внешний факт без документа не принимается).
CREATE TABLE IF NOT EXISTS ai_competitor_observations (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  competitor_product_id INTEGER NOT NULL REFERENCES ai_competitor_products(id) ON DELETE RESTRICT,
  pack_id             INTEGER REFERENCES ai_competitor_packs(id) ON DELETE RESTRICT,
  spec_key            TEXT NOT NULL,
  label               TEXT,
  conditions_json     TEXT NOT NULL DEFAULT '{}',
  condition_key       TEXT NOT NULL DEFAULT '',
  condition_text      TEXT,
  statement_type      TEXT NOT NULL DEFAULT 'unknown',
  original_value      TEXT NOT NULL,
  value_num           REAL,
  value_min           REAL,
  value_max           REAL,
  value_bool          INTEGER,
  value_text          TEXT,
  unit_raw            TEXT,
  normalized_unit     TEXT,
  comparator          TEXT,
  parse_note          TEXT,
  source_type         TEXT NOT NULL,                       -- вид документа (evidence-model.js, подмножество)
  source_id           INTEGER NOT NULL REFERENCES ai_sources(id) ON DELETE RESTRICT,
  source_reference    TEXT,                                -- страница, раздел, номер документа
  provided_at         TEXT,                                -- дата документа / страницы
  captured_at         TEXT NOT NULL DEFAULT (datetime('now')),  -- когда внесено
  access_level        TEXT NOT NULL DEFAULT 'internal',
  evidence_note       TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',      -- active | superseded | withdrawn
  replaced_by_id      INTEGER REFERENCES ai_competitor_observations(id) ON DELETE RESTRICT,
  lifecycle_note      TEXT,
  content_hash        TEXT NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_cobs_dup ON ai_competitor_observations(tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_ai_cobs_property ON ai_competitor_observations(tenant_id, competitor_product_id, spec_key, pack_id, condition_key);
CREATE INDEX IF NOT EXISTS ix_ai_cobs_source ON ai_competitor_observations(tenant_id, source_id);

-- Наблюдение цены. Таблица общая по замыслу архитектуры (§7.2): сейчас —
-- только товар конкурента (обязателен в коде), в Phase 6 — и наши товары
-- (добавятся столбцы, существующие строки не меняются).
-- Цена в копейках; основа цены обязательна и не пересчитывается
-- («за мешок 25 кг» ≠ «за кг»); дата и источник обязательны.
CREATE TABLE IF NOT EXISTS ai_price_observations (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  competitor_product_id INTEGER REFERENCES ai_competitor_products(id) ON DELETE RESTRICT,
  pack_id             INTEGER REFERENCES ai_competitor_packs(id) ON DELETE RESTRICT,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'RUB',
  price_kind          TEXT NOT NULL,                       -- retail | wholesale | dealer | rrp | promo | marketplace
  price_basis         TEXT NOT NULL,                       -- как в источнике: «за мешок 25 кг»
  basis_unit          TEXT NOT NULL,                       -- pack | kg | l | m2 | pcs | other
  basis_qty           REAL,                                -- 25 (кг в мешке), если указано
  vat                 TEXT NOT NULL DEFAULT 'unknown',     -- with_vat | without_vat | unknown
  seller_company_id   INTEGER REFERENCES ai_companies(id) ON DELETE RESTRICT,
  region_id           INTEGER REFERENCES ai_regions(id) ON DELETE RESTRICT,
  observed_at         TEXT NOT NULL,                       -- дата, на которую цена наблюдалась
  source_id           INTEGER NOT NULL REFERENCES ai_sources(id) ON DELETE RESTRICT,
  source_reference    TEXT,
  captured_at         TEXT NOT NULL DEFAULT (datetime('now')),
  access_level        TEXT NOT NULL DEFAULT 'internal',
  evidence_note       TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',
  replaced_by_id      INTEGER REFERENCES ai_price_observations(id) ON DELETE RESTRICT,
  lifecycle_note      TEXT,
  content_hash        TEXT NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_price_dup ON ai_price_observations(tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_ai_price_subject ON ai_price_observations(tenant_id, competitor_product_id, pack_id, observed_at);
CREATE INDEX IF NOT EXISTS ix_ai_price_region ON ai_price_observations(tenant_id, region_id, price_kind);

-- Связь «наш товар ↔ товар конкурента». Хранятся только утверждения с
-- допустимым основанием: прямое указание источника или решение сотрудника
-- (с обоснованием). Статус CONFIRMED / INFERRED / UNKNOWN / CONFLICTED
-- вычисляется при чтении (analogs.js); INFERRED не хранится никогда.
CREATE TABLE IF NOT EXISTS ai_competitor_analogs (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  competitor_product_id INTEGER NOT NULL REFERENCES ai_competitor_products(id) ON DELETE RESTRICT,
  relation            TEXT NOT NULL,                       -- analog | partial_analog | not_analog
  basis               TEXT NOT NULL,                       -- explicit_source_statement | user_decision
  source_id           INTEGER REFERENCES ai_sources(id) ON DELETE RESTRICT,
  source_reference    TEXT,
  note                TEXT,                                -- обоснование; для решения сотрудника обязательно
  differences         TEXT,                                -- чем отличается (для частичного аналога)
  access_level        TEXT NOT NULL DEFAULT 'internal',
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',      -- active | withdrawn
  withdrawn_reason    TEXT,
  withdrawn_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at        TEXT,
  content_hash        TEXT NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (relation IN ('analog', 'partial_analog', 'not_analog')),
  CHECK (basis IN ('explicit_source_statement', 'user_decision')),
  CHECK (basis <> 'explicit_source_statement' OR source_id IS NOT NULL),
  CHECK (basis <> 'user_decision' OR (note IS NOT NULL AND length(trim(note)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_analog_dup ON ai_competitor_analogs(tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_ai_analog_pair ON ai_competitor_analogs(tenant_id, product_id, competitor_product_id);
CREATE INDEX IF NOT EXISTS ix_ai_analog_competitor ON ai_competitor_analogs(tenant_id, competitor_product_id);

-- История не уничтожается: удалять наблюдения, цены и аналоги нельзя,
-- значение и источник после записи не меняются.
CREATE TRIGGER IF NOT EXISTS trg_ai_cobs_no_delete BEFORE DELETE ON ai_competitor_observations
BEGIN SELECT RAISE(ABORT, 'ai_competitor_observations: удаление запрещено, используйте withdrawn'); END;
CREATE TRIGGER IF NOT EXISTS trg_ai_price_no_delete BEFORE DELETE ON ai_price_observations
BEGIN SELECT RAISE(ABORT, 'ai_price_observations: удаление запрещено, используйте withdrawn'); END;
CREATE TRIGGER IF NOT EXISTS trg_ai_analog_no_delete BEFORE DELETE ON ai_competitor_analogs
BEGIN SELECT RAISE(ABORT, 'ai_competitor_analogs: удаление запрещено, используйте withdrawn'); END;
CREATE TRIGGER IF NOT EXISTS trg_ai_cobs_immutable BEFORE UPDATE OF competitor_product_id, pack_id, spec_key, condition_key, statement_type, original_value, source_type, source_id, source_reference, provided_at, content_hash ON ai_competitor_observations
BEGIN SELECT RAISE(ABORT, 'ai_competitor_observations: значение и источник не меняются — новое значение = новое наблюдение'); END;
CREATE TRIGGER IF NOT EXISTS trg_ai_price_immutable BEFORE UPDATE OF competitor_product_id, pack_id, amount_minor, currency, price_kind, price_basis, basis_unit, basis_qty, vat, seller_company_id, region_id, observed_at, source_id, source_reference, content_hash ON ai_price_observations
BEGIN SELECT RAISE(ABORT, 'ai_price_observations: цена и источник не меняются — новая цена = новое наблюдение'); END;
CREATE TRIGGER IF NOT EXISTS trg_ai_analog_immutable BEFORE UPDATE OF product_id, competitor_product_id, relation, basis, source_id, source_reference, note, content_hash ON ai_competitor_analogs
BEGIN SELECT RAISE(ABORT, 'ai_competitor_analogs: утверждение не меняется — новое утверждение = новая строка'); END;
