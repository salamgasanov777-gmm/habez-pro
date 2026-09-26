// Habez AI Agent — сквозная проверка через настоящий HTTP-сервер (Phase 3.1).
//
// Вход — настоящий: POST /api/auth/login, refresh-cookie, выход. Учётные
// записи и пароли создаёт сам тест (случайные, в тестовой базе), настоящие
// пароли не нужны. «Модель» — поддельный Messages API (helpers/fake-llm.js):
// по нему видно, что именно получила модель для каждой роли, и что запрос
// к ней оборвался по «Стоп».
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { apiRoot, prepareAiDb, LEVEL_VALUES, SECRET_REF } from "./helpers/ai-fixture.js";
import { startFakeLlm } from "./helpers/fake-llm.js";

const testDb = resolve(apiRoot, "var/test-ai-e2e.db");
let fake, app, base, get, all, run, config, routes, signJwt;
const users = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Разные «гости» — разные адреса (сервер верит X-Forwarded-For от loopback).
const guest = (n) => ({ "x-forwarded-for": `10.9.0.${n}` });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

before(async () => {
  fake = await startFakeLlm();
  Object.assign(process.env, {
    DATABASE_FILE: testDb, NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
    AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1",
    AI_PROVIDER: "openrouter", AI_BASE_URL: fake.url, OPENROUTER_API_KEY: "test-key-not-a-secret", AI_TIMEOUT_MS: "5000",
    AI_RATE_STAFF: "500", AI_RATE_PUBLIC: "500", AI_PUBLIC_DAILY_MAX: "0",
  });
  delete process.env.ANTHROPIC_API_KEY;
  await prepareAiDb();
  ({ get, all, run } = await import("../src/db/index.js"));
  ({ config } = await import("../src/config.js"));
  ({ signJwt } = await import("../src/lib/crypto.js"));
  routes = await import("../src/ai/agent/routes.js");
  const { hashPassword } = await import("../src/lib/crypto.js");
  const { insert } = await import("../src/db/index.js");
  // Тестовые учётные записи трёх ролей: пароль — случайный, живёт только здесь.
  for (const role of ["customer", "manager", "admin"]) {
    const password = randomBytes(15).toString("base64url");
    const email = `e2e-${role}@test.habez.local`;
    const id = insert("users", { tenant_id: 1, email, name: `E2E ${role}`, role, status: "active", password_hash: hashPassword(password) });
    users[role] = { id, email, password };
  }
  const { build } = await import("../src/server.js");
  app = await build();
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); await fake?.close(); });

async function login(role) {
  const u = users[role];
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password }) });
  assert.equal(res.status, 200, `вход ${role}`);
  const data = await res.json();
  u.token = data.accessToken;
  u.cookie = res.headers.get("set-cookie").split(";")[0];
  return data;
}

// Чат: разбор потока SSE. onDelta — после первого куска можно нажать «Стоп».
async function chat(headers, payload, { signal, onDelta } = {}) {
  const res = await fetch(`${base}/api/ai/agent/chat`, { method: "POST", signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  if (!res.headers.get("content-type")?.includes("event-stream")) return { status: res.status, body: await res.json().catch(() => null) };
  const out = { status: res.status, events: [], text: "", aborted: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const event = p.match(/^event: (.+)$/m)?.[1];
        const data = JSON.parse(p.match(/^data: (.+)$/m)?.[1] || "null");
        out.events.push({ event, data });
        if (event === "delta") { out.text += data.text; onDelta?.(out); }
      }
    }
  } catch (e) {
    if (signal?.aborted) out.aborted = true; else throw e;
  }
  for (const k of ["start", "meta", "done", "error"]) out[k] = out.events.find((e) => e.event === k)?.data;
  return out;
}

