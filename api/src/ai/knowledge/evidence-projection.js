// Habez AI, Phase 2.2D: проекции наблюдений.
//
// 1. Старая проекция «одно значение на ключ» для /api/ai/specs,
//    /intelligence и /compare в режиме AI_EVIDENCE_READ_MODE=evidence.
//    Считается при чтении, в базу не пишется: ai_product_specs остаётся
//    замороженным снимком для режима legacy и для отката.
// 2. Публичная проекция: что из наблюдений вообще может увидеть покупатель.
//    Витрина её пока не читает — правило закреплено тестами.
//
// Правила проекции (P1–P6, docs/HABEZ-AI-PHASE-2-2D-IMPLEMENTATION-PLAN.md):
//  P1. Значение есть, только если итог свойства agreed или resolved_by_policy
//      И по свойству нет открытого вопроса сверки.
//  P2. Спор → значения нет (числа null), статус conflict, в displayValue —
//      все варианты через « / ». Победитель не выбирается.
//  P3. Открытый вопрос сверки (D2, D3, D4, D6, D10 …) → статус unresolved,
//      значения нет, даже если внутри свойства источники согласны.
//  P4. Несколько согласных источников → одно значение и ВСЕ их номера.
//  P5. Происхождение — номера наблюдений (observationIds) и вопросов.
//  P6. Нет наблюдений → not_backfilled: старое значение отдаётся как есть,
//      с пометкой; режим evidence без переноса ничего не «улучшает».
import { all } from "../../db/index.js";
import { productEvidence, seesConfidential } from "./evidence.js";
import { publicationDecision, STATEMENT_CLASS } from "./evidence-model.js";
import { UNIT_LABEL } from "./units.js";

const EMPTY = { num: null, min: null, max: null, bool: null, text: null };

export function projectResolution(current, openItems = []) {
  if (openItems.length) {
    return {
      status: "unresolved", value: null,
      displayValue: [...new Set(openItems.flatMap((i) => i.values))].sort().join(" / ") || null,
      observationIds: current?.observationIds ?? [], openItems: openItems.map((i) => i.key),
    };
  }
  if (!current) return { status: "no_current", value: null, displayValue: null, observationIds: [] };
  if (current.status === "agreed" || current.status === "resolved_by_policy") {
    if (!current.value) return { status: "hidden", value: null, displayValue: null, observationIds: current.supporting };
    return {
      status: current.status, value: current.value, displayValue: current.value.displays[0],
      observationIds: current.supporting, verification: current.verification,
    };
  }
  return {
    status: "conflict", value: null, reason: current.reason,
    displayValue: (current.candidates || []).map((c) => (c.hidden ? "…" : c.displays.join(" = "))).join(" / "),
    observationIds: current.observationIds,
  };
}

// Открытые вопросы сверки по товару, со значениями видимых участников.
export function openItemsFor(tenantId, productId, role) {
  const levels = seesConfidential(role) ? ["public", "internal", "confidential"] : ["public", "internal"];
  const marks = levels.map(() => "?").join(",");
  return all(`SELECT i.id, i.item_key, i.kind, i.decision_ref, i.variant_id, i.spec_key, i.related_spec_key, i.condition_key,
      (SELECT json_group_array(o.original_value) FROM ai_reconciliation_members m
         JOIN ai_spec_observations o ON o.id = m.observation_id
        WHERE m.item_id = i.id AND o.access_level IN (${marks})) AS vals
     FROM ai_reconciliation_items i WHERE i.tenant_id=? AND i.product_id=? AND i.status='unresolved' ORDER BY i.item_key`,
  ...levels, tenantId, productId).map((i) => ({
    key: i.item_key, kind: i.kind, decision: i.decision_ref, variantId: i.variant_id,
    specKey: i.spec_key, relatedSpecKey: i.related_spec_key, conditionKey: i.condition_key, values: JSON.parse(i.vals || "[]"),
  }));
}

const touches = (item, specKey, variantId = null) =>
  (item.specKey === specKey || item.relatedSpecKey === specKey) && (item.variantId ?? null) === (variantId ?? null);

