// Push-уведомления менеджерам: устройство подписывается, приходит заказ —
// на адрес устройства уходит зашифрованное сообщение.
//
// Службу доставки браузера заменяет крошечный локальный сервер: он
// принимает то, что отправил наш сервер, и запоминает. Так проверяется
// вся цепочка без настоящего телефона.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import webpush from "web-push";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-push.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "mock";
process.env.LOG_LEVEL = "silent";
// Свои ключи, чтобы тест не создавал var/vapid.json рядом с рабочей базой.
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
// Служба доставки принимает только HTTPS. Сертификат у нас самодельный —
// на время теста разрешаем его; на рабочий сервер это не влияет.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let app, inbox, inboxUrl, token;
const received = [];

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();

  // «Служба доставки»: /ok принимает, /gone отвечает 410 — подписка протухла.
  const certDir = mkdtempSync(resolve(tmpdir(), "hgz-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", resolve(certDir, "key.pem"), "-out", resolve(certDir, "cert.pem")], { stdio: "ignore" });
  const tls = { key: readFileSync(resolve(certDir, "key.pem")), cert: readFileSync(resolve(certDir, "cert.pem")) };
  inbox = createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
      if (req.url.startsWith("/gone")) { res.statusCode = 410; res.end(); return; }
      res.statusCode = 201; res.end();
    });
  });
  await new Promise((r) => inbox.listen(0, "127.0.0.1", r));
  inboxUrl = `https://127.0.0.1:${inbox.address().port}`;

  const login = JSON.parse((await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { email: "admin@habez.local", password: "admin12345" },
  })).body);
  token = login.accessToken;
});

after(async () => {
  await app?.close();
  inbox?.close();
});

const json = (res) => JSON.parse(res.body);
const auth = () => ({ authorization: `Bearer ${token}` });

// Ключи устройства: настоящая пара на кривой P-256, как делает браузер.
function deviceKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

test("клиенту push недоступен, менеджеру — доступен", async () => {
  assert.equal((await app.inject("/api/push/key")).statusCode, 401);
  const key = json(await app.inject({ url: "/api/push/key", headers: auth() }));
  assert.equal(key.publicKey, vapid.publicKey);
});

test("подписанное устройство получает заказ", async () => {
  const sub = await app.inject({
    method: "POST", url: "/api/push/subscribe", headers: auth(),
    payload: { endpoint: `${inboxUrl}/ok/device-1`, keys: deviceKeys() },
  });
  assert.equal(sub.statusCode, 200);
  assert.equal(json(await app.inject({ url: "/api/push/devices", headers: auth() })).devices, 1);

  // Пробное сообщение — кнопка «Проверить».
  const t = json(await app.inject({ method: "POST", url: "/api/push/test", headers: auth(), payload: {} }));
  assert.equal(t.sent, 1);

  // Настоящий заказ от гостя.
  const product = json(await app.inject("/api/catalog/products/pobeda80")).product;
  const added = await app.inject({ method: "POST", url: "/api/cart/items", payload: { variantId: product.variants[0].id, qty: 2 } });
  const cookie = added.cookies.find((c) => c.name === "hgz_cart");
  const before = received.length;
  const order = await app.inject({
    method: "POST", url: "/api/orders", headers: { cookie: `hgz_cart=${cookie.value}` },
    payload: { customer: { name: "Пров Прорабов", phone: "+79381234567", deliveryType: "pickup" } },
  });
  assert.equal(order.statusCode, 201);

  const delivered = received.slice(before).filter((r) => r.path === "/ok/device-1");
  assert.equal(delivered.length, 1, "заказ ушёл на устройство ровно один раз");
  assert.equal(delivered[0].headers["content-encoding"], "aes128gcm", "сообщение зашифровано, как требует стандарт");
  assert.ok(delivered[0].headers.authorization?.startsWith("vapid "), "подписано нашим ключом");
  assert.ok(delivered[0].bytes > 50, "внутри есть текст заказа");
});

test("протухшая подписка удаляется сама", async () => {
  await app.inject({
    method: "POST", url: "/api/push/subscribe", headers: auth(),
    payload: { endpoint: `${inboxUrl}/gone/device-2`, keys: deviceKeys() },
  });
  assert.equal(json(await app.inject({ url: "/api/push/devices", headers: auth() })).devices, 2);

  await app.inject({ method: "POST", url: "/api/push/test", headers: auth(), payload: {} });
  assert.equal(json(await app.inject({ url: "/api/push/devices", headers: auth() })).devices, 1, "устройство с 410 убрано");
});

test("отписка убирает устройство", async () => {
  await app.inject({ method: "DELETE", url: "/api/push/subscribe", headers: auth(), payload: { endpoint: `${inboxUrl}/ok/device-1` } });
  assert.equal(json(await app.inject({ url: "/api/push/devices", headers: auth() })).devices, 0);
});