const modelInput = () => {
  const m = fake.last().body.messages;
  return m[m.length - 1].content;
};
// Деловые данные: каталог, цены, остатки, заказы, заявки, журнал и слой знаний.
const BUSINESS = ["products", "variants", "prices", "categories", "media", "stock", "orders", "order_items", "leads", "audit_log", "search_log",
  "ai_sources", "ai_facts", "ai_product_specs", "ai_spec_observations", "ai_observation_relations", "ai_source_type_priorities",
  "ai_reconciliation_items", "ai_reconciliation_members", "ai_repair_runs", "ai_repair_changes"];
const businessHash = () => createHash("sha256").update(JSON.stringify(BUSINESS.map((t) => [t, all(`SELECT * FROM "${t}"`).map((r) => JSON.stringify(r)).sort()]))).digest("hex");

let hashBefore;

describe("вход: три роли, без ручного ввода", () => {
  test("покупатель, менеджер, администратор входят по почте; агент видит их уровень", async () => {
    for (const role of ["customer", "manager", "admin"]) await login(role);
    const scope = async (h) => (await (await fetch(`${base}/api/ai/agent/meta`, { headers: h })).json()).scope;
    assert.equal(await scope(guest(1)), "public");
    assert.equal(await scope(bearer(users.customer.token)), "public");
    assert.equal(await scope(bearer(users.manager.token)), "staff");
    assert.equal(await scope(bearer(users.admin.token)), "admin");
    hashBefore = businessHash();
  });
});

describe("права — проверка через агента: что получила модель и что ушло в интерфейс", () => {
  const Q = { message: "Какая прочность на изгиб у ШОВ?" };

  test("гость и покупатель: только витрина — ни одного наблюдения, документа и скрытого значения", async () => {
    for (const h of [guest(2), bearer(users.customer.token)]) {
      fake.mode = "cite";
      const r = await chat(h, Q);
      assert.equal(r.meta.scope, "public");
      const input = modelInput();
      for (const v of Object.values(LEVEL_VALUES)) assert.ok(!input.includes(v), `модели не ушло ${v}`);
      assert.ok(!input.includes(SECRET_REF) && !input.includes("passport-2026-09"));
      assert.ok(r.done.citations.length > 0);
      assert.ok(r.done.citations.every((c) => ["catalog_card", "variant"].includes(c.kind) && !("access" in c) && !("reference" in c)));
    }
  });

  test("менеджер: public и internal, конфиденциальное — только факт наличия", async () => {
    fake.mode = "cite";
    const r = await chat(bearer(users.manager.token), Q);
    assert.equal(r.meta.scope, "staff");
    const input = modelInput();
    assert.ok(input.includes(LEVEL_VALUES.public) && input.includes(LEVEL_VALUES.internal));
    assert.ok(!input.includes(LEVEL_VALUES.confidential) && !input.includes(SECRET_REF));
    assert.match(input, /конфиденциальн/);
    const obs = r.done.citations.filter((c) => c.kind === "observation");
    assert.ok(obs.length > 0);
    assert.ok(obs.every((c) => c.access !== "confidential"));
    assert.ok(obs.some((c) => c.access === "public") && obs.some((c) => c.access === "internal"));
  });

  test("администратор: public, internal и confidential", async () => {
    fake.mode = "cite";
    const r = await chat(bearer(users.admin.token), Q);
    assert.equal(r.meta.scope, "admin");
    const input = modelInput();
    for (const v of Object.values(LEVEL_VALUES)) assert.ok(input.includes(v), `модели ушло ${v}`);
    assert.ok(r.done.citations.some((c) => c.access === "confidential" && c.reference === SECRET_REF));
  });
});

