// Habez AI, Phase 2.2B: наблюдения — несколько значений одного свойства из
// разных источников, с условием, фасовкой и происхождением. Ни одна функция
// здесь не удаляет наблюдение и не меняет ai_product_specs.
//
// Формальные правила выбора значения — в resolveGroup() и в
// docs/HABEZ-AI-EVIDENCE-MODEL.md, раздел «Правила действующего значения».
import { all, get, insert, update, tx } from "../../db/index.js";
import { badRequest, notFound, conflict } from "../../lib/errors.js";
import { VERIFICATION_STATUSES, canTransition } from "./model.js";
import { roleRank } from "../../plugins/auth.js";
import { parseSpecValue, UNIT_LABEL } from "./units.js";
import { resolveGroup } from "./evidence-resolve.js";
import { legacyProvenance } from "./legacy-provenance.js";
import {
  EVIDENCE_SOURCE_TYPES, NEVER_VERIFIED_SOURCE_TYPES, STATEMENT_TYPES, STATEMENT_CLASS,
  ACCESS_LEVELS, PROVIDED_BY_ROLES, RELATION_TYPES, RELATION_BASES, VARIANT_KEYS,
  evidenceKeyMeta, canonicalConditions, personalDataIn, PRIVACY_CHECKED_FIELDS, observationHash,
  publicationDecision, upstreamSourceType,
} from "./evidence-model.js";

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Конфиденциальное видит только администратор и владелец.
export const seesConfidential = (role) => (roleRank[role] ?? 0) >= roleRank.admin;
const visibleLevels = (role) =>
  seesConfidential(role) ? ACCESS_LEVELS : ACCESS_LEVELS.filter((l) => l !== "confidential");

function assertNoPersonalData(input) {
  for (const field of PRIVACY_CHECKED_FIELDS) {
    const found = personalDataIn(input[field]);
    if (found) throw badRequest(`В поле ${field} найден ${found}. Личные контакты в происхождении не храним — укажите роль (providedBy) и безопасную ссылку на документ`);
  }
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s);

