// Оформление заказа. Цены пересчитываются на сервере из прайса — то, что
// пришло с клиента, в расчёт не берётся никогда.
import { all, get, insert, run, tx } from "../db/index.js";
import { priceMapFor, tierFor, unitPrice } from "./pricing.js";
import { cartView } from "./cart.js";
import { badRequest, notFound } from "../lib/errors.js";

export function nextOrderNumber(tenantId, prefix = "ЗК") {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const row = get(
    "SELECT COUNT(*) AS n FROM orders WHERE tenant_id=? AND number LIKE ?", tenantId, `${prefix}-${stamp}-%`
  );
  return `${prefix}-${stamp}-${String(row.n + 1).padStart(4, "0")}`;
}

export function applyPromo(tenantId, code, subtotal) {
  if (!code) return { discount: 0, promo: null };
  const promo = get(
    `SELECT * FROM promo_codes WHERE tenant_id=? AND code=? AND is_active=1
       AND (valid_to IS NULL OR valid_to >= datetime('now'))
       AND (uses_left IS NULL OR uses_left > 0)`, tenantId, String(code).toUpperCase()
  );
  if (!promo) throw badRequest("Промокод не найден или истёк");
  if (subtotal < promo.min_total) throw badRequest("Сумма заказа меньше минимальной для этого промокода");
  const discount = promo.kind === "percent"
    ? Math.floor((subtotal * promo.value) / 100)
    : Math.min(promo.value, subtotal);
  return { discount, promo };
}

export function createOrder({ tenant, user, cart, customer, deliveryCost = 0, promoCode = null, source = "web" }) {
  const view = cartView(tenant.id, cart, user);
  if (!view.items.length) throw badRequest("Корзина пуста");

  return tx(() => {
    const prices = priceMapFor(tenant.id, tierFor(user), view.items.map((i) => i.variantId));
    let subtotal = 0;
    const rows = [];
    for (const item of view.items) {
      const price = unitPrice(prices.get(item.variantId), item.qty) ?? 0;
      const total = price * item.qty;
      subtotal += total;
      rows.push({ variant_id: item.variantId, product_name: item.name, unit: item.unit, qty: item.qty, price, total });
    }

    const { discount, promo } = applyPromo(tenant.id, promoCode, subtotal);

    const orderId = insert("orders", {
      tenant_id: tenant.id,
      number: nextOrderNumber(tenant.id, JSON.parse(tenant.settings || "{}").orderPrefix || "ЗК"),
      user_id: user?.id ?? null,
      customer_name: customer.name,
      customer_phone: customer.phone,
      customer_email: customer.email ?? null,
      company: customer.company ?? null,
      inn: customer.inn ?? null,
      delivery_type: customer.deliveryType || "pickup",
      delivery_address: customer.deliveryAddress ?? null,
      delivery_cost: deliveryCost,
      comment: customer.comment ?? null,
      subtotal,
      discount,
      total: Math.max(0, subtotal - discount + deliveryCost),
      promo_code: promo?.code ?? null,
      source,
    });

    for (const r of rows) insert("order_items", { order_id: orderId, ...r });
    insert("order_events", { order_id: orderId, status: "new", note: "Заказ оформлен", actor_id: user?.id ?? null });
    if (promo?.uses_left !== null && promo) run("UPDATE promo_codes SET uses_left=uses_left-1 WHERE id=?", promo.id);
    run("UPDATE carts SET status='ordered' WHERE id=?", cart.id);

    return orderView(tenant.id, orderId);
  });
}

export function orderView(tenantId, orderId) {
  const order = get("SELECT * FROM orders WHERE id=? AND tenant_id=?", orderId, tenantId);
  if (!order) throw notFound("Заказ не найден");
  const items = all("SELECT * FROM order_items WHERE order_id=? ORDER BY id", orderId);
  const events = all("SELECT status, note, created_at FROM order_events WHERE order_id=? ORDER BY id", orderId);
  const payment = get("SELECT provider, status, confirmation_url, amount FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", orderId);
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    paymentStatus: order.payment_status,
    customer: { name: order.customer_name, phone: order.customer_phone, email: order.customer_email, company: order.company, inn: order.inn },
    delivery: { type: order.delivery_type, address: order.delivery_address, cost: order.delivery_cost },
    comment: order.comment,
    subtotal: order.subtotal,
    discount: order.discount,
    total: order.total,
    promoCode: order.promo_code,
    createdAt: order.created_at,
    items: items.map((i) => ({ name: i.product_name, unit: i.unit, qty: i.qty, price: i.price, total: i.total })),
    events,
    payment: payment ? { provider: payment.provider, status: payment.status, url: payment.confirmation_url, amount: payment.amount } : null,
  };
}

export const ORDER_STATUSES = ["new", "confirmed", "paid", "shipping", "done", "cancelled"];

export function setStatus(tenantId, orderId, status, actorId, note) {
  if (!ORDER_STATUSES.includes(status)) throw badRequest("Неизвестный статус заказа");
  const order = get("SELECT * FROM orders WHERE id=? AND tenant_id=?", orderId, tenantId);
  if (!order) throw notFound("Заказ не найден");
  run("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?", status, orderId);
  insert("order_events", { order_id: orderId, status, note: note ?? null, actor_id: actorId ?? null });
  return orderView(tenantId, orderId);
}
