import { z } from "zod";
import { all, get } from "../db/index.js";
import { getOrCreateCart, cartView } from "../services/cart.js";
import { createOrder, orderView, applyPromo, orderTokenOk } from "../services/orders.js";
import { notifyManagers } from "../lib/notify.js";
import { rub } from "../lib/money.js";
import { forbidden, notFound } from "../lib/errors.js";

const customerSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(10).max(20),
  kind: z.enum(["person", "foreman", "shop", "company"]).default("person"),
  email: z.string().email().optional().or(z.literal("")),
  company: z.string().max(200).optional(),
  inn: z.string().max(12).optional(),
  deliveryType: z.enum(["pickup", "delivery"]).default("pickup"),
  deliveryAddress: z.string().max(400).optional(),
  comment: z.string().max(1000).optional(),
});

export default async function orderRoutes(app) {
  app.post("/api/orders/promo", async (req, reply) => {
    const { code } = z.object({ code: z.string().min(2).max(40) }).parse(req.body);
    const cart = getOrCreateCart(req, reply);
    const view = cartView(req.tenant.id, cart, req.user);
    const { discount } = applyPromo(req.tenant.id, code, view.subtotal);
    return { code: code.toUpperCase(), discount, total: view.subtotal - discount };
  });

  app.post("/api/orders", { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const body = z.object({
      customer: customerSchema,
      promoCode: z.string().max(40).optional().nullable(),
      // 152-ФЗ: без галочки «согласен на обработку данных» заказ не принимается.
      consent: z.literal(true, { errorMap: () => ({ message: "Нужно согласие на обработку персональных данных" }) }),
    }).parse(req.body);

    const cart = getOrCreateCart(req, reply);
    const settings = JSON.parse(req.tenant.settings || "{}");
    const deliveryCost = body.customer.deliveryType === "delivery" ? (settings.deliveryCost ?? 0) : 0;

    const order = createOrder({
      tenant: req.tenant, user: req.user, cart,
      customer: body.customer, deliveryCost, promoCode: body.promoCode || null,
    });

    const KIND = { person: "частное лицо", foreman: "прораб", shop: "магазин", company: "организация" };
    const who = [KIND[order.customer.kind] || "", order.customer.company].filter(Boolean).join(", ");
    await notifyManagers(`Новый заказ ${order.number}`, [
      `${order.customer.name}${who ? ` (${who})` : ""}, ${order.customer.phone}`,
      ...order.items.map((i) => `• ${i.name} — ${i.qty} × ${rub(i.price)}`),
      `Итого: ${rub(order.total)}`,
      order.delivery.type === "delivery" ? `Доставка: ${order.delivery.address}` : "Самовывоз",
    ], req.log, { tenantId: req.tenant.id, url: "/admin/orders" });

    reply.code(201);
    return order;
  });

  app.get("/api/orders", { onRequest: [app.requireAuth()] }, async (req) => {
    const rows = all(
      `SELECT id FROM orders WHERE tenant_id=? AND user_id=? ORDER BY id DESC LIMIT 50`,
      req.tenant.id, req.user.id);
    return { items: rows.map((r) => orderView(req.tenant.id, r.id)) };
  });

  // Кто вправе видеть заказ: его владелец (по входу), сотрудник, либо гость
  // с секретным токеном, который сервер выдал при оформлении. Номер заказа
  // и телефон правом доступа не являются — их можно подобрать.
  app.get("/api/orders/:number", async (req) => {
    const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, req.params.number);
    if (!order) throw notFound("Заказ не найден");
    const isOwner = req.user && order.user_id !== null && order.user_id === req.user.id;
    const isStaff = req.user && ["manager", "admin", "owner"].includes(req.user.role);
    const tokenOk = orderTokenOk(order, req.headers["x-order-token"]);
    if (!isOwner && !isStaff && !tokenOk) throw forbidden("Заказ доступен по ссылке из подтверждения или после входа");
    return orderView(req.tenant.id, order.id);
  });
}
