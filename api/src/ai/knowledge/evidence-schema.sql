-- Habez AI, Phase 2.2B: наблюдения и доказательства.
--
-- Зачем: ai_product_specs держит одно значение на свойство товара
-- (уникальность tenant + product + spec_key). Этого мало: у одного свойства
-- бывает значение карточки, письма технолога и паспорта, у разных фасовок —
-- разные числа, у прочности — возраст 7 или 28 суток. Здесь каждое такое
-- утверждение — отдельная строка, и ни одна не затирает другую.
--
-- ai_product_specs не меняется и не удаляется. Canonical-источник для AI —
-- эти наблюдения; ai_product_specs — проекция «одно значение на ключ», на
-- которой пока работают существующие /api/ai/* (переходный период, см.
-- docs/HABEZ-AI-EVIDENCE-MODEL.md §8.2). Связь со старой записью —
-- legacy_spec_id.
--
-- Откат: evidence-rollback.sql (удаляет только эти три таблицы).

CREATE TABLE IF NOT EXISTS ai_spec_observations (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id          INTEGER REFERENCES variants(id) ON DELETE CASCADE,  -- фасовка / SKU; NULL — весь товар
  spec_key            TEXT NOT NULL,          -- ключ словаря (spec-dictionary.js) или фасовочный ключ (evidence-model.js)
  label               TEXT,                   -- подпись так, как в источнике
  -- Условие значения. conditions_json — разобранное человеком ({"age_days":7}),
  -- condition_key — его каноническая строка («age_days=7»), по ней наблюдения
  -- группируются: 7 и 28 суток — разные группы, а не спор двух значений.
  -- Условие без дословной цитаты (condition_text) не принимается: условие
  -- из воздуха — такое же выдуманное значение.
  conditions_json     TEXT NOT NULL DEFAULT '{}',
  condition_key       TEXT NOT NULL DEFAULT '',
  condition_text      TEXT,                   -- как написано: «в возрасте 7 сут»
  statement_type      TEXT NOT NULL DEFAULT 'unknown',  -- declared | measured | norm | instruction | replacement | unknown
  -- Значение: исходная строка — всегда, число — если разобралось.
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
  -- Происхождение. source_type — вид доказательства (письмо технолога,
  -- паспорт, карточка…), source_id — необязательная ссылка на ai_sources.
  source_type         TEXT NOT NULL,
  source_id           INTEGER REFERENCES ai_sources(id) ON DELETE RESTRICT,
  source_name         TEXT,
  source_reference    TEXT,                   -- безопасный идентификатор: technologist-note-2026-09-05
  provided_by         TEXT,                   -- роль, не имя и не почта: factory_technologist
  provided_at         TEXT,                   -- дата документа
  captured_at         TEXT NOT NULL DEFAULT (datetime('now')),  -- когда внесено в систему
  access_level        TEXT NOT NULL DEFAULT 'internal',         -- public | internal | confidential
  evidence_note       TEXT,
  evidence_ref        TEXT,                   -- путь к скану документа (позже)
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  -- Насколько точно значение прочитано из источника (0–100), NULL — не
  -- оценивалось. Это НЕ доверие к источнику: доверие к виду источника
  -- задаёт только владелец (ai_source_type_priorities). В выборе
  -- действующего значения не участвует.
  extraction_confidence INTEGER,
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  checked_at          TEXT,
  verify_note         TEXT,
  -- active — участвует в выборе значения; superseded — заменено другим
  -- наблюдением (причина — строка в ai_observation_relations); withdrawn —
  -- снято человеком. Строка не удаляется ни в одном из случаев.
  lifecycle_status    TEXT NOT NULL DEFAULT 'active',
  -- Ссылка на строку ai_product_specs, из которой перенесено наблюдение.
  -- Доверие (confidence) и origin старой записи сюда не копируются — они
  -- остаются в самой строке и доступны по этой ссылке.
  legacy_spec_id      INTEGER REFERENCES ai_product_specs(id) ON DELETE SET NULL,
  legacy_origin       TEXT,
  -- Два звена происхождения храним раздельно (решение D8):
  -- capture_* — как значение попало в систему (доказано: «строка карточки
  -- Habez Pro»); upstream_* — откуда оно в карточке (коммит приложения №1,
  -- дата записи в №1 — это НЕ дата документа). source_type описывает
  -- первоисточник; если он не доказан — unknown_legacy_origin.
  capture_channel     TEXT,                   -- habez_pro_product_card | api | repair_plan | variants_record
  capture_ref         TEXT,                   -- «spec_table / Технические характеристики / Адгезия (прочность на отрыв)»
  upstream_ref        TEXT,                   -- app1-commit-e4ddf47
  upstream_recorded_at TEXT,                  -- дата коммита в №1
  -- Идемпотентный перенос: backfill_key — постоянный адрес записи
  -- («legacy-spec:312»), backfill_fingerprint — отпечаток её содержания.
  -- Повторный прогон с тем же ключом и тем же отпечатком ничего не делает,
  -- с другим отпечатком — останавливается (данные разошлись).
  backfill_key        TEXT,
  backfill_fingerprint TEXT,
  created_by_run      TEXT,                   -- ai_repair_runs.id; нужен для отката прогона
  content_hash        TEXT NOT NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Одно и то же утверждение из того же документа не записывается дважды.
-- Хеш включает товар, фасовку, ключ, условие, тип утверждения, вид и
-- ссылку источника и исходную строку — всё остальное может совпадать.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_obs_dup ON ai_spec_observations(tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_ai_obs_property ON ai_spec_observations(tenant_id, product_id, spec_key, variant_id, condition_key);
CREATE INDEX IF NOT EXISTS ix_ai_obs_source ON ai_spec_observations(tenant_id, source_type, source_reference);
CREATE INDEX IF NOT EXISTS ix_ai_obs_status ON ai_spec_observations(tenant_id, verification_status, lifecycle_status);
CREATE INDEX IF NOT EXISTS ix_ai_obs_legacy ON ai_spec_observations(legacy_spec_id);
-- Одна строка ai_product_specs → не больше одного наблюдения переноса.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_obs_legacy ON ai_spec_observations(tenant_id, legacy_spec_id) WHERE legacy_spec_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_obs_backfill ON ai_spec_observations(tenant_id, backfill_key) WHERE backfill_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ai_obs_run ON ai_spec_observations(created_by_run);

-- Связи между наблюдениями. «B заменяет A» — строка здесь, а не удаление A.
CREATE TABLE IF NOT EXISTS ai_observation_relations (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_observation_id INTEGER NOT NULL REFERENCES ai_spec_observations(id) ON DELETE CASCADE,
  to_observation_id   INTEGER NOT NULL REFERENCES ai_spec_observations(id) ON DELETE CASCADE,
  relation_type       TEXT NOT NULL,          -- replaces | conflicts_with | confirms | clarifies
  basis               TEXT NOT NULL,          -- explicit_source_statement | user_decision
  basis_note          TEXT,                   -- «в письме: 0,3 вместо 0,5»
  source_reference    TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_observation_id <> to_observation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_obs_rel ON ai_observation_relations(tenant_id, from_observation_id, to_observation_id, relation_type);
CREATE INDEX IF NOT EXISTS ix_ai_obs_rel_to ON ai_observation_relations(tenant_id, to_observation_id);

-- Приоритет видов источника. Намеренно пустая: порядок доверия утверждает
-- владелец (docs/HABEZ-AI-TECHNOLOGIST-DATA-AUDIT.md, решение №1). Пока
-- строк нет, расходящиеся наблюдения не разрешаются автоматически, а
-- уходят в «ждёт решения».
CREATE TABLE IF NOT EXISTS ai_source_type_priorities (
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type         TEXT NOT NULL,
  priority            INTEGER NOT NULL,       -- больше — весомее
  decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at          TEXT NOT NULL DEFAULT (datetime('now')),
  note                TEXT,
  PRIMARY KEY (tenant_id, source_type)
);
