// Связь «наш товар ↔ товар конкурента». Хранится только утверждение с
// допустимым основанием:
//   explicit_source_statement — источник прямо называет товар аналогом
//     (или не аналогом); ссылка на источник обязательна;
//   user_decision — решение сотрудника с обоснованием (note обязателен).
// Статус CONFIRMED / INFERRED / UNKNOWN / CONFLICTED считается при чтении
// (resolve.js → analogStatusOf); INFERRED не записывается никогда.
// Частичный аналог — всегда с перечнем различий: «аналог» не значит
// «одинаковый товар». Снять можно, удалить и переписать — нет.
import { z } from "zod";
import { createHash } from "node:crypto";
import { all, get, insert, update, tx } from "../../db/index.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { ANALOG_RELATIONS, ANALOG_BASES, parse, zId, zAccess, requireWriter, requireReader, rowOf, audit, assertNoPersonalData, now } from "./model.js";
import { visibleProduct } from "./products.js";
import { checkSource } from "./observations.js";
import { analogStatusOf } from "./resolve.js";

const input = z.object({
  productId: zId, competitorProductId: zId, relation: z.enum(ANALOG_RELATIONS), basis: z.enum(ANALOG_BASES),
  sourceId: zId.nullable().optional(), sourceReference: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(), differences: z.string().trim().max(2000).nullable().optional(), accessLevel: zAccess.default("internal"),
}).strict();

export const analogView = (r) => r && ({
  id: r.id, productId: r.product_id, competitorProductId: r.competitor_product_id, relation: r.relation, basis: r.basis, sourceId: r.source_id,
  sourceReference: r.source_reference, note: r.note, differences: r.differences, accessLevel: r.access_level, lifecycleStatus: r.lifecycle_status,
  withdrawnReason: r.withdrawn_reason, withdrawnAt: r.withdrawn_at, createdAt: r.created_at,
});

function ourProduct(ctx, productId) {
  const p = get("SELECT p.id, p.slug, p.name, p.short_name, p.category_id, p.status FROM products p WHERE p.id=? AND p.tenant_id=?", productId, ctx.tenantId);
  if (!p) throw notFound("Товар Habez не найден");
  return p;
}

export function createAnalog(ctx, data) {
  requireWriter(ctx);
  const b = parse(input, data);
  assertNoPersonalData(b, ["sourceReference", "note", "differences"]);
  if (b.basis === "explicit_source_statement" && !b.sourceId) throw badRequest("Прямое указание источника — нужен источник (sourceId)");
  if (b.basis === "user_decision" && !String(b.note ?? "").trim()) throw badRequest("Решение сотрудника принимается только с обоснованием (note)");
  if (b.relation === "partial_analog" && !String(b.differences ?? "").trim()) throw badRequest("Частичный аналог — укажите, чем товары различаются (differences)");
  const ours = ourProduct(ctx, b.productId);
  if (ours.status === "archived") throw badRequest("Товар Habez в архиве");
  const cp = rowOf(ctx, "ai_competitor_products", b.competitorProductId, { what: "Товар конкурента" });
  if (cp.lifecycle_status !== "active") throw badRequest("Товар конкурента снят");
  if (b.sourceId) checkSource(ctx, b.sourceId);
  const hash = createHash("sha256").update(JSON.stringify([b.productId, b.competitorProductId, b.relation, b.basis, b.sourceId ?? null, b.sourceReference ?? null, b.note ?? null])).digest("hex");
  if (get("SELECT id FROM ai_competitor_analogs WHERE tenant_id=? AND content_hash=?", ctx.tenantId, hash)) throw conflict("Такое утверждение уже записано");
  const id = tx(() => {
    const aid = insert("ai_competitor_analogs", {
      tenant_id: ctx.tenantId, product_id: b.productId, competitor_product_id: b.competitorProductId, relation: b.relation, basis: b.basis,
      source_id: b.sourceId ?? null, source_reference: b.sourceReference ?? null, note: b.note ?? null, differences: b.differences ?? null,
      access_level: b.accessLevel, content_hash: hash, created_by: ctx.actorId ?? null,
    });
    audit(ctx, "ai.competitor.analog.create", "ai_competitor_analogs", aid, {
      productId: b.productId, competitorProductId: b.competitorProductId, relation: b.relation, basis: b.basis, sourceId: b.sourceId ?? null, accessLevel: b.accessLevel,
    });
    return aid;
  });
  return analogView(rowOf(ctx, "ai_competitor_analogs", id, { what: "Связь" }));
}

