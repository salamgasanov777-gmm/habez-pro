// Habez AI 3.5: пять инструментов чтения для сведений о конкурентах.
// Всё — через доменный слой (api/src/ai/competitors/), который сам
// проверяет компанию-арендатора, роль и уровень доступа. Гостю — отказ
// без данных. Наружу — только поля, нужные для ответа: номера, имена,
// значения, статусы, источники и даты; служебные поля (хеши, авторы,
// жизненный цикл строк) модели не отдаются.
import { all, get } from "../../../db/index.js";
import {
  getCompany, listBrands, listCompetitorProducts, listPacks, findAnalogs, analogStatus, productObservations, productPrices,
  competitorRegistry, visibleProduct, scopeOf, levelsFor,
} from "../../competitors/index.js";
import { groupObservationProperties } from "../retrieval/conflicts.js";
import { detectCompetitors } from "./detect.js";

// Роль доменного слоя для уровня доступа агента.
const roleOf = (scope) => (scope === "admin" ? "admin" : scope === "staff" ? "manager" : "customer");
export const dctx = (ctx) => ({ tenantId: ctx.tenantId, role: roleOf(ctx.scope) });
const FORBIDDEN = { forbidden: true, reason: "Сведения о конкурентах доступны сотрудникам" };
// Не найдено в своей компании-арендаторе (в т. ч. чужой номер) — null, а не
// ошибка: наличие чужой записи этим не раскрывается.
const guard = (ctx, fn) => {
  if (ctx.scope === "public") return FORBIDDEN;
  try { return fn(dctx(ctx)); } catch (e) { if (e.status === 404) return null; throw e; }
};

const catName = (id) => (id ? get("SELECT name FROM categories WHERE id=?", id)?.name ?? null : null);
const sourceOf = (tenantId, id) => {
  const s = id ? get("SELECT id, name, source_type, url FROM ai_sources WHERE id=? AND tenant_id=?", id, tenantId) : null;
  return s ? { id: s.id, name: s.name, type: s.source_type, url: s.url || null } : null;
};

export function searchCompetitors(ctx, { terms }) {
  return guard(ctx, (c) => {
    const reg = competitorRegistry(c);
    const hits = detectCompetitors(terms.join(" "), reg);
    return { items: hits.map((h) => ({ type: h.item.type, id: h.item.id, name: h.item.name, company: h.item.companyName ?? null, brand: h.item.brandName ?? null, matchedBy: h.via })) };
  });
}

export function getCompetitor(ctx, { companyId }) {
  return guard(ctx, (c) => {
    let co;
    try { co = getCompany(c, companyId); } catch (e) { if (e.status === 404) return null; throw e; }
    if (co.lifecycleStatus !== "active") return null;
    const brands = listBrands(c, co.id);
    const products = listCompetitorProducts(c, { companyId: co.id });
    const levels = levelsFor(c.role);
    const IN = levels.map(() => "?").join(",");
    const pids = products.map((p) => p.id);
    const PIN = pids.map(() => "?").join(",") || "NULL";
    const obs = pids.length ? all(`SELECT source_id FROM ai_competitor_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN}) AND competitor_product_id IN (${PIN})`, c.tenantId, ...levels, ...pids) : [];
    const prices = pids.length ? all(`SELECT source_id, region_id FROM ai_price_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN}) AND competitor_product_id IN (${PIN})`, c.tenantId, ...levels, ...pids) : [];
    const analogs = pids.length ? all(`SELECT COUNT(*) AS n FROM ai_competitor_analogs WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN}) AND competitor_product_id IN (${PIN})`, c.tenantId, ...levels, ...pids)[0].n : 0;
    const regionIds = [...new Set([co.hqRegionId, ...prices.map((p) => p.region_id)].filter(Boolean))];
    const regions = regionIds.map((id) => get("SELECT name FROM ai_regions WHERE id=? AND tenant_id=?", id, c.tenantId)?.name).filter(Boolean);
    const sources = [...new Set([...obs, ...prices].map((r) => r.source_id))].map((id) => sourceOf(c.tenantId, id)).filter(Boolean);
    const unresolved = [];
    if (co.competitorStatus === "unknown") unresolved.push("не отмечено, конкурент ли это");
    if (!co.website) unresolved.push("сайт не указан");
    if (!products.length) unresolved.push("товаров в данных нет");
    if (!obs.length) unresolved.push("характеристик товаров в данных нет");
    if (!prices.length) unresolved.push("цен в данных нет");
    if (!regions.length) unresolved.push("регионы не указаны");
    return {
      company: { id: co.id, name: co.name, legalName: co.legalName, kind: co.kind, competitorStatus: co.competitorStatus, website: co.website },
      brands: brands.map((b) => ({ id: b.id, name: b.name })),
      products: products.map((p) => ({ id: p.id, name: p.name, short: p.shortName, brand: brands.find((b) => b.id === p.brandId)?.name ?? null, category: catName(p.categoryId), marketStatus: p.marketStatus })),
      regions, sources, counts: { products: products.length, observations: obs.length, prices: prices.length, analogs }, unresolved,
    };
  });
}

