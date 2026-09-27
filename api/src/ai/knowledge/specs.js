// Характеристики товаров: запись, правка, подтверждение, выдача и сравнение.
// Правила достоверности те же, что у фактов (фаза 1), — они общие для всего
// слоя знаний и лежат в model.js.
import { all, get, insert, update } from "../../db/index.js";
import { badRequest, notFound, conflict } from "../../lib/errors.js";
import {
  ORIGINS, ORIGINS_NEVER_VERIFIED, VERIFICATION_STATUSES, canTransition, defaultConfidence,
} from "./model.js";
import { SPEC_KEYS, specMeta } from "./spec-dictionary.js";
import { parseSpecValue, UNIT_LABEL, compareSpecs } from "./units.js";

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Товар обязан существовать и принадлежать этой компании — иначе через
// характеристику можно было бы подсмотреть чужой каталог.
function resolveProduct(tenantId, productId) {
  const p = get("SELECT id, name, short_name, slug, category_id FROM products WHERE id=? AND tenant_id=?", productId, tenantId);
  if (!p) throw notFound("Товар не найден");
  return p;
}

export function createSpec(tenantId, input, actorId) {
  const product = resolveProduct(tenantId, input.productId);
  if (!SPEC_KEYS[input.specKey]) throw badRequest(`Неизвестная характеристика: ${input.specKey}. Список — GET /api/ai/spec-keys`);
  if (!ORIGINS.includes(input.origin || "habez_internal")) throw badRequest(`Неизвестное происхождение: ${input.origin}`);
  if (input.displayValue === undefined || String(input.displayValue).trim() === "") {
    throw badRequest("Пустое значение: характеристики без значения не существует");
  }
  if (input.variantId) {
    const v = get("SELECT id FROM variants WHERE id=? AND tenant_id=? AND product_id=?", input.variantId, tenantId, product.id);
    if (!v) throw notFound("Фасовка не найдена у этого товара");
  }
  if (input.sourceId) {
    const src = get("SELECT id FROM ai_sources WHERE id=? AND tenant_id=?", input.sourceId, tenantId);
    if (!src) throw notFound("Источник не найден");
  }

  const twin = get("SELECT id FROM ai_product_specs WHERE tenant_id=? AND product_id=? AND spec_key=?", tenantId, product.id, input.specKey);
  if (twin) throw conflict(`Такая характеристика у товара уже есть (№${twin.id}) — измените её, а не заводите вторую`);

  const parsed = parseSpecValue(input.displayValue);
  const meta = specMeta(input.specKey);
  const origin = input.origin || "habez_internal";
  const id = insert("ai_product_specs", {
    tenant_id: tenantId, product_id: product.id, variant_id: input.variantId ?? null,
    spec_key: input.specKey, label: input.label || meta.label,
    display_value: parsed.displayValue,
    value_num: parsed.valueNum, value_min: parsed.valueMin, value_max: parsed.valueMax,
    value_bool: parsed.valueBool === null ? null : (parsed.valueBool ? 1 : 0),
    value_text: parsed.valueText,
    unit_raw: parsed.unitRaw, normalized_unit: parsed.normalizedUnit, comparator: parsed.comparator,
    source_id: input.sourceId ?? null, fact_id: input.factId ?? null,
    origin,
    // Как и у фактов: новое сведение всегда непроверенное.
    verification_status: "unverified",
    confidence: input.confidence ?? defaultConfidence(origin),
    imported_from: input.importedFrom || "manual", source_ref: input.sourceRef ?? null,
    parse_note: parsed.note, created_by: actorId ?? null,
  });
  return specById(tenantId, id);
}

