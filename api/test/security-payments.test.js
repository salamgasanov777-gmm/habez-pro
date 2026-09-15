// П-11: пометить заказ оплаченным можно только через подтверждение провайдера.
// Проверяем все обходные пути, которые были возможны до исправления.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-sec-pay.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "mock";
process.env.LOG_LEVEL = "silent";

let app, get, order, payment, owner, customer;

const json = (res) => JSON.parse(res.body);
const orderNow = () => get("SELECT status, payment_status FROM orders WHERE id=?", order.id);

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  ({ get } = await import("../src/db/index.js"));

  // Заказ с созданным, но не оплаченным платежом — цель всех попыток ниже.
  const product = json(await app.inject("/api/catalog/products/akvalayt")).product;
  const added = await app.inject({ method: "POST", url: "/api/cart/items", payload: { variantId: product.variants[0].id, qty: 2 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart").value;
  order = json(await app.inject({
    method: "POST", url: "/api/orders", headers: { cookie: `hgz_cart=${cookie}` },
    payload: { customer: { name: "Жертва Атаки", phone: "+79380000001" }, consent: true },
  }));
  const noRight = await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: order.number } });
  assert.equal(noRight.statusCode, 403, "без права на заказ платёж не создать");
  const pay = json(await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: order.number }, headers: { "x-order-token": order.accessToken } }));
  payment = get("SELECT * FROM payments WHERE id=?", pay.paymentId);

  owner = json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@habez.local", password: "admin12345" } }));
  const otp = json(await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+79005550001" } }));
  customer = json(await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { phone: "+79005550001", code: otp.devCode } }));
});

after(async () => { await app?.close(); });

// Свежий заказ с открытым платежом — для сценариев, которым нужен неоплаченный заказ.
async function freshOrder(phone) {
  const product = json(await app.inject("/api/catalog/products/akvalayt")).product;
  const added = await app.inject({ method: "POST", url: "/api/cart/items", payload: { variantId: product.variants[0].id, qty: 3 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart").value;
  const o = json(await app.inject({
    method: "POST", url: "/api/orders", headers: { cookie: `hgz_cart=${cookie}` },
    payload: { customer: { name: "Покупатель", phone }, consent: true },
  }));
  const headers = { "x-order-token": o.accessToken };
  const pay = json(await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: o.number }, headers }));
  return { o, headers, p: get("SELECT * FROM payments WHERE id=?", pay.paymentId), status: () => get("SELECT status, payment_status FROM orders WHERE id=?", o.id) };
}
const webhook = (p, extra = {}) => app.inject({
  method: "POST", url: "/api/payments/webhook/mock",
  payload: { event: "payment.succeeded", object: { id: p.provider_id, key: p.idempotence_key, status: "succeeded", amount: p.amount, ...extra } },
});

test("аноним: старый обход — вебхук с номером заказа — отклоняется", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/payments/webhook/mock",
    payload: { event: "payment.succeeded", object: { id: order.number, status: "succeeded" } },
  });
  assert.ok([200, 403].includes(res.statusCode));
  assert.equal(orderNow().payment_status, "pending");
  assert.equal(orderNow().status, "new");
});

test("аноним: вебхук с настоящим id платежа, но без ключа — отклоняется", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/payments/webhook/mock",
    payload: { event: "payment.succeeded", object: { id: payment.provider_id, status: "succeeded" } },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(orderNow().payment_status, "pending");

  const wrongKey = await app.inject({
    method: "POST", url: "/api/payments/webhook/mock",
    payload: { event: "payment.succeeded", object: { id: payment.provider_id, key: "не-тот-ключ", status: "succeeded" } },
  });
  assert.equal(wrongKey.statusCode, 403);
  assert.equal(orderNow().payment_status, "pending");
});

test("вебхук чужого провайдера — 404", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/payments/webhook/yookassa",
    payload: { event: "payment.succeeded", object: { id: payment.provider_id, status: "succeeded" } },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(orderNow().payment_status, "pending");
});

test("демо-страница оплаты без ключа платежа не открывается", async () => {
  assert.equal((await app.inject(`/api/payments/mock/${order.number}`)).statusCode, 404);
  assert.equal((await app.inject(`/api/payments/mock/${order.number}?key=чужой`)).statusCode, 404);
  assert.equal((await app.inject(`/api/payments/mock/${order.number}?key=${payment.idempotence_key}`)).statusCode, 200);
});

