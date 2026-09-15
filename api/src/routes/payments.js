// Оплата. Ключевые правила: сумма берётся из заказа в базе, ключ
// идемпотентности не даёт создать второй платёж по двойному нажатию,
// а статус заказа меняется только после подтверждения от провайдера.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { all, get, insert, run } from "../db/index.js";
import { config } from "../config.js";
import { paymentProvider, paymentsEnabled } from "../payments/index.js";
import { setStatus, orderTokenOk } from "../services/orders.js";
import { badRequest, notFound, forbidden } from "../lib/errors.js";
import { rub } from "../lib/money.js";
import { notifyManagers } from "../lib/notify.js";

const paymentsOff = () => badRequest("Онлайн-оплата недоступна: заказ оплачивается менеджеру или по счёту");

// Статусы, при которых платёж у провайдера ещё «живой» и второй создавать нельзя.
const OPEN = new Set(["pending", "waiting_for_capture"]);

const paymentEvent = (paymentId, status, note, amount) =>
  insert("payment_events", { payment_id: paymentId, status, note: note ?? null, amount: amount ?? null });

// Единственное место, где результат платежа применяется к заказу.
// Сюда попадают и вебхук, и перепроверка перед созданием нового платежа.
// Правила: сумма обязана совпасть с суммой платежа в базе; уже оплаченный
// заказ второй раз не оплачивается — платёж помечается к возврату.
function applyPaymentResult(payment, { status, amount }, log, note = "") {
  if (payment.status === "succeeded") return "succeeded";

  if (status === "succeeded" && amount !== undefined && amount !== payment.amount) {
    run("UPDATE payments SET status='mismatch', updated_at=datetime('now') WHERE id=?", payment.id);
    paymentEvent(payment.id, "mismatch", `сумма провайдера ${amount} ≠ сумма платежа ${payment.amount}. ${note}`.trim(), amount);
    insert("audit_log", { tenant_id: payment.tenant_id, actor_id: null, action: "payment.mismatch", entity: "payment",
      entity_id: String(payment.id), diff: { expected: payment.amount, got: amount } });
    log?.error({ paymentId: payment.id, expected: payment.amount, got: amount }, "оплата: сумма не сходится");
    notifyManagers("Оплата: сумма не сходится", [`Платёж №${payment.id}: ожидали ${rub(payment.amount)}, пришло ${rub(amount)}`, "Заказ не помечен оплаченным — проверьте в кабинете провайдера"], log, { tenantId: payment.tenant_id, url: "/admin/orders" });
    return "mismatch";
  }

  run("UPDATE payments SET status=?, updated_at=datetime('now') WHERE id=?", status, payment.id);
  paymentEvent(payment.id, status, note || null, amount);

  if (status === "succeeded") {
    const order = get("SELECT * FROM orders WHERE id=?", payment.order_id);
    if (order.payment_status === "paid") {
      // Второй успешный платёж по уже оплаченному заказу: деньги надо вернуть.
      run("UPDATE payments SET status='needs_refund' WHERE id=?", payment.id);
      paymentEvent(payment.id, "needs_refund", "заказ уже был оплачен другим платежом");
      insert("audit_log", { tenant_id: payment.tenant_id, actor_id: null, action: "payment.duplicate", entity: "order",
        entity_id: String(order.id), diff: { paymentId: payment.id, amount: payment.amount } });
      notifyManagers("Двойная оплата", [`Заказ ${order.number} оплачен повторно: платёж №${payment.id} на ${rub(payment.amount)}`, "Нужен возврат покупателю"], log, { tenantId: payment.tenant_id, url: "/admin/orders" });
      return "needs_refund";
    }
    run("UPDATE orders SET payment_status='paid' WHERE id=?", payment.order_id);
    setStatus(payment.tenant_id, payment.order_id, "paid", null, "Оплата подтверждена провайдером");
  } else if (status === "canceled") {
    run("UPDATE orders SET payment_status='failed' WHERE id=? AND payment_status='pending'", payment.order_id);
  }
  return status;
}

