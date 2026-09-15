// П-23: демо-пароли из README не работают на живом сервере.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

import { prodDataDir, prodEnv as prodEnvFor } from "./helpers/prod-env.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoData = prodDataDir("hgz-cred-demo-");
const prodData = prodDataDir("hgz-cred-prod-");
const dbDemo = demoData.db;
const dbProd = prodData.db;

const prodEnv = (file) => prodEnvFor(file === dbDemo ? demoData : prodData);

function fresh(file, demo) {
  for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: file, NODE_ENV: "test", LOG_LEVEL: "silent" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", ...(demo ? ["--demo-prices"] : [])], { cwd: apiRoot, env, stdio: "ignore" });
}

test("боевой сид не создаёт учётных записей", () => {
  fresh(dbProd, false);
  const n = execFileSync("sqlite3", [dbProd, "SELECT COUNT(*) FROM users"], { encoding: "utf8" }).trim();
  assert.equal(n, "0");
});

test("production с демо-записями в базе не стартует — войти известным паролем нельзя", () => {
  fresh(dbDemo, true);
  const r = spawnSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    await build();
  `], { cwd: apiRoot, encoding: "utf8", env: prodEnv(dbDemo) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /демо-учётные записи/);
  assert.match(r.stderr, /admin@habez.local/);
});

test("production с чистой базой стартует, демо-пароль не подходит", () => {
  const r = spawnSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "admin@habez.local", password: "admin12345" } });
    console.log(res.statusCode);
    await app.close();
  `], { cwd: apiRoot, encoding: "utf8", env: prodEnv(dbProd) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "401");
});

test("create-owner заводит владельца со случайным паролем, который печатается один раз", () => {
  const env = { ...process.env, DATABASE_FILE: dbProd, NODE_ENV: "test", LOG_LEVEL: "silent" };
  const out = execFileSync("node", ["src/db/create-owner.js", "owner@example.com"], { cwd: apiRoot, env, encoding: "utf8" });
  const password = out.match(/Пароль \(показывается один раз\): (\S+)/)?.[1];
  assert.ok(password && password.length >= 12);
  const r = spawnSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "owner@example.com", password: ${JSON.stringify(password)} } });
    console.log(res.statusCode, JSON.parse(res.body).user?.role);
    await app.close();
  `], { cwd: apiRoot, encoding: "utf8", env: prodEnv(dbProd) });
  assert.equal(r.stdout.trim(), "200 owner", r.stderr);
  assert.ok(!out.includes("admin12345"));
});
