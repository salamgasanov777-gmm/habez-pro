// Наблюдения цен товара конкурента. Цена — всегда с источником и датой
// наблюдения, в копейках, с видом цены и основой («за мешок 25 кг»).
// Разные основы не пересчитываются друг в друга, действующая цена не
// выбирается. Новая цена старую не меняет; удалить нельзя (триггер).
import { z } from "zod";
import { createHash } from "node:crypto";
import { all, insert, update, tx, get } from "../../db/index.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { PRICE_KINDS, BASIS_UNITS, VAT, parse, zId, zText, zDate, zAccess, requireWriter, requireReader, rowOf, audit, assertNoPersonalData, now } from "./model.js";
import { visibleProduct } from "./products.js";
import { checkSource, checkPack } from "./observations.js";
import { priceGroups } from "./resolve.js";
import { setVerification } from "./entity.js";

const input = z.object({
  competitorProductId: zId, packId: zId.nullable().optional(),
  amountMinor: z.number().int().min(0).max(1e12), currency: z.string().regex(/^[A-Z]{3}$/).default("RUB"),
  priceKind: z.enum(PRICE_KINDS), priceBasis: zText(120), basisUnit: z.enum(BASIS_UNITS), basisQty: z.number().positive().nullable().optional(),
  vat: z.enum(VAT).default("unknown"), sellerCompanyId: zId.nullable().optional(), regionId: zId.nullable().optional(),
  observedAt: zDate, sourceId: zId, sourceReference: z.string().trim().max(300).nullable().optional(),
  accessLevel: zAccess.default("internal"), evidenceNote: z.string().trim().max(1000).nullable().optional(),
}).strict();

const hashOf = (b) => createHash("sha256").update(JSON.stringify([
  b.competitorProductId, b.packId ?? null, b.amountMinor, b.currency, b.priceKind, b.basisUnit, b.basisQty ?? null, b.vat,
  b.sellerCompanyId ?? null, b.regionId ?? null, b.observedAt, b.sourceId, b.sourceReference ?? null,
])).digest("hex");

export const priceView = (r) => r && ({
  id: r.id, competitorProductId: r.competitor_product_id, packId: r.pack_id, amountMinor: r.amount_minor, currency: r.currency, priceKind: r.price_kind,
  priceBasis: r.price_basis, basisUnit: r.basis_unit, basisQty: r.basis_qty, vat: r.vat, sellerCompanyId: r.seller_company_id, regionId: r.region_id,
  observedAt: r.observed_at, sourceId: r.source_id, sourceReference: r.source_reference, capturedAt: r.captured_at, accessLevel: r.access_level,
  evidenceNote: r.evidence_note, verificationStatus: r.verification_status, lifecycleStatus: r.lifecycle_status, replacedById: r.replaced_by_id, lifecycleNote: r.lifecycle_note,
});

const today = () => new Date().toISOString().slice(0, 10);

export function createPrice(ctx, data) {
  requireWriter(ctx);
  // Без источника и даты цена не принимается — это проверяет схема
  // (sourceId, observedAt обязательны) и ещё раз база (NOT NULL).
  const b = parse(input, data);
  assertNoPersonalData(b, ["priceBasis", "sourceReference", "evidenceNote"]);
  if (b.observedAt > today()) throw badRequest("Дата наблюдения цены — не позже сегодняшнего дня");
  const p = rowOf(ctx, "ai_competitor_products", b.competitorProductId, { what: "Товар конкурента" });
  if (p.lifecycle_status !== "active") throw badRequest("Товар снят");
  checkPack(ctx, b.packId, b.competitorProductId);
  checkSource(ctx, b.sourceId);
  if (b.sellerCompanyId) rowOf(ctx, "ai_companies", b.sellerCompanyId, { what: "Продавец" });
  if (b.regionId) rowOf(ctx, "ai_regions", b.regionId, { what: "Регион" });
  const hash = hashOf(b);
  if (get("SELECT id FROM ai_price_observations WHERE tenant_id=? AND content_hash=?", ctx.tenantId, hash)) throw conflict("Такая цена из этого источника на эту дату уже записана");
  const id = tx(() => {
    const pid = insert("ai_price_observations", {
      tenant_id: ctx.tenantId, competitor_product_id: b.competitorProductId, pack_id: b.packId ?? null, amount_minor: b.amountMinor, currency: b.currency,
      price_kind: b.priceKind, price_basis: b.priceBasis, basis_unit: b.basisUnit, basis_qty: b.basisQty ?? null, vat: b.vat,
      seller_company_id: b.sellerCompanyId ?? null, region_id: b.regionId ?? null, observed_at: b.observedAt, source_id: b.sourceId,
      source_reference: b.sourceReference ?? null, access_level: b.accessLevel, evidence_note: b.evidenceNote ?? null, content_hash: hash, created_by: ctx.actorId ?? null,
    });
    audit(ctx, "ai.competitor.price.create", "ai_price_observations", pid, {
      competitorProductId: b.competitorProductId, packId: b.packId ?? null, amountMinor: b.amountMinor, currency: b.currency, priceKind: b.priceKind,
      basis: b.priceBasis, regionId: b.regionId ?? null, observedAt: b.observedAt, sourceId: b.sourceId, accessLevel: b.accessLevel,
    });
    return pid;
  });
  return getPrice(ctx, id);
}