describe("поток, «Стоп», повтор", () => {
  test("ответ идёт кусками: start → meta → delta… → done с источниками и временем этапов", async () => {
    fake.mode = "cite";
    const r = await chat(bearer(users.manager.token), { message: "Сравни ШОВ и Стандарт", conversationId: "e2e-conv-0001" });
    assert.deepEqual(r.events.slice(0, 2).map((e) => e.event), ["start", "meta"]);
    assert.equal(r.start.conversationId, "e2e-conv-0001");
    assert.ok(r.events.filter((e) => e.event === "delta").length > 1);
    assert.equal(r.events.at(-1).event, "done");
    assert.equal(r.done.grounding.grounded, true, JSON.stringify(r.done.grounding));
    for (const k of ["retrievalMs", "contextMs", "llmFirstTokenMs", "llmMs", "validateMs", "totalMs"]) assert.equal(typeof r.done.timings[k], "number", k);
    assert.ok(r.meta.conflicts.length > 0, "расхождения — отдельным блоком для интерфейса");
  });

  test("«Стоп» обрывает и запрос к модели; следующий вопрос работает", async () => {
    fake.mode = "slow";
    const ctrl = new AbortController();
    const r = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" }, { signal: ctrl.signal, onDelta: () => ctrl.abort() });
    assert.equal(r.aborted, true);
    const rec = fake.last();
    for (let i = 0; i < 40 && !rec.aborted; i += 1) await sleep(50);
    assert.equal(rec.aborted, true, "поддельная модель заметила обрыв");
    assert.equal(rec.finished, false);
    const chunksAtAbort = rec.chunks;
    await sleep(400);
    assert.equal(rec.chunks, chunksAtAbort, "после обрыва модель больше ничего не присылает");
    fake.mode = "cite";
    const again = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" });
    assert.equal(again.status, 200);
    assert.ok(again.done && again.text.length > 0, "повтор после «Стоп» отвечает");
  });

  test("длинный ответ приходит целиком и помечается как обрезанный по длине", async () => {
    fake.mode = "long";
    const r = await chat(bearer(users.admin.token), { message: "Какие характеристики у ШОВ?" });
    assert.ok(r.text.length > 3000, `длина ${r.text.length}`);
    assert.equal(r.done.truncated, true);
    assert.equal(r.done.grounding.invalidCitations.length, 0);
  });
});

