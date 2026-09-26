// Habez AI Agent: инструменты чтения. Все — только SELECT; ни один не
// меняет товары, характеристики, цены, источники, проверки и вопросы
// сверки. Каждый принимает контекст { tenantId, scope } и сам решает, что
// этой роли можно отдать.
//
//   search_products      — товары по словам вопроса (витринные данные);
//   get_product          — карточка: название, раздел, описание, фасовки;
//   get_product_specs    — характеристики свойствами, с расхождениями
//                          (сотрудникам — наблюдения + строки карточки вне словаря);
//   get_product_evidence — наблюдения с происхождением (сотрудникам);
//   compare_products     — характеристики нескольких товаров рядом;
//   search_knowledge     — факты слоя знаний по словам (сотрудникам).
import { z } from "zod";
import { all, get } from "../../../db/index.js";
import { cardItems } from "../../knowledge/legacy-provenance.js";
import { productEvidence } from "../../knowledge/evidence.js";
import { openItemsFor } from "../../knowledge/evidence-projection.js";
import { evidenceKeyMeta } from "../../knowledge/evidence-model.js";
import { evidenceRoleForScope } from "../permissions.js";
import { groupCardProperties, groupObservationProperties, sameValueKey } from "../retrieval/conflicts.js";

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const PUBLISHED = "p.status='published'";