// Замена цены — только той же группы (товар, фасовка, вид, основа, НДС,
// регион, валюта) и с обоснованием («в прайсе опечатка»). Более новая дата
// сама по себе ничего не заменяет.
export function supersedePrice(ctx, oldId, newId, note) {
  requireWriter(ctx);
  if (!String(note ?? "").trim()) throw badRequest("Укажите, на каком основании прежняя цена заменяется");
  const a = rowOf(ctx, "ai_price_observations", oldId, { what: "Цена" });
  const b = rowOf(ctx, "ai_price_observations", newId, { what: "Цена" });
  const key = (r) => [r.competitor_product_id, r.pack_id, r.price_kind, r.basis_unit, r.basis_qty, r.vat, r.region_id, r.currency].join("|");
  if (a.id === b.id || key(a) !== key(b)) throw badRequest("Заменить можно только цену той же группы (товар, фасовка, вид, основа, НДС, регион, валюта)");
  if (a.lifecycle_status !== "active" || b.lifecycle_status !== "active") throw badRequest("Заменять можно только действующие цены");
  tx(() => {
    update("ai_price_observations", a.id, { lifecycle_status: "superseded", replaced_by_id: b.id, lifecycle_note: String(note).trim().slice(0, 500), updated_at: now() });
    audit(ctx, "ai.competitor.price.supersede", "ai_price_observations", a.id, { replacedBy: b.id, note: String(note).trim().slice(0, 500) });
  });
  return getPrice(ctx, a.id);
}

export function withdrawPrice(ctx, id, reason) {
  requireWriter(ctx);
  if (!String(reason ?? "").trim()) throw badRequest("Укажите причину, по которой цена снимается");
  const r = rowOf(ctx, "ai_price_observations", id, { what: "Цена" });
  if (r.lifecycle_status === "withdrawn") return priceView(r);
  tx(() => {
    update("ai_price_observations", id, { lifecycle_status: "withdrawn", lifecycle_note: String(reason).trim().slice(0, 500), updated_at: now() });
    audit(ctx, "ai.competitor.price.withdraw", "ai_price_observations", id, { reason: String(reason).trim().slice(0, 500) });
  });
  return getPrice(ctx, id);
}

export function getPrice(ctx, id) {
  const levels = requireReader(ctx);
  const r = rowOf(ctx, "ai_price_observations", id, { what: "Цена", levels });
  visibleProduct(ctx, r.competitor_product_id, levels);
  return priceView(r);
}

// Все цены товара, видимые роли (с историей), и группы сравнимых цен.
export function productPrices(ctx, competitorProductId) {
  const levels = requireReader(ctx);
  visibleProduct(ctx, competitorProductId, levels);
  const prices = all(`SELECT * FROM ai_price_observations WHERE tenant_id=? AND competitor_product_id=? AND access_level IN (${levels.map(() => "?").join(",")})
    ORDER BY observed_at, id`, ctx.tenantId, competitorProductId, ...levels).map(priceView);
  return { prices, groups: priceGroups(prices) };
}

export const setPriceVerification = (ctx, id, status, note) => priceView(setVerification(ctx, { table: "ai_price_observations", what: "Цена", action: "ai.competitor.price", id, status, note }));
