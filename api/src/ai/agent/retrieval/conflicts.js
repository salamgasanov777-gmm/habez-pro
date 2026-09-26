// Habez AI Agent: слой споров. Раскладывает данные товара по свойствам
// «ключ × условие × фасовка» и говорит про каждое:
//   single     — одно значение;
//   agreed     — несколько согласных источников;
//   conflict   — значения расходятся (в т. ч. в разных единицах);
//   unresolved — по ключу открыт вопрос сверки (D1–D10 и др.).
// Разные условия и разные фасовки — разные свойства, не спор. Единицы не
// пересчитываются. Победитель не выбирается никогда.
import { keyForLabel } from "../../knowledge/spec-dictionary.js";
import { evidenceKeyMeta } from "../../knowledge/evidence-model.js";
import { parseSpecValue, UNIT_LABEL } from "../../knowledge/units.js";

const norm = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// Условие, записанное в самой подписи строки карточки: «…в возрасте 7 сут»,
// «при толщине слоя 1 мм», «на мешок». Это цитата, а не вывод.
function conditionFromLabel(label) {
  const l = norm(label);
  const age = l.match(/,?\s*(?:в возрасте|через)?\s*(\d+)\s*сут(?:ок|ки)?\.?/i);
  const layer = l.match(/при (?:толщине )?(?:слоя|слое)\s*(\d+(?:[.,]\d+)?)\s*мм/i);
  const per = l.match(/на (1 )?(кг|мешок|мешка|1 м²|м²)/i);
  const parts = [];
  if (age) parts.push(`age_days=${age[1]}`);
  if (layer) parts.push(`layer_mm=${layer[1].replace(",", ".")}`);
  if (per) parts.push(`per=${/меш/i.test(per[2]) ? "bag" : /кг/.test(per[2]) ? "kg" : "m2"}`);
  const stripped = age ? l.replace(age[0], "").replace(/\s+в возрасте\s*$/i, "").trim() : l;
  return { key: parts.sort().join(";"), text: parts.length ? l : null, stripped };
}

const meaningOf = (v) => (v.valueNum !== null || v.valueMin !== null || v.valueBool !== null
  ? JSON.stringify([v.valueNum, v.valueMin, v.valueMax, v.valueBool, v.normalizedUnit, v.comparator])
  : JSON.stringify(["t", norm(v.displayValue).toLowerCase()]));

// Ключ «то же число»: число, границы, единица и знак сравнения. Для «ДА» и
// текста — null: одинаковое «ДА» у разных свойств — не повтор.
// withBool — сравнивать и «ДА/НЕТ» («возможно» = «ДА»): только внутри одного
// свойства.
export const sameValueKey = (display, { withBool = false } = {}) => {
  const v = parseSpecValue(norm(display));
  return v.valueNum !== null || v.valueMin !== null || (withBool && v.valueBool !== null) ? meaningOf(v) : null;
};

const labelOfKey = (key) => evidenceKeyMeta(key)?.label || null;

// Витрина: строки карточки товара (ярлыки и таблицы) — то, что покупатель
// и так видит. Строки фасовки (упаковка, поддон, штрихкод) — отдельно, по
// подписи, без спора.
export function groupCardProperties(product, items, keyFilter = null) {
  const groups = new Map();
  for (const it of items) {
    const cond = conditionFromLabel(it.label);
    const key = it.skipped ? null : (it.key || keyForLabel(cond.stripped));
    if (keyFilter && !(key && keyFilter(key))) continue;
    const gkey = key ? `${key}|${cond.key}` : `label:${norm(it.label).toLowerCase()}`;
    if (!groups.has(gkey)) {
      groups.set(gkey, {
        key: key || null, label: key ? labelOfKey(key) || it.label : it.label, conditionKey: key ? cond.key : "",
        conditionText: key ? cond.text : null, variant: null, packaging: !!it.skipped, rows: [],
      });
    }
    groups.get(gkey).rows.push(it);
  }
  return [...groups.values()].map((g) => {
    const byMeaning = new Map();
    for (const it of g.rows) {
      const v = parseSpecValue(it.value);
      const m = meaningOf(v);
      if (!byMeaning.has(m)) byMeaning.set(m, { display: norm(it.value), unit: v.normalizedUnit, evidence: [] });
      byMeaning.get(m).evidence.push({
        kind: "catalog_card", product: product.slug, label: it.label, value: norm(it.value),
        where: it.from === "badge" ? "ярлык карточки" : `таблица «${it.ref}»`, unit: v.normalizedUnit,
      });
    }
    const values = [...byMeaning.values()].sort((a, b) => (a.display < b.display ? -1 : 1));
    const units = new Set(values.map((v) => v.unit).filter(Boolean));
    const status = values.length > 1 ? "conflict" : g.rows.length > 1 ? "agreed" : "single";
    return {
      key: g.key, label: g.label, conditionKey: g.conditionKey, conditionText: g.conditionText, variant: null, packaging: g.packaging,
      status, reason: status === "conflict" ? (units.size > 1 ? "different_units" : "values_differ") : null,
      values, items: [], hiddenConfidential: 0,
    };
  });
}

