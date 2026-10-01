// Phase 4.1: контракт реестра обработчиков. Поведение ассистента
// проверяет эталон (ai-routing-golden*.test.js); здесь — устройство, и по
// возможности наблюдаемо, а не повтором массивов реестра:
//   - какие поля t пишут домены — узнаём, запуская ассистент на наборе
//     вопросов, и проверяем, что agent.js не знает ни их, ни имён доменов;
//   - этапы: when не меняет t, этап выполняется не больше раза, после
//     решившего этапа режим и готовый ответ никто не меняет;
//   - синтетический домен test-domain со своими данными, метрикой, ссылкой
//     [E#] и полем состояния подключается и снимается только реестром.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-registry.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

// База — до импорта модулей ассистента (они открывают её при загрузке).
await prepareAiDb();
await (await import("./helpers/competitor-fixture.js")).seedCompetitors();

const AGENT = resolve(apiRoot, "src/ai/agent/runtime/agent.js");
const HANDLERS = resolve(apiRoot, "src/ai/agent/runtime/handlers.js");
const H = await import("../src/ai/agent/runtime/handlers.js");
const R = await import("../src/ai/agent/retrieval/router.js");
const B = await import("../src/ai/agent/runtime/base-handlers.js");
const { runAgent } = await import("../src/ai/agent/runtime/agent.js");
const mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
const { z } = await import("zod");

const REGISTRIES = () => ({ STAGES: H.STAGES, CHECKS: H.CHECKS, DIGESTS: H.DIGESTS, OUTPUTS: H.OUTPUTS, LOOKUPS: H.LOOKUPS, DOMAIN_ROUTES: R.DOMAIN_ROUTES });
const baseEntries = new Set(Object.values(B));
// Домен — запись реестра не из базовых этапов 3.2/3.3 и не общая проверка
// ответа или политика (слой common / policy, Phase 4.2).
const isBase = (e) => baseEntries.has(e) || ["common", "policy"].includes(e.layer);
const domainEntries = () => Object.values(REGISTRIES()).flat().filter((e) => !isBase(e));
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const importsOf = (file) => [...readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)].map((m) => resolve(dirname(file), m[1]));

// Прогон ассистента по вопросам эталона с наблюдением за этапами.
async function observeStages(scopes = ["staff", "public"]) {
  const { goldenCases } = await import("./helpers/routing-golden.js");
  const writes = new Map(H.STAGES.map((s) => [s, new Set()]));
  const problems = [];
  const original = [...H.STAGES];
  H.STAGES.splice(0, H.STAGES.length, ...original.map((s) => ({
    ...s,
    when(t) {
      const pure = new Proxy(t, { set: (_, k) => { problems.push(`${s.id}.when пишет ${String(k)}`); return true; } });
      return s.when(pure);
    },
    run(t) {
      const seen = (t.__ran ??= []);
      if (seen.includes(s.id)) problems.push(`${s.id} выполнен дважды`);
      seen.push(s.id);
      const before = { mode: t.mode, fixed: t.fixed, clarification: t.clarification };
      s.run(new Proxy(t, { set: (o, k, v) => { writes.get(s).add(k); o[k] = v; return true; } }));
      if (before.mode && (t.mode !== before.mode || t.fixed !== before.fixed || t.clarification !== before.clarification)) problems.push(`${s.id} изменил решение «${before.mode}» → «${t.mode}» (${t.q})`);
    },
  })));
  let turns = 0;
  try {
    for (const c of goldenCases()) for (const scope of scopes) {
      let state = {}; let refBase = 0; const history = [];
      for (const q of c.turns) {
        const r = await runAgent({ tenantId: 1, scope, question: q, history, state, refBase, provider: mock });
        history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
        state = r.state; refBase = r.refBase + r.context.evidence.length; turns += 1;
      }
    }
  } finally { H.STAGES.splice(0, H.STAGES.length, ...original); }
  return { writes, problems, turns };
}

// Поля t, которые пишут только домены (а базовые этапы — нет).
function domainFields(writes) {
  const base = new Set([...writes].filter(([s]) => baseEntries.has(s)).flatMap(([, w]) => [...w]));
  return [...new Set([...writes].filter(([s]) => !baseEntries.has(s)).flatMap(([, w]) => [...w]))].filter((k) => !base.has(k) && k !== "__ran");
}