// Товар, видимый роли. Гость и покупатель видят только опубликованное —
// как витрина.
function productRow(ctx, productId) {
  const where = ctx.scope === "public" ? ` AND ${PUBLISHED}` : "";
  return get(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.id=? AND p.tenant_id=?${where}`, productId, ctx.tenantId);
}

const schemas = {
  search_products: z.object({ terms: z.array(z.string().min(2).max(40)).max(12), limit: z.number().int().min(1).max(12).default(6) }),
  get_product: z.object({ productId: z.number().int().positive() }),
  get_product_specs: z.object({ productId: z.number().int().positive(), keyFilter: z.any().optional() }),
  get_product_evidence: z.object({ productId: z.number().int().positive() }),
  compare_products: z.object({ productIds: z.array(z.number().int().positive()).min(2).max(4), keyFilter: z.any().optional() }),
  search_knowledge: z.object({ terms: z.array(z.string().min(2).max(40)).max(12), limit: z.number().int().min(1).max(20).default(8) }),
};

function searchProducts(ctx, { terms, limit }) {
  if (!terms.length) return { items: [] };
  const rows = all(`SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.badges, p.spec_tables, p.sections, p.tasks, c.name AS category
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=? AND ${PUBLISHED}`, ctx.tenantId);
  const scored = rows.map((r) => {
    const hay = [r.name, r.summary, r.category, r.sections, r.spec_tables, r.tasks].join(" ").toLowerCase().replace(/ё/g, "е");
    const inName = [r.name, r.summary].join(" ").toLowerCase().replace(/ё/g, "е");
    let score = 0;
    for (const t of terms) { if (inName.includes(t)) score += 3; else if (hay.includes(t)) score += 1; }
    return { r, score };
  // Одно слово где-то в глубине описания — случайность, а не ответ.
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || a.r.id - b.r.id).slice(0, limit);
  return {
    items: scored.map(({ r, score }) => ({
      id: r.id, slug: r.slug, name: r.name, short: r.short_name, category: r.category, summary: r.summary, score,
      // Строки «Область применения» — прямой ответ на «что подходит для…».
      application: json(r.spec_tables, []).filter((t) => /применени|основани/i.test(t.title || ""))
        .flatMap((t) => (t.rows || []).map((row) => ({ table: t.title, label: row[0], value: row[1] }))).slice(0, 14),
    })),
  };
}

function getProduct(ctx, { productId }) {
  const p = productRow(ctx, productId);
  if (!p) return null;
  const variants = all(`SELECT id, sku, unit, pack_size, pack_unit, weight_kg, per_pallet FROM variants
    WHERE tenant_id=? AND product_id=? AND is_active=1 ORDER BY position, id`, ctx.tenantId, productId);
  const sections = json(p.sections, []).map((s) => ({ title: s.title, text: String(s.text || "").slice(0, 700) }));
  return {
    id: p.id, slug: p.slug, name: p.name, short: p.short_name, category: p.category, summary: p.summary, gost: p.gost,
    variants, sections,
  };
}

function getProductSpecs(ctx, { productId, keyFilter }) {
  const p = productRow(ctx, productId);
  if (!p) return null;
  if (ctx.scope === "public") {
    // Гостю и покупателю — ровно то, что напечатано в карточке на витрине.
    const props = groupCardProperties(p, cardItems(p), keyFilter);
    // Сам факт открытых вопросов сверки по товару можно назвать, значения и
    // источники — нет.
    const internalOpenItems = all("SELECT COUNT(*) AS n FROM ai_reconciliation_items WHERE tenant_id=? AND product_id=? AND status='unresolved'", ctx.tenantId, productId)[0]?.n ?? 0;
    return { product: { id: p.id, slug: p.slug, name: p.name, short: p.short_name }, channel: "catalog_card", properties: props, internalOpenItems };
  }
  const role = evidenceRoleForScope(ctx.scope);
  const ev = productEvidence(ctx.tenantId, productId, role);
  const open = openItemsFor(ctx.tenantId, productId, role);
  const props = groupObservationProperties(p, ev.properties, open, keyFilter);
  // Сотрудник видит не меньше покупателя. Строки карточки, которые в
  // наблюдения не попали: вне словаря («Заливка наливных полов — через 7
  // суток»), с ключом без наблюдений или со вторым значением, которое
  // перенос 2.1 отбросил («50 циклов» при «F50»), — добавляются как строки
  // карточки. Значение, которое уже есть среди наблюдений, не повторяется.
  const seen = (display, key) => {
    const d = String(display ?? "").toLowerCase().trim();
    const opt = { withBool: !!key };
    const k = sameValueKey(display, opt);
    return props.some((g) => (key ? g.key === key : true) && g.values.some((v) => !v.hidden && (String(v.display ?? "").toLowerCase().trim() === d || (k && sameValueKey(v.display, opt) === k))));
  };
  // Значение карточки по свойству, у которого есть наблюдения, встаёт в ту
  // же строку: при открытом вопросе сверки оно участвует в споре, иначе —
  // это расхождение карточки и наблюдений. Отдельной строкой «одно
  // значение» оно не показывается никогда.
  const extra = [];
  for (const g of groupCardProperties(p, cardItems(p), keyFilter)) {
    const values = g.values.filter((v) => !seen(v.display, g.key));
    if (!values.length) continue;
    const twin = g.key && props.find((o) => o.key === g.key && !o.variant && (o.conditionKey || "") === (g.conditionKey || ""));
    if (twin) {
      twin.values = [...twin.values, ...values];
      if (twin.status !== "unresolved") twin.status = "conflict";
      const units = new Set(twin.values.map((v) => v.unit).filter(Boolean));
      if (twin.status === "conflict") twin.reason = units.size > 1 ? "different_units" : "values_differ";
      continue;
    }
    const units = new Set(values.map((v) => v.unit).filter(Boolean));
    const status = values.length > 1 ? "conflict" : values[0].evidence.length > 1 ? "agreed" : "single";
    extra.push({ ...g, values, status, reason: status === "conflict" ? (units.size > 1 ? "different_units" : "values_differ") : null });
  }
  const cardOnly = extra;
  return { product: { id: p.id, slug: p.slug, name: p.name, short: p.short_name }, channel: "observations", properties: [...props, ...cardOnly], internalOpenItems: open.length };
}

function getProductEvidence(ctx, { productId }) {
  if (ctx.scope === "public") return { forbidden: true, reason: "наблюдения и их происхождение доступны сотрудникам" };
  const p = productRow(ctx, productId);
  if (!p) return null;
  return productEvidence(ctx.tenantId, productId, evidenceRoleForScope(ctx.scope));
}

function compareProducts(ctx, { productIds, keyFilter }) {
  return { items: productIds.map((id) => getProductSpecs(ctx, { productId: id, keyFilter })).filter(Boolean) };
}

function searchKnowledge(ctx, { terms, limit }) {
  if (ctx.scope === "public") return { items: [] };
  if (!terms.length) return { items: [] };
  const levels = ctx.scope === "admin" ? ["public", "internal", "confidential"] : ["public", "internal"];
  const rows = all(`SELECT o.id, o.product_id, p.slug, o.spec_key, o.label, o.original_value, o.condition_text, o.source_type, o.access_level
      FROM ai_spec_observations o JOIN products p ON p.id=o.product_id
     WHERE o.tenant_id=? AND o.access_level IN (${levels.map(() => "?").join(",")})`, ctx.tenantId, ...levels);
  return {
    items: rows.map((r) => {
      const hay = [r.label, r.original_value, r.condition_text, evidenceKeyMeta(r.spec_key)?.label].join(" ").toLowerCase().replace(/ё/g, "е");
      return { r, score: terms.filter((t) => hay.includes(t)).length };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.r.id - b.r.id).slice(0, limit).map((x) => x.r),
  };
}

const IMPL = {
  search_products: searchProducts, get_product: getProduct, get_product_specs: getProductSpecs,
  get_product_evidence: getProductEvidence, compare_products: compareProducts, search_knowledge: searchKnowledge,
};

export const TOOL_NAMES = Object.keys(IMPL);

// Единая точка вызова: проверка аргументов по схеме, контекст обязателен.
export function callTool(name, args, ctx) {
  if (!IMPL[name]) throw new Error(`нет инструмента ${name}`);
  if (!ctx || !ctx.tenantId || !["public", "staff", "admin"].includes(ctx.scope)) throw new Error("инструменту нужен контекст с ролью");
  const parsed = schemas[name].parse(args);
  return IMPL[name](ctx, parsed);
}

