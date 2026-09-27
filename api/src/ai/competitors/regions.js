// Регионы: где продаёт компания и где наблюдалась цена.
import { z } from "zod";
import { all, get } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { REGION_KINDS, nameKey, parse, zId, zText, requireReader, rowOf } from "./model.js";
import { createEntity, updateEntity, withdrawEntity } from "./entity.js";

const T = { table: "ai_regions", what: "Регион", action: "ai.competitor.region" };
const input = z.object({ name: zText(120), kind: z.enum(REGION_KINDS).default("region"), parentId: zId.nullable().optional(), code: z.string().trim().max(20).nullable().optional() }).strict();

const view = (r) => r && ({ id: r.id, name: r.name, kind: r.kind, parentId: r.parent_id, code: r.code, lifecycleStatus: r.lifecycle_status, withdrawnReason: r.withdrawn_reason });

function checkParent(ctx, parentId) {
  if (!parentId) return;
  const p = rowOf(ctx, "ai_regions", parentId, { what: "Регион" });
  if (p.lifecycle_status !== "active") throw badRequest("Родительский регион снят");
}

export function createRegion(ctx, data) {
  const b = parse(input, data);
  checkParent(ctx, b.parentId);
  const id = createEntity(ctx, { ...T, row: { name: b.name, name_key: nameKey(b.name), kind: b.kind, parent_id: b.parentId ?? null, code: b.code ?? null }, auditFields: ["name", "kind", "parent_id", "code"] });
  return getRegion(ctx, id);
}
export function updateRegion(ctx, id, data) {
  const b = parse(input.partial(), data);
  if (b.parentId !== undefined) { checkParent(ctx, b.parentId); if (b.parentId === id) throw badRequest("Регион не может быть родителем самому себе"); }
  const patch = {};
  if (b.name !== undefined) Object.assign(patch, { name: b.name, name_key: nameKey(b.name) });
  if (b.kind !== undefined) patch.kind = b.kind;
  if (b.parentId !== undefined) patch.parent_id = b.parentId;
  if (b.code !== undefined) patch.code = b.code;
  return view(updateEntity(ctx, { ...T, id, patch }));
}
export const withdrawRegion = (ctx, id, reason) => view(withdrawEntity(ctx, { ...T, id, reason }));

export function getRegion(ctx, id) {
  requireReader(ctx);
  return view(rowOf(ctx, "ai_regions", id, { what: "Регион" }));
}
export function listRegions(ctx, { includeWithdrawn = false } = {}) {
  requireReader(ctx);
  return all(`SELECT * FROM ai_regions WHERE tenant_id=?${includeWithdrawn ? "" : " AND lifecycle_status='active'"} ORDER BY name_key`, ctx.tenantId).map(view);
}
export function regionByName(ctx, name) {
  requireReader(ctx);
  return view(get("SELECT * FROM ai_regions WHERE tenant_id=? AND name_key=? AND lifecycle_status='active'", ctx.tenantId, nameKey(name)));
}