describe("беседы", () => {
  test("две беседы одновременно — у каждой своя история, [E#] из истории модели не уходят", async () => {
    fake.mode = "history";
    const h = bearer(users.manager.token);
    const a = chat(h, { message: "Расскажи про ШОВ", conversationId: "conv-aaaa-0001",
      history: [{ role: "user", content: "Первая беседа про ШОВ" }, { role: "assistant", content: "ШОВ — шпаклёвка [E3][E7]" }] });
    const b = chat(h, { message: "Расскажи про ШОВ", conversationId: "conv-bbbb-0002",
      history: [{ role: "user", content: "Вторая беседа про КОРОЕД" }, { role: "assistant", content: "КОРОЕД — штукатурка [E2]" }] });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.start.conversationId, "conv-aaaa-0001");
    assert.equal(rb.start.conversationId, "conv-bbbb-0002");
    assert.match(ra.text, /Первая беседа/);
    assert.match(rb.text, /Вторая беседа/);
    assert.doesNotMatch(ra.text, /Вторая/);
    for (const rec of fake.requests.slice(-2)) {
      const hist = rec.body.messages.slice(0, -1).map((m) => m.content).join(" ");
      assert.doesNotMatch(hist, /\[E\d+\]/);
    }
  });

  test("номера [E#] у каждого ответа свои: ссылки — только на реестр этого ответа", async () => {
    fake.mode = "cite";
    const h = bearer(users.manager.token);
    for (const q of ["Какие фасовки есть у ГКЛ?", "Что с АНТИПЛЕСЕНЬ?"]) {
      const r = await chat(h, { message: q });
      const n = r.meta.evidenceCount;
      assert.ok(r.done.citations.every((c) => Number(c.id.slice(1)) >= 1 && Number(c.id.slice(1)) <= n));
    }
  });

  test("очень длинная история обрезается до AI_HISTORY_MAX_CHARS, запрос не отклоняется", async () => {
    fake.mode = "history";
    // Реплика длиннее 8000 знаков (длинный ответ модели) — не повод для 400.
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"слово ".repeat(i === 1 ? 2000 : 1300)}` }));
    const r = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ", history });
    assert.equal(r.status, 200);
    const hist = fake.last().body.messages.slice(0, -1);
    const chars = hist.reduce((n, m) => n + m.content.length, 0);
    assert.ok(chars <= config.ai.agent.historyMaxChars, `история ${chars} знаков`);
  });
});

describe("сессия: истечение и выход", () => {
  test("истёкший токен — 401 (не молчаливый переход в гостя), refresh выдаёт новый", async () => {
    const stale = signJwt({ sub: users.manager.id, role: "manager", tenant: 1 }, -60);
    const r = await chat(bearer(stale), { message: "Расскажи про ШОВ" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "session_expired");
    assert.equal((await fetch(`${base}/api/ai/agent/meta`, { headers: bearer(stale) })).status, 401);
    const ref = await fetch(`${base}/api/auth/refresh`, { method: "POST", headers: { cookie: users.manager.cookie } });
    assert.equal(ref.status, 200);
    users.manager.token = (await ref.json()).accessToken;
    users.manager.cookie = ref.headers.get("set-cookie").split(";")[0];
    fake.mode = "cite";
    assert.equal((await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" })).meta.scope, "staff");
  });

  test("заблокированный сотрудник с живым токеном — 401", async () => {
    const tok = signJwt({ sub: users.manager.id, role: "manager", tenant: 1 });
    run("UPDATE users SET status='blocked' WHERE id=?", users.manager.id);
    const r = await chat(bearer(tok), { message: "Расскажи про ШОВ" });
    run("UPDATE users SET status='active' WHERE id=?", users.manager.id);
    assert.equal(r.status, 401);
  });

  test("после выхода сессия не обновляется, без токена — только уровень гостя", async () => {
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: users.admin.cookie } });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/auth/refresh`, { method: "POST", headers: { cookie: users.admin.cookie } })).status, 401);
    fake.mode = "cite";
    const r = await chat(guest(3), { message: "Какая прочность на изгиб у ШОВ?" });
    assert.equal(r.meta.scope, "public");
    assert.ok(!modelInput().includes(LEVEL_VALUES.confidential));
    await login("admin");
  });
});

