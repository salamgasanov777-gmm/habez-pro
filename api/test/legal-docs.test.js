// П-45: места под оферту, доставку и возврат. Текст пишет завод; пока его
// нет — документа нет нигде, и ни к чему он покупателя не обязывает.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-legal.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";

let app, owner, customer;
const json = (res) => JSON.parse(res.body);

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  owner = json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@habez.local", password: "admin12345" } }));
  const otp = json(await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+79005550077" } }));
  customer = json(await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { phone: "+79005550077", code: otp.devCode } }));
});
after(async () => { await app?.close(); });

test("пока текстов нет — документов нет: ни в meta, ни по адресу", async () => {
  const meta = json(await app.inject("/api/catalog/meta"));
  assert.deepEqual(meta.settings.legalDocs, []);
  for (const k of ["offer", "delivery", "refund", "whatever"]) {
    assert.equal((await app.inject(`/api/catalog/legal/${k}`)).statusCode, 404, k);
  }
});

test("публиковать документы может только админ, и только текст", async () => {
  const asCustomer = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { authorization: `Bearer ${customer.accessToken}` },
    payload: { settings: { legal: { offer: "текст" } } } });
  assert.equal(asCustomer.statusCode, 403);
  const tooLong = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { settings: { legal: { offer: "x".repeat(60001) } } } });
  assert.equal(tooLong.statusCode, 400);
  const wrongType = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { settings: { legal: { offer: { html: "<b>x</b>" } } } } });
  assert.equal(wrongType.statusCode, 400);
});

test("опубликованный текст появляется на витрине как есть, с датой редакции", async () => {
  const text = "1. Общие положения\n\nТекст, который предоставил завод.\n\n2. Доставка\n\nСогласно договору.";
  const res = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { authorization: `Bearer ${owner.accessToken}` },
    payload: { settings: { legal: { offer: text, delivery: "", refund: "   " } } } });
  assert.equal(res.statusCode, 200);

  const meta = json(await app.inject("/api/catalog/meta"));
  assert.deepEqual(meta.settings.legalDocs, ["offer"], "пустые и пробельные документы не считаются опубликованными");
  const doc = json(await app.inject("/api/catalog/legal/offer"));
  assert.equal(doc.title, "Публичная оферта");
  assert.equal(doc.text, text);
  assert.match(doc.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await app.inject("/api/catalog/legal/delivery")).statusCode, 404);
  // Публикация записана в журнал.
  const { get } = await import("../src/db/index.js");
  assert.ok(get("SELECT id FROM audit_log WHERE action='settings.update' AND actor_id=?", owner.user.id));
});
