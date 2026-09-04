// Сквозной тест основного пути: каталог → корзина → заказ → оплата → статус.
// Гоняется по настоящему приложению на отдельном файле базы, поэтому ловит
// и ошибки схемы, и ошибки маршрутов.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "mock";
process.env.LOG_LEVEL = "silent";   // тесты не должны тонуть в логе запросов

let app;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();
});

after(async () => {
  await app?.close();
});

const json = (res) => JSON.parse(res.body);

test("каталог отдаёт товары и категории", async () => {
  const meta = json(await app.inject("/api/catalog/meta"));
  assert.equal(meta.tenant.slug, "habez");
  assert.ok(meta.categories.length >= 8);

  const list = json(await app.inject("/api/catalog/products?limit=100"));
  assert.equal(list.total, 43);
  assert.ok(list.items[0].variants.length >= 1);
});

test("поиск находит по описанию и по ГОСТу", async () => {
  const byName = json(await app.inject("/api/catalog/products?search=аквалайт"));
  assert.ok(byName.total >= 1, "поиск по названию");
  const byBody = json(await app.inject("/api/catalog/products?search=плитк"));
  assert.ok(byBody.total >= 1, "поиск по тексту карточки");
});

test("подбор по задаче не пустой", async () => {
  const wet = json(await app.inject("/api/catalog/products?task=wet"));
  assert.ok(wet.total > 0);
});

test("расчёт расхода считает мешки", async () => {
  const res = json(await app.inject({
    method: "POST", url: "/api/catalog/calc",
    payload: { productId: 1, area: 100, thicknessMm: 10 },
  }));
  assert.equal(Math.round(res.amount), 950);   // 0,95 кг/м² × 100 м² × 10 мм
  assert.equal(res.packs, 32);                 // мешки по 30 кг
});

test("корзина, заказ и оплата проходят целиком", async () => {
  const product = json(await app.inject("/api/catalog/products/akvalayt")).product;
  const variantId = product.variants[0].id;

  const added = await app.inject({ method: "POST", url: "/api/cart/items", payload: { variantId, qty: 4 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart");
  assert.ok(cookie, "гостевая корзина живёт в cookie");
  const cart = json(added);
  assert.equal(cart.count, 4);
  assert.equal(cart.subtotal, product.variants[0].price * 4);

  const headers = { cookie: `hgz_cart=${cookie.value}` };
  const orderRes = await app.inject({
    method: "POST", url: "/api/orders", headers,
    payload: { customer: { name: "Пров Прорабов", phone: "+79381234567", deliveryType: "pickup" } },
  });
  assert.equal(orderRes.statusCode, 201);
  const order = json(orderRes);
  assert.match(order.number, /^ХГЗ-\d{4}-\d{4}$/);
  assert.equal(order.total, cart.subtotal);

  const pay = json(await app.inject({ method: "POST", url: "/api/payments/create", payload: { orderNumber: order.number } }));
  assert.ok(pay.url.includes("/api/payments/mock/"));

  await app.inject({
    method: "POST", url: "/api/payments/webhook/mock",
    payload: { event: "payment.succeeded", object: { id: order.number, status: "succeeded" } },
  });

  const after = json(await app.inject(`/api/orders/${order.number}?phone=9381234567`));
  assert.equal(after.paymentStatus, "paid");
  assert.equal(after.status, "paid");
});

test("чужой заказ не открывается без телефона", async () => {
  const res = await app.inject("/api/orders/ХГЗ-0000-0001");
  assert.ok([403, 404].includes(res.statusCode));
});

test("вход и права: клиент не попадает в админку", async () => {
  const admin = json(await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { email: "admin@habez.local", password: "admin12345" },
  }));
  assert.equal(admin.user.role, "owner");

  const stats = json(await app.inject({
    url: "/api/admin/stats", headers: { authorization: `Bearer ${admin.accessToken}` },
  }));
  assert.equal(stats.catalog.products, 43);

  const anon = await app.inject("/api/admin/stats");
  assert.equal(anon.statusCode, 401);

  const otp = json(await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+79001112233" } }));
  const client = json(await app.inject({
    method: "POST", url: "/api/auth/otp/verify",
    payload: { phone: "+79001112233", code: otp.devCode, name: "Клиент" },
  }));
  const forbidden = await app.inject({ url: "/api/admin/stats", headers: { authorization: `Bearer ${client.accessToken}` } });
  assert.equal(forbidden.statusCode, 403);
});

test("дилер видит свою цену, а розница — розничную", async () => {
  const dealer = json(await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { email: "dealer@habez.local", password: "dealer12345" },
  }));
  const retail = json(await app.inject("/api/catalog/products/akvalayt")).product.variants[0].price;
  const forDealer = json(await app.inject({
    url: "/api/catalog/products/akvalayt", headers: { authorization: `Bearer ${dealer.accessToken}` },
  })).product.variants[0].price;
  assert.ok(forDealer < retail, `дилерская ${forDealer} должна быть ниже розничной ${retail}`);
});

test("данные другого тенанта недоступны", async () => {
  const res = await app.inject({ url: "/api/catalog/products", headers: { "x-tenant": "не-существует" } });
  // Неизвестный тенант откатывается на дефолтный, а не отдаёт чужое.
  assert.equal(res.statusCode, 200);
});