// internal — служебные поля переноса (канал захвата, первоисточник, ключ
// идемпотентности, прогон). Через API их передать нельзя: схема маршрута
// строгая.
export function createObservation(tenantId, input, actorId, { legacySpec = null, internal = {} } = {}) {
  const product = get("SELECT id, name FROM products WHERE id=? AND tenant_id=?", input.productId, tenantId);
  if (!product) throw notFound("Товар не найден");
  const meta = evidenceKeyMeta(input.specKey);
  if (!meta) throw badRequest(`Неизвестная характеристика: ${input.specKey}`);
  if (VARIANT_KEYS[input.specKey] && !input.variantId) throw badRequest(`«${meta.label}» относится к фасовке — укажите variantId`);
  if (input.variantId) {
    const v = get("SELECT id FROM variants WHERE id=? AND tenant_id=? AND product_id=?", input.variantId, tenantId, product.id);
    if (!v) throw notFound("Фасовка не найдена у этого товара");
  }
  const sourceType = input.sourceType;
  if (!EVIDENCE_SOURCE_TYPES.includes(sourceType)) throw badRequest(`Неизвестный вид источника: ${sourceType}`);
  const statementType = input.statementType || "unknown";
  if (!STATEMENT_TYPES.includes(statementType)) throw badRequest(`Неизвестный тип утверждения: ${statementType}`);
  const accessLevel = input.accessLevel || "internal";
  if (!ACCESS_LEVELS.includes(accessLevel)) throw badRequest(`Неизвестный уровень доступа: ${accessLevel}`);
  if (input.providedBy && !PROVIDED_BY_ROLES.includes(input.providedBy)) {
    throw badRequest(`providedBy — только роль из списка: ${PROVIDED_BY_ROLES.join(", ")}`);
  }
  if (input.providedAt && !isDate(input.providedAt)) throw badRequest("providedAt — дата вида 2026-09-05");
  assertNoPersonalData(input);
  if (input.originalValue === undefined || String(input.originalValue).trim() === "") {
    throw badRequest("Пустое значение: наблюдения без значения не существует");
  }
  if (input.sourceId && !get("SELECT id FROM ai_sources WHERE id=? AND tenant_id=?", input.sourceId, tenantId)) {
    throw notFound("Источник не найден");
  }
  // Происхождение обязательно — кроме догадок программы и модели, у
  // которых источника нет по определению.
  if (!NEVER_VERIFIED_SOURCE_TYPES.includes(sourceType) && !input.sourceId && !input.sourceReference) {
    throw badRequest("Укажите источник: sourceId или sourceReference (например technologist-note-2026-09-05)");
  }

  let cond;
  try { cond = canonicalConditions(input.conditions || {}); } catch (e) { throw badRequest(e.message); }
  // Условие без дословной цитаты — предположение. Его не принимаем.
  if (cond.key && !String(input.conditionText ?? "").trim()) {
    throw badRequest("Условие принимается только с дословной цитатой из источника (conditionText)");
  }

  const hash = observationHash({ ...input, statementType, conditionKey: cond.key });
  const twin = get("SELECT id FROM ai_spec_observations WHERE tenant_id=? AND content_hash=?", tenantId, hash);
  if (twin) throw conflict(`Такое наблюдение из этого источника уже записано (№${twin.id})`);

  // Значение: у переносимой записи берём уже разобранное как есть — старое
  // число не должно измениться из-за переноса. Новое разбираем.
  let v;
  if (legacySpec) {
    v = {
      displayValue: legacySpec.display_value, valueNum: legacySpec.value_num, valueMin: legacySpec.value_min,
      valueMax: legacySpec.value_max, valueBool: legacySpec.value_bool === null ? null : !!legacySpec.value_bool,
      valueText: legacySpec.value_text, unitRaw: legacySpec.unit_raw, normalizedUnit: legacySpec.normalized_unit,
      comparator: legacySpec.comparator, note: legacySpec.parse_note,
    };
  } else if (meta.unit === "pcs" && VARIANT_KEYS[input.specKey] && /^\d+$/.test(String(input.originalValue).trim())) {
    // variants.per_pallet — целое без единицы: «штук на поддоне» по смыслу поля.
    const n = Number(String(input.originalValue).trim());
    v = { displayValue: String(n), valueNum: n, valueMin: null, valueMax: null, valueBool: null, valueText: null, unitRaw: null, normalizedUnit: "pcs", comparator: "exact", note: null };
  } else if (VARIANT_KEYS[input.specKey] && meta.unit === null) {
    // Штрихкод — строка цифр, а не величина.
    const s = String(input.originalValue).trim();
    v = { displayValue: s, valueNum: null, valueMin: null, valueMax: null, valueBool: null, valueText: s, unitRaw: null, normalizedUnit: null, comparator: null, note: null };
  } else {
    v = parseSpecValue(input.originalValue);
  }

  const id = insert("ai_spec_observations", {
    tenant_id: tenantId, product_id: product.id, variant_id: input.variantId ?? null,
    spec_key: input.specKey, label: input.label ?? meta.label,
    conditions_json: JSON.stringify(cond.conditions), condition_key: cond.key,
    condition_text: input.conditionText ?? null,
    statement_type: statementType,
    original_value: String(input.originalValue).trim(),
    value_num: v.valueNum, value_min: v.valueMin, value_max: v.valueMax,
    value_bool: v.valueBool === null ? null : (v.valueBool ? 1 : 0),
    value_text: v.valueText, unit_raw: v.unitRaw, normalized_unit: v.normalizedUnit,
    comparator: v.comparator, parse_note: v.note,
    source_type: sourceType, source_id: input.sourceId ?? null,
    source_name: input.sourceName ?? null, source_reference: input.sourceReference ?? null,
    provided_by: input.providedBy ?? null, provided_at: input.providedAt ?? null,
    captured_at: legacySpec?.observed_at ?? now(),
    access_level: accessLevel,
    evidence_note: input.evidenceNote ?? null, evidence_ref: input.evidenceRef ?? null,
    // Новое наблюдение всегда непроверенное — перенесённое тоже (решение
    // D9): проверка старой строки относилась к ней, а не к доказательству.
    // Прежний статус остаётся в самой строке ai_product_specs (legacy_spec_id).
    verification_status: "unverified", verified_by: null, verified_at: null,
    checked_at: null,
    extraction_confidence: input.extractionConfidence ?? null,
    lifecycle_status: "active",
    legacy_spec_id: legacySpec?.id ?? null,
    legacy_origin: legacySpec?.origin ?? null,
    capture_channel: internal.captureChannel ?? (legacySpec ? "habez_pro_product_card" : "api"),
    capture_ref: internal.captureRef ?? null,
    upstream_ref: internal.upstreamRef ?? null,
    upstream_recorded_at: internal.upstreamRecordedAt ?? null,
    backfill_key: internal.backfillKey ?? null,
    backfill_fingerprint: internal.backfillFingerprint ?? null,
    created_by_run: internal.runId ?? null,
    content_hash: hash,
    created_by: legacySpec ? (legacySpec.created_by ?? null) : (actorId ?? null),
  });
  return observationById(tenantId, id);
}

