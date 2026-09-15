// П-11/П-41: без провайдера (так будет на живом сайте) онлайн-оплаты нет
// вообще: ни страницы, ни вебхуков, ни кнопки на витрине.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-pay-off.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";

let app, order;
const json = (res) => JSON.parse(res.body);

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();

  const product = json(await app.inject("/api/catalog/products/akvalayt")).product;
  const added = await app.inject({ method: "POST", url: "/api/cart/items", payload: { variantId: product.variants[0].id, qty: 1 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart").value;
  order = json(await app.inject({
    method: "POST", url: "/api/orders", headers: { cookie: `hgz_cart=${cookie}` },
    payload: { customer: { name: "Без Оплаты", phone: "+79380000002" }, consent: true },
  }));
});

after(async () => { await app?.close(); });

test("витрина знает, что онлайн-оплаты нет", async () => {
  const meta = json(await app.inject("/api/catalog/meta"));
  assert.equal(meta.settings.onlinePayment, false);
});

test("заказ оформляется, но платёж создать нельзя", async () => {
  assert.ok(order.number);
  const res = await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: order.number } });
  assert.equal(res.statusCode, 400);
});

test("демо-страницы банка и вебхуков не существует", async () => {
  assert.equal((await app.inject(`/api/payments/mock/${order.number}`)).statusCode, 404);
  for (const p of ["mock", "none", "yookassa"]) {
    const res = await app.inject({
      method: "POST", url: `/api/payments/webhook/${p}`,
      payload: { event: "payment.succeeded", object: { id: order.number, status: "succeeded" } },
    });
    assert.equal(res.statusCode, 404, `webhook/${p}`);
  }
  const after = json(await app.inject({ url: `/api/orders/${order.number}`, headers: { "x-order-token": order.accessToken } }));
  assert.equal(after.paymentStatus, "pending");
});

test("в production сервер с PAYMENT_PROVIDER=mock не стартует", async () => {
  const run = (provider) => spawnSync("node", ["-e", "import('./src/config.js').then(() => process.exit(0))"], {
    cwd: apiRoot, encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", JWT_SECRET: "x".repeat(64), PAYMENT_PROVIDER: provider },
  });
  const mock = run("mock");
  assert.equal(mock.status, 1);
  assert.match(mock.stderr, /запрещён в production/);
  assert.equal(run("none").status, 0);
  assert.equal(run("unknown").status, 1);
});
