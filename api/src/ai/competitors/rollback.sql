-- Откат миграции 2026-09-ai-competitors (3.5 Competitor Intelligence).
-- Удаляет только таблицы конкурентов; каталог, слой знаний, наблюдения
-- 2.2B и сверка 2.2D не затрагиваются. Перед запуском — копия базы
-- (./scripts/backup-db.sh): вместе с таблицами уходят все внесённые
-- сведения о конкурентах.
DROP TABLE IF EXISTS ai_competitor_analogs;
DROP TABLE IF EXISTS ai_price_observations;
DROP TABLE IF EXISTS ai_competitor_observations;
DROP TABLE IF EXISTS ai_competitor_packs;
DROP TABLE IF EXISTS ai_competitor_products;
DROP TABLE IF EXISTS ai_brands;
DROP TABLE IF EXISTS ai_companies;
DROP TABLE IF EXISTS ai_regions;
DELETE FROM migrations WHERE name = '2026-09-ai-competitors';
