// Справочник имён для распознавания вопросов: действующие компании, марки и
// товары конкурентов, видимые роли. Только чтение. Гостю — пусто: он о
// конкурентах не узнаёт даже по названию (requireReader).
import { all } from "../../db/index.js";
import { requireReader } from "./model.js";

export function competitorRegistry(ctx) {
  const levels = requireReader(ctx);
  const IN = levels.map(() => "?").join(",");
  const companies = all(`SELECT id, name, legal_name FROM ai_companies WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN})`, ctx.tenantId, ...levels);
  const visible = new Set(companies.map((c) => c.id));
  const nameOf = new Map(companies.map((c) => [c.id, c.name]));
  const brands = all("SELECT id, company_id, name FROM ai_brands WHERE tenant_id=? AND lifecycle_status='active'", ctx.tenantId).filter((b) => visible.has(b.company_id));
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const products = all(`SELECT id, company_id, brand_id, category_id, name, short_name FROM ai_competitor_products WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN (${IN})`, ctx.tenantId, ...levels)
    .filter((p) => visible.has(p.company_id));
  return [
    ...companies.map((c) => ({ type: "company", id: c.id, name: c.name, names: [c.name, c.legal_name].filter(Boolean), companyId: c.id, companyName: c.name })),
    ...brands.map((b) => ({ type: "brand", id: b.id, name: b.name, names: [b.name], companyId: b.company_id, companyName: nameOf.get(b.company_id), brandId: b.id })),
    ...products.map((p) => ({ type: "product", id: p.id, name: p.name, short: p.short_name, names: [p.name, p.short_name].filter(Boolean), companyId: p.company_id,
      companyName: nameOf.get(p.company_id), brandId: p.brand_id, brandName: brandName.get(p.brand_id) ?? null, categoryId: p.category_id })),
  ];
}
