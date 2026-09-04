// Цена зависит от того, кто спрашивает: розница, дилер, VIP. Плюс объёмные
// пороги (min_qty) — типовая заводская схема «от паллеты дешевле».
// Пустая цена — это не ноль, а «по запросу»: у завода часть позиций
// действительно продаётся только через менеджера, и выдумывать цифру нельзя.
import { all } from "../db/index.js";

export function tierFor(user) {
  if (!user) return "retail";
  if (user.price_tier) return user.price_tier;
  return user.role === "dealer" ? "dealer" : "retail";
}

export function priceMapFor(tenantId, tier, variantIds) {
  if (!variantIds.length) return new Map();
  const marks = variantIds.map(() => "?").join(",");
  // Розница берётся как запасной вариант: если дилерской цены на позицию нет,
  // дилер увидит розничную, а не «нет цены».
  const rows = all(
    `SELECT variant_id, tier, amount, min_qty, currency FROM prices
      WHERE tenant_id=? AND variant_id IN (${marks}) AND tier IN (?, 'retail')
        AND (valid_from IS NULL OR valid_from <= datetime('now'))
        AND (valid_to   IS NULL OR valid_to   >= datetime('now'))
      ORDER BY min_qty ASC`,
    tenantId, ...variantIds, tier
  );

  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.variant_id) || { tiers: [] };
    cur.tiers.push(r);
    map.set(r.variant_id, cur);
  }

  for (const [id, v] of map) {
    const own = v.tiers.filter((t) => t.tier === tier);
    const list = own.length ? own : v.tiers.filter((t) => t.tier === "retail");
    const base = list.find((t) => t.min_qty === 1) || list[0];
    map.set(id, {
      amount: base?.amount ?? null,
      currency: base?.currency || "RUB",
      tier: base?.tier || tier,
      onRequest: !base || base.amount === null,
      breaks: list.filter((t) => t.min_qty > 1).map((t) => ({ minQty: t.min_qty, amount: t.amount })),
    });
  }
  return map;
}

// Цена за штуку с учётом объёмного порога — считается в момент заказа.
export function unitPrice(priceInfo, qty) {
  if (!priceInfo || priceInfo.onRequest) return null;
  let amount = priceInfo.amount;
  for (const b of priceInfo.breaks || []) if (qty >= b.minQty && b.amount !== null) amount = Math.min(amount, b.amount);
  return amount;
}