// Сотрудники: наблюдения слоя знаний с итогом resolveGroup и открытыми
// вопросами сверки.
export function groupObservationProperties(product, properties, openItems, keyFilter = null) {
  return properties.filter((g) => !keyFilter || keyFilter(g.specKey)).map((g) => {
    const obsById = new Map(g.observations.map((o) => [o.id, o]));
    const ev = (o) => ({
      kind: "observation", product: product.slug, observationId: o.id, label: o.label, value: o.originalValue,
      unit: o.normalizedUnit, condition: o.conditionText, variant: o.variant?.unit ?? null,
      sourceType: o.sourceType, sourceReference: o.sourceReference, upstream: o.upstream?.ref ?? null,
      capture: o.capture?.channel ?? null, statementType: o.statementType,
      verification: o.verificationStatus, access: o.accessLevel, lifecycle: o.lifecycleStatus,
    });
    const cur = g.resolution.current;
    let values = [];
    if (cur?.status === "agreed" || cur?.status === "resolved_by_policy") {
      values = [{ display: cur.value?.displays?.join(" = ") ?? "—", unit: cur.value?.unit ?? null, evidence: cur.supporting.map((id) => obsById.get(id)).filter(Boolean).map(ev) }];
    } else if (cur?.status === "pending_user_decision") {
      values = cur.candidates.map((c) => (c.hidden
        ? { display: null, hidden: true, unit: null, evidence: [] }
        : { display: c.displays.join(" = "), unit: c.unit, evidence: c.observationIds.map((id) => obsById.get(id)).filter(Boolean).map(ev) }));
    }
    for (const [cls, r] of [["замер", g.resolution.measured], ["норма", g.resolution.norm]]) {
      if (r?.value) values.push({ display: `${cls}: ${r.value.displays.join(" = ")}`, unit: r.value.unit, evidence: r.supporting.map((id) => obsById.get(id)).filter(Boolean).map(ev) });
    }
    const items = openItems.filter((i) => (i.specKey === g.specKey || i.relatedSpecKey === g.specKey) && (i.variantId ?? null) === null)
      .map((i) => ({ key: i.key, kind: i.kind, decision: i.decision, values: i.values }));
    const status = items.length ? "unresolved"
      : cur?.status === "pending_user_decision" ? "conflict"
        : values.length && values[0].evidence.length > 1 ? "agreed" : "single";
    const units = new Set(values.map((v) => v.unit).filter(Boolean));
    return {
      key: g.specKey, label: labelOfKey(g.specKey) || g.observations[0]?.label, conditionKey: g.conditionKey,
      conditionText: g.observations.find((o) => o.conditionText)?.conditionText ?? null,
      variant: g.variantId ? { id: g.variantId, unit: g.observations[0]?.variant?.unit ?? null } : null,
      packaging: false, status,
      reason: status === "conflict" ? (units.size > 1 ? "different_units" : cur?.reason ?? "values_differ") : status === "unresolved" ? "open_reconciliation_item" : null,
      values, items, hiddenConfidential: cur?.hiddenObservations ?? 0,
    };
  });
}

export const unitLabel = (u) => (u ? UNIT_LABEL[u] || u : null);
