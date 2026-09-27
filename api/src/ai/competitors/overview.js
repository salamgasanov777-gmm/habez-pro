// Сводки для панели: список конкурентов, карточка компании, карточка товара
// конкурента, аналоги нашего товара. Только чтение, те же права, что у
// остальных функций слоя. Скрытое роли видно только числом («есть ещё N
// сведений для другой роли»), как у конфиденциальных наблюдений 2.2B.
import { all, get } from "../../db/index.js";
import { SPEC_KEYS } from "../knowledge/spec-dictionary.js";
import { UNIT_LABEL } from "../knowledge/units.js";
import { requireReader, nameKey } from "./model.js";
import { companyView } from "./companies.js";
import { brandView } from "./brands.js";
import { productView, visibleProduct } from "./products.js";
import { packView } from "./packs.js";
import { productObservations } from "./observations.js";
import { productPrices } from "./prices.js";
import { analogStatus, findAnalogs } from "./analogs.js";
import { getCompany } from "./companies.js";

const IN = (xs) => xs.map(() => "?").join(",") || "NULL";
const sourceOf = (tenantId, id) => {
  const s = id ? get("SELECT id, name, source_type, url, last_checked_at FROM ai_sources WHERE id=? AND tenant_id=?", id, tenantId) : null;
  return s ? { id: s.id, name: s.name, type: s.source_type, url: s.url || null, lastCheckedAt: s.last_checked_at } : null;
};
const catName = (tenantId, id) => (id ? get("SELECT name FROM categories WHERE id=? AND tenant_id=?", id, tenantId)?.name ?? null : null);
const regionName = (tenantId, id) => (id ? get("SELECT name FROM ai_regions WHERE id=? AND tenant_id=?", id, tenantId)?.name ?? null : null);
const companyName = (tenantId, id) => (id ? get("SELECT name FROM ai_companies WHERE id=? AND tenant_id=?", id, tenantId)?.name ?? null : null);

// Список: компании со счётчиками. Поиск — по названию компании, марки и
// товара (нижний регистр, без кавычек).
export function competitorOverview(ctx, { search = "", kind = null, competitorStatus = null } = {}) {
  const levels = requireReader(ctx);
  const where = ["c.tenant_id=?", "c.lifecycle_status='active'", `c.access_level IN (${IN(levels)})`];
  const args = [ctx.tenantId, ...levels];
  if (kind) { where.push("c.kind=?"); args.push(kind); }
  if (competitorStatus) { where.push("c.competitor_status=?"); args.push(competitorStatus); }
  const s = nameKey(search);
  if (s) {
    where.push(`(c.name_key LIKE ? OR c.id IN (SELECT company_id FROM ai_brands WHERE tenant_id=c.tenant_id AND lifecycle_status='active' AND name_key LIKE ?)
      OR c.id IN (SELECT company_id FROM ai_competitor_products WHERE tenant_id=c.tenant_id AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND name_key LIKE ?))`);
    args.push(`%${s}%`, `%${s}%`, ...levels, `%${s}%`);
  }
  const companies = all(`SELECT c.* FROM ai_companies c WHERE ${where.join(" AND ")} ORDER BY c.name_key`, ...args);
  return {
    items: companies.map((c) => {
      const pids = all(`SELECT id FROM ai_competitor_products WHERE tenant_id=? AND company_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)})`, ctx.tenantId, c.id, ...levels).map((r) => r.id);
      const sources = pids.length ? all(`SELECT DISTINCT source_id FROM (SELECT source_id FROM ai_competitor_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)})
        UNION SELECT source_id FROM ai_price_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)}))`,
      ctx.tenantId, ...levels, ...pids, ctx.tenantId, ...levels, ...pids).length : 0;
      const regions = [...new Set([c.hq_region_id, ...(pids.length ? all(`SELECT DISTINCT region_id FROM ai_price_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)})`, ctx.tenantId, ...levels, ...pids).map((r) => r.region_id) : [])].filter(Boolean))]
        .map((id) => regionName(ctx.tenantId, id)).filter(Boolean);
      return {
        ...companyView(c),
        brands: all("SELECT name FROM ai_brands WHERE tenant_id=? AND company_id=? AND lifecycle_status='active' ORDER BY name_key", ctx.tenantId, c.id).map((b) => b.name),
        products: pids.length, sources, regions,
      };
    }),
  };
}