test("аноним и клиент не могут сменить статус заказа", async () => {
  const anon = await app.inject({ method: "PATCH", url: `/api/admin/orders/${order.id}`, payload: { status: "paid" } });
  assert.equal(anon.statusCode, 401);
  const cust = await app.inject({
    method: "PATCH", url: `/api/admin/orders/${order.id}`, payload: { status: "paid" },
    headers: { authorization: `Bearer ${customer.accessToken}` },
  });
  assert.equal(cust.statusCode, 403);
  assert.equal(orderNow().status, "new");
  assert.equal(orderNow().payment_status, "pending");
});

test("менеджер меняет статус заказа, но факт оплаты деньгами от этого не появляется", async () => {
  // Статус «оплачен» менеджер ставит для наличных и счетов — это его роль.
  // Но payment_status (подтверждение провайдера) остаётся нетронутым.
  const res = await app.inject({
    method: "PATCH", url: `/api/admin/orders/${order.id}`, payload: { status: "confirmed" },
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(orderNow().status, "confirmed");
  assert.equal(orderNow().payment_status, "pending");
});

test("настоящее подтверждение (id + ключ платежа) — единственный путь к paid", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/payments/webhook/mock",
    payload: { event: "payment.succeeded", object: { id: payment.provider_id, key: payment.idempotence_key, status: "succeeded" } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(orderNow().payment_status, "paid");
});

test("П-36: пока платёж не завершён, второй не создаётся — даже спустя час", async () => {
  const { run } = await import("../src/db/index.js");
  const t = await freshOrder("+79380000011");
  run("UPDATE payments SET created_at=datetime('now','-2 hours') WHERE id=?", t.p.id);
  const again = json(await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: t.o.number }, headers: t.headers }));
  assert.equal(again.paymentId, t.p.id);
  assert.equal(get("SELECT COUNT(*) AS n FROM payments WHERE order_id=?", t.o.id).n, 1);
});

test("П-37: подтверждение с другой суммой не оплачивает заказ", async () => {
  const t = await freshOrder("+79380000012");
  const res = await webhook(t.p, { amount: t.p.amount - 100 });
  assert.equal(res.statusCode, 200);
  assert.equal(t.status().payment_status, "pending");
  assert.equal(get("SELECT status FROM payments WHERE id=?", t.p.id).status, "mismatch");
  assert.ok(get("SELECT id FROM audit_log WHERE action='payment.mismatch' AND entity_id=?", String(t.p.id)));
  assert.ok(get("SELECT id FROM payment_events WHERE payment_id=? AND status='mismatch'", t.p.id), "история статусов");
  // Платёж с несошедшейся суммой закрыт: можно создать новый, и он оплачивается.
  const next = json(await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: t.o.number }, headers: t.headers }));
  assert.notEqual(next.paymentId, t.p.id);
  await webhook(get("SELECT * FROM payments WHERE id=?", next.paymentId));
  assert.equal(t.status().payment_status, "paid");
});

test("П-39: у платежа есть история статусов", async () => {
  const { all } = await import("../src/db/index.js");
  const t = await freshOrder("+79380000013");
  await webhook(t.p);
  const events = all("SELECT status FROM payment_events WHERE payment_id=? ORDER BY id", t.p.id);
  assert.deepEqual(events.map((e) => e.status), ["pending", "succeeded"]);
});

test("П-36: второй успешный платёж по оплаченному заказу помечается к возврату, заказ не трогается", async () => {
  const { run } = await import("../src/db/index.js");
  const t = await freshOrder("+79380000014");
  await webhook(t.p);
  assert.equal(t.status().payment_status, "paid");
  const paidEvents = get("SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND status='paid'", t.o.id).n;

  // «Застрявший» второй платёж (открыт до оплаты в другой вкладке) тоже приходит успешным.
  run(`INSERT INTO payments (tenant_id, order_id, provider, provider_id, amount, status, idempotence_key)
       VALUES (?,?,?,?,?,?,?)`, t.p.tenant_id, t.o.id, "mock", "mock_dup", t.p.amount, "pending", "dup-key");
  const dup = get("SELECT * FROM payments WHERE provider_id='mock_dup'");
  await webhook(dup);
  assert.equal(get("SELECT status FROM payments WHERE id=?", dup.id).status, "needs_refund");
  assert.ok(get("SELECT id FROM audit_log WHERE action='payment.duplicate' AND entity_id=?", String(t.o.id)));
  assert.equal(get("SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND status='paid'", t.o.id).n, paidEvents, "заказ второй раз не «оплачивался»");
  // Новый платёж по оплаченному заказу не создаётся.
  const res = await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: t.o.number }, headers: t.headers });
  assert.equal(res.statusCode, 400);
});
