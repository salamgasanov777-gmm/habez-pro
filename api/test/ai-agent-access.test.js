// Habez AI Agent: доступ, когда агент не включён покупателям
// (AI_AGENT_PUBLIC=0, по умолчанию). Сотрудникам — работает.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-agent-access.db");
Object.assign(process.env, {
  DATABASE_FILE: testDb, NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "0", AI_PROVIDER: "mock",
});

let app, tok;
before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env: process.env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env: process.env, stdio: "ignore" });
  const { get, insert } = await import("../src/db/index.js");
  const { signJwt } = await import("../src/lib/crypto.js");
  tok = (role) => {
    const id = get("SELECT id FROM users WHERE role=? LIMIT 1", role)?.id ?? insert("users", { tenant_id: 1, email: `${role}-acc@habez.local`, role, status: "active" });
    return { authorization: `Bearer ${signJwt({ sub: id, role, tenant: 1 })}` };
  };
  ({ build: app } = await import("../src/server.js"));
  app = await app();
});
after(async () => { await app?.close(); });

test("без AI_AGENT_PUBLIC: гость 401, покупатель 403, сотрудник 200", async () => {
  const chat = (headers) => app.inject({ method: "POST", url: "/api/ai/agent/chat", headers, payload: { message: "Расскажи про ШОВ" } });
  assert.equal((await chat({})).statusCode, 401);
  assert.equal((await chat(tok("customer"))).statusCode, 403);
  assert.equal((await chat(tok("manager"))).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/ai/agent/meta" })).statusCode, 401);
  const meta = JSON.parse((await app.inject({ url: "/api/catalog/meta" })).body);
  assert.equal(meta.settings.aiAgent, true);
  assert.equal(meta.settings.aiAgentPublic, false, "на витрине ссылки нет");
});

test("без ключа модели сотрудник получает понятный 503, а не падение", async () => {
  const { config } = await import("../src/config.js");
  const prev = config.ai.agent.provider;
  config.ai.agent.provider = "openrouter";
  config.ai.agent.apiKey = "";
  const res = await app.inject({ method: "POST", url: "/api/ai/agent/chat", headers: tok("manager"), payload: { message: "Расскажи про ШОВ" } });
  config.ai.agent.provider = prev;
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /не настроено подключение/);
});
