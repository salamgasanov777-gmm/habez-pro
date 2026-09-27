// Habez AI: выбор действующего значения свойства. Чистые функции без базы —
// их используют API (evidence.js) и сверка только на чтение
// (reconcile-dry-run.js). Правила R1–R8 — docs/HABEZ-AI-EVIDENCE-MODEL.md.
import { STATEMENT_CLASS } from "./evidence-model.js";

// ── Действующее значение ──────────────────────────────────────────────────
// Формальные правила (docs/HABEZ-AI-EVIDENCE-MODEL.md, §2.9):
//  R1. Свойство = товар × фасовка × ключ × условие; внутри — класс
//      утверждения (claimed / measured / norm). Разные свойства и классы
//      между собой не спорят.
//  R2. Кандидат = наблюдение active и не rejected. superseded и withdrawn
//      в выборе не участвуют, но остаются в history.
//  R3. Значения равны, если совпадают число/границы/логическое, единица и
//      признак границы (comparator); для текста — строка без учёта регистра.
//  R4. Все кандидаты равны → agreed. Итог — само значение и список ВСЕХ
//      подтверждающих наблюдений; «представитель» не выбирается.
//  R5. Кандидаты расходятся → resolved_by_policy только если владелец задал
//      приоритет для КАЖДОГО участвующего вида источника и все наблюдения
//      лучшего вида согласны; иначе pending_user_decision, value = null.
//  R6. Дата, номер записи, порядок вставки, вид источника без утверждённого
//      приоритета, extraction_confidence и статус проверки победителя
//      НЕ определяют. statement_type = replacement сам ничего не заменяет:
//      заменяет только связь replaces.

const valueKey = (o) => {
  const numeric = o.value.num !== null || o.value.min !== null || o.value.bool !== null;
  return numeric
    ? JSON.stringify(["n", o.value.num, o.value.min, o.value.max, o.value.bool, o.normalizedUnit, o.comparator])
    : JSON.stringify(["t", o.originalValue.trim().toLowerCase()]);
};

function distinctValues(list) {
  const groups = new Map();
  for (const o of list) {
    const k = valueKey(o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  // Порядок вариантов — по значению, а не по номеру или дате записи.
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}

const valueOf = (g) => {
  const o = g[0]; // все в группе равны по R3 — берём сами числа, не наблюдение
  return {
    num: o.value.num, min: o.value.min, max: o.value.max, bool: o.value.bool, text: o.value.text,
    unit: o.normalizedUnit, unitLabel: o.unitLabel, comparator: o.comparator,
    displays: [...new Set(g.map((x) => x.originalValue))].sort(),
  };
};
const verificationOf = (g) => {
  const n = g.filter((o) => o.verificationStatus === "verified").length;
  return n === 0 ? "none" : n === g.length ? "all" : "some";
};
const ids = (list) => list.map((o) => o.id).sort((a, b) => a - b);

function resolveClass(list, priorities) {
  if (!list.length) return null;
  const groups = distinctValues(list);
  if (groups.length === 1) {
    return { status: "agreed", value: valueOf(groups[0]), supporting: ids(groups[0]), verification: verificationOf(groups[0]), observationIds: ids(list) };
  }
  const units = new Set(list.map((o) => o.normalizedUnit).filter(Boolean));
  const reason = units.size > 1 ? "different_units" : "values_differ";
  const types = [...new Set(list.map((o) => o.sourceType))];
  if (types.every((t) => priorities.has(t))) {
    const top = Math.max(...types.map((t) => priorities.get(t)));
    const topObs = list.filter((o) => priorities.get(o.sourceType) === top);
    const topGroups = distinctValues(topObs);
    if (topGroups.length === 1) {
      return {
        status: "resolved_by_policy", value: valueOf(topGroups[0]), supporting: ids(topGroups[0]),
        verification: verificationOf(topGroups[0]), reason, observationIds: ids(list),
        overruled: groups.filter((g) => !g.includes(topGroups[0][0])).map((g) => ({ ...valueOf(g), observationIds: ids(g) })),
      };
    }
  }
  return {
    status: "pending_user_decision", value: null, supporting: [], reason,
    candidates: groups.map((g) => ({ ...valueOf(g), observationIds: ids(g), sourceTypes: [...new Set(g.map((o) => o.sourceType))].sort() })),
    observationIds: ids(list),
  };
}

// replacesOut — множество id наблюдений, у которых есть исходящая связь
// replaces. Нужно, чтобы показать «замена заявлена, но не оформлена».
export function resolveGroup(observations, priorities = new Map(), replacesOut = new Set()) {
  const usable = observations.filter((o) => o.lifecycleStatus === "active" && o.verificationStatus !== "rejected");
  const byClass = (c) => usable.filter((o) => STATEMENT_CLASS[o.statementType] === c);
  return {
    current: resolveClass(byClass("claimed"), priorities),
    measured: resolveClass(byClass("measured"), priorities),
    norm: resolveClass(byClass("norm"), priorities),
    // Источник пишет «вместо», но связь «заменяет» не создана — прежнее
    // значение продолжает участвовать в выборе. Это сигнал человеку.
    unlinkedReplacementClaims: ids(usable.filter((o) => o.statementType === "replacement" && !replacesOut.has(o.id))),
    history: observations.filter((o) => !usable.includes(o))
      .sort((a, b) => a.id - b.id)
      .map((o) => ({
        id: o.id, display: o.originalValue, lifecycleStatus: o.lifecycleStatus, verificationStatus: o.verificationStatus,
        sourceType: o.sourceType, sourceReference: o.sourceReference,
      })),
  };
}

