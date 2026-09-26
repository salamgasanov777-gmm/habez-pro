// Сравнение «наш товар ↔ товар конкурента»: строка — характеристика
// (ключ словаря × условие), ячейки — значения каждой стороны со статусом.
// Нет значения — «нет данных» (не ноль и не пропуск строки). Разные единицы
// помечаются и не пересчитываются. Победитель, «лучше» и «хуже» не
// вычисляются. Цены конкурента — отдельным блоком групп; с нашими ценами
// они здесь не сравниваются (это Phase 6).
import { productEvidence } from "../knowledge/evidence.js";
import { evidenceKeyMeta } from "../knowledge/evidence-model.js";
import { requireReader, scopeOf } from "./model.js";
import { visibleProduct, productView } from "./products.js";
import { productObservations } from "./observations.js";
import { productPrices } from "./prices.js";
import { analogStatus } from "./analogs.js";

const RESOLUTION = { agreed: "agreed", resolved_by_policy: "agreed", pending_user_decision: "conflict" };

// Ячейка из итога свойства (2.2B): согласованное значение или все
// расходящиеся значения — без выбора.
// Если заявленного значения нет, а есть только замер или норма, ячейка —
// по ним (с пометкой класса), а не «нет данных».
function cellOf(resolution, observations, hidden = false) {
  const cls = resolution?.current ? "claimed" : resolution?.measured ? "measured" : resolution?.norm ? "norm" : null;
  const cur = cls ? resolution[cls === "claimed" ? "current" : cls] : null;
  if (!cur) return null;
  const displays = cur.status === "pending_user_decision" ? cur.candidates.flatMap((c) => c.displays) : cur.value?.displays || [];
  const units = [...new Set((cur.status === "pending_user_decision" ? cur.candidates.map((c) => c.unit) : [cur.value?.unit]).filter(Boolean))];
  const ids = new Set(cur.observationIds || []);
  const obs = observations.filter((o) => ids.has(o.id));
  return {
    missing: false, status: RESOLUTION[cur.status] || cur.status, reason: cur.reason ?? null, statementClass: cls, values: displays, units,
    sources: obs.map((o) => ({ observationId: o.id, sourceType: o.sourceType, sourceId: o.sourceId ?? o.source?.id ?? null, date: o.providedAt ?? null })),
    measured: cls !== "measured" && resolution.measured ? (resolution.measured.value?.displays || resolution.measured.candidates?.flatMap((c) => c.displays) || []) : [],
    norm: cls !== "norm" && resolution.norm ? (resolution.norm.value?.displays || resolution.norm.candidates?.flatMap((c) => c.displays) || []) : [],
    hiddenDisagreement: !!hidden,
  };
}
const MISSING = { missing: true, status: null, values: [], units: [] };

export function compareWithCompetitor(ctx, productId, competitorProductId) {
  requireReader(ctx);
  const cp = visibleProduct(ctx, competitorProductId);
  const role = scopeOf(ctx.role) === "admin" ? "owner" : "manager";
  const ours = productEvidence(ctx.tenantId, productId, role);
  const theirs = productObservations(ctx, competitorProductId);
  const rows = new Map();
  const row = (key, conditionKey, conditionText) => {
    const k = `${key}|${conditionKey || ""}`;
    if (!rows.has(k)) rows.set(k, { key, conditionKey: conditionKey || "", conditionText: conditionText || null, label: evidenceKeyMeta(key)?.label || key, ours: MISSING, theirs: MISSING });
    return rows.get(k);
  };
  // Фасовочные свойства сравниваются по фасовкам — не здесь.
  for (const g of ours.properties.filter((x) => x.variantId === null)) {
    const r = row(g.specKey, g.conditionKey, g.observations.find((o) => o.conditionText)?.conditionText);
    r.ours = cellOf(g.resolution, g.observations, (g.resolution?.current?.hiddenObservations ?? 0) > 0) || MISSING;
  }
  for (const g of theirs.properties.filter((x) => x.packId === null)) {
    const r = row(g.specKey, g.conditionKey, g.conditionText);
    r.theirs = cellOf(g.resolution, g.observations, g.hiddenDisagreement) || MISSING;
  }
  const list = [...rows.values()].map((r) => ({
    ...r, common: !r.ours.missing && !r.theirs.missing,
    // Разные единицы — пометка, без пересчёта (мл/м² и г/м² — разные величины).
    differentUnits: !r.ours.missing && !r.theirs.missing && r.ours.units.length > 0 && r.theirs.units.length > 0 && r.ours.units.join() !== r.theirs.units.join(),
  }));
  list.sort((a, b) => Number(b.common) - Number(a.common) || a.label.localeCompare(b.label, "ru"));
  return {
    product: { id: ours.product.id, slug: ours.product.slug, name: ours.product.name },
    competitorProduct: productView(cp),
    analog: analogStatus(ctx, productId, competitorProductId),
    rows: list,
    prices: productPrices(ctx, competitorProductId).groups,
  };
}
