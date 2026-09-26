-- Habez AI, Phase 2.2D: сверка и журнал исправлений.
--
-- ai_reconciliation_items — нерешённые вопросы о данных: спор значений,
-- кандидат на замену, кандидат на «одно и то же свойство». Статус
-- unresolved держится, пока владелец не примет решение; сам вопрос и его
-- участники не удаляются.
--
-- ai_repair_runs / ai_repair_changes — журнал прогонов исправления: что
-- было до, что стало, отпечатки, и всё, что нужно для отката.
--
-- Откат: evidence-rollback.sql.

CREATE TABLE IF NOT EXISTS ai_reconciliation_items (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_key            TEXT NOT NULL,          -- D1:standart:adhesion_strength | AUTO:nal:—:water_ratio:
  kind                TEXT NOT NULL,          -- value_conflict | candidate_replacement | semantic_mapping_candidate
  decision_ref        TEXT,                   -- D1…D10, план 2.2A §6 …
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id          INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  spec_key            TEXT NOT NULL,
  related_spec_key    TEXT,                   -- для кандидата «одно свойство»: второй ключ
  condition_key       TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'unresolved',  -- unresolved | resolved | dismissed
  rule_note           TEXT,                   -- почему не решено автоматически
  resolution_note     TEXT,
  resolved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TEXT,
  created_by_run      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_recon_item ON ai_reconciliation_items(tenant_id, item_key);
CREATE INDEX IF NOT EXISTS ix_ai_recon_status ON ai_reconciliation_items(tenant_id, status, kind);

CREATE TABLE IF NOT EXISTS ai_reconciliation_members (
  item_id             INTEGER NOT NULL REFERENCES ai_reconciliation_items(id) ON DELETE CASCADE,
  observation_id      INTEGER NOT NULL REFERENCES ai_spec_observations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'member',       -- member | older | newer
  PRIMARY KEY (item_id, observation_id)
);

CREATE TABLE IF NOT EXISTS ai_repair_runs (
  id                  TEXT PRIMARY KEY,       -- rr-2026…-xxxx
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operations          TEXT NOT NULL,          -- «R2,R3,R4,R5,R6» или «R1»
  plan_hash           TEXT NOT NULL,          -- отпечаток плана, который подтвердил человек
  manifest_hash       TEXT,
  status              TEXT NOT NULL,          -- applied | rolled_back
  counts_before       TEXT NOT NULL,          -- JSON
  counts_after        TEXT NOT NULL,
  fingerprint_before  TEXT NOT NULL,          -- JSON: таблица → отпечаток
  fingerprint_after   TEXT NOT NULL,
  backup_file         TEXT,
  actor               TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT NOT NULL,
  rolled_back_at      TEXT
);

-- Изменения существующих строк (только variants.per_pallet в R1): значение
-- до и после. По ним откат возвращает прежнее, если строку с тех пор не
-- трогали.
CREATE TABLE IF NOT EXISTS ai_repair_changes (
  id                  INTEGER PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES ai_repair_runs(id) ON DELETE CASCADE,
  table_name          TEXT NOT NULL,
  row_id              INTEGER NOT NULL,
  column_name         TEXT NOT NULL,
  before_value        TEXT,
  after_value         TEXT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS ix_ai_repair_changes_run ON ai_repair_changes(run_id);
