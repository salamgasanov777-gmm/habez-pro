// Перенос характеристик из карточек товара в машиночитаемый вид.
//
//   npm run ai:import-specs -- --dry-run    только показать, что получится
//   npm run ai:import-specs                 записать
//   npm run ai:import-specs -- --report     подробный отчёт по качеству данных
//
// Что делает: читает products.badges и products.spec_tables, сопоставляет
// подписи со словарём, разбирает значения и складывает в ai_product_specs.
// Карточки товара при этом НЕ меняются — это второе представление тех же
// данных, для сравнения и расчётов.
//
// Повторный запуск безопасен: значение из карточки обновляет запись, если
// оно изменилось, и не создаёт вторую. Подтверждённые человеком записи
// перезаписываются только при реальном изменении значения — и тогда
// подтверждение снимается, потому что подтверждали другое число.
import { all, get, insert, run, tx, db } from "../../db/index.js";
import { config } from "../../config.js";
import { parseSpecValue } from "./units.js";
import { keyForLabel, skipReason, specMeta } from "./spec-dictionary.js";
import { defaultConfidence } from "./model.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withReport = args.includes("--report");

const tenant = get("SELECT * FROM tenants WHERE slug=?", config.tenant.defaultSlug);
if (!tenant) { console.error("Компания не найдена — сначала npm run migrate && npm run seed"); process.exit(1); }
const t = tenant.id;

// Источник: карточки товара в самой системе. Заводится один раз.
function catalogSource() {
  const name = "Карточки товаров Habez Pro";
  const found = get("SELECT * FROM ai_sources WHERE tenant_id=? AND name=?", t, name);
  if (found) return found.id;
  if (dryRun) return null;
  return insert("ai_sources", {
    tenant_id: t, source_type: "habez_internal", name,
    publisher: tenant.name,
    description: "Характеристики, которые завод внёс в карточки товара в этой же системе",
    trust_base: 95, status: "active",
  });
}

const stat = {
  products: 0, productsWithSpecs: 0, rows: 0, skipped: 0, unmapped: 0,
  created: 0, updated: 0, unchanged: 0,
  numeric: 0, boolean: 0, text: 0, conflicts: 0,
};
const unmappedLabels = new Map();
const needsReview = [];
const conflicts = [];

function collect(product) {
  const items = [];
  for (const b of JSON.parse(product.badges || "[]")) {
    if (b?.label) items.push({ label: b.label, value: b.value, from: "badge", ref: "ярлык карточки" });
  }
  for (const table of JSON.parse(product.spec_tables || "[]")) {
    for (const row of table.rows || []) {
      if (Array.isArray(row) && row.length >= 2 && row[0]) {
        items.push({ label: row[0], value: row[1], from: "spec_table", ref: table.title || "таблица" });
      }
    }
  }
  return items;
}

// Сравниваем по сути, а не по написанию: «50 циклов» и «F50» — одно и то же,
// «0,3 МПа» и «не менее 0,3 МПа» — тоже. Настоящее расхождение — когда
// отличаются числа.
const sameMeaning = (a, b) =>
  a.valueNum === b.valueNum && a.valueMin === b.valueMin
  && a.valueMax === b.valueMax && a.valueBool === b.valueBool
  && a.normalizedUnit === b.normalizedUnit
  && (a.valueText ?? null) === (b.valueText ?? null);