export function updateSpec(tenantId, id, patch, actorId) {
  const row = get("SELECT * FROM ai_product_specs WHERE id=? AND tenant_id=?", id, tenantId);
  if (!row) throw notFound("Характеристика не найдена");

  const next = {};
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.confidence !== undefined) next.confidence = patch.confidence;
  if (patch.sourceId !== undefined) {
    if (patch.sourceId !== null && !get("SELECT id FROM ai_sources WHERE id=? AND tenant_id=?", patch.sourceId, tenantId)) {
      throw notFound("Источник не найден");
    }
    next.source_id = patch.sourceId;
    // Сняли источник — подтверждение держаться не на чем.
    if (patch.sourceId === null && row.verification_status === "verified") {
      next.verification_status = "unverified";
      next.verified_by = null;
      next.verified_at = null;
    }
  }
  // Значение меняется целиком и разбирается заново: иначе исходная строка и
  // число разойдутся, и непонятно, чему верить.
  if (patch.displayValue !== undefined) {
    if (String(patch.displayValue).trim() === "") throw badRequest("Пустое значение недопустимо");
    const parsed = parseSpecValue(patch.displayValue);
    Object.assign(next, {
      display_value: parsed.displayValue, value_num: parsed.valueNum,
      value_min: parsed.valueMin, value_max: parsed.valueMax,
      value_bool: parsed.valueBool === null ? null : (parsed.valueBool ? 1 : 0),
      value_text: parsed.valueText, unit_raw: parsed.unitRaw,
      normalized_unit: parsed.normalizedUnit, comparator: parsed.comparator, parse_note: parsed.note,
    });
    if (row.verification_status === "verified") {
      next.verification_status = "unverified";
      next.verified_by = null;
      next.verified_at = null;
    }
  }
  if (!Object.keys(next).length) return { spec: specById(tenantId, id), before: row, changed: [] };
  next.updated_at = now();
  update("ai_product_specs", id, next);
  return { spec: specById(tenantId, id), before: row, changed: Object.keys(next) };
}

export function setSpecVerification(tenantId, id, status, actorId, note) {
  if (!VERIFICATION_STATUSES.includes(status)) throw badRequest(`Неизвестный статус: ${status}`);
  const row = get("SELECT * FROM ai_product_specs WHERE id=? AND tenant_id=?", id, tenantId);
  if (!row) throw notFound("Характеристика не найдена");
  if (row.verification_status === status) return { spec: specById(tenantId, id), before: row };
  if (status === "verified" && ORIGINS_NEVER_VERIFIED.includes(row.origin)) {
    throw badRequest("Вывод AI нельзя подтвердить как характеристику: нужен источник с настоящим значением");
  }
  if (!canTransition(row.verification_status, status)) {
    throw badRequest(`Нельзя перейти из «${row.verification_status}» в «${status}»`);
  }
  // Правило Phase 1: подтверждают сведение по источнику. Без источника
  // подтверждать нечего — так же, как у фактов (facts.js).
  if (status === "verified" && !row.source_id) {
    throw badRequest("Подтвердить можно только характеристику с источником");
  }
  const next = { verification_status: status, updated_at: now(), checked_at: now() };
  if (status === "verified") { next.verified_by = actorId ?? null; next.verified_at = now(); }
  else { next.verified_by = null; next.verified_at = null; }
  update("ai_product_specs", id, next);
  return { spec: specById(tenantId, id), before: row, note: note ?? null };
}

const FIELDS = `s.*, p.name AS product_name, p.slug AS product_slug, p.short_name AS product_short,
  c.name AS category_name, src.name AS source_name, u.name AS verified_by_name`;
const JOINS = `FROM ai_product_specs s
  JOIN products p ON p.id = s.product_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN ai_sources src ON src.id = s.source_id
  LEFT JOIN users u ON u.id = s.verified_by`;

export function specById(tenantId, id) {
  const row = get(`SELECT ${FIELDS} ${JOINS} WHERE s.id=? AND s.tenant_id=?`, id, tenantId);
  if (!row) throw notFound("Характеристика не найдена");
  return view(row);
}