// Утечки доменов в agent.js: имена доменов (id, camelCase), их поля t,
// прямые импорты модулей доменов. Функция чистая — ей можно дать и
// испорченный текст (см. тест «проверка ловит нарушение»).
function domainLeaks(src, { ids, fields, domainDirs }) {
  const leaks = [];
  const text = src.toLowerCase();
  for (const id of ids) for (const tok of new Set([id, camel(id)])) if (text.includes(tok.toLowerCase())) leaks.push(`имя домена «${tok}»`);
  for (const f of fields) if (new RegExp(`(?<![\\w$])${f}(?![\\w$])`).test(src)) leaks.push(`поле домена t.${f}`);
  for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
    const target = resolve(dirname(AGENT), m[1]);
    if (domainDirs.some((d) => target.startsWith(`${d}/`))) leaks.push(`импорт модуля домена ${relative(apiRoot, target)}`);
  }
  return leaks;
}
// Папки модулей доменов — где лежат модули, из которых реестры берут записи
// доменов (импорты handlers.js и реестра проверок checks/registry.js).
const REGISTRY_FILES = [HANDLERS, resolve(apiRoot, "src/ai/agent/checks/registry.js")];
async function domainDirsOf() {
  const domain = new Set(domainEntries());
  const dirs = new Set();
  for (const file of REGISTRY_FILES.flatMap(importsOf)) if (Object.values(await import(file)).some((v) => domain.has(v))) dirs.add(dirname(file));
  return [...dirs];
}
let dirsCache;
const domainDirs = async () => (dirsCache ??= await domainDirsOf());

let observed;
const observe = async () => (observed ??= await observeStages());

test("реестры: у каждой записи есть id и обязательные методы, id в реестре не повторяются", () => {
  const need = { STAGES: ["when", "run"], CHECKS: ["run", "report"], DIGESTS: ["lines"], OUTPUTS: [], LOOKUPS: ["load"], DOMAIN_ROUTES: ["detect", "apply"] };
  const optional = { OUTPUTS: ["meta", "result", "metrics", "refs", "state"] };
  for (const [name, list] of Object.entries(REGISTRIES())) {
    assert.ok(list.length > 0, name);
    for (const e of list) {
      assert.equal(typeof e.id, "string", `${name}: id`);
      for (const m of need[name]) assert.equal(typeof e[m], "function", `${name}.${e.id}.${m}`);
      for (const m of optional[name] || []) assert.ok(e[m] === undefined || typeof e[m] === "function", `${name}.${e.id}.${m}`);
    }
    assert.equal(new Set(list.map((e) => e.id)).size, list.length, `${name}: id не повторяются`);
  }
});

// Приоритет закреплён намеренно: изменить его — отдельное решение с новым
// эталоном. Поведение приоритета проверяет эталон и тест ниже.
test("приоритет: порядок этапов, проверок, доменов маршрута — как до 4.1", () => {
  assert.deepEqual(H.STAGES.map((s) => s.id), ["competitor", "resolution", "criteria", "factory", "intel", "profile-factory", "unknown-notes", "plan", "application-search"]);
  // Проверки ответа: порядок — порядок полей grounding в ответе API (4.2).
  assert.deepEqual(H.CHECKS.map((c) => c.id), ["numbers", "citations", "forbidden", "products", "suitability-status", "empty-answer", "factory", "dates", "competitor"]);
  assert.deepEqual(R.DOMAIN_ROUTES.map((d) => d.id), ["competitor", "factory"]);
});

test("приоритет наблюдаемо: вопрос о конкуренте со словами о заводе уходит конкурентам", async () => {
  const r = await runAgent({ tenantId: 1, scope: "staff", question: "Что производит ТестСмесь?", provider: mock });
  assert.match(r.intent, /^competitor_/);
  assert.ok(r.competitor, "ответ собран доменом конкурентов");
  assert.equal(r.factory, null);
});

test("этапы на всех вопросах эталона: when не меняет t, этап — не больше раза, решение первого этапа никто не меняет", async () => {
  const { problems, turns } = await observe();
  assert.ok(turns > 300, `прогон: ${turns} реплик`);
  assert.deepEqual(problems, []);
});

test("вывод доменов: методы дают объекты, поля разных доменов не пересекаются", async () => {
  const { createBundle } = await import("../src/ai/agent/runtime/bundle.js");
  const t = H.createTurn({ tenantId: 1, scope: "staff", q: "", state: {}, catalog: [], route: R.routeQuestion("", { catalog: [], state: {} }), bundle: createBundle({ scope: "staff" }), lookups: H.loadLookups({ tenantId: 1, scope: "staff" }).data });
  for (const part of ["meta", "result", "metrics"]) {
    const owner = new Map();
    for (const o of H.OUTPUTS) {
      if (!o[part]) continue;
      const v = o[part](t);
      assert.ok(v && typeof v === "object" && !Array.isArray(v), `${o.id}.${part}`);
      for (const k of Object.keys(v)) { assert.ok(!owner.has(k), `${part}.${k}: ${owner.get(k)} и ${o.id}`); owner.set(k, o.id); }
      if (part === "metrics") for (const x of Object.values(v)) assert.equal(typeof x, "number", `${o.id}.metrics`);
    }
  }
  for (const o of H.OUTPUTS) {
    if (o.refs) assert.ok(Array.isArray(o.refs(t)), `${o.id}.refs`);
    if (o.state) assert.ok(o.state(t) && typeof o.state(t) === "object", `${o.id}.state`);
  }
});

test("agent.js не знает доменов: ни имён, ни их полей t, ни импортов их модулей", async () => {
  const { writes } = await observe();
  const fields = domainFields(writes);
  // Наблюдение что-то нашло — иначе проверка ниже была бы пустой.
  for (const f of ["comp", "factory", "intel", "profileFactory"]) assert.ok(fields.includes(f), `домен пишет t.${f}`);
  const ids = [...new Set(domainEntries().map((e) => e.id))];
  assert.deepEqual(domainLeaks(readFileSync(AGENT, "utf8"), { ids, fields, domainDirs: await domainDirs() }), []);
});

