// П-12: чужой заказ недоступен. Право на заказ подтверждает сервер: вход
// владельца, роль сотрудника или секретный токен, выданный при оформлении.
// Номер заказа, телефон и всё, что можно подобрать, правом не являются.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-sec-orders.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";

let app, variantId, owner, A, B, orderA, orderB, guestOrder;
const json = (res) => JSON.parse(res.body);

async function loginByPhone(phone, name) {
  const otp = json(await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone } }));
  return json(await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { phone, code: otp.devCode, name } }));
}

// Заказ от имени пользователя (или гостя): своя корзина через cookie.
async function placeOrder(user, phone, name) {
  const auth = user ? { authorization: `Bearer ${user.accessToken}` } : {};
  const added = await app.inject({ method: "POST", url: "/api/cart/items", headers: auth, payload: { variantId, qty: 1 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart").value;
  const res = await app.inject({
    method: "POST", url: "/api/orders", headers: { ...auth, cookie: `hgz_cart=${cookie}` },
    payload: { customer: { name, phone, deliveryType: "delivery", deliveryAddress: "секретный адрес " + name, inn: "1234567890" }, consent: true },
  });
  assert.equal(res.statusCode, 201);
  return json(res);
}

const view = (number, headers = {}) => app.inject({ url: `/api/orders/${encodeURIComponent(number)}`, headers });

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();

  variantId = json(await app.inject("/api/catalog/products/akvalayt")).product.variants[0].id;
  owner = json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@habez.local", password: "admin12345" } }));
  A = await loginByPhone("+79001000001", "Клиент А");
  B = await loginByPhone("+79001000002", "Клиент Б");
  orderA = await placeOrder(A, "+79001000001", "Клиент А");
  orderB = await placeOrder(B, "+79001000002", "Клиент Б");
  guestOrder = await placeOrder(null, "+79001000003", "Гость");
});

after(async () => { await app?.close(); });

test("владелец видит свой заказ по входу, чужой — нет", async () => {
  const mine = await view(orderA.number, { authorization: `Bearer ${A.accessToken}` });
  assert.equal(mine.statusCode, 200);
  assert.equal(json(mine).customer.name, "Клиент А");

  const theirs = await view(orderB.number, { authorization: `Bearer ${A.accessToken}` });
  assert.equal(theirs.statusCode, 403);
  assert.ok(!theirs.body.includes("секретный адрес"), "персональные данные Б не утекли");
});

test("список «мои заказы» содержит только свои", async () => {
  const list = json(await app.inject({ url: "/api/orders", headers: { authorization: `Bearer ${A.accessToken}` } }));
  assert.deepEqual(list.items.map((o) => o.number), [orderA.number]);
});

test("аноним: номер заказа не даёт доступа, телефон — тоже", async () => {
  for (const q of ["", "?phone=9001000002", "?phone=2", "?phone=+79001000002"]) {
    const res = await app.inject({ url: `/api/orders/${encodeURIComponent(orderB.number)}${q}` });
    assert.equal(res.statusCode, 403, `запрос «${q}» должен быть отклонён`);
    assert.ok(!res.body.includes("Клиент Б"));
  }
});

test("перебор последовательных номеров ничего не открывает", async () => {
  const [prefix, stamp] = orderA.number.split("-");
  let opened = 0;
  for (let n = 1; n <= 20; n++) {
    const res = await view(`${prefix}-${stamp}-${String(n).padStart(4, "0")}`);
    if (res.statusCode === 200) opened++;
    assert.ok([403, 404].includes(res.statusCode));
  }
  assert.equal(opened, 0);
});

test("гость: заказ открывается только по своему токену", async () => {
  assert.ok(guestOrder.accessToken.length >= 20);
  assert.equal((await view(guestOrder.number)).statusCode, 403);
  assert.equal((await view(guestOrder.number, { "x-order-token": "короткий" })).statusCode, 403);
  assert.equal((await view(guestOrder.number, { "x-order-token": "x".repeat(43) })).statusCode, 403);
  // Токен одного заказа не открывает другой.
  assert.equal((await view(orderB.number, { "x-order-token": guestOrder.accessToken })).statusCode, 403);
  const ok = await view(guestOrder.number, { "x-order-token": guestOrder.accessToken });
  assert.equal(ok.statusCode, 200);
  assert.equal(json(ok).customer.name, "Гость");
});

test("токен не выдаётся повторно: в чтении заказа и в панели его нет", async () => {
  const again = json(await view(guestOrder.number, { "x-order-token": guestOrder.accessToken }));
  assert.equal(again.accessToken, undefined);
  const admin = json(await app.inject({ url: `/api/admin/orders/${guestOrder.id}`, headers: { authorization: `Bearer ${owner.accessToken}` } }));
  assert.equal(admin.accessToken, undefined);
  assert.equal(admin.access_token_hash, undefined);
});

test("сотрудник видит любой заказ", async () => {
  const res = await view(orderB.number, { authorization: `Bearer ${owner.accessToken}` });
  assert.equal(res.statusCode, 200);
});

test("клиент не может изменить чужой (и свой) заказ и не видит чужих данных в панели", async () => {
  const auth = { authorization: `Bearer ${A.accessToken}` };
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/orders/${orderB.id}`, headers: auth, payload: { status: "cancelled" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/orders/${orderA.id}`, headers: auth, payload: { status: "cancelled" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/orders", headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/users", headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/leads", headers: auth })).statusCode, 403);
  const untouched = json(await view(orderB.number, { authorization: `Bearer ${B.accessToken}` }));
  assert.equal(untouched.status, "new");
});
