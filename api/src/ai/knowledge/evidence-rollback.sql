-- Откат миграций 2026-09-ai-evidence и 2026-09-ai-reconciliation. Удаляет
-- только таблицы наблюдений и сверки; ai_product_specs, ai_facts,
-- ai_sources и каталог не затрагиваются.
-- ВНИМАНИЕ: если прогон R1 (поддоны) был применён, сначала откатите его
-- командой `npm run ai:reconcile-repair -- --rollback <run_id>`: иначе
-- журнал со старыми значениями per_pallet исчезнет вместе с таблицами.
-- Перед запуском — копия базы (./scripts/backup-db.sh).
DROP TABLE IF EXISTS ai_repair_changes;
DROP TABLE IF EXISTS ai_repair_runs;
DROP TABLE IF EXISTS ai_reconciliation_members;
DROP TABLE IF EXISTS ai_reconciliation_items;
DROP TABLE IF EXISTS ai_observation_relations;
DROP TABLE IF EXISTS ai_source_type_priorities;
DROP TABLE IF EXISTS ai_spec_observations;
DELETE FROM migrations WHERE name IN ('2026-09-ai-evidence', '2026-09-ai-reconciliation');