// Карточка компании.
export function companyCard(ctx, id) {
  const levels = requireReader(ctx);
  const company = getCompany(ctx, id);
  const brands = all("SELECT * FROM ai_brands WHERE tenant_id=? AND company_id=? ORDER BY lifecycle_status, name_key", ctx.tenantId, id).map(brandView);
  const allProducts = all("SELECT * FROM ai_competitor_products WHERE tenant_id=? AND company_id=? ORDER BY lifecycle_status, name_key", ctx.tenantId, id);
  const products = allProducts.filter((p) => levels.includes(p.access_level));
  const pids = products.filter((p) => p.lifecycle_status === "active").map((p) => p.id);
  const count = (table) => (pids.length ? all(`SELECT competitor_product_id AS id, COUNT(*) AS n, MAX(${table === "ai_price_observations" ? "observed_at" : "COALESCE(provided_at, captured_at)"}) AS last
     FROM ${table} WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)}) GROUP BY competitor_product_id`, ctx.tenantId, ...levels, ...pids) : []);
  const obs = new Map(count("ai_competitor_observations").map((r) => [r.id, r]));
  const prices = new Map(count("ai_price_observations").map((r) => [r.id, r]));
  const sourceIds = pids.length ? all(`SELECT source_id AS id, MAX(d) AS last FROM (SELECT source_id, COALESCE(provided_at, captured_at) AS d FROM ai_competitor_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)})
      UNION ALL SELECT source_id, observed_at AS d FROM ai_price_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)})) GROUP BY source_id`,
  ctx.tenantId, ...levels, ...pids, ctx.tenantId, ...levels, ...pids) : [];
  const regions = [...new Set([company.hqRegionId, ...(pids.length ? all(`SELECT DISTINCT region_id FROM ai_price_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN(levels)}) AND competitor_product_id IN (${IN(pids)})`, ctx.tenantId, ...levels, ...pids).map((r) => r.region_id) : [])].filter(Boolean))];
  const hiddenProducts = allProducts.filter((p) => !levels.includes(p.access_level) && p.lifecycle_status === "active").length;
  const unresolved = [];
  if (company.competitorStatus === "unknown") unresolved.push("не отмечено, конкурент ли это");
  if (!company.website) unresolved.push("сайт не указан");
  if (!regions.length) unresolved.push("регионы не указаны");
  if (!pids.length) unresolved.push("товаров в данных нет");
  else {
    if (!obs.size) unresolved.push("характеристик товаров в данных нет");
    if (!prices.size) unresolved.push("цен в данных нет");
  }
  return {
    company: { ...company, hqRegion: regionName(ctx.tenantId, company.hqRegionId) },
    brands,
    products: products.map((p) => ({ ...productView(p), brand: brands.find((b) => b.id === p.brand_id)?.name ?? null, category: catName(ctx.tenantId, p.category_id),
      observations: obs.get(p.id)?.n ?? 0, prices: prices.get(p.id)?.n ?? 0, lastObservation: obs.get(p.id)?.last ?? null, lastPrice: prices.get(p.id)?.last ?? null })),
    regions: regions.map((rid) => ({ id: rid, name: regionName(ctx.tenantId, rid) })),
    sources: sourceIds.map((s) => ({ ...sourceOf(ctx.tenantId, s.id), lastDate: s.last })).filter((s) => s.id),
    hidden: { products: hiddenProducts },
    unresolved,
  };
}

