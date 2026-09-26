// Марки. Марка всегда принадлежит компании и сама компанией не становится:
// совпадение названий марки и компании ничего не объединяет.
import { z } from "zod";
import { all } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { nameKey, parse, zId, zText, requireReader, rowOf, assertNoPersonalData } from "./model.js";
import { createEntity, updateEntity, withdrawEntity } from "./entity.js";

const T = { table: "ai_brands", what: "Марка", action: "ai.competitor.brand" };
const input = z.object({ companyId: zId, name: zText(120), notes: z.string().trim().max(1000).nullable().optional() }).strict();

export const brandView = (r) => r && ({ id: r.id, companyId: r.company_id, name: r.name, notes: r.notes, lifecycleStatus: r.lifecycle_status, withdrawnReason: r.withdrawn_reason });

function checkCompany(ctx, companyId) {
  const c = rowOf(ctx, "ai_companies", companyId, { what: "Компания" });
  if (c.lifecycle_status !== "active") throw badRequest("Компания снята — марку к ней не добавить");
  return c;
}

export function createBrand(ctx, data) {
  const b = parse(input, data);
  assertNoPersonalData(b, ["notes"]);
  checkCompany(ctx, b.companyId);
  const id = createEntity(ctx, { ...T, row: { company_id: b.companyId, name: b.name, name_key: nameKey(b.name), notes: b.notes ?? null }, auditFields: ["company_id", "name"] });
  return getBrand(ctx, id);
}
// Марку не переносят к другой компании: это была бы уже другая марка.
export function updateBrand(ctx, id, data) {
  const b = parse(input.omit({ companyId: true }).partial(), data);
  assertNoPersonalData(b, ["notes"]);
  const patch = {};
  if (b.name !== undefined) Object.assign(patch, { name: b.name, name_key: nameKey(b.name) });
  if (b.notes !== undefined) patch.notes = b.notes;
  return brandView(updateEntity(ctx, { ...T, id, patch }));
}
export const withdrawBrand = (ctx, id, reason) => brandView(withdrawEntity(ctx, { ...T, id, reason }));

// Марка видна, если видна её компания.
export function getBrand(ctx, id) {
  const levels = requireReader(ctx);
  const b = rowOf(ctx, "ai_brands", id, { what: "Марка" });
  rowOf(ctx, "ai_companies", b.company_id, { what: "Марка", levels });
  return brandView(b);
}
export function listBrands(ctx, companyId, { includeWithdrawn = false } = {}) {
  const levels = requireReader(ctx);
  rowOf(ctx, "ai_companies", companyId, { what: "Компания", levels });
  return all(`SELECT * FROM ai_brands WHERE tenant_id=? AND company_id=?${includeWithdrawn ? "" : " AND lifecycle_status='active'"} ORDER BY name_key`, ctx.tenantId, companyId).map(brandView);
}