test("проверка ловит нарушение: доменная ветка, поле или импорт в agent.js", async () => {
  const { writes } = await observe();
  const opts = { ids: [...new Set(domainEntries().map((e) => e.id))], fields: domainFields(writes), domainDirs: await domainDirs() };
  const src = readFileSync(AGENT, "utf8");
  for (const bad of ["    competitor: t.comp?.competitor || null,", "  const x = t.intel?.profile;", "import { runFactory } from \"../factory/run.js\";", "  if (route.intent === \"factory_lookup\") {}"]) {
    assert.ok(domainLeaks(`${src}\n${bad}\n`, opts).length > 0, bad);
  }
});

// Синтетический домен: свои данные (meta и ответ), метрика, ссылка [E#] в
// таблице источников, поле состояния беседы. Регистрация — только в реестре.
function testDomain() {
  const stage = {
    id: "test-domain",
    when: (t) => !t.mode && /тестовый домен/i.test(t.q),
    run(t) {
      const ref = t.bundle.record({ label: "Тестовый домен", value: "синтетическая запись" });
      t.testDomain = { ref, record: "record-1" };
      t.mode = "TEST_DOMAIN";
      t.fixed = "Ответ тестового домена.";
    },
  };
  const output = {
    id: "test-domain",
    meta: (t) => ({ testDomain: t.testDomain ? { record: t.testDomain.record } : null }),
    result: (t) => ({ testDomain: t.testDomain || null }),
    metrics: (t) => ({ test_domain_ms: t.testDomain ? 1 : 0 }),
    refs: (t) => (t.testDomain ? [t.testDomain.ref] : []),
    state: (t) => ({ fields: t.testDomain ? { current_test_domain: t.testDomain.record } : {} }),
  };
  return {
    register() { H.STAGES.unshift(stage); H.OUTPUTS.push(output); R.STATE_FIELDS.current_test_domain = z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().optional(); },
    unregister() { H.STAGES.splice(H.STAGES.indexOf(stage), 1); H.OUTPUTS.splice(H.OUTPUTS.indexOf(output), 1); delete R.STATE_FIELDS.current_test_domain; },
  };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function ask(question, state = {}) {
  const events = [];
  const r = await runAgent({ tenantId: 1, scope: "staff", question, state, provider: mock, onEvent: (type, data) => events.push([type, data]) });
  return { r, meta: events.find(([type]) => type === "meta")[1] };
}

test("новый домен подключается регистрацией: данные, метрика, ссылка [E#], состояние — через общий сборщик", async () => {
  const agentBefore = sha(readFileSync(AGENT, "utf8"));
  const d = testDomain();
  d.register();
  try {
    const { r, meta } = await ask("Расскажи про тестовый домен");
    assert.equal(r.mode, "TEST_DOMAIN");
    assert.equal(r.answer, "Ответ тестового домена.");
    assert.deepEqual(r.testDomain, { ref: r.testDomain.ref, record: "record-1" });
    assert.deepEqual(meta.testDomain, { record: "record-1" });
    assert.equal(r.metrics.test_domain_ms, 1);
    assert.ok(r.citations.some((c) => c.id === r.testDomain.ref), "ссылка домена — в источниках ответа");
    assert.equal(r.state.current_test_domain, "record-1");
    assert.doesNotThrow(() => R.stateSchema.parse(r.state), "поле домена принимает схема состояния");
    // Поля домена — блоком после прежних доменов, общий ответ не сдвинут.
    const keys = Object.keys(r);
    assert.ok(keys.indexOf("testDomain") > keys.indexOf("competitor") && keys.indexOf("testDomain") < keys.indexOf("citations"));
    // Другой вопрос: домен молчит, поле состояния переносится как есть.
    const next = await ask("Какая прочность ШОВ?", r.state);
    assert.equal(next.r.testDomain, null);
    assert.equal(next.r.state.current_test_domain, "record-1");
    assert.notEqual(next.r.mode, "TEST_DOMAIN");
    // agent.js о test-domain не знает.
    const src = readFileSync(AGENT, "utf8");
    for (const s of ["test-domain", "testDomain", "test_domain", "TEST_DOMAIN"]) assert.ok(!src.includes(s), s);
  } finally { d.unregister(); }

  // Снят регистрацией — ни следа в ответе, схема поле больше не принимает.
  const { r, meta } = await ask("Расскажи про тестовый домен");
  assert.notEqual(r.mode, "TEST_DOMAIN");
  assert.ok(!("testDomain" in r) && !("testDomain" in meta) && !("test_domain_ms" in r.metrics) && !("current_test_domain" in r.state));
  assert.throws(() => R.stateSchema.parse({ current_test_domain: "record-1" }));
  assert.equal(sha(readFileSync(AGENT, "utf8")), agentBefore, "agent.js не менялся");
});
