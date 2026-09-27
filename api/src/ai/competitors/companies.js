// Компании: производитель, владелец марки, дилер, дистрибьютор, сеть,
// маркетплейс. Конкурентом компанию делает только competitor_status,
// поставленный человеком, — не сам факт записи.
import { z } from "zod";
import { all } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { COMPANY_KINDS, COMPETITOR_STATUSES, nameKey, parse, zId, zText, zAccess, requireReader, rowOf, assertNoPersonalData } from "./model.js";
import { createEntity, updateEntity, withdrawEntity } from "./entity.js";

const T = { table: "ai_companies", what: "Компания", action: "ai.competitor.company" };
const input = z.object({
  name: zText(160), legalName: z.string().trim().max(200).nullable().optional(), inn: z.string().regex(/^\d{10}(\d{2})?$/, "ИНН — 10 или 12 цифр").nullable().optional(),
  website: z.string().trim().url().max(300).nullable().optional(), kind: z.enum(COMPANY_KINDS).default("unknown"),
  competitorStatus: z.enum(COMPETITOR_STATUSES).default("unknown"), hqRegionId: zId.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(), accessLevel: zAccess.default("internal"),
}).strict();

export const companyView = (r) => r && ({
  id: r.id, name: r.name, legalName: r.legal_name, inn: r.inn, website: r.website, kind: r.kind, competitorStatus: r.competitor_status,
  hqRegionId: r.hq_region_id, notes: r.notes, accessLevel: r.access_level, lifecycleStatus: r.lifecycle_status, withdrawnReason: r.withdrawn_reason,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

function checkRegion(ctx, id) {
  if (!id) return;
  if (rowOf(ctx, "ai_regions", id, { what: "Регион" }).lifecycle_status !== "active") throw badRequest("Регион снят");
}
const toRow = (b) => {
  const row = {};
  if (b.name !== undefined) Object.assign(row, { name: b.name, name_key: nameKey(b.name) });
  for (const [k, c] of [["legalName", "legal_name"], ["inn", "inn"], ["website", "website"], ["kind", "kind"], ["competitorStatus", "competitor_status"],
    ["hqRegionId", "hq_region_id"], ["notes", "notes"], ["accessLevel", "access_level"]]) if (b[k] !== undefined) row[c] = b[k];
  return row;
};

export function createCompany(ctx, data) {
  const b = parse(input, data);
  assertNoPersonalData(b, ["notes"]);
  checkRegion(ctx, b.hqRegionId);
  const id = createEntity(ctx, { ...T, row: toRow(b), auditFields: ["name", "kind", "competitor_status", "access_level"] });
  return getCompany(ctx, id);
}
export function updateCompany(ctx, id, data) {
  const b = parse(input.partial(), data);
  assertNoPersonalData(b, ["notes"]);
  checkRegion(ctx, b.hqRegionId);
  return companyView(updateEntity(ctx, { ...T, id, patch: toRow(b) }));
}
export const withdrawCompany = (ctx, id, reason) => companyView(withdrawEntity(ctx, { ...T, id, reason }));

export function getCompany(ctx, id) {
  const levels = requireReader(ctx);
  return companyView(rowOf(ctx, "ai_companies", id, { what: "Компания", levels }));
}
export function listCompanies(ctx, { competitorStatus = null, kind = null, includeWithdrawn = false } = {}) {
  const levels = requireReader(ctx);
  const where = ["tenant_id=?", `access_level IN (${levels.map(() => "?").join(",")})`];
  const args = [ctx.tenantId, ...levels];
  if (!includeWithdrawn) where.push("lifecycle_status='active'");
  if (competitorStatus) { where.push("competitor_status=?"); args.push(competitorStatus); }
  if (kind) { where.push("kind=?"); args.push(kind); }
  return all(`SELECT * FROM ai_companies WHERE ${where.join(" AND ")} ORDER BY name_key`, ...args).map(companyView);
}