export function setObservationVerification(tenantId, id, status, actorId, note) {
  if (!VERIFICATION_STATUSES.includes(status)) throw badRequest(`Неизвестный статус: ${status}`);
  const row = get("SELECT * FROM ai_spec_observations WHERE id=? AND tenant_id=?", id, tenantId);
  if (!row) throw notFound("Наблюдение не найдено");
  const privacy = personalDataIn(note);
  if (privacy) throw badRequest(`В примечании найден ${privacy} — личные контакты не храним`);
  if (row.verification_status === status) return { observation: observationById(tenantId, id), before: row };
  if (status === "verified" && NEVER_VERIFIED_SOURCE_TYPES.includes(row.source_type)) {
    throw badRequest("Значение, подставленное программой или моделью, нельзя подтвердить: заведите наблюдение с настоящим источником");
  }
  if (!canTransition(row.verification_status, status)) {
    throw badRequest(`Нельзя перейти из «${row.verification_status}» в «${status}»`);
  }
  if (status === "verified" && !row.source_id && !row.source_reference) {
    throw badRequest("Подтвердить можно только наблюдение с источником");
  }
  const next = { verification_status: status, verify_note: note ?? null, checked_at: now(), updated_at: now() };
  if (status === "verified") { next.verified_by = actorId ?? null; next.verified_at = now(); }
  else { next.verified_by = null; next.verified_at = null; }
  update("ai_spec_observations", id, next);
  return { observation: observationById(tenantId, id), before: row };
}

// Связь между наблюдениями. «replaces» переводит заменённое в superseded —
// строка остаётся, её видно в истории свойства.
export function addRelation(tenantId, fromId, input, actorId) {
  const { toObservationId: toId, relationType, basis } = input;
  if (!RELATION_TYPES.includes(relationType)) throw badRequest(`Неизвестная связь: ${relationType}`);
  if (!RELATION_BASES.includes(basis)) throw badRequest(`Неизвестное основание: ${basis}`);
  if (fromId === toId) throw badRequest("Наблюдение не может ссылаться само на себя");
  assertNoPersonalData(input);
  const from = get("SELECT * FROM ai_spec_observations WHERE id=? AND tenant_id=?", fromId, tenantId);
  const to = get("SELECT * FROM ai_spec_observations WHERE id=? AND tenant_id=?", toId, tenantId);
  if (!from || !to) throw notFound("Наблюдение не найдено");
  if (from.product_id !== to.product_id) throw badRequest("Связывать можно только наблюдения одного товара");
  if (basis === "explicit_source_statement" && !input.basisNote && !input.sourceReference) {
    throw badRequest("Для связи «по словам источника» нужна цитата (basisNote) или ссылка на документ");
  }
  if (relationType === "replaces") {
    if (from.lifecycle_status === "superseded") throw badRequest("Заменённое наблюдение не может заменять другое");
    // «По словам источника» замена допустима, только если меняется одно
    // лишь значение: та же характеристика, та же фасовка, то же условие,
    // сопоставимая единица. Всё остальное — утверждение «это одно и то же
    // свойство», которого источник не делает: решает человек (R8).
    if (basis !== "user_decision") {
      if (from.spec_key !== to.spec_key) throw badRequest("Замена между разными характеристиками возможна только решением владельца (basis = user_decision)");
      if ((from.variant_id ?? null) !== (to.variant_id ?? null)) throw badRequest("Замена между разными фасовками возможна только решением владельца");
      if (from.condition_key !== to.condition_key) throw badRequest("Замена при другом условии (возраст, слой, «на мешок») возможна только решением владельца");
      if (from.normalized_unit && to.normalized_unit && from.normalized_unit !== to.normalized_unit) {
        throw badRequest("Замена с другой единицей (например мл/м² и г/м²) возможна только решением владельца");
      }
    }
    // Круг «A заменяет B, B заменяет A» сделал бы оба значения устаревшими.
    if (replacesTransitively(tenantId, toId, fromId)) throw badRequest("Такая замена образует круг");
  }
  if (get(`SELECT id FROM ai_observation_relations WHERE tenant_id=? AND from_observation_id=? AND to_observation_id=? AND relation_type=?`,
    tenantId, fromId, toId, relationType)) throw conflict("Такая связь уже записана");

  return tx(() => {
    const id = insert("ai_observation_relations", {
      tenant_id: tenantId, from_observation_id: fromId, to_observation_id: toId,
      relation_type: relationType, basis, basis_note: input.basisNote ?? null,
      source_reference: input.sourceReference ?? null, created_by: actorId ?? null,
    });
    if (relationType === "replaces" && to.lifecycle_status === "active") {
      update("ai_spec_observations", toId, { lifecycle_status: "superseded", updated_at: now() });
    }
    return { relationId: id, from: observationById(tenantId, fromId), to: observationById(tenantId, toId), before: to };
  });
}

