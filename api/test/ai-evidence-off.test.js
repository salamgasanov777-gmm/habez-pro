// Модель наблюдений включается отдельно (AI_EVIDENCE_ENABLED). Пока она
// выключена, её маршрутов нет, а старый путь ai_product_specs работает.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-evidence-off.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";
delete process.env.AI_EVIDENCE_ENABLED;
// Режим чтения evidence без включённой модели — не действует.
process.env.AI_EVIDENCE_READ_MODE = "evidence";

let app, headers;
before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb, AI_EVIDENCE_ENABLED: "0" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });
  process.env.AI_EVIDENCE_ENABLED = "0";
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@habez.local", password: "admin12345" } });
  headers = { authorization: `Bearer ${JSON.parse(res.body).accessToken}` };
});
after(async () => { await app?.close(); });

test("без AI_EVIDENCE_ENABLED маршрутов наблюдений нет, старые работают", async () => {
  for (const url of ["/api/ai/observations", "/api/ai/evidence/meta", "/api/ai/products/1/evidence"]) {
    assert.equal((await app.inject({ url, headers })).statusCode, 404, url);
  }
  for (const url of ["/api/ai/specs", "/api/ai/products", "/api/ai/products/1/intelligence"]) {
    assert.equal((await app.inject({ url, headers })).statusCode, 200, url);
  }
});

test("режим evidence без AI_EVIDENCE_ENABLED не действует: ответы старых маршрутов прежние", async () => {
  const { all } = await import("../src/db/index.js");
  const { config } = await import("../src/config.js");
  assert.equal(config.ai.readMode, "legacy");
  const list = JSON.parse((await app.inject({ url: "/api/ai/specs?limit=300", headers })).body);
  const rows = new Map(all("SELECT id, display_value, value_num, value_min, verification_status FROM ai_product_specs").map((r) => [r.id, r]));
  assert.ok(list.items.length > 0);
  for (const it of list.items) {
    assert.ok(!("evidence" in it), "блока evidence нет");
    const r = rows.get(it.id);
    assert.equal(it.displayValue, r.display_value);
    assert.equal(it.value.num, r.value_num);
    assert.equal(it.value.min, r.value_min);
    assert.equal(it.verificationStatus, r.verification_status);
  }
  const intel = JSON.parse((await app.inject({ url: "/api/ai/products/1/intelligence", headers })).body);
  assert.ok(!("evidence" in intel));
  assert.deepEqual(Object.keys(intel).sort(), ["groups", "product", "specs", "stats", "variants"]);
});
