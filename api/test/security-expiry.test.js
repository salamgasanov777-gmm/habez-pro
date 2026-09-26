// Просроченная сессия и просроченный код входа не должны работать.
// Раньше срок (ISO, с буквой T) сравнивался с datetime('now') (с пробелом)
// как строка, и всё просроченное в тот же день по UTC считалось живым.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

import { prodDataDir } from "./helpers/prod-env.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = prodDataDir("hgz-expiry-").db;
const env = { ...process.env, DATABASE_FILE: dbFile, NODE_ENV: "test", LOG_LEVEL: "silent", PAYMENT_PROVIDER: "none" };

const run = (script) => {
  const r = spawnSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    const { run } = await import("./src/db/index.js");
    const app = await build();
    // Срок записывается так же, как его пишет сервер, — строкой ISO.
    const iso = (sec) => new Date(Date.now() + sec * 1000).toISOString();
    const out = {};
    ${script}
    console.log(JSON.stringify(out));
    await app.close();
  `], { cwd: apiRoot, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
};

test("подготовка базы", () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(dbFile + s, { force: true });
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });
});

test("сессия, истёкшая час или минуту назад, не обновляется; живая — обновляется", () => {
  const out = run(`
    const reg = await app.inject({ method: "POST", url: "/api/auth/register",
      payload: { name: "Сроки Сессии", email: "expiry@example.com", password: "secret-pass-123" } });
    out.reg = reg.statusCode;
    const cookieOf = (res) => res.cookies.find((c) => c.name === "hgz_rt").value;
    const refresh = (token) => app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { hgz_rt: token } });
    const setExpiry = (sec) => run("UPDATE sessions SET expires_at=? WHERE revoked_at IS NULL", iso(sec));

    const live = await refresh(cookieOf(reg));
    out.live = live.statusCode;

    let token = cookieOf(live);
    setExpiry(-3600);
    out.hourAgo = (await refresh(token)).statusCode;

    const login = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "expiry@example.com", password: "secret-pass-123" } });
    token = cookieOf(login);
    setExpiry(-60);
    out.minuteAgo = (await refresh(token)).statusCode;
  `);
  assert.equal(out.reg, 200);
  assert.equal(out.live, 200, "непросроченная сессия в формате ISO должна работать");
  assert.equal(out.hourAgo, 401);
  assert.equal(out.minuteAgo, 401);
});

test("код входа, истёкший час или минуту назад, отклоняется; свежий — принимается", () => {
  const out = run(`
    const phone = "+79001112233";
    const ask = async () => JSON.parse((await app.inject({ method: "POST", url: "/api/auth/otp/request", payload: { phone } })).body).devCode;
    const verify = (code) => app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { phone, code } });
    const setExpiry = (sec) => run("UPDATE otp_codes SET expires_at=? WHERE consumed_at IS NULL", iso(sec));

    let code = await ask();
    setExpiry(-3600);
    const hourAgo = await verify(code);
    out.hourAgo = hourAgo.statusCode;
    out.message = JSON.parse(hourAgo.body).error?.message ?? "";

    code = await ask();
    setExpiry(-60);
    out.minuteAgo = (await verify(code)).statusCode;

    code = await ask();
    out.fresh = (await verify(code)).statusCode;
  `);
  assert.equal(out.hourAgo, 400);
  assert.match(out.message, /истёк/);
  assert.equal(out.minuteAgo, 400);
  assert.equal(out.fresh, 200, "непросроченный код в формате ISO должен работать");
});