export default async function paymentRoutes(app) {
  app.post("/api/payments/create", async (req) => {
    if (!paymentsEnabled()) throw paymentsOff();
    const { orderNumber } = z.object({ orderNumber: z.string().min(3).max(40) }).parse(req.body);
    const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, orderNumber);
    if (!order) throw notFound("Заказ не найден");
    // Платёж создаёт тот, кто вправе видеть заказ: владелец, сотрудник или
    // гость с токеном из оформления (то же правило, что у GET /api/orders/:number).
    const isOwner = req.user && order.user_id !== null && order.user_id === req.user.id;
    const isStaff = req.user && ["manager", "admin", "owner"].includes(req.user.role);
    if (!isOwner && !isStaff && !orderTokenOk(order, req.headers["x-order-token"])) throw forbidden("Оплатить заказ может только его владелец");
    if (order.payment_status === "paid") throw badRequest("Заказ уже оплачен");
    if (order.total <= 0) throw badRequest("По этому заказу цена уточняется менеджером");

    const provider = paymentProvider();

    // Пока у провайдера есть незавершённый платёж по заказу — второй не
    // создаём (иначе покупатель с двумя вкладками заплатит дважды). Перед
    // тем как отдать старую ссылку, перепроверяем его статус у провайдера:
    // он мог успеть оплатиться или отмениться, пока вебхук не дошёл.
    const open = all("SELECT * FROM payments WHERE order_id=? AND provider=? AND status IN ('pending','waiting_for_capture') ORDER BY id DESC", order.id, provider.name);
    for (const p of open) {
      const fresh = provider.name === "mock" ? { status: p.status } : await provider.fetchPayment(p.provider_id);
      if (OPEN.has(fresh.status)) return { url: p.confirmation_url, paymentId: p.id, status: p.status };
      const result = applyPaymentResult(p, fresh, req.log, "перепроверка перед созданием нового платежа");
      if (result === "succeeded") throw badRequest("Заказ уже оплачен");
    }

    const idempotenceKey = randomUUID();
    const items = all("SELECT * FROM order_items WHERE order_id=?", order.id);
    const created = await provider.createPayment({ order, amount: order.total, idempotenceKey, items });

    const id = insert("payments", {
      tenant_id: req.tenant.id, order_id: order.id, provider: provider.name,
      provider_id: created.providerId, amount: order.total, status: created.status,
      confirmation_url: created.confirmationUrl ?? null, idempotence_key: idempotenceKey,
      raw: created.raw ?? {},
    });
    paymentEvent(id, created.status, "платёж создан", order.total);
    return { url: created.confirmationUrl, paymentId: id, status: created.status };
  });

  // Демо-страница оплаты для провайдера mock: без неё нельзя показать
  // заказчику весь путь до «оплачено», пока эквайринг не подключён.
  // Существует только в режиме mock: на живом сайте её нет (config это гарантирует).
  app.get("/api/payments/mock/:number", async (req, reply) => {
    if (config.payments.provider !== "mock") throw notFound();
    const order = get("SELECT * FROM orders WHERE tenant_id=? AND number=?", req.tenant.id, req.params.number);
    if (!order) throw notFound("Заказ не найден");
    // Ключ платежа из ссылки: страница передаст его вебхуку, без него
    // подтверждение не примется.
    const payment = get("SELECT * FROM payments WHERE order_id=? AND provider='mock' AND idempotence_key=?",
      order.id, String(req.query.key || ""));
    if (!payment) throw notFound("Платёж не найден");
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
    body:JSON.stringify({event:'payment.'+status,object:{id:'${payment.provider_id}',key:'${payment.idempotence_key}',status:status,amount:${payment.amount}}})});
  location.href='${config.payments.returnUrl}?order=${order.number}&status='+status;
}</script>`;
  });

  // Единственное место, где заказ становится оплаченным. Принимается только
  // вебхук настроенного провайдера, платёж ищется строго среди его платежей,
  // а подтверждение — либо перезапрос у провайдера, либо (для демо) секретный
  // ключ платежа. Подделать «оплату» посторонним запросом нельзя.
  app.post("/api/payments/webhook/:provider", { config: { rateLimit: false } }, async (req, reply) => {
    if (!paymentsEnabled() || req.params.provider !== config.payments.provider) throw notFound();
    const provider = paymentProvider(config.payments.provider);
    if (!provider.verifyWebhook(req)) return reply.code(403).send({ ok: false });

    const parsed = provider.parseWebhook(req.body);
    if (!parsed?.providerId) return { ok: true };

    const payment = get("SELECT * FROM payments WHERE provider=? AND provider_id=?", provider.name, parsed.providerId);
    if (!payment) return { ok: true };
    if (payment.status === "succeeded") return { ok: true }; // повторная доставка вебхука

    let fresh = { status: parsed.status, amount: parsed.amount };
    if (parsed.verifyByFetch) {
      // Тело вебхука не подписано — перезапрашиваем платёж у провайдера,
      // и статус, и сумму.
      fresh = await provider.fetchPayment(payment.provider_id);
    } else if (parsed.key !== payment.idempotence_key) {
      // Демо-режим: без ключа платежа телу запроса не верим.
      return reply.code(403).send({ ok: false });
    }

    applyPaymentResult(payment, fresh, req.log, "вебхук провайдера");
    return { ok: true };
  });
}
