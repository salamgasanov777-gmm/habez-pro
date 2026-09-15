// П-1: пока SMS не отправляется, входа по телефону на живом сайте нет —
// ни кнопки на витрине, ни маршрутов. Вход по почте работает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = resolve(apiRoot, "var/test-phone-login.db");

const inProd = (script, extra = {}) => spawnSync("node", ["--input-type=module", "-e", script], {
  cwd: apiRoot, encoding: "utf8",
  env: { ...process.env, DATABASE_FILE: dbFile, NODE_ENV: "production", LOG_LEVEL: "silent",
    JWT_SECRET: "x".repeat(64), PAYMENT_PROVIDER: "none", SMS_PROVIDER: "log", ...extra },
});

test("production без SMS-провайдера: витрина не предлагает вход по телефону, маршруты отвечают 503", () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(dbFile + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: dbFile, NODE_ENV: "test", LOG_LEVEL: "silent" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });

  const r = inProd(`
    const { build } = await import("./src/server.js");
    const app = await build();
    const meta = JSON.parse((await app.inject("/api/catalog/meta")).body);
    const req = await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+79001234567" } });
    const ver = await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { phone: "+79001234567", code: "123456" } });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register",
      payload: { name: "Почтовый Клиент", email: "client@example.com", password: "secret-pass-123" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "client@example.com", password: "secret-pass-123" } });
    console.log(JSON.stringify({ phoneLogin: meta.settings.phoneLogin, req: req.statusCode, ver: ver.statusCode, reg: reg.statusCode, login: login.statusCode }));
    await app.close();
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.phoneLogin, false);
  assert.equal(out.req, 503);
  assert.equal(out.ver, 503);
  assert.equal(out.reg, 200, "вход по почте — рабочий временный механизм");
  assert.equal(out.login, 200);
});

test("вне production вход по коду доступен (код возвращается для разработки и тестов)", () => {
  const r = spawnSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    const app = await build();
    const meta = JSON.parse((await app.inject("/api/catalog/meta")).body);
    const req = JSON.parse((await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone: "+79001234568" } })).body);
    console.log(JSON.stringify({ phoneLogin: meta.settings.phoneLogin, dev: /^\\d{6}$/.test(req.devCode || "") }));
    await app.close();
  `], { cwd: apiRoot, encoding: "utf8", env: { ...process.env, DATABASE_FILE: dbFile, NODE_ENV: "test", LOG_LEVEL: "silent", PAYMENT_PROVIDER: "none" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { phoneLogin: true, dev: true });
});
