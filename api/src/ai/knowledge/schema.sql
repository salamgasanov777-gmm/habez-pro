-- Habez AI, фаза 1: слой знаний. Две таблицы — откуда сведение и само
-- сведение. История изменений отдельной таблицей не заводится: она уже есть
-- в audit_log, куда пишут все остальные разделы панели.
--
-- Каталог (products, variants, categories) не меняется и не дублируется:
-- факт ссылается на существующий товар через subject_type + subject_id.

CREATE TABLE IF NOT EXISTS ai_sources (
  id              INTEGER PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,                       -- habez_internal | manufacturer_site | dealer_site | marketplace | price_list | news_media | manual_research | document
  name            TEXT NOT NULL,
  url             TEXT,
  publisher       TEXT,                                -- кто издал: завод, дилер, редакция
  description     TEXT,
  trust_base      INTEGER NOT NULL DEFAULT 50,         -- 0–100, базовое доверие к источнику
  status          TEXT NOT NULL DEFAULT 'active',      -- active | paused | archived
  last_checked_at TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_ai_sources_tenant ON ai_sources(tenant_id, status, source_type);
-- Один и тот же адрес не заводится дважды: иначе одна страница даст два
-- источника с разным доверием, и факты разойдутся.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_sources_url ON ai_sources(tenant_id, url) WHERE url IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_facts (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fact_type           TEXT NOT NULL,                   -- spec | consumption | packaging | price | availability | application | document | company | market | other
  subject_type        TEXT NOT NULL,                   -- product | variant | category | company | market
  subject_id          INTEGER,                         -- products.id / variants.id / categories.id; NULL для market
  subject_label       TEXT,                            -- как объект назывался в момент записи (товар могут переименовать)
  attribute           TEXT NOT NULL,                   -- «прочность на сжатие», «расход», «цена розничная»
  -- Значение хранится и текстом (как в источнике), и числом (для сравнения).
  -- Структурная часть — для составных значений: диапазоны, таблицы, ссылки.
  value_text          TEXT,
  value_num           REAL,
  value_json          TEXT,
  unit                TEXT,                            -- МПа, кг/м², мин, ₽
  source_id           INTEGER REFERENCES ai_sources(id) ON DELETE RESTRICT,
  source_url          TEXT,                            -- точный адрес страницы, если отличается от адреса источника
  snapshot_ref        TEXT,                            -- путь к сохранённой копии страницы (заполняется в фазе 4)
  content_hash        TEXT,                            -- хеш значения: повторная запись того же не плодит дубли
  origin              TEXT NOT NULL,                   -- habez_internal | official_manufacturer | official_dealer | external_source | monitored | ai_inference
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  confidence          INTEGER NOT NULL DEFAULT 50,     -- 0–100
  observed_at         TEXT NOT NULL DEFAULT (datetime('now')),  -- когда сведение получено
  checked_at          TEXT,                            -- когда последний раз сверяли с источником
  recheck_after       TEXT,                            -- после этой даты факт считается устаревшим
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  verify_note         TEXT,
  supersedes_fact_id  INTEGER REFERENCES ai_facts(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Списки в панели: по объекту, по статусу, по источнику, по свежести.
CREATE INDEX IF NOT EXISTS ix_ai_facts_subject ON ai_facts(tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS ix_ai_facts_status ON ai_facts(tenant_id, verification_status, observed_at);
CREATE INDEX IF NOT EXISTS ix_ai_facts_source ON ai_facts(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS ix_ai_facts_type ON ai_facts(tenant_id, fact_type, origin);
CREATE INDEX IF NOT EXISTS ix_ai_facts_recheck ON ai_facts(tenant_id, recheck_after);
-- Один и тот же факт из одного источника не записывается дважды.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_facts_dup
  ON ai_facts(tenant_id, subject_type, subject_id, attribute, source_id, content_hash)
  WHERE content_hash IS NOT NULL;