// Список конкурентов (компании со статусом «конкурент»).
export function listCompetitorCompanies(ctx) {
  return guard(ctx, (c) => all(`SELECT id, name, kind FROM ai_companies WHERE tenant_id=? AND lifecycle_status='active' AND competitor_status='competitor' AND access_level IN (${levelsFor(c.role).map(() => "?").join(",")}) ORDER BY name_key`, c.tenantId, ...levelsFor(c.role)));
}

export function getCompetitorProducts(ctx, { companyId = null, brandId = null, categoryId = null }) {
  return guard(ctx, (c) => {
    const items = listCompetitorProducts(c, { companyId, brandId, categoryId });
    const brand = (id) => (id ? get("SELECT name FROM ai_brands WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null : null);
    const company = (id) => get("SELECT name FROM ai_companies WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null;
    return {
      items: items.map((p) => ({ id: p.id, name: p.name, short: p.shortName, company: company(p.companyId), brand: brand(p.brandId), category: catName(p.categoryId),
        marketStatus: p.marketStatus, gost: p.gost, packs: listPacks(c, p.id).map((k) => k.unitLabel) })),
    };
  });
}

// Аналоги нашего товара. Вычисленное предположение (INFERRED) идёт
// отдельным списком и помечено confirmed: false, basisKind: heuristic —
// модели нечего принять за подтверждённый аналог.
export function findAnalogsTool(ctx, { productId }) {
  return guard(ctx, (c) => {
    const list = findAnalogs(c, productId);
    const shape = (x) => ({
      competitorProduct: { id: x.competitorProduct.id, name: x.competitorProduct.name, short: x.competitorProduct.short,
        company: get("SELECT name FROM ai_companies WHERE id=? AND tenant_id=?", x.competitorProduct.companyId, c.tenantId)?.name ?? null,
        brand: x.competitorProduct.brandId ? get("SELECT name FROM ai_brands WHERE id=? AND tenant_id=?", x.competitorProduct.brandId, c.tenantId)?.name ?? null : null },
      status: x.status, relation: x.relation,
      confirmed: x.status === "CONFIRMED" && ["analog", "partial_analog"].includes(x.relation),
      basisKind: x.status === "INFERRED" ? "heuristic" : [...new Set(x.basis.map((b) => (b.basis === "explicit_source_statement" ? "source" : "employee_decision")))].join("+"),
      basis: x.basis.map((b) => ({ relation: b.relation, kind: b.basis === "explicit_source_statement" ? "source" : "employee_decision", source: sourceOf(c.tenantId, b.sourceId), note: b.note, differences: b.differences })),
      inferredBasis: x.inferredBasis, needsReview: x.needsReview,
    });
    const items = list.map(shape);
    return {
      product: get("SELECT id, name, short_name AS short FROM products WHERE id=? AND tenant_id=?", productId, c.tenantId),
      confirmed: items.filter((x) => x.confirmed),
      notAnalog: items.filter((x) => x.status === "CONFIRMED" && x.relation === "not_analog"),
      conflicted: items.filter((x) => x.status === "CONFLICTED"),
      inferred: items.filter((x) => x.status === "INFERRED"),
    };
  });
}

// Свойства товара конкурента в той же форме, что у наших (3.2): их можно
// сложить в одну таблицу comparisonRows и в пакет с номерами [E#].
export function competitorSpecs(c, competitorProductId) {
  const p = visibleProduct(c, competitorProductId);
  const { properties } = productObservations(c, competitorProductId);
  const packs = new Map(listPacks(c, competitorProductId, { includeWithdrawn: true }).map((k) => [k.id, k.unitLabel]));
  const sourceNames = new Map();
  const groups = properties.map((g) => ({
    variantId: g.packId, specKey: g.specKey, conditionKey: g.conditionKey, resolution: g.resolution,
    observations: g.observations.map((o) => {
      if (!sourceNames.has(o.sourceId)) sourceNames.set(o.sourceId, sourceOf(c.tenantId, o.sourceId)?.name ?? null);
      return { ...o, variant: o.packId ? { unit: packs.get(o.packId) } : null, sourceName: sourceNames.get(o.sourceId) };
    }),
    hiddenDisagreement: g.hiddenDisagreement,
  }));
  const shaped = groupObservationProperties({ slug: `competitor-${p.id}` }, groups, []);
  shaped.forEach((x, i) => { x.hiddenDisagreement = groups[i].hiddenDisagreement; for (const v of x.values) for (const e of v.evidence) e.competitor = true; });
  return { product: { id: -p.id, slug: `competitor-${p.id}`, name: p.name, short: p.short_name || p.name, competitorId: p.id }, channel: "competitor_observations", properties: shaped, internalOpenItems: 0 };
}

// Цены товара конкурента группами сравнимых цен: сумма, валюта, вид, основа,
// количество, единица основы, дата, регион, продавец, источник.
export function competitorPrices(c, competitorProductId) {
  const { groups } = productPrices(c, competitorProductId);
  const region = (id) => (id ? get("SELECT name FROM ai_regions WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null : null);
  const seller = (id) => (id ? get("SELECT name FROM ai_companies WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null : null);
  const pack = (id) => (id ? get("SELECT unit_label FROM ai_competitor_packs WHERE id=? AND tenant_id=?", id, c.tenantId)?.unit_label ?? null : null);
  return groups.map((g) => ({
    priceKind: g.priceKind, currency: g.currency, basis: g.priceBasis, basisUnit: g.basisUnit, basisQty: g.basisQty, vat: g.vat, pack: pack(g.packId), region: region(g.regionId),
    status: g.status, conflicts: g.conflicts,
    observations: g.observations.map((o) => ({ id: o.id, amountMinor: o.amountMinor, currency: o.currency, priceKind: o.priceKind, basis: o.priceBasis, basisQty: o.basisQty,
      basisUnit: o.basisUnit, vat: o.vat, observedAt: o.observedAt, region: region(o.regionId), seller: seller(o.sellerCompanyId), source: sourceOf(c.tenantId, o.sourceId),
      sourceReference: o.sourceReference, access: o.accessLevel })),
  }));
}

// Сколько действующих цен товара роли не видно (конфиденциальные для
// менеджера). Только число — без суммы, вида, даты и источника.
export function hiddenPriceCount(c, competitorProductId) {
  if (scopeOf(c.role) === "admin") return 0;
  const levels = levelsFor(c.role);
  return get(`SELECT COUNT(*) AS n FROM ai_price_observations WHERE tenant_id=? AND competitor_product_id=? AND lifecycle_status='active'
    AND access_level NOT IN (${levels.map(() => "?").join(",")})`, c.tenantId, competitorProductId, ...levels).n;
}

export function compareWithCompetitorTool(ctx, { productId, competitorProductId }, { getProductSpecs, comparisonRows }) {
  return guard(ctx, (c) => {
    let theirs;
    try { theirs = competitorSpecs(c, competitorProductId); } catch (e) { if (e.status === 404) return null; throw e; }
    const ours = getProductSpecs(ctx, { productId });
    if (!ours) return null;
    const items = [ours, theirs];
    return { items, products: items.map((it) => it.product), rows: comparisonRows(items), analog: analogStatus(c, productId, competitorProductId), prices: competitorPrices(c, competitorProductId) };
  });
}

export const competitorScopeAllowed = (scope) => scopeOf(roleOf(scope)) !== "public";