// overlay — необязательное преобразование строки (режим evidence, см.
// evidence-projection.js). Без него ответ тот же, что и раньше.
export function listSpecs(tenantId, q = {}, overlay = null) {
  const where = ["s.tenant_id=?"];
  const params = [tenantId];
  const eq = (sql, v) => { if (v !== undefined && v !== null && v !== "") { where.push(sql); params.push(v); } };
  eq("s.product_id=?", q.productId);
  eq("s.spec_key=?", q.specKey);
  eq("s.verification_status=?", q.status);
  eq("s.origin=?", q.origin);
  eq("s.normalized_unit=?", q.unit);
  eq("p.category_id=?", q.categoryId);
  if (q.numericOnly) where.push("(s.value_num IS NOT NULL OR s.value_min IS NOT NULL)");
  if (q.search) {
    where.push("(s.label LIKE ? OR s.display_value LIKE ? OR p.name LIKE ?)");
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  const clause = where.join(" AND ");
  const total = get(`SELECT COUNT(*) AS n ${JOINS} WHERE ${clause}`, ...params).n;
  const limit = q.limit ?? 100;
  const page = q.page ?? 1;
  const items = all(
    `SELECT ${FIELDS} ${JOINS} WHERE ${clause} ORDER BY p.position, p.id, s.spec_key LIMIT ? OFFSET ?`,
    ...params, limit, (page - 1) * limit).map(view).map(overlay || ((x) => x));
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}

// Список товаров с тем, насколько они «понятны» машине.
export function productsOverview(tenantId, q = {}) {
  const where = ["p.tenant_id=?"];
  const params = [tenantId];
  if (q.categoryId) { where.push("p.category_id=?"); params.push(q.categoryId); }
  if (q.search) { where.push("(p.name LIKE ? OR p.slug LIKE ?)"); params.push(`%${q.search}%`, `%${q.search}%`); }
  const items = all(
    `SELECT p.id, p.slug, p.name, p.short_name, p.status, c.name AS category,
            (SELECT COUNT(*) FROM ai_product_specs s WHERE s.product_id=p.id) AS specs,
            (SELECT COUNT(*) FROM ai_product_specs s WHERE s.product_id=p.id
               AND (s.value_num IS NOT NULL OR s.value_min IS NOT NULL)) AS numeric_specs,
            (SELECT COUNT(*) FROM ai_product_specs s WHERE s.product_id=p.id AND s.verification_status='verified') AS verified_specs
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE ${where.join(" AND ")} ORDER BY p.position, p.id`, ...params);
  return { items, total: items.length };
}

// Всё, что машина знает о товаре: карточка из каталога + характеристики,
// сгруппированные так же, как в словаре.
export function productIntelligence(tenantId, productId, overlay = null) {
  const p = get(
    `SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.gost, p.status, c.name AS category, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.id=? AND p.tenant_id=?`, productId, tenantId);
  if (!p) throw notFound("Товар не найден");

  const specs = all(`SELECT ${FIELDS} ${JOINS} WHERE s.tenant_id=? AND s.product_id=? ORDER BY s.spec_key`, tenantId, productId).map(view).map(overlay || ((x) => x));
  const groups = new Map();
  for (const s of specs) {
    const g = s.group || "Прочее";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  // Фасовки берём из каталога, а не копируем в характеристики.
  const variants = all(
    `SELECT id, unit, pack_size, pack_unit, weight_kg, per_pallet, barcode FROM variants
      WHERE tenant_id=? AND product_id=? AND is_active=1 ORDER BY position, id`, tenantId, productId);

  return {
    product: p,
    variants,
    specs,
    groups: [...groups.entries()].map(([name, items]) => ({ name, items })),
    stats: {
      total: specs.length,
      numeric: specs.filter((s) => s.value.num !== null || s.value.min !== null).length,
      boolean: specs.filter((s) => s.value.bool !== null).length,
      text: specs.filter((s) => s.value.text !== null).length,
      verified: specs.filter((s) => s.verificationStatus === "verified").length,
      needsReview: specs.filter((s) => s.parseNote && s.value.num === null && s.value.min === null && s.value.bool === null).length,
    },
  };
}

// Сравнение товаров по числам. Дополняет /api/catalog/compare, который
// сводит те же карточки строками для человека: здесь — величины для машины.
export function compareProducts(tenantId, productIds, overlay = null) {
  const ids = [...new Set(productIds)].slice(0, 6);
  if (ids.length < 2) throw badRequest("Для сравнения нужно хотя бы два товара");
  const marks = ids.map(() => "?").join(",");
  const products = all(
    `SELECT id, slug, name, short_name FROM products WHERE tenant_id=? AND id IN (${marks})`, tenantId, ...ids);
  if (products.length !== ids.length) throw notFound("Один из товаров не найден");

  // В режиме evidence спорное значение приходит без чисел — к сравнению по
  // числам оно не допускается само (comparable требует чисел).
  const specs = all(`SELECT ${FIELDS} ${JOINS} WHERE s.tenant_id=? AND s.product_id IN (${marks})`, tenantId, ...ids).map(view).map(overlay || ((x) => x));
  const byKey = new Map();
  for (const s of specs) {
    if (!byKey.has(s.specKey)) byKey.set(s.specKey, new Map());
    byKey.get(s.specKey).set(s.productId, s);
  }

  const rows = [...byKey.entries()].map(([key, perProduct]) => {
    const meta = specMeta(key);
    const values = products.map((p) => perProduct.get(p.id) || null);
    const numeric = values.filter((v) => v && (v.value.num !== null || v.value.min !== null));
    const units = new Set(numeric.map((v) => v.normalizedUnit));
    // Сравнивать можно, только когда единица у всех одна: «2 МПа» и «60 мин»
    // сопоставлению не подлежат.
    const comparable = numeric.length >= 2 && units.size === 1;
    let best = null;
    if (comparable) {
      const sorted = [...numeric].sort((a, b) => (compareSpecs(b, a) ?? 0));
      const top = sorted[0];
      const bottom = sorted[sorted.length - 1];
      // Если значения равны, «у кого больше» не существует — не выдумываем
      // победителя из-за порядка строк.
      if (compareSpecs(top, bottom) !== 0) best = { max: top.productId, min: bottom.productId };
    }
    return {
      specKey: key, label: meta?.label || key, group: meta?.group || "Прочее",
      unit: [...units][0] || null, unitLabel: UNIT_LABEL[[...units][0]] || null,
      comparable, best,
      values: values.map((v) => v && ({
        productId: v.productId, display: v.displayValue,
        num: v.value.num, min: v.value.min, max: v.value.max, bool: v.value.bool, text: v.value.text,
        unit: v.normalizedUnit, status: v.verificationStatus, origin: v.origin,
      })),
    };
  }).sort((a, b) => (a.group + a.label).localeCompare(b.group + b.label, "ru"));

  return { products: products.map((p) => ({ id: p.id, name: p.short_name || p.name, slug: p.slug })), rows };
}

export function specsSummary(tenantId) {
  const s = get(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN value_num IS NOT NULL OR value_min IS NOT NULL THEN 1 ELSE 0 END) AS numeric,
      SUM(CASE WHEN value_bool IS NOT NULL THEN 1 ELSE 0 END) AS boolean,
      SUM(CASE WHEN verification_status='verified' THEN 1 ELSE 0 END) AS verified
    FROM ai_product_specs WHERE tenant_id=?`, tenantId);
  const products = get(`SELECT COUNT(DISTINCT product_id) AS n FROM ai_product_specs WHERE tenant_id=?`, tenantId).n;
  const totalProducts = get(`SELECT COUNT(*) AS n FROM products WHERE tenant_id=?`, tenantId).n;
  const topKeys = all(
    `SELECT spec_key, COUNT(*) AS n FROM ai_product_specs WHERE tenant_id=? GROUP BY spec_key ORDER BY n DESC LIMIT 10`, tenantId)
    .map((r) => ({ specKey: r.spec_key, label: specMeta(r.spec_key)?.label || r.spec_key, count: r.n }));
  return {
    specs: s.total || 0, numeric: s.numeric || 0, boolean: s.boolean || 0, verified: s.verified || 0,
    productsWithSpecs: products, productsTotal: totalProducts, topKeys,
  };
}

function view(row) {
  const meta = specMeta(row.spec_key);
  return {
    id: row.id,
    productId: row.product_id,
    product: { id: row.product_id, name: row.product_name, short: row.product_short, slug: row.product_slug, category: row.category_name },
    variantId: row.variant_id,
    specKey: row.spec_key,
    label: row.label,
    group: meta?.group || "Прочее",
    expectedUnit: meta?.unit ?? null,
    displayValue: row.display_value,
    value: {
      num: row.value_num, min: row.value_min, max: row.value_max,
      bool: row.value_bool === null ? null : !!row.value_bool, text: row.value_text,
    },
    unitRaw: row.unit_raw,
    normalizedUnit: row.normalized_unit,
    unitLabel: UNIT_LABEL[row.normalized_unit] || row.unit_raw || null,
    comparator: row.comparator,
    // Нормализовано = есть что сравнивать машиной.
    normalized: row.value_num !== null || row.value_min !== null || row.value_bool !== null,
    source: row.source_id ? { id: row.source_id, name: row.source_name } : null,
    factId: row.fact_id,
    origin: row.origin,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    importedFrom: row.imported_from,
    sourceRef: row.source_ref,
    parseNote: row.parse_note,
    observedAt: row.observed_at,
    checkedAt: row.checked_at,
    verifiedBy: row.verified_by ? { id: row.verified_by, name: row.verified_by_name } : null,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
