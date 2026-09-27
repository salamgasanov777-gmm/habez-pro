// Чистые правила 3.5 (без базы): статус аналога, группы сравнимых цен,
// свойства товара конкурента. Победитель нигде не выбирается.
import { resolveGroup } from "../knowledge/evidence-resolve.js";

// ── Аналог ───────────────────────────────────────────────────────────────
// Правила (как у связей завод ↔ товар в Phase 3.4):
//   CONFIRMED  — есть действующие утверждения с допустимым основанием
//                (прямое указание источника или решение сотрудника с
//                обоснованием), и все они говорят одно (analog,
//                partial_analog или not_analog);
//   CONFLICTED — утверждения расходятся (например, «аналог» и «не аналог»
//                или «аналог» и «частичный аналог»);
//   INFERRED   — утверждений нет, но есть косвенный признак (тот же наш
//                раздел каталога). Вычисляется при чтении, не хранится,
//                подтверждением не становится;
//   UNKNOWN    — нет ни утверждений, ни признаков.
// Снятые (withdrawn) утверждения в статусе не участвуют, но остаются в
// истории. «Аналог» не значит «одинаковый товар».
export function analogStatusOf(rows = [], { sameCategory = false, hiddenRelations = [] } = {}) {
  const active = rows.filter((r) => r.lifecycleStatus === "active");
  const relations = [...new Set(active.map((r) => r.relation))].sort();
  let status;
  let relation = null;
  if (active.length) {
    if (relations.length > 1) status = "CONFLICTED";
    else { status = "CONFIRMED"; relation = relations[0]; }
  } else status = sameCategory ? "INFERRED" : "UNKNOWN";
  // Скрытые роли утверждения, которые изменили бы статус: роль видит только
  // «нужна сверка», без значения.
  const needsReview = hiddenRelations.length > 0 && (!active.length || hiddenRelations.some((h) => !relations.includes(h)));
  return {
    status, relation, relations,
    basis: active.map((r) => ({ id: r.id, relation: r.relation, basis: r.basis, sourceId: r.sourceId, note: r.note, differences: r.differences })),
    inferredBasis: status === "INFERRED" ? "тот же раздел каталога — это предположение, не подтверждение" : null,
    history: rows.filter((r) => r.lifecycleStatus !== "active").map((r) => ({ id: r.id, relation: r.relation, basis: r.basis, lifecycleStatus: r.lifecycleStatus, withdrawnReason: r.withdrawnReason })),
    needsReview,
  };
}

// ── Цены ─────────────────────────────────────────────────────────────────
// Цены сравнимы только при одной валюте, виде цены, основе (единица и
// количество), НДС, фасовке и регионе. Всё остальное — разные группы:
// «за мешок 25 кг» и «за кг» не пересчитываются друг в друга.
export const priceGroupKey = (p) => [p.currency, p.priceKind, p.basisUnit, p.basisQty ?? "", p.vat, p.packId ?? "", p.regionId ?? ""].join("|");
export const pricesComparable = (a, b) => priceGroupKey(a) === priceGroupKey(b);

// Внутри группы — по дате наблюдения. Разные суммы на одну дату в одной
// группе — противоречие источников (CONFLICTED), не «правильная» и
// «неправильная». Более поздняя цена — просто более поздняя: действующая
// не выбирается.
export function priceGroups(prices = []) {
  const groups = new Map();
  for (const p of prices.filter((x) => x.lifecycleStatus === "active")) {
    const k = priceGroupKey(p);
    if (!groups.has(k)) groups.set(k, { key: k, currency: p.currency, priceKind: p.priceKind, basisUnit: p.basisUnit, basisQty: p.basisQty, priceBasis: p.priceBasis,
      vat: p.vat, packId: p.packId, regionId: p.regionId, observations: [] });
    groups.get(k).observations.push(p);
  }
  return [...groups.values()].map((g) => {
    g.observations.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id - b.id));
    const byDate = new Map();
    for (const o of g.observations) {
      if (!byDate.has(o.observedAt)) byDate.set(o.observedAt, new Set());
      byDate.get(o.observedAt).add(o.amountMinor);
    }
    const conflicts = [...byDate].filter(([, s]) => s.size > 1).map(([d, s]) => ({ observedAt: d, amounts: [...s].sort((a, b) => a - b) }));
    return { ...g, status: conflicts.length ? "CONFLICTED" : "OBSERVED", conflicts, dates: [...byDate.keys()] };
  });
}

// ── Свойства товара конкурента ───────────────────────────────────────────
// Та же группировка и те же правила выбора, что у наших наблюдений (2.2B):
// товар × фасовка × ключ × условие, классы заявлено / замер / норма.
export function propertyGroups(observations = [], priorities = new Map()) {
  const groups = new Map();
  for (const o of observations) {
    const k = `${o.packId ?? ""}|${o.specKey}|${o.conditionKey}`;
    if (!groups.has(k)) groups.set(k, { packId: o.packId, specKey: o.specKey, conditionKey: o.conditionKey, conditionText: o.conditionText, observations: [] });
    groups.get(k).observations.push(o);
  }
  return [...groups.values()].map((g) => ({ ...g, resolution: resolveGroup(g.observations, priorities) }));
}
