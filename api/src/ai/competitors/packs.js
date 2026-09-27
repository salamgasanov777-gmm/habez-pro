// Фасовки товара конкурента (как variants у наших товаров).
import { z } from "zod";
import { all } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { parse, zId, zText, rowOf, requireReader } from "./model.js";
import { createEntity, updateEntity, withdrawEntity } from "./entity.js";
import { visibleProduct } from "./products.js";

const T = { table: "ai_competitor_packs", what: "Фасовка", action: "ai.competitor.pack" };
const input = z.object({
  competitorProductId: zId, unitLabel: zText(80), packSize: z.number().positive().nullable().optional(), packUnit: z.string().trim().max(10).nullable().optional(),
  weightKg: z.number().positive().nullable().optional(), barcode: z.string().regex(/^\d{8,14}$/, "штрихкод — 8–14 цифр").nullable().optional(),
}).strict();

export const packView = (r) => r && ({ id: r.id, competitorProductId: r.competitor_product_id, unitLabel: r.unit_label, packSize: r.pack_size, packUnit: r.pack_unit,
  weightKg: r.weight_kg, barcode: r.barcode, lifecycleStatus: r.lifecycle_status, withdrawnReason: r.withdrawn_reason });

const toRow = (b) => {
  const row = {};
  for (const [k, c] of [["unitLabel", "unit_label"], ["packSize", "pack_size"], ["packUnit", "pack_unit"], ["weightKg", "weight_kg"], ["barcode", "barcode"]]) if (b[k] !== undefined) row[c] = b[k];
  return row;
};

export function createPack(ctx, data) {
  const b = parse(input, data);
  const p = rowOf(ctx, "ai_competitor_products", b.competitorProductId, { what: "Товар конкурента" });
  if (p.lifecycle_status !== "active") throw badRequest("Товар снят — фасовку к нему не добавить");
  const id = createEntity(ctx, { ...T, row: { competitor_product_id: b.competitorProductId, ...toRow(b) }, auditFields: ["competitor_product_id", "unit_label", "pack_size", "pack_unit", "weight_kg", "barcode"] });
  return getPack(ctx, id);
}
export function updatePack(ctx, id, data) {
  const b = parse(input.omit({ competitorProductId: true }).partial(), data);
  return packView(updateEntity(ctx, { ...T, id, patch: toRow(b) }));
}
export const withdrawPack = (ctx, id, reason) => packView(withdrawEntity(ctx, { ...T, id, reason }));

export function getPack(ctx, id) {
  const levels = requireReader(ctx);
  const k = rowOf(ctx, T.table, id, { what: T.what });
  visibleProduct(ctx, k.competitor_product_id, levels);
  return packView(k);
}
export function listPacks(ctx, competitorProductId, { includeWithdrawn = false } = {}) {
  visibleProduct(ctx, competitorProductId);
  return all(`SELECT * FROM ai_competitor_packs WHERE tenant_id=? AND competitor_product_id=?${includeWithdrawn ? "" : " AND lifecycle_status='active'"} ORDER BY id`, ctx.tenantId, competitorProductId).map(packView);
}
