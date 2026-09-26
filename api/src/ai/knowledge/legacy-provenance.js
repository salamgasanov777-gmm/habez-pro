// Habez AI, Phase 2.2C: происхождение старых строк ai_product_specs.
// Чистые функции, без базы: их используют и перенос в наблюдения
// (evidence.js), и сверка только на чтение (reconcile-dry-run.js).
//
// Правило: «строка ai_product_specs» ≠ «доказательство из карточки».
// Карточкой строка считается, только если в текущей карточке товара
// найдена ровно та строка ярлыка или таблицы, из которой её перенесли:
// тот же вид (ярлык / таблица), тот же заголовок таблицы, тот же ключ
// словаря и то же значение. Иначе — unknown_legacy_origin.
import { keyForLabel, skipReason } from "./spec-dictionary.js";
import { parseSpecValue } from "./units.js";

const parseJson = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

// Строки карточки так же, как их видит перенос (import-specs.js).
export function cardItems(product) {
  const items = [];
  for (const b of parseJson(product.badges, [])) {
    if (b?.label) items.push({ label: b.label, value: b.value, from: "badge", ref: "ярлык карточки" });
  }
  for (const table of parseJson(product.spec_tables, [])) {
    for (const row of table?.rows || []) {
      if (Array.isArray(row) && row.length >= 2 && row[0]) {
        items.push({ label: row[0], value: row[1], from: "spec_table", ref: table.title || "таблица" });
      }
    }
  }
  return items.map((it) => {
    const skipped = !!skipReason(it.label);
    const key = skipped ? null : keyForLabel(it.label);
    return { ...it, key, skipped, display: parseSpecValue(it.value).displayValue };
  });
}

export function findCardRow(spec, product) {
  const matches = cardItems(product).filter((it) =>
    it.from === spec.imported_from && it.ref === spec.source_ref
    && it.key === spec.spec_key && it.display === spec.display_value);
  return { row: matches[0] || null, count: matches.length };
}

// Вид источника старой строки для переноса в наблюдения.
export function legacyProvenance(spec, product) {
  if (spec.origin === "ai_inference") return { sourceType: "ai_inference", row: null, reason: "origin = ai_inference" };
  if (spec.imported_from === "badge" || spec.imported_from === "spec_table") {
    if (!product) return { sourceType: "unknown_legacy_origin", row: null, reason: "товар не найден" };
    const { row, count } = findCardRow(spec, product);
    if (count === 1) return { sourceType: "product_card", row, reason: "строка найдена в текущей карточке" };
    if (count > 1) return { sourceType: "product_card", row, reason: `в карточке ${count} одинаковые строки` };
    return { sourceType: "unknown_legacy_origin", row: null, reason: "строки с таким значением в текущей карточке нет" };
  }
  if (spec.imported_from === "manual" && spec.origin === "habez_internal") {
    return { sourceType: "manual_entry", row: null, reason: "внесено вручную без документа" };
  }
  return { sourceType: "unknown_legacy_origin", row: null, reason: `imported_from=${spec.imported_from ?? "—"}, origin=${spec.origin ?? "—"}` };
}