function importProduct(product, sourceId) {
  let wrote = 0;

  // Сначала собираем все варианты одной характеристики, потом выбираем.
  const byKey = new Map();
  for (const item of collect(product)) {
    stat.rows++;
    if (skipReason(item.label)) { stat.skipped++; continue; }
    const key = keyForLabel(item.label);
    if (!key) {
      stat.unmapped++;
      unmappedLabels.set(item.label, (unmappedLabels.get(item.label) || 0) + 1);
      continue;
    }
    const parsed = parseSpecValue(item.value);
    if (!parsed.displayValue) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ item, parsed });
  }

  for (const [key, variants] of byKey) {
    // Таблица технических характеристик точнее ярлыка: в ней пишут
    // «не менее 0,3 МПа», в ярлыке — короткое «0,3 МПа».
    const chosen = variants.find((v) => v.item.from === "spec_table") || variants[0];
    const parsed = chosen.parsed;
    const item = chosen.item;
    for (const other of variants) {
      if (other === chosen) continue;
      if (!sameMeaning(parsed, other.parsed)) {
        stat.conflicts++;
        conflicts.push({ product: product.slug, key, a: parsed.displayValue, b: other.parsed.displayValue, from: other.item.from });
      }
    }

    const meta = specMeta(key);
    // Единица, не совпадающая с ожидаемой по словарю, — повод посмотреть глазами.
    const unitMismatch = meta?.unit && parsed.normalizedUnit && parsed.normalizedUnit !== meta.unit;
    const normalized = parsed.valueNum !== null || parsed.valueMin !== null || parsed.valueBool !== null;
    if (parsed.valueBool !== null) stat.boolean++;
    else if (normalized) stat.numeric++;
    else stat.text++;
    if (!normalized || unitMismatch) {
      needsReview.push({
        product: product.slug, key, label: item.label, value: parsed.displayValue,
        note: unitMismatch ? `единица ${parsed.normalizedUnit}, ожидалась ${meta.unit}` : (parsed.note || "не разобрано"),
      });
    }

    const row = {
      tenant_id: t, product_id: product.id, spec_key: key, label: meta.label,
      display_value: parsed.displayValue,
      value_num: parsed.valueNum, value_min: parsed.valueMin, value_max: parsed.valueMax,
      value_bool: parsed.valueBool === null ? null : (parsed.valueBool ? 1 : 0),
      value_text: parsed.valueText,
      unit_raw: parsed.unitRaw, normalized_unit: parsed.normalizedUnit, comparator: parsed.comparator,
      source_id: sourceId, origin: "habez_internal",
      confidence: defaultConfidence("habez_internal"),
      imported_from: item.from, source_ref: item.ref,
      parse_note: unitMismatch ? `единица ${parsed.normalizedUnit}, по словарю ожидается ${meta.unit}` : parsed.note,
    };

    const existing = get("SELECT * FROM ai_product_specs WHERE tenant_id=? AND product_id=? AND spec_key=?", t, product.id, key);
    if (!existing) {
      if (!dryRun) insert("ai_product_specs", { ...row, verification_status: "unverified" });
      stat.created++; wrote++;
      continue;
    }
    const same = existing.display_value === row.display_value
      && existing.value_num === row.value_num && existing.value_min === row.value_min
      && existing.value_max === row.value_max && existing.value_bool === row.value_bool
      && existing.normalized_unit === row.normalized_unit
      && existing.comparator === row.comparator;
    if (same) { stat.unchanged++; wrote++; continue; }

    if (!dryRun) {
      const patch = { ...row, updated_at: new Date().toISOString().slice(0, 19).replace("T", " ") };
      delete patch.tenant_id; delete patch.product_id; delete patch.spec_key;
      // Значение в карточке изменилось — прежнее подтверждение к нему не относится.
      if (existing.verification_status === "verified") {
        patch.verification_status = "unverified";
        patch.verified_by = null;
        patch.verified_at = null;
      }
      const keys = Object.keys(patch);
      run(`UPDATE ai_product_specs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
        ...keys.map((k) => patch[k]), existing.id);
    }
    stat.updated++; wrote++;
  }
  return wrote;
}

const products = all("SELECT id, slug, name, badges, spec_tables FROM products WHERE tenant_id=? ORDER BY position, id", t);
stat.products = products.length;

const sourceId = catalogSource();
const work = () => {
  for (const p of products) {
    if (importProduct(p, sourceId) > 0) stat.productsWithSpecs++;
  }
};
if (dryRun) work(); else tx(work);

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
console.log(`\n[specs] ${dryRun ? "ПРОГОН БЕЗ ЗАПИСИ" : "перенос выполнен"}`);
console.log(`товаров: ${stat.products}, с характеристиками: ${stat.productsWithSpecs} (${pct(stat.productsWithSpecs, stat.products)})`);
console.log(`строк в карточках: ${stat.rows} · пропущено (есть в variants): ${stat.skipped} · без ключа словаря: ${stat.unmapped}`);
console.log(`записей: создано ${stat.created}, обновлено ${stat.updated}, без изменений ${stat.unchanged}`);
console.log(`из них числовых: ${stat.numeric}, логических: ${stat.boolean}, текстовых: ${stat.text}`);
console.log(`расхождений между ярлыком и таблицей: ${stat.conflicts}`);
console.log(`требуют взгляда человека: ${needsReview.length}`);

if (withReport) {
  console.log("\n── подписи без ключа словаря (топ 25) ──");
  [...unmappedLabels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([label, n]) => console.log(`${String(n).padStart(3)}  ${label.slice(0, 90)}`));
  console.log("\n── требуют взгляда человека (первые 30) ──");
  needsReview.slice(0, 30).forEach((r) => console.log(`  ${r.product} · ${r.key} · «${String(r.value).slice(0, 40)}» — ${r.note}`));
  if (conflicts.length) {
    console.log("\n── расхождения ярлык/таблица ──");
    conflicts.forEach((c) => console.log(`  ${c.product} · ${c.key}: «${c.a}» и «${c.b}»`));
  }
  console.log("\n── частота характеристик ──");
  const freq = all(`SELECT spec_key, COUNT(*) AS n FROM ai_product_specs WHERE tenant_id=? GROUP BY spec_key ORDER BY n DESC LIMIT 20`, t);
  freq.forEach((r) => console.log(`${String(r.n).padStart(3)}  ${specMeta(r.spec_key)?.label || r.spec_key}`));
}

if (dryRun) console.log("\nНичего не записано. Уберите --dry-run, чтобы применить.");
db.close();