// Карточка товара конкурента: основное, фасовки, характеристики по группам
// словаря (значения, единицы, условие, тип утверждения, источник, дата,
// статус, расхождение, история), цены группами, связи с товарами Habez.
export function competitorProductCard(ctx, id) {
  const levels = requireReader(ctx);
  const p = visibleProduct(ctx, id, levels);
  const packs = all("SELECT * FROM ai_competitor_packs WHERE tenant_id=? AND competitor_product_id=? ORDER BY lifecycle_status, id", ctx.tenantId, id).map(packView);
  const packLabel = new Map(packs.map((k) => [k.id, k.unitLabel]));
  const { properties } = productObservations(ctx, id);
  const obsView = (o) => ({
    id: o.id, value: o.originalValue, unit: o.unitLabel, statementType: o.statementType, condition: o.conditionText, source: sourceOf(ctx.tenantId, o.sourceId),
    sourceReference: o.sourceReference, providedAt: o.providedAt, capturedAt: o.capturedAt, verificationStatus: o.verificationStatus, accessLevel: o.accessLevel,
    lifecycleStatus: o.lifecycleStatus, replacedById: o.replacedById, lifecycleNote: o.lifecycleNote,
  });
  const groups = new Map();
  for (const g of properties) {
    const group = SPEC_KEYS[g.specKey]?.group || "Прочее";
    if (!groups.has(group)) groups.set(group, []);
    const cur = g.resolution.current || g.resolution.measured || g.resolution.norm;
    const active = g.observations.filter((o) => o.lifecycleStatus === "active");
    groups.get(group).push({
      specKey: g.specKey, label: g.label, conditionKey: g.conditionKey, conditionText: g.conditionText, pack: g.packId ? packLabel.get(g.packId) ?? null : null,
      status: !active.length ? "history" : cur?.status === "pending_user_decision" ? "conflict" : active.length > 1 ? "agreed" : "single",
      reason: cur?.reason ?? null, unit: cur?.value?.unitLabel ?? null,
      observations: active.map(obsView), history: g.observations.filter((o) => o.lifecycleStatus !== "active").map(obsView),
      hiddenCount: g.hiddenCount, hiddenDisagreement: g.hiddenDisagreement,
    });
  }
  const { prices, groups: priceGroups } = productPrices(ctx, id);
  const priceView = (o) => ({
    id: o.id, amountMinor: o.amountMinor, currency: o.currency, priceKind: o.priceKind, basis: o.priceBasis, basisQty: o.basisQty, basisUnit: o.basisUnit, vat: o.vat,
    pack: o.packId ? packLabel.get(o.packId) ?? null : null, observedAt: o.observedAt, region: regionName(ctx.tenantId, o.regionId), seller: companyName(ctx.tenantId, o.sellerCompanyId),
    source: sourceOf(ctx.tenantId, o.sourceId), sourceReference: o.sourceReference, accessLevel: o.accessLevel, verificationStatus: o.verificationStatus, lifecycleStatus: o.lifecycleStatus, lifecycleNote: o.lifecycleNote,
  });
  const hiddenPrices = get(`SELECT COUNT(*) AS n FROM ai_price_observations WHERE tenant_id=? AND competitor_product_id=? AND lifecycle_status='active' AND access_level NOT IN (${IN(levels)})`, ctx.tenantId, id, ...levels).n;
  // Связи с нашими товарами: утверждения и предположения по тому же разделу.
  const stored = all("SELECT DISTINCT product_id FROM ai_competitor_analogs WHERE tenant_id=? AND competitor_product_id=?", ctx.tenantId, id).map((r) => r.product_id);
  const sameCat = p.category_id ? all("SELECT id FROM products WHERE tenant_id=? AND category_id=? AND status<>'archived' ORDER BY position, id", ctx.tenantId, p.category_id).map((r) => r.id) : [];
  const order = { CONFIRMED: 0, CONFLICTED: 1, INFERRED: 2, UNKNOWN: 3 };
  const analogs = [...new Set([...stored, ...sameCat])].map((pid) => analogStatus(ctx, pid, id)).filter((a) => a.status !== "UNKNOWN").sort((a, b) => order[a.status] - order[b.status]).map(analogPanelView(ctx));
  return {
    product: { ...productView(p), company: companyName(ctx.tenantId, p.company_id), brand: p.brand_id ? get("SELECT name FROM ai_brands WHERE id=? AND tenant_id=?", p.brand_id, ctx.tenantId)?.name ?? null : null,
      category: catName(ctx.tenantId, p.category_id) },
    packs,
    properties: [...groups].map(([group, items]) => ({ group, items })),
    prices: { groups: priceGroups.map((g) => ({ priceKind: g.priceKind, currency: g.currency, basis: g.priceBasis, basisUnit: g.basisUnit, basisQty: g.basisQty, vat: g.vat,
      pack: g.packId ? packLabel.get(g.packId) ?? null : null, region: regionName(ctx.tenantId, g.regionId), status: g.status, conflicts: g.conflicts, observations: g.observations.map(priceView) })),
    history: prices.filter((x) => x.lifecycleStatus !== "active").map(priceView), hidden: hiddenPrices },
    analogs,
  };
}

// Связь в форме для панели: наш товар, товар конкурента, статус, вид,
// основание с источником и различиями, предположение — отдельной пометкой.
export const analogPanelView = (ctx) => (a) => ({
  product: a.product, competitorProduct: { ...a.competitorProduct, company: companyName(ctx.tenantId, a.competitorProduct.companyId) },
  status: a.status, relation: a.relation, confirmed: a.status === "CONFIRMED" && ["analog", "partial_analog"].includes(a.relation),
  inferred: a.status === "INFERRED", inferredBasis: a.inferredBasis,
  basis: a.basis.map((b) => ({ id: b.id, relation: b.relation, kind: b.basis === "explicit_source_statement" ? "source" : "employee_decision", source: sourceOf(ctx.tenantId, b.sourceId), note: b.note, differences: b.differences })),
  history: a.history, needsReview: a.needsReview,
});

// Аналоги нашего товара (для карточки товара Habez).
export function productAnalogs(ctx, productId) {
  requireReader(ctx);
  return { items: findAnalogs(ctx, productId).map(analogPanelView(ctx)) };
}