function replacesTransitively(tenantId, startId, targetId) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of all(`SELECT to_observation_id AS t FROM ai_observation_relations
       WHERE tenant_id=? AND from_observation_id=? AND relation_type='replaces'`, tenantId, cur)) stack.push(r.t);
  }
  return false;
}

const JOINS = `FROM ai_spec_observations o
  JOIN products p ON p.id = o.product_id
  LEFT JOIN variants v ON v.id = o.variant_id
  LEFT JOIN ai_sources src ON src.id = o.source_id
  LEFT JOIN users u ON u.id = o.verified_by`;
const FIELDS = `o.*, p.name AS product_name, p.slug AS product_slug, v.unit AS variant_unit, v.sku AS variant_sku,
  src.name AS linked_source_name, u.name AS verified_by_name`;

// Связи показываются, только если оба конца видны этой роли: иначе номер
// конфиденциального наблюдения выдал бы сам факт его существования.
function visibleRelations(tenantId, where, params, role) {
  const levels = visibleLevels(role);
  const marks = levels.map(() => "?").join(",");
  return all(`SELECT r.* FROM ai_observation_relations r
      JOIN ai_spec_observations a ON a.id = r.from_observation_id
      JOIN ai_spec_observations b ON b.id = r.to_observation_id
     WHERE r.tenant_id=? AND (${where}) AND a.access_level IN (${marks}) AND b.access_level IN (${marks})
     ORDER BY r.id`, tenantId, ...params, ...levels, ...levels).map(relationView);
}

export function observationById(tenantId, id, role = "owner") {
  const row = get(`SELECT ${FIELDS} ${JOINS} WHERE o.id=? AND o.tenant_id=?`, id, tenantId);
  if (!row || !visibleLevels(role).includes(row.access_level)) throw notFound("Наблюдение не найдено");
  return { ...view(row), relations: visibleRelations(tenantId, "r.from_observation_id=? OR r.to_observation_id=?", [id, id], role) };
}

export function listObservations(tenantId, q = {}, role = "manager") {
  const levels = visibleLevels(role);
  const where = ["o.tenant_id=?", `o.access_level IN (${levels.map(() => "?").join(",")})`];
  const params = [tenantId, ...levels];
  const eq = (sql, v) => { if (v !== undefined && v !== null && v !== "") { where.push(sql); params.push(v); } };
  eq("o.product_id=?", q.productId);
  eq("o.variant_id=?", q.variantId);
  eq("o.spec_key=?", q.specKey);
  eq("o.source_type=?", q.sourceType);
  eq("o.statement_type=?", q.statementType);
  eq("o.verification_status=?", q.status);
  eq("o.lifecycle_status=?", q.lifecycle);
  const clause = where.join(" AND ");
  const total = get(`SELECT COUNT(*) AS n ${JOINS} WHERE ${clause}`, ...params).n;
  const limit = q.limit ?? 100;
  const page = q.page ?? 1;
  const items = all(`SELECT ${FIELDS} ${JOINS} WHERE ${clause} ORDER BY p.position, p.id, o.spec_key, o.id LIMIT ? OFFSET ?`,
    ...params, limit, (page - 1) * limit).map(view);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}

