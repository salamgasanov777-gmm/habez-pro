// Наблюдения характеристик товара конкурента. Правила — модели 2.2B:
// ключ из словаря, условие только с дословной цитатой, тип утверждения,
// исходная строка всегда, число — если разобралось, источник обязателен.
// Новое наблюдение старое не меняет; замена — отдельным действием
// (superseded + ссылка на новое), снятие — withdrawn с причиной. Удалить
// нельзя (триггер в schema.sql).
import { z } from "zod";
import { createHash } from "node:crypto";
import { all, insert, update, tx, get } from "../../db/index.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { STATEMENT_TYPES, evidenceKeyMeta, canonicalConditions } from "../knowledge/evidence-model.js";
import { sourcePriorities } from "../knowledge/evidence.js";
import { parseSpecValue, UNIT_LABEL } from "../knowledge/units.js";
import { COMPETITOR_SOURCE_TYPES, parse, zId, zText, zDate, zAccess, requireWriter, requireReader, rowOf, audit, assertNoPersonalData, now } from "./model.js";
import { visibleProduct } from "./products.js";
import { setVerification } from "./entity.js";
import { propertyGroups } from "./resolve.js";

const input = z.object({
  competitorProductId: zId, packId: zId.nullable().optional(), specKey: z.string().regex(/^[a-z0-9_]{2,60}$/), label: z.string().trim().max(200).nullable().optional(),
  originalValue: zText(500), conditions: z.record(z.union([z.string(), z.number()])).optional(), conditionText: z.string().trim().max(500).nullable().optional(),
  statementType: z.enum(STATEMENT_TYPES).default("unknown"), sourceType: z.enum(COMPETITOR_SOURCE_TYPES), sourceId: zId,
  sourceReference: z.string().trim().max(300).nullable().optional(), providedAt: zDate.nullable().optional(), accessLevel: zAccess.default("internal"),
  evidenceNote: z.string().trim().max(1000).nullable().optional(),
}).strict();

const hashOf = (b, conditionKey) => createHash("sha256").update(JSON.stringify([
  b.competitorProductId, b.packId ?? null, b.specKey, conditionKey, b.statementType, b.sourceType, b.sourceId, b.sourceReference ?? null, String(b.originalValue).trim(),
])).digest("hex");

export const observationView = (r) => r && ({
  id: r.id, competitorProductId: r.competitor_product_id, packId: r.pack_id, specKey: r.spec_key, label: r.label || evidenceKeyMeta(r.spec_key)?.label || r.spec_key,
  conditions: JSON.parse(r.conditions_json || "{}"), conditionKey: r.condition_key, conditionText: r.condition_text, statementType: r.statement_type,
  originalValue: r.original_value, value: { num: r.value_num, min: r.value_min, max: r.value_max, bool: r.value_bool === null ? null : !!r.value_bool, text: r.value_text },
  unitRaw: r.unit_raw, normalizedUnit: r.normalized_unit, unitLabel: UNIT_LABEL[r.normalized_unit] || r.unit_raw || null, comparator: r.comparator,
  sourceType: r.source_type, sourceId: r.source_id, sourceReference: r.source_reference, providedAt: r.provided_at, capturedAt: r.captured_at,
  accessLevel: r.access_level, evidenceNote: r.evidence_note, verificationStatus: r.verification_status,
  lifecycleStatus: r.lifecycle_status, replacedById: r.replaced_by_id, lifecycleNote: r.lifecycle_note,
});

// Источник: этой же компании-арендатора и не в архиве.
export function checkSource(ctx, sourceId) {
  const s = rowOf(ctx, "ai_sources", sourceId, { what: "Источник" });
  if (s.status === "archived") throw badRequest("Источник в архиве: выберите действующий");
  return s;
}
export function checkPack(ctx, packId, competitorProductId) {
  if (!packId) return null;
  const k = rowOf(ctx, "ai_competitor_packs", packId, { what: "Фасовка" });
  if (k.competitor_product_id !== competitorProductId) throw badRequest("Фасовка относится к другому товару");
  return k;
}

export function createObservation(ctx, data) {
  requireWriter(ctx);
  const b = parse(input, data);
  if (!evidenceKeyMeta(b.specKey)) throw badRequest(`Неизвестная характеристика: ${b.specKey}`);
  assertNoPersonalData(b, ["label", "originalValue", "conditionText", "sourceReference", "evidenceNote"]);
  const p = rowOf(ctx, "ai_competitor_products", b.competitorProductId, { what: "Товар конкурента" });
  if (p.lifecycle_status !== "active") throw badRequest("Товар снят");
  checkPack(ctx, b.packId, b.competitorProductId);
  checkSource(ctx, b.sourceId);
  let cond;
  try { cond = canonicalConditions(b.conditions || {}); } catch (e) { throw badRequest(e.message); }
  // Условие без цитаты — предположение: не принимается (правило 2.2B).
  if (cond.key && !String(b.conditionText ?? "").trim()) throw badRequest("Условие принимается только с дословной цитатой из источника (conditionText)");
  const v = parseSpecValue(b.originalValue);
  const hash = hashOf(b, cond.key);
  if (get("SELECT id FROM ai_competitor_observations WHERE tenant_id=? AND content_hash=?", ctx.tenantId, hash)) throw conflict("Такое наблюдение из этого источника уже записано");
  const id = tx(() => {
    const oid = insert("ai_competitor_observations", {
      tenant_id: ctx.tenantId, competitor_product_id: b.competitorProductId, pack_id: b.packId ?? null, spec_key: b.specKey, label: b.label ?? null,
      conditions_json: JSON.stringify(cond.conditions), condition_key: cond.key, condition_text: b.conditionText ?? null, statement_type: b.statementType,
      original_value: b.originalValue, value_num: v.valueNum, value_min: v.valueMin, value_max: v.valueMax, value_bool: v.valueBool === null ? null : (v.valueBool ? 1 : 0),
      value_text: v.valueText, unit_raw: v.unitRaw, normalized_unit: v.normalizedUnit, comparator: v.comparator, parse_note: v.note,
      source_type: b.sourceType, source_id: b.sourceId, source_reference: b.sourceReference ?? null, provided_at: b.providedAt ?? null,
      access_level: b.accessLevel, evidence_note: b.evidenceNote ?? null, content_hash: hash, created_by: ctx.actorId ?? null,
    });
    audit(ctx, "ai.competitor.observation.create", "ai_competitor_observations", oid, {
      competitorProductId: b.competitorProductId, packId: b.packId ?? null, specKey: b.specKey, conditionKey: cond.key, value: b.originalValue,
      sourceType: b.sourceType, sourceId: b.sourceId, accessLevel: b.accessLevel,
    });
    return oid;
  });
  return getObservation(ctx, id);
}