export function withdrawAnalog(ctx, id, reason) {
  requireWriter(ctx);
  if (!String(reason ?? "").trim()) throw badRequest("Укажите причину, по которой утверждение снимается");
  const r = rowOf(ctx, "ai_competitor_analogs", id, { what: "Связь" });
  if (r.lifecycle_status === "withdrawn") return analogView(r);
  tx(() => {
    update("ai_competitor_analogs", id, { lifecycle_status: "withdrawn", withdrawn_reason: String(reason).trim().slice(0, 500), withdrawn_by: ctx.actorId ?? null, withdrawn_at: now() });
    audit(ctx, "ai.competitor.analog.withdraw", "ai_competitor_analogs", id, { reason: String(reason).trim().slice(0, 500) });
  });
  return analogView(rowOf(ctx, "ai_competitor_analogs", id, { what: "Связь" }));
}

// Статус одной пары. Видимые роли утверждения — основание; скрытые — только
// флаг «нужна сверка», если они изменили бы статус.
function pairStatus(ctx, levels, ours, cp) {
  const rows = all("SELECT * FROM ai_competitor_analogs WHERE tenant_id=? AND product_id=? AND competitor_product_id=? ORDER BY id", ctx.tenantId, ours.id, cp.id);
  const visible = rows.filter((r) => levels.includes(r.access_level)).map(analogView);
  const hiddenRelations = rows.filter((r) => !levels.includes(r.access_level) && r.lifecycle_status === "active").map((r) => r.relation);
  const sameCategory = !!ours.category_id && ours.category_id === cp.category_id;
  return {
    product: { id: ours.id, slug: ours.slug, name: ours.name, short: ours.short_name || ours.name },
    competitorProduct: { id: cp.id, name: cp.name, short: cp.short_name || cp.name, companyId: cp.company_id, brandId: cp.brand_id },
    ...analogStatusOf(visible, { sameCategory, hiddenRelations }),
  };
}

export function analogStatus(ctx, productId, competitorProductId) {
  const levels = requireReader(ctx);
  return pairStatus(ctx, levels, ourProduct(ctx, productId), visibleProduct(ctx, competitorProductId, levels));
}

// Аналоги нашего товара: пары с утверждениями и пары, которые можно только
// предположить (тот же раздел каталога) — отдельно, как INFERRED.
// «Нет данных» (UNKNOWN) в список не попадает.
export function findAnalogs(ctx, productId) {
  const levels = requireReader(ctx);
  const ours = ourProduct(ctx, productId);
  const IN = levels.map(() => "?").join(",");
  const cps = all(`SELECT DISTINCT cp.* FROM ai_competitor_products cp JOIN ai_companies c ON c.id=cp.company_id
     WHERE cp.tenant_id=? AND cp.lifecycle_status='active' AND c.lifecycle_status='active' AND cp.access_level IN (${IN}) AND c.access_level IN (${IN})
       AND (cp.id IN (SELECT competitor_product_id FROM ai_competitor_analogs WHERE tenant_id=? AND product_id=?) OR (cp.category_id IS NOT NULL AND cp.category_id=?))
     ORDER BY cp.name_key`, ctx.tenantId, ...levels, ...levels, ctx.tenantId, ours.id, ours.category_id ?? -1);
  const order = { CONFIRMED: 0, CONFLICTED: 1, INFERRED: 2, UNKNOWN: 3 };
  return cps.map((cp) => pairStatus(ctx, levels, ours, cp)).filter((x) => x.status !== "UNKNOWN").sort((a, b) => order[a.status] - order[b.status]);
}

// Наши товары, которые сопоставлены с товаром конкурента (только утверждения).
export function analogsOfCompetitorProduct(ctx, competitorProductId) {
  const levels = requireReader(ctx);
  const cp = visibleProduct(ctx, competitorProductId, levels);
  const ids = all("SELECT DISTINCT product_id FROM ai_competitor_analogs WHERE tenant_id=? AND competitor_product_id=?", ctx.tenantId, cp.id).map((r) => r.product_id);
  return ids.map((id) => pairStatus(ctx, levels, ourProduct(ctx, id), cp)).filter((x) => x.status !== "UNKNOWN" && x.status !== "INFERRED");
}