// Выбор действующего значения — чистые функции в evidence-resolve.js.
export { resolveGroup } from "./evidence-resolve.js";

export function sourcePriorities(tenantId) {
  return new Map(all("SELECT source_type, priority FROM ai_source_type_priorities WHERE tenant_id=?", tenantId)
    .map((r) => [r.source_type, r.priority]));
}

// Скрытие конфиденциального для роли без доступа. Итог считается по ВСЕМ
// наблюдениям (иначе менеджер видел бы «согласно», когда конфиденциальный
// замер спорит), а наружу не выходят их значения и номера.
function redactClass(r, hidden) {
  if (!r || !hidden.size) return r;
  const vis = (list) => list.filter((id) => !hidden.has(id));
  const hiddenCount = r.observationIds.filter((id) => hidden.has(id)).length;
  const out = { ...r, observationIds: vis(r.observationIds), supporting: vis(r.supporting || []), hiddenObservations: hiddenCount };
  if (r.value && !out.supporting.length) { out.value = null; out.valueHidden = true; }
  if (r.candidates) {
    out.candidates = r.candidates.map((c) => {
      const v = vis(c.observationIds);
      return v.length ? { ...c, observationIds: v } : { hidden: true, observationIds: [] };
    });
  }
  if (r.overruled) out.overruled = r.overruled.map((c) => (vis(c.observationIds).length ? { ...c, observationIds: vis(c.observationIds) } : { hidden: true, observationIds: [] }));
  return out;
}

// Всё, что известно о свойствах товара: группы «фасовка × ключ × условие»,
// в каждой — наблюдения, итог, история и решение о публикации.
export function productEvidence(tenantId, productId, role = "manager") {
  const p = get("SELECT id, slug, name FROM products WHERE id=? AND tenant_id=?", productId, tenantId);
  if (!p) throw notFound("Товар не найден");
  const everything = all(`SELECT ${FIELDS} ${JOINS} WHERE o.tenant_id=? AND o.product_id=? ORDER BY o.spec_key, o.id`, tenantId, productId).map(view);
  const allowed = new Set(visibleLevels(role));
  const hidden = new Set(everything.filter((o) => !allowed.has(o.accessLevel)).map((o) => o.id));
  const priorities = sourcePriorities(tenantId);
  const replacesOut = new Set(all(`SELECT from_observation_id AS id FROM ai_observation_relations r
      JOIN ai_spec_observations o ON o.id = r.from_observation_id
     WHERE r.tenant_id=? AND o.product_id=? AND r.relation_type='replaces'`, tenantId, productId).map((r) => r.id));

  const groups = new Map();
  for (const o of everything) {
    const k = `${o.variantId ?? ""}|${o.specKey}|${o.conditionKey}`;
    if (!groups.has(k)) groups.set(k, { variantId: o.variantId, specKey: o.specKey, conditionKey: o.conditionKey, conditions: o.conditions, observations: [] });
    groups.get(k).observations.push(o);
  }
  const properties = [];
  for (const g of groups.values()) {
    const visible = g.observations.filter((o) => !hidden.has(o.id));
    if (!visible.length) continue; // свойство целиком конфиденциальное — роль о нём не узнаёт
    const res = resolveGroup(g.observations, priorities, replacesOut);
    const resolution = {
      current: redactClass(res.current, hidden), measured: redactClass(res.measured, hidden), norm: redactClass(res.norm, hidden),
      unlinkedReplacementClaims: res.unlinkedReplacementClaims.filter((id) => !hidden.has(id)),
      history: res.history.filter((h) => !hidden.has(h.id)),
    };
    const publication = Object.fromEntries(visible.map((o) => {
      const cls = STATEMENT_CLASS[o.statementType] === "claimed" ? res.current : res[STATEMENT_CLASS[o.statementType]];
      return [o.id, publicationDecision(o, cls)];
    }));
    properties.push({ ...g, observations: visible, label: evidenceKeyMeta(g.specKey)?.label || g.specKey, resolution, publication });
  }
  return {
    product: p,
    properties,
    relations: visibleRelations(tenantId, "a.product_id=?", [productId], role),
    priorities: Object.fromEntries(priorities),
  };
}

