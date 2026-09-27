-- Habez AI, фаза 2: машиночитаемые характеристики товаров Habez.
--
-- Зачем отдельная таблица, если есть products.badges и spec_tables: там всё
-- лежит строками («не менее 0,5 МПа»), и сравнить «2 МПа» с «2,5 МПа» кодом
-- нельзя. Здесь то же самое, но с числом, единицей и происхождением.
-- Карточки товара не меняются: это дополнительное представление.
--
-- Фасовки, вес, штрихкоды и количество на поддоне сюда НЕ переносятся —
-- они уже есть в variants, второй раз заводить нельзя.

CREATE TABLE IF NOT EXISTS ai_product_specs (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id          INTEGER REFERENCES variants(id) ON DELETE CASCADE,  -- если характеристика фасовки
  spec_key            TEXT NOT NULL,          -- ключ словаря: compressive_strength
  label               TEXT NOT NULL,          -- подпись для человека
  -- Исходная строка из карточки хранится всегда: она главная для человека
  -- и доказывает, что число не выдумано.
  display_value       TEXT NOT NULL,
  -- Числовое представление. Для диапазона («3–70 мм») одного числа нет:
  -- заполняются min и max, value_num остаётся пустым.
  value_num           REAL,
  value_min           REAL,
  value_max           REAL,
  value_bool          INTEGER,                -- ДА/НЕТ из таблиц пригодности
  value_text          TEXT,                   -- цвет, ГОСТ и прочее неисчислимое
  unit_raw            TEXT,                   -- как написано: «МПа», «мин», «см»
  normalized_unit     TEXT,                   -- канон: MPa, min, mm, kg/m2
  comparator          TEXT,                   -- exact | min | max | range | approx
  -- Происхождение и доверие — те же правила, что у ai_facts (фаза 1).
  source_id           INTEGER REFERENCES ai_sources(id) ON DELETE SET NULL,
  fact_id             INTEGER REFERENCES ai_facts(id) ON DELETE SET NULL,
  origin              TEXT NOT NULL DEFAULT 'habez_internal',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  confidence          INTEGER NOT NULL DEFAULT 50,
  imported_from       TEXT,                   -- badge | spec_table | manual
  source_ref          TEXT,                   -- заголовок таблицы или «ярлык карточки»
  parse_note          TEXT,                   -- почему значение осталось текстом
  observed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  checked_at          TEXT,
  verified_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Одна характеристика на товар: иначе сравнение «наш ↔ чужой» получит два
-- разных числа для одного свойства и выберет любое.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_specs ON ai_product_specs(tenant_id, product_id, spec_key);
CREATE INDEX IF NOT EXISTS ix_ai_specs_product ON ai_product_specs(tenant_id, product_id);
CREATE INDEX IF NOT EXISTS ix_ai_specs_key ON ai_product_specs(tenant_id, spec_key, normalized_unit);
CREATE INDEX IF NOT EXISTS ix_ai_specs_status ON ai_product_specs(tenant_id, verification_status);