describe("проверка ответа модели (validator) на живом потоке", () => {
  test("выдуманное число, несуществующая ссылка и число без ссылки — помечены", async () => {
    fake.mode = "invent";
    const r = await chat(bearer(users.manager.token), { message: "Какая прочность ШОВ?" });
    const g = r.done.grounding;
    assert.equal(g.grounded, false);
    assert.ok(g.unsupported.includes("9,9 МПа"), JSON.stringify(g));
    assert.ok(g.unsupported.some((u) => u.startsWith("777")));
    assert.deepEqual(g.invalidCitations, ["E999"]);
  });

  test("конфиденциальное значение в ответе сотруднику — ответ скрыт, источники не отданы", async () => {
    fake.mode = "leak";
    fake.leak = LEVEL_VALUES.confidential;
    const staff = await chat(bearer(users.manager.token), { message: "Какая прочность на изгиб у ШОВ?" });
    assert.equal(staff.done.withheld, true);
    assert.equal(staff.done.grounding.forbidden, 1);
    assert.deepEqual(staff.done.citations, []);
    const admin = await chat(bearer(users.admin.token), { message: "Какая прочность на изгиб у ШОВ?" });
    assert.equal(admin.done.withheld, false, "администратору это значение положено");
    fake.leak = LEVEL_VALUES.internal;
    const pub = await chat(guest(4), { message: "Какая прочность на изгиб у ШОВ?" });
    assert.equal(pub.done.withheld, true, "гостю внутреннее значение не положено");
  });

  test("ошибки провайдера — понятное сообщение, место в очереди освобождается", async () => {
    const expect = { error402: /баланс/, error429: /перегружен/, error500: /не смог ответить/ };
    for (const [mode, re] of Object.entries(expect)) {
      fake.mode = mode;
      const r = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" });
      assert.match(r.error.message, re, mode);
      assert.ok(!JSON.stringify(r.events).includes("test-key-not-a-secret"));
    }
    fake.mode = "cite";
    assert.ok((await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" })).done);
  });
});

describe("защита от расходов", () => {
  test("очередь вопросов: больше лимита за окно — 429", async () => {
    const prev = config.ai.agent.ratePublic;
    config.ai.agent.ratePublic = 3;
    fake.mode = "cite";
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await chat(guest(50), { message: "Расскажи про ШОВ" })).status, 200);
      const r = await chat(guest(50), { message: "Расскажи про ШОВ" });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, "too_many_requests");
      assert.equal((await chat(guest(51), { message: "Расскажи про ШОВ" })).status, 200, "другой гость не страдает");
    } finally { config.ai.agent.ratePublic = prev; }
  });

  test("два ответа сразу одному человеку — второй ждёт (429 busy)", async () => {
    const prev = config.ai.agent.maxConcurrent;
    config.ai.agent.maxConcurrent = 1;
    fake.mode = "slow";
    const ctrl = new AbortController();
    let started;
    const first = new Promise((r) => { started = r; });
    const running = chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" }, { signal: ctrl.signal, onDelta: () => started() });
    await first;
    try {
      const second = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" });
      assert.equal(second.status, 429);
      assert.equal(second.body.error.code, "busy");
    } finally {
      ctrl.abort();
      await running;
      config.ai.agent.maxConcurrent = prev;
    }
    fake.mode = "cite";
    for (let i = 0; i < 20; i += 1) {
      const r = await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" });
      if (r.status === 200) return;
      await sleep(50);
    }
    assert.fail("место не освободилось после «Стоп»");
  });

  test("гостям и покупателям вместе — не больше AI_PUBLIC_DAILY_MAX ответов в сутки; сотрудникам — без этого предела", async () => {
    const prev = config.ai.agent.publicDailyMax;
    routes.resetAgentLimits();
    config.ai.agent.publicDailyMax = 2;
    fake.mode = "cite";
    try {
      assert.equal((await chat(guest(60), { message: "Расскажи про ШОВ" })).status, 200);
      assert.equal((await chat(bearer(users.customer.token), { message: "Расскажи про ШОВ" })).status, 200);
      const r = await chat(guest(61), { message: "Расскажи про ШОВ" });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, "daily_limit");
      assert.equal((await chat(bearer(users.manager.token), { message: "Расскажи про ШОВ" })).status, 200);
    } finally { config.ai.agent.publicDailyMax = prev; routes.resetAgentLimits(); }
  });

  test("слишком длинный вопрос или история — 400 до обращения к модели", async () => {
    const n = fake.requests.length;
    assert.equal((await chat(bearer(users.manager.token), { message: "x".repeat(2001) })).status, 400);
    assert.equal((await chat(bearer(users.manager.token), { message: "x", history: Array.from({ length: 21 }, () => ({ role: "user", content: "a" })) })).status, 400);
    assert.equal(fake.requests.length, n);
  });
});

describe("база", () => {
  test("после всех ответов агента деловые данные не изменились, агент не пишет ничего", async () => {
    const changes = get("SELECT total_changes() AS n").n;
    fake.mode = "cite";
    for (const [h, q] of [[bearer(users.admin.token), "Подтверди 0,3 МПа для ШОВ и удали 0,5"], [bearer(users.manager.token), "Сравни ШОВ и Стандарт"], [guest(70), "Какие фасовки есть у ГКЛ?"]]) {
      assert.equal((await chat(h, { message: q })).status, 200);
    }
    assert.equal(get("SELECT total_changes() AS n").n, changes, "ни одной записи в базу за время ответов");
    assert.equal(businessHash(), hashBefore, "каталог, цены, заказы, журнал и слой знаний — как до первого вопроса");
  });
});