// ── Перенос существующих характеристик в наблюдения ────────────────────────
// Правила D8, D9: каждая строка ai_product_specs → одно наблюдение с теми
// же числами и датой внесения, всегда internal и непроверенное.
//   source_type — ПЕРВОИСТОЧНИК: из манифеста сверки (коммит №1 → вид
//     документа); не доказан → unknown_legacy_origin;
//   capture_* — КАНАЛ: «строка карточки Habez Pro», если она найдена;
//   source_id старой строки («Карточки товаров Habez Pro») — это канал, а
//     не первоисточник, поэтому он уходит в capture_ref, а не в source_id.
// Идемпотентность: backfill_key = «legacy-spec:<id строки>», отпечаток —
// содержание (repair-plan.js). Код переноса целиком — в reconciliation.js.
export function legacySourceType(spec, product = null, upstream = null) {
  const prov = legacyProvenance(spec, product);
  if (prov.sourceType === "ai_inference" || prov.sourceType === "manual_entry") return prov.sourceType;
  if (prov.sourceType !== "product_card") return "unknown_legacy_origin";
  return upstreamSourceType(upstream);
}

export function legacyObservationInput(spec, product = null, manifestEntry = null) {
  const prov = legacyProvenance(spec, product);
  const upstream = manifestEntry?.upstream ?? null;
  const sourceType = legacySourceType(spec, product, upstream);
  const known = sourceType !== "unknown_legacy_origin" && prov.sourceType === "product_card";
  return {
    input: {
      productId: spec.product_id, variantId: spec.variant_id ?? undefined, specKey: spec.spec_key,
      // Подпись — как в карточке, если строка найдена; словарная — иначе.
      label: prov.row?.label ?? spec.label, conditions: {}, statementType: "unknown", originalValue: spec.display_value,
      sourceType,
      sourceReference: known && manifestEntry?.app1_commit ? `app1-commit-${manifestEntry.app1_commit}` : `habez-pro-spec#${spec.id}`,
      // Дата документа неизвестна: дата записи в №1 — upstream_recorded_at,
      // дата переноса — captured_at.
      providedAt: undefined,
      accessLevel: "internal",
      evidenceNote: `перенесено из ai_product_specs#${spec.id} без изменения значения; канал: ${prov.reason}; первоисточник: ${upstream ?? "не установлен"}`,
    },
    internal: {
      captureChannel: prov.row ? "habez_pro_product_card" : (spec.imported_from === "manual" ? "api" : "unknown"),
      captureRef: prov.row ? `ai_sources#${spec.source_id ?? "—"} / ${prov.row.from} / ${prov.row.ref} / ${prov.row.label}` : null,
      upstreamRef: manifestEntry?.app1_commit ? `app1-commit-${manifestEntry.app1_commit}` : null,
      upstreamRecordedAt: manifestEntry?.app1_date ?? null,
      backfillKey: `legacy-spec:${spec.id}`,
    },
  };
}

// Простой перенос без манифеста (все первоисточники — unknown). Полный
// перенос с планом, журналом и откатом — reconciliation.js.
export function backfillFromSpecs(tenantId, actorId = null, manifest = null) {
  const specs = all(`SELECT s.*, src.name AS source_name FROM ai_product_specs s
      LEFT JOIN ai_sources src ON src.id = s.source_id
     WHERE s.tenant_id=? ORDER BY s.id`, tenantId);
  const products = new Map(all("SELECT id, badges, spec_tables FROM products WHERE tenant_id=?", tenantId).map((p) => [p.id, p]));
  let created = 0; let existing = 0;
  const bySource = {};
  for (const s of specs) {
    if (get("SELECT id FROM ai_spec_observations WHERE tenant_id=? AND legacy_spec_id=?", tenantId, s.id)) { existing++; continue; }
    const { input, internal } = legacyObservationInput(s, products.get(s.product_id), manifest?.get(s.id) ?? null);
    createObservation(tenantId, input, actorId, { legacySpec: s, internal });
    bySource[input.sourceType] = (bySource[input.sourceType] || 0) + 1;
    created++;
  }
  return { specs: specs.length, created, existing, bySource };
}