// Замена: старое остаётся (superseded) со ссылкой на новое. Только для
// того же свойства (товар, фасовка, ключ, условие) и с обоснованием.
export function supersedeObservation(ctx, oldId, newId, note) {
  requireWriter(ctx);
  if (!String(note ?? "").trim()) throw badRequest("Укажите, на каком основании прежнее значение заменяется");
  const a = rowOf(ctx, "ai_competitor_observations", oldId, { what: "Наблюдение" });
  const b = rowOf(ctx, "ai_competitor_observations", newId, { what: "Наблюдение" });
  if (a.id === b.id) throw badRequest("Наблюдение не заменяет само себя");
  if ([a.competitor_product_id, a.pack_id, a.spec_key, a.condition_key].join("|") !== [b.competitor_product_id, b.pack_id, b.spec_key, b.condition_key].join("|")) {
    throw badRequest("Заменить можно только значение того же свойства (товар, фасовка, характеристика, условие)");
  }
  if (a.lifecycle_status !== "active" || b.lifecycle_status !== "active") throw badRequest("Заменять можно только действующие наблюдения");
  tx(() => {
    update("ai_competitor_observations", a.id, { lifecycle_status: "superseded", replaced_by_id: b.id, lifecycle_note: String(note).trim().slice(0, 500), updated_at: now() });
    audit(ctx, "ai.competitor.observation.supersede", "ai_competitor_observations", a.id, { replacedBy: b.id, note: String(note).trim().slice(0, 500) });
  });
  return getObservation(ctx, a.id);
}

export function withdrawObservation(ctx, id, reason) {
  requireWriter(ctx);
  if (!String(reason ?? "").trim()) throw badRequest("Укажите причину, по которой наблюдение снимается");
  const o = rowOf(ctx, "ai_competitor_observations", id, { what: "Наблюдение" });
  if (o.lifecycle_status === "withdrawn") return observationView(o);
  tx(() => {
    update("ai_competitor_observations", id, { lifecycle_status: "withdrawn", lifecycle_note: String(reason).trim().slice(0, 500), updated_at: now() });
    audit(ctx, "ai.competitor.observation.withdraw", "ai_competitor_observations", id, { reason: String(reason).trim().slice(0, 500) });
  });
  return getObservation(ctx, id);
}

export function getObservation(ctx, id) {
  const levels = requireReader(ctx);
  const o = rowOf(ctx, "ai_competitor_observations", id, { what: "Наблюдение", levels });
  visibleProduct(ctx, o.competitor_product_id, levels);
  return observationView(o);
}

// Все наблюдения товара, видимые роли (с историей), и свойства с итогом по
// правилам 2.2B. Скрытое: сколько конфиденциальных наблюдений есть у
// свойства — без значений.
export function productObservations(ctx, competitorProductId) {
  const levels = requireReader(ctx);
  visibleProduct(ctx, competitorProductId, levels);
  const rows = all("SELECT * FROM ai_competitor_observations WHERE tenant_id=? AND competitor_product_id=? ORDER BY spec_key, id", ctx.tenantId, competitorProductId);
  const visible = rows.filter((r) => levels.includes(r.access_level)).map(observationView);
  const hidden = rows.filter((r) => !levels.includes(r.access_level) && r.lifecycle_status === "active");
  const low = (x) => String(x ?? "").trim().toLowerCase();
  const properties = propertyGroups(visible, sourcePriorities(ctx.tenantId)).map((g) => {
    const mine = hidden.filter((h) => h.spec_key === g.specKey && (h.pack_id ?? null) === (g.packId ?? null) && h.condition_key === g.conditionKey);
    const shown = new Set(g.observations.filter((o) => o.lifecycleStatus === "active").map((o) => low(o.originalValue)));
    // Скрытое значение расходится с видимыми: роль узнаёт только сам факт.
    return { ...g, label: evidenceKeyMeta(g.specKey)?.label || g.specKey, hiddenCount: mine.length, hiddenDisagreement: mine.some((h) => !shown.has(low(h.original_value))) };
  });
  return { observations: visible, properties };
}

export const setObservationVerification = (ctx, id, status, note) => observationView(setVerification(ctx, { table: "ai_competitor_observations", what: "Наблюдение", action: "ai.competitor.observation", id, status, note }));