// Наложение на ответ старых маршрутов: те же поля того же типа плюс блок
// evidence. Режим legacy этой функцией не пользуется вовсе.
export function makeEvidenceOverlay(tenantId, role) {
  const cache = new Map();
  const forProduct = (productId) => {
    if (!cache.has(productId)) {
      const ev = productEvidence(tenantId, productId, role);
      const groups = new Map(ev.properties.filter((g) => g.variantId === null && g.conditionKey === "").map((g) => [g.specKey, g]));
      cache.set(productId, { groups, open: openItemsFor(tenantId, productId, role) });
    }
    return cache.get(productId);
  };
  return (spec) => {
    const { groups, open } = forProduct(spec.productId);
    const items = open.filter((i) => touches(i, spec.specKey, spec.variantId));
    const g = groups.get(spec.specKey);
    if (!g) return { ...spec, evidence: { mode: "evidence", status: "not_backfilled", openItems: items.map((i) => i.key) } };
    const p = projectResolution(g.resolution.current, items);
    if (p.status === "agreed" || p.status === "resolved_by_policy") {
      const v = p.value;
      return {
        ...spec,
        displayValue: v.displays.includes(spec.displayValue) ? spec.displayValue : v.displays[0],
        value: { num: v.num, min: v.min, max: v.max, bool: v.bool, text: v.text },
        normalizedUnit: v.unit, unitLabel: UNIT_LABEL[v.unit] || null, comparator: v.comparator,
        normalized: v.num !== null || v.min !== null || v.bool !== null,
        verificationStatus: p.verification === "all" ? "verified" : "unverified",
        evidence: { mode: "evidence", status: p.status, observationIds: p.observationIds, openItems: [] },
      };
    }
    return {
      ...spec,
      displayValue: p.displayValue || "—",
      value: { ...EMPTY }, normalizedUnit: null, unitLabel: null, comparator: null, normalized: false,
      verificationStatus: "disputed",
      evidence: { mode: "evidence", status: p.status, reason: p.reason ?? null, observationIds: p.observationIds, openItems: p.openItems ?? [] },
    };
  };
}

// Публичная проекция: для каждого свойства — можно ли показать покупателю и
// почему нет. Публикуется значение, только если: итог agreed/resolved,
// нет открытого вопроса, и хотя бы одно подтверждающее наблюдение проходит
// publicationDecision (public, проверено, не догадка, действует).
export function publicProjection(tenantId, productId) {
  const ev = productEvidence(tenantId, productId, "owner");
  const open = openItemsFor(tenantId, productId, "owner");
  return ev.properties.map((g) => {
    // Вопрос по ключу блокирует все его условия: D4 касается и «без
    // возраста», и «7 сут».
    const items = open.filter((i) => touches(i, g.specKey, g.variantId));
    const out = { specKey: g.specKey, variantId: g.variantId, conditionKey: g.conditionKey };
    const classes = [["current", g.resolution.current], ["measured", g.resolution.measured], ["norm", g.resolution.norm]].filter(([, r]) => r);
    out.classes = classes.map(([name, r]) => {
      if (items.length) return { class: name, publishable: false, reason: "open_reconciliation_item", items: items.map((i) => i.key) };
      if (!["agreed", "resolved_by_policy"].includes(r.status)) return { class: name, publishable: false, reason: "unresolved" };
      const decisions = r.supporting.map((id) => {
        const o = g.observations.find((x) => x.id === id);
        const cls = STATEMENT_CLASS[o.statementType] === "claimed" ? "current" : STATEMENT_CLASS[o.statementType];
        return cls === name ? publicationDecision(o, r) : { publishable: false, reason: "other_class" };
      });
      const ok = decisions.some((d) => d.publishable);
      return ok
        ? { class: name, publishable: true, value: r.value, observationIds: r.supporting }
        : { class: name, publishable: false, reason: decisions[0]?.reason ?? "no_evidence" };
    });
    out.publishable = out.classes.some((c) => c.publishable);
    return out;
  });
}