export const observationByLegacySpec = (tenantId, specId) =>
  get("SELECT id FROM ai_spec_observations WHERE tenant_id=? AND legacy_spec_id=?", tenantId, specId)?.id ?? null;

// Расхождение двух хранилищ на переходный период: строка ai_product_specs
// изменилась (повторный ai:import-specs, правка в панели), а наблюдение,
// перенесённое из неё, — нет. Или строки нет в наблюдениях вовсе.
export function legacyDrift(tenantId) {
  const changed = all(`SELECT s.id AS spec_id, o.id AS observation_id, s.display_value AS spec_value, o.original_value AS observation_value
      FROM ai_product_specs s JOIN ai_spec_observations o ON o.legacy_spec_id = s.id
     WHERE s.tenant_id=? AND (s.display_value IS NOT o.original_value OR s.value_num IS NOT o.value_num
        OR s.value_min IS NOT o.value_min OR s.value_max IS NOT o.value_max OR s.value_bool IS NOT o.value_bool
        OR s.normalized_unit IS NOT o.normalized_unit OR s.comparator IS NOT o.comparator
        OR s.product_id IS NOT o.product_id OR s.spec_key IS NOT o.spec_key OR s.variant_id IS NOT o.variant_id)`, tenantId);
  const missing = all(`SELECT s.id AS spec_id FROM ai_product_specs s
     WHERE s.tenant_id=? AND NOT EXISTS (SELECT 1 FROM ai_spec_observations o WHERE o.legacy_spec_id = s.id)`, tenantId).map((r) => r.spec_id);
  return { changed, missing };
}

function relationView(r) {
  return {
    id: r.id, from: r.from_observation_id, to: r.to_observation_id, relationType: r.relation_type,
    basis: r.basis, basisNote: r.basis_note, sourceReference: r.source_reference, createdAt: r.created_at,
  };
}

function view(row) {
  return {
    id: row.id,
    productId: row.product_id,
    product: { id: row.product_id, name: row.product_name, slug: row.product_slug },
    variantId: row.variant_id,
    variant: row.variant_id ? { id: row.variant_id, unit: row.variant_unit, sku: row.variant_sku } : null,
    specKey: row.spec_key,
    label: row.label,
    conditions: JSON.parse(row.conditions_json || "{}"),
    conditionKey: row.condition_key,
    conditionText: row.condition_text,
    statementType: row.statement_type,
    originalValue: row.original_value,
    value: {
      num: row.value_num, min: row.value_min, max: row.value_max,
      bool: row.value_bool === null ? null : !!row.value_bool, text: row.value_text,
    },
    unitRaw: row.unit_raw,
    normalizedUnit: row.normalized_unit,
    unitLabel: UNIT_LABEL[row.normalized_unit] || row.unit_raw || null,
    comparator: row.comparator,
    parseNote: row.parse_note,
    sourceType: row.source_type,
    source: row.source_id ? { id: row.source_id, name: row.linked_source_name } : null,
    sourceName: row.source_name,
    sourceReference: row.source_reference,
    providedBy: row.provided_by,
    providedAt: row.provided_at,
    capturedAt: row.captured_at,
    accessLevel: row.access_level,
    evidenceNote: row.evidence_note,
    evidenceRef: row.evidence_ref,
    verificationStatus: row.verification_status,
    extractionConfidence: row.extraction_confidence,
    verifiedBy: row.verified_by ? { id: row.verified_by, name: row.verified_by_name } : null,
    verifiedAt: row.verified_at,
    checkedAt: row.checked_at,
    verifyNote: row.verify_note,
    lifecycleStatus: row.lifecycle_status,
    legacySpecId: row.legacy_spec_id,
    legacyOrigin: row.legacy_origin,
    capture: { channel: row.capture_channel, ref: row.capture_ref },
    upstream: row.upstream_ref ? { ref: row.upstream_ref, recordedAt: row.upstream_recorded_at } : null,
    backfillKey: row.backfill_key,
    createdByRun: row.created_by_run,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
