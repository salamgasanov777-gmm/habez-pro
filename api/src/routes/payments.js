// Оплата. Ключевые правила: сумма берётся из заказа в базе, ключ
// идемпотентности не даёт создать второй платёж по двойному нажатию,
// а статус заказа меняется только после подтверждения от провайдера.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { all, get, insert, run } from "../db/index.js";
import { config } from "../config.js";
import { paymentProvider } from "../payments/index.js";
import { setStatus } from "../services/orders.js";
import { badRequest, notFound } from "../lib/errors.js";
import { rub } from "../lib/money.js";

export default async function paymentRoutes(app) {
  app.post("/api/payments/create", async (req) => {
    const { orderNumber } = z.object({ orderNumber: z.string().min(3).max(40) }).parse(req.body);
    const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, orderNumber);
    if (!order) throw notFound("Заказ не найден");
    if (order.payment_status === "paid") throw badRequest("Заказ уже оплачен");
    if (order.total <= 0) throw badRequest("По этому заказу цена уточняется менеджером");

    const pending = get(
      `SELECT * FROM payments WHERE order_id=? AND status='pending' AND created_at > datetime('now','-15 minutes')
       ORDER BY id DESC LIMIT 1`, order.id);
    if (pending?.confirmation_url) return { url: pending.confirmation_url, paymentId: pending.id, status: pending.status };

    const provider = paymentProvider();
    const idempotenceKey = randomUUID();
    const items = all("SELECT * FROM order_items WHERE order_id=?", order.id);
    const created = await provider.createPayment({ order, amount: order.total, idempotenceKey, items });

    const id = insert("payments", {
      tenant_id: req.tenant.id, order_id: order.id, provider: provider.name,
      provider_id: created.providerId, amount: order.total, status: created.status,
      confirmation_url: created.confirmationUrl ?? null, idempotence_key: idempotenceKey,
      raw: created.raw ?? {},
    });
    return { url: created.confirmationUrl, paymentId: id, status: created.status };
  });

  // Демо-страница оплаты для провайдера mock: без неё нельзя показать
  // заказчику весь путь до «оплачено», пока эквайринг не подключён.
  app.get("/api/payments/mock/:number", async (req, reply) => {
    const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, req.params.number);
    if (!order) throw notFound("Заказ не найден");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата ${order.number}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0f1720;color:#e8eef5;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#182430;padding:32px;border-radius:20px;max-width:380px;width:90%;box-shadow:0 24px 60px #0008}
h1{font-size:20px;margin:0 0 4px}.sum{font-size:34px;font-weight:700;margin:16px 0}
button{width:100%;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}
.pay{background:#2f8f4e;color:#fff}.cancel{background:#26323f;color:#9fb0c0}
.note{font-size:13px;color:#8b9bab;margin-top:16px}</style>
<div class=card><h1>Тестовая оплата</h1><div>Заказ ${order.number}</div><div class=sum>${rub(order.total)}</div>
<button class=pay onclick="done('succeeded')">Оплатить</button>
<button class=cancel onclick="done('canceled')">Отменить</button>
<p class=note>Это встроенная имитация эквайринга. В боевом режиме здесь открывается платёжная страница банка.</p></div>
<script>async function done(status){
  await fetch('${config.publicUrl}/api/payments/webhook/mock',{method:'POST',headers:{'content-type':'application/json','x-tenant':'${req.tenant.slug}'},
    body:JSON.stringify({event:'payment.'+status,object:{id:'${order.number}',status:status}})});
  location.href='${config.payments.returnUrl}?order=${order.number}&status='+status;
}</script>`;
  });

  app.post("/api/payments/webhook/:provider", { config: { rateLimit: false } }, async (req, reply) => {
    const provider = paymentProvider(req.params.provider === "mock" ? "mock" : config.payments.provider);
    if (!provider.verifyWebhook(req)) return reply.code(403).send({ ok: false });

    const parsed = provider.parseWebhook(req.body);
    if (!parsed?.providerId) return { ok: true };

    // mock шлёт номер заказа, боевой провайдер — свой id платежа.
    let payment = get("SELECT * FROM payments WHERE provider=? AND provider_id=?", provider.name, parsed.providerId);
    if (!payment && provider.name === "mock") {
      const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, parsed.providerId);
      payment = order ? get("SELECT * FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1", order.id) : null;
    }
    if (!payment) return { ok: true };
    if (payment.status === "succeeded") return { ok: true }; // повторная доставка вебхука

    let status = parsed.status;
    if (parsed.verifyByFetch) {
      // Тело вебхука не подписано — перезапрашиваем платёж у провайдера.
      const fresh = await provider.fetchPayment(payment.provider_id);
      status = fresh.status;
    }

    run("UPDATE payments SET status=?, updated_at=datetime('now') WHERE id=?", status, payment.id);

    if (status === "succeeded") {
      run("UPDATE orders SET payment_status='paid' WHERE id=?", payment.order_id);
      setStatus(req.tenant.id, payment.order_id, "paid", null, "Оплата подтверждена провайдером");
    } else if (status === "canceled") {
      run("UPDATE orders SET payment_status='failed' WHERE id=?", payment.order_id);
    }
    return { ok: true };
  });
}
