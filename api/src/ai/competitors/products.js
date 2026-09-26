// Товары конкурентов. Живут только здесь: в products (витрина, заказы,
// поиск, выгрузка на сервер) не попадают никогда. category_id — наш раздел
// каталога для сопоставления, не больше.
import { z } from "zod";
import { all, get } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { MARKET_STATUSES, nameKey, parse, zId, zText, zAccess, requireReader, rowOf, assertNoPersonalData } from "./model.js";
import { createEntity, updateEntity, withdrawEntity } from "./entity.js";

const T = { table: "ai_competitor_products", what: "Товар конкурента", action: "ai.competitor.product" };
const input = z.object({
  companyId: zId, brandId: zId.nullable().optional(), categoryId: zId.nullable().optional(), name: zText(200),
  shortName: z.string().trim().max(80).nullable().optional(), gost: z.string().trim().max(120).nullable().optional(),
  marketStatus: z.enum(MARKET_STATUSES).default("unknown"), notes: z.string().trim().max(2000).nullable().optional(), accessLevel: zAccess.default("internal"),
}).strict();

export const productView = (r) => r && ({
  id: r.id, companyId: r.company_id, brandId: r.brand_id, categoryId: r.category_id, name: r.name, shortName: r.short_name, gost: r.gost,
  marketStatus: r.market_status, notes: r.notes, accessLevel: r.access_level, lifecycleStatus: r.lifecycle_status, withdrawnReason: r.withdrawn_reason,
});

// Марка — той же компании; раздел — наш, этой же компании-арендатора.
function checkRefs(ctx, companyId, brandId, categoryId) {
  const c = rowOf(ctx, "ai_companies", companyId, { what: "Компания" });
  if (c.lifecycle_status !== "active") throw badRequest("Компания снята");
  if (brandId) {
    const b = rowOf(ctx, "ai_brands", brandId, { what: "Марка" });
    if (b.company_id !== companyId) throw badRequest("Марка принадлежит другой компании");
    if (b.lifecycle_status !== "active") throw badRequest("Марка снята");
  }
  if (categoryId && !get("SELECT id FROM categories WHERE id=? AND tenant_id=?", categoryId, ctx.tenantId)) throw badRequest("Раздел каталога не найден");
}
const toRow = (b) => {
  const row = {};
  if (b.name !== undefined) Object.assign(row, { name: b.name, name_key: nameKey(b.name) });
  for (const [k, c] of [["brandId", "brand_id"], ["categoryId", "category_id"], ["shortName", "short_name"], ["gost", "gost"], ["marketStatus", "market_status"],
    ["notes", "notes"], ["accessLevel", "access_level"]]) if (b[k] !== undefined) row[c] = b[k];
  return row;
};

export function createCompetitorProduct(ctx, data) {
  const b = parse(input, data);
  assertNoPersonalData(b, ["notes"]);
  checkRefs(ctx, b.companyId, b.brandId, b.categoryId);
  const id = createEntity(ctx, { ...T, row: { company_id: b.companyId, ...toRow(b) }, auditFields: ["company_id", "brand_id", "category_id", "name", "access_level"] });
  return getCompetitorProduct(ctx, id);
}
// Товар не переносят к другой компании — это уже другой товар.
export function updateCompetitorProduct(ctx, id, data) {
  const b = parse(input.omit({ companyId: true }).partial(), data);
  assertNoPersonalData(b, ["notes"]);
  const cur = rowOf(ctx, T.table, id, { what: T.what });
  checkRefs(ctx, cur.company_id, b.brandId === undefined ? null : b.brandId, b.categoryId === undefined ? null : b.categoryId);
  return productView(updateEntity(ctx, { ...T, id, patch: toRow(b) }));
}
export const withdrawCompetitorProduct = (ctx, id, reason) => productView(withdrawEntity(ctx, { ...T, id, reason }));

// Товар виден, если виден он сам и его компания.
export function visibleProduct(ctx, id, levels = requireReader(ctx)) {
  const p = rowOf(ctx, T.table, id, { what: T.what, levels });
  rowOf(ctx, "ai_companies", p.company_id, { what: T.what, levels });
  return p;
}
export const getCompetitorProduct = (ctx, id) => productView(visibleProduct(ctx, id));

export function listCompetitorProducts(ctx, { companyId = null, brandId = null, categoryId = null, includeWithdrawn = false } = {}) {
  const levels = requireReader(ctx);
  const IN = levels.map(() => "?").join(",");
  const where = ["p.tenant_id=?", `p.access_level IN (${IN})`, `c.access_level IN (${IN})`];
  const args = [ctx.tenantId, ...levels, ...levels];
  // Товары снятой компании в «действующих» не показываются.
  if (!includeWithdrawn) where.push("p.lifecycle_status='active'", "c.lifecycle_status='active'");
  for (const [v, col] of [[companyId, "p.company_id"], [brandId, "p.brand_id"], [categoryId, "p.category_id"]]) if (v) { where.push(`${col}=?`); args.push(v); }
  return all(`SELECT p.* FROM ai_competitor_products p JOIN ai_companies c ON c.id=p.company_id WHERE ${where.join(" AND ")} ORDER BY p.name_key`, ...args).map(productView);
}
