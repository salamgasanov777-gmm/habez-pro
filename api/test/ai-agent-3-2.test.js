// Habez AI Phase 3.2: агент с инструментами. Поиск товаров и характеристик,
// условия, фасовки, маршрут и состояние беседы, контракт инструментов,
// цикл вызовов (лимиты, повторы, «Стоп»), пакет доказательств, сквозные
// номера [E#], сравнение, скрытые данные, усиленная проверка ответа и 30
// детерминированных случаев. Модель — заглушка или сценарий в тесте.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { apiRoot, prepareAiDb, KOROED_SECRET } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-3-2.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let ids, get, all, db, agent, mock, tools, resolver, specs, router, ctxmod, evalmod, slugOf, catalog;
const T = (scope) => ({ tenantId: 1, scope });
const changes = () => get("SELECT total_changes() AS n").n;

before(async () => {
  ids = await prepareAiDb();
  ({ get, all, db } = await import("../src/db/index.js"));
  agent = await import("../src/ai/agent/runtime/agent.js");
  mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
  tools = await import("../src/ai/agent/tools/index.js");
  resolver = await import("../src/ai/agent/retrieval/resolver.js");
  specs = await import("../src/ai/agent/retrieval/specs.js");
  router = await import("../src/ai/agent/retrieval/router.js");
  ctxmod = await import("../src/ai/agent/runtime/context.js");
  evalmod = await import("../src/ai/agent/eval/eval-3-2.js");
  slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
  catalog = all("SELECT id, slug, name, short_name, summary, sections, spec_tables FROM products");
});

const ask = (question, extra = {}) => agent.runAgent({ tenantId: 1, scope: "staff", question, provider: mock, ...extra });
const found = (q) => resolver.resolveProducts(q, catalog);

describe("поиск товаров: падежи, регистр, опечатки, группы", () => {
  test("имя, падежи и регистр", () => {
    for (const q of ["ШОВ", "ШОВа", "ШОВом", "шов", "про ШОВе"]) assert.deepEqual(found(q).products.map((p) => p.slug), ["shov"], q);
    for (const q of ["СТАНДАРТ", "стандарта", "Стандартом"]) assert.deepEqual(found(q).products.map((p) => p.slug), ["standart"], q);
    assert.deepEqual(found("ГКЛ").products.map((p) => p.slug), ["gkl"]);
    assert.equal(found("ШОВ").products[0].score, 100);
    assert.equal(found("ШОВа").products[0].score, 90);
  });
  test("опечатка — ниже по рангу, но находит; короткие имена опечатками не ищутся", () => {
    const r = found("стандрат");
    assert.deepEqual(r.products.map((p) => [p.slug, p.via, p.score]), [["standart", "typo", 70]]);
    assert.deepEqual(found("корроед").products.map((p) => p.slug), ["koroed"]);
    assert.deepEqual(found("шоф").products, [], "три буквы — не опечатка «шов»");
  });
  test("несколько товаров — в порядке упоминания", () => {
    assert.deepEqual(found("Сравни Стандарт и ШОВ").products.map((p) => p.slug), ["standart", "shov"]);
  });
  test("обычное слово-название («фасада») без вида товара — не товар", () => {
    assert.deepEqual(found("Какая штукатурка для фасада?").products, []);
  });
  test("выдуманный товар не находится ничем, модель о нём не спрашивают", async () => {
    const r = found("Расскажи про ГИПСОМАКС-900");
    assert.deepEqual(r.products, []);
    assert.deepEqual(r.unknown, ["ГИПСОМАКС-900"]);
    assert.deepEqual(found("Какой GTIN у ГКЛ?").unknown, [], "GTIN — понятие, а не товар");
  });
});

describe("характеристики, условия, фасовки", () => {
  test("«прочность» — все виды и неоднозначно; «прочность сцепления» — только адгезия", () => {
    const a = specs.resolveSpecs("Какая прочность у ШОВ?");
    assert.equal(a.ambiguous, "strength");
    assert.ok(["adhesion_strength", "compressive_strength", "flexural_strength"].every((k) => a.keys.includes(k)));
    assert.deepEqual(specs.resolveSpecs("Какая прочность сцепления у ШОВ?").keys, ["adhesion_strength"]);
    assert.deepEqual(specs.resolveSpecs("прочность на изгиб").keys, ["flexural_strength"]);
    assert.ok(specs.resolveSpecs("время схватывания").keys.includes("setting_time"));
    assert.ok(specs.resolveSpecs("сколько воды на мешок").keys.includes("water_per_bag"));
    assert.deepEqual(specs.resolveSpecs("Какие есть расхождения?").keys, [], "«расхождения» — не «время хождения»");
    assert.equal(specs.resolveSpecs("полный набор прочности").ambiguous, null);
  });
  test("условия: сутки, слой, на мешок, разбавление; «толщина 9,5 мм» листа — не слой", () => {
    assert.deepEqual(specs.parseConditions("через 28 суток"), { age_days: 28 });
    assert.deepEqual(specs.parseConditions("в возрасте 7 сут"), { age_days: 7 });
    assert.deepEqual(specs.parseConditions("расход при толщине 1 мм"), { layer_mm: 1 });
    assert.deepEqual(specs.parseConditions("воды на мешок"), { per: "bag" });
    assert.deepEqual(specs.parseConditions("разбавление 1:4"), { dilution: "1:4" });
    assert.deepEqual(specs.parseConditions("толщина ГКЛ 9,5 мм"), {});
  });
  test("фасовка по размеру, «9,5 и 12,5 мм» — обе, ни одна не выбирается", () => {
    const vs = [{ id: 1, unit: "лист 9,5 мм" }, { id: 2, unit: "лист 12,5 мм" }];
    assert.equal(specs.matchVariant("ГКЛ 12,5 мм", vs).id, 2);
    assert.equal(specs.matchVariant("ГКЛ 9,5 мм", vs).id, 1);
    assert.equal(specs.matchVariant("ГКЛ 9,5 и 12,5 мм", vs), null);
    assert.equal(specs.matchVariant("ГКЛ", vs), null);
  });
  test("значение на 7 суток не подходит под «28 суток»; без возраста — подходит", () => {
    assert.equal(specs.matchesConditions({ key: "compressive_strength", conditionKey: "age_days=7" }, { age_days: 28 }), false);
    assert.equal(specs.matchesConditions({ key: "compressive_strength", conditionKey: "" }, { age_days: 28 }), true);
    assert.equal(specs.matchesConditions({ key: "compressive_strength_28d", conditionKey: "" }, { age_days: 7 }), false, "ключ …_28d = 28 суток");
  });
});

describe("маршрут и состояние беседы", () => {
  test("маршрут — структурный ответ", () => {
    const r = router.routeQuestion("Сравни ШОВ и Стандарт по прочности сцепления", { catalog, state: {} });
    assert.equal(r.intent, "comparison");
    assert.deepEqual(r.products.map((p) => p.slug), ["shov", "standart"]);
    assert.deepEqual(r.specs.keys, ["adhesion_strength"]);
    for (const [q, intent] of [["Расскажи про ШОВ", "product_lookup"], ["Какая прочность ШОВ?", "spec_lookup"], ["Сколько воды на мешок КОРОЕДА?", "condition"],
      ["Какие фасовки у ГКЛ?", "packaging"], ["Что подходит для заделки швов ГКЛ?", "application"], ["Кто подтвердил прочность ШОВ?", "source"],
      ["Какие расхождения у Стандарта?", "conflict"], ["Привет", "unknown"]]) {
      assert.equal(router.routeQuestion(q, { catalog, state: {} }).intent, intent, q);
    }
  });
  test("«у него» → ШОВ, «А у Стандарта?» → Стандарт с той же характеристикой, «Сравни их» → оба", () => {
    let st = {};
    const step = (q) => { const r = router.routeQuestion(q, { catalog, state: st }); st = router.nextState(r, st); return r; };
    step("Расскажи про ШОВ");
    let r = step("А какая у него прочность?");
    assert.deepEqual([r.products.map((p) => p.slug), r.productsFrom, r.specs.ambiguous], [["shov"], "state", "strength"]);
    r = step("А у Стандарта?");
    assert.deepEqual([r.products.map((p) => p.slug), r.specs.from], [["standart"], "state"]);
    r = step("Сравни их");
    assert.deepEqual([r.intent, r.products.map((p) => p.slug)], ["comparison", ["shov", "standart"]]);
    assert.deepEqual(Object.keys(st).sort(), ["awaiting", "current_condition", "current_product", "current_products", "current_spec", "current_specs", "current_variant", "last_intent"]);
    // После сравнения «у него» неясно, о каком.
    r = step("А какая у него прочность?");
    assert.deepEqual(r.needs, ["which_product"]);
  });
  test("состояние проверяется схемой: лишние поля и чужие значения не проходят", () => {
    assert.throws(() => router.stateSchema.parse({ current_product: "shov", evil: 1 }));
    assert.throws(() => router.stateSchema.parse({ current_product: "../../etc" }));
  });
  test("новая тема короткой фразой не наследует прошлую характеристику", () => {
    const st = { current_product: "gkl", current_products: ["gkl"], current_specs: ["per_pallet"], current_spec: "количество на поддоне", last_intent: "packaging" };
    const r = router.routeQuestion("Расскажи про ШОВ", { catalog, state: st });
    assert.deepEqual([r.intent, r.specs.keys], ["product_lookup", []]);
  });
});

describe("инструменты: единый контракт и только чтение", () => {
  test("у каждого — имя, описание, схема входа и выхода, права, read_only: true, write: false", () => {
    assert.deepEqual(Object.keys(tools.TOOL_SPECS).sort(), [...tools.TOOL_NAMES].sort());
    for (const t of Object.values(tools.TOOL_SPECS)) {
      assert.ok(t.name && t.description && t.input_schema?.type === "object" && t.output_schema, t.name);
      assert.deepEqual(Object.keys(t.permissions).sort(), ["admin", "public", "staff"], t.name);
      assert.equal(t.read_only, true, t.name);
      assert.equal(t.write, false, t.name);
    }
    assert.ok(!tools.toolsForScope("public").some((t) => t.name === "get_product_evidence"), "гостю модель этот инструмент не видит");
    assert.equal(tools.toolsForScope("staff").length, 6);
  });
  test("защита ловит запись: инструмент, изменивший базу, падает", () => {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS t_guard (x INTEGER)");
    assert.throws(() => tools.readOnly("test", () => db.exec("INSERT INTO t_guard VALUES (1)")), /изменил базу/);
    assert.equal(tools.readOnly("test", () => 42), 42);
  });
  test("сравнение — таблица: общие строки, пропуски, без победителя", () => {
    const cmp = tools.callTool("compare_products", { productIds: [ids.shov, ids.standart] }, T("staff"));
    const adh = cmp.rows.find((r) => r.key === "adhesion_strength" && !r.conditionKey);
    assert.ok(adh && adh.common);
    assert.ok(cmp.rows.some((r) => r.missing.length), "есть строки «нет данных»");
    assert.ok(!JSON.stringify(cmp).match(/winner|best|лучш/));
  });
});

describe("цикл инструментов", () => {
  // Сценарий модели: список ходов; ход — { tool: { name, input } } или { text }.
  const scripted = (turns, seen = []) => ({
    name: "script", model: "script", capabilities: { streaming: true, tools: true, maxOutputTokens: 1000 },
    async* stream(args) {
      seen.push(args);
      const t = turns[Math.min(seen.length - 1, turns.length - 1)];
      if (t.tool && args.toolChoice !== "none") {
        yield { type: "tool_use", id: `tu${seen.length}`, name: t.tool.name, input: t.tool.input };
        yield { type: "done", stopReason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: `tu${seen.length}`, name: t.tool.name, input: t.tool.input }] };
        return;
      }
      const text = typeof t.text === "function" ? t.text(args) : (t.text || "Готово.");
      yield { type: "text", text };
      yield { type: "done", stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text }] };
    },
  });

  test("модель сама вызывает инструмент, результат дописывается в пакет со следующими номерами", async () => {
    const seen = [];
    const provider = scripted([{ tool: { name: "get_product_specs", input: { product: "СТАНДАРТ", specs: ["прочность сцепления"] } } },
      { text: (args) => { const res = args.messages.at(-1).content[0].content; const ref = res.match(/\[(E\d+)\]/)[1]; return `Стандарт: 0,5 МПа [${ref}]`; } }], seen);
    const r = await ask("Расскажи про ШОВ", { provider });
    assert.equal(r.metrics.tool_calls_model, 2, "get_product + get_product_specs");
    assert.equal(r.metrics.turns, 2);
    assert.ok(r.toolCalls.some((c) => c.source === "model" && c.name === "get_product_specs"));
    const toolResult = seen[1].messages.at(-1).content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.match(toolResult.content, /Прочность сцепления/);
    const firstNew = Number(toolResult.content.match(/\[E(\d+)\]/)[1]);
    assert.ok(firstNew > seen[0].hints.properties.length, "номера продолжают пакет, а не начинаются заново");
    assert.equal(r.grounding.invalidCitations.length, 0, "ссылка на результат инструмента — настоящая");
    assert.ok(r.citations.some((c) => c.product.includes("СТАНДАРТ")));
    assert.ok(seen[0].tools.length === 6 && seen[0].system.includes("Инструменты:"));
  });

  test("повтор того же вызова не выполняется; лимит; последний ход — без вызовов", async () => {
    const seen = [];
    const loop = scripted([{ tool: { name: "search_knowledge", input: { query: "шов прочность" } } }], seen);
    const r = await ask("Расскажи про ШОВ", { provider: loop, budget: { maxTurns: 4 } });
    const results = seen.slice(1).map((a) => a.messages.at(-1).content.find((b) => b.type === "tool_result")?.content || "");
    assert.match(results[1], /уже выполнялся/);
    assert.equal(r.metrics.tool_calls_model, 1, "одинаковый вызов выполнен один раз");
    assert.equal(seen.at(-1).toolChoice, "none", "последний ход — ответ по имеющимся данным");
    assert.equal(r.metrics.turns, 4);

    const many = [];
    const different = { ...scripted([]), async* stream(args) {
      many.push(args);
      if (args.toolChoice === "none") { yield { type: "text", text: "Ответ." }; yield { type: "done", stopReason: "end_turn", usage: {}, content: [] }; return; }
      const input = { query: `запрос ${many.length}` };
      yield { type: "tool_use", id: `x${many.length}`, name: "search_knowledge", input };
      yield { type: "done", stopReason: "tool_use", usage: {}, content: [{ type: "tool_use", id: `x${many.length}`, name: "search_knowledge", input }] };
    } };
    const r2 = await ask("Расскажи про ШОВ", { provider: different, budget: { maxTurns: 6, maxToolCalls: 2 } });
    assert.equal(r2.metrics.tool_calls_model, 2, "не больше лимита");
    assert.ok(many.some((a) => JSON.stringify(a.messages.at(-1).content).includes("Лимит обращений")));
  });

  test("неизвестный инструмент и чужой товар — отказ текстом; гостю — без get_product_evidence", async () => {
    const seen = [];
    const p = scripted([{ tool: { name: "update_product", input: {} } }, { tool: { name: "get_product", input: { product: "ГИПСОМАКС" } } }, { text: "Нет данных." }], seen);
    await ask("Расскажи про ШОВ", { provider: p, budget: { maxTurns: 3 } });
    assert.match(seen[1].messages.at(-1).content[0].content, /Инструмента update_product нет/);
    assert.match(seen[2].messages.at(-1).content[0].content, /нет/);
    const pub = [];
    await agent.runAgent({ tenantId: 1, scope: "public", question: "Расскажи про ШОВ", provider: scripted([{ tool: { name: "get_product_evidence", input: { product: "ШОВ" } } }, { text: "Ок." }], pub) });
    assert.ok(!pub[0].tools.some((t) => t.name === "get_product_evidence"));
    assert.match(pub[1].messages.at(-1).content[0].content, /недоступен/);
  });

  test("«Стоп» посреди цикла: всё прекращается, запись в базу — ни одной", async () => {
    const n = changes();
    const ctrl = new AbortController();
    const p = { name: "s", model: "s", capabilities: { streaming: true, tools: true, maxOutputTokens: 100 },
      async* stream({ signal }) { ctrl.abort(new Error("стоп")); if (signal.aborted) throw signal.reason; yield { type: "done" }; } };
    await assert.rejects(() => ask("Расскажи про ШОВ", { provider: p, signal: ctrl.signal }));
    assert.equal(changes(), n);
  });

  test("метрики ответа: вызовы, ходы, время, токены, размер контекста", async () => {
    const r = await ask("Сравни ШОВ и Стандарт");
    for (const k of ["tool_calls", "turns", "retrieval_ms", "context_ms", "model_ms", "total_ms", "input_tokens", "output_tokens", "context_chars", "evidence"]) {
      assert.equal(typeof r.metrics[k], "number", k);
    }
    assert.ok(r.metrics.tool_calls_plan >= 3);
  });
});

describe("пакет доказательств и номера [E#]", () => {
  test("у каждой записи — нормализованные поля", async () => {
    const r = await ask("Какая прочность сцепления у ШОВ?");
    const obs = r.context.evidence.find((e) => e.kind === "observation");
    for (const k of ["claim", "value", "raw_value", "unit", "product", "variant", "packaging", "condition", "assertion_type", "source", "source_type", "source_date", "verification", "access_level", "status", "conflict_id"]) {
      assert.ok(k in obs, k);
    }
    assert.equal(obs.conflict_id, "D4");
    assert.equal(obs.status, "unresolved");
  });
  test("второе сообщение продолжает номера первого; ссылка на номер первого — недействительна", async () => {
    const a = await ask("Какая прочность Стандарта?");
    const n = a.context.evidence.length;
    const b = await ask("Какая прочность сцепления у ШОВ?", { refBase: n, state: a.state });
    assert.equal(b.context.evidence[0].id, `E${n + 1}`);
    assert.deepEqual(ctxmod.checkAnswer("[E1]", b.context.evidence).invalidCitations, ["E1"]);
  });
});

describe("доступ: скрытые данные, которые спорят с витриной", () => {
  const q = "Какая прочность на сжатие у КОРОЕДа?";
  test("гость: «есть внутренние данные, окончательное значение не опубликовано», значения нет", async () => {
    const r = await agent.runAgent({ tenantId: 1, scope: "public", question: q, provider: mock });
    assert.match(r.context.text, /окончательное значение не опубликовано/);
    assert.ok(!r.context.text.includes("9 МПа") && !r.context.text.includes(KOROED_SECRET.reference));
    assert.equal(r.mode, "CONFLICT");
  });
  test("сотрудник: факт скрытого значения без самого значения; администратор — весь спор", async () => {
    const staff = await ask(q);
    assert.ok(!staff.context.text.includes("9 МПа") && /скрытое значение|конфиденциальн/.test(staff.context.text));
    const admin = await agent.runAgent({ tenantId: 1, scope: "admin", question: q, provider: mock });
    assert.ok(admin.context.text.includes("не менее 9 МПа"));
    const p = admin.context.properties.find((x) => x.key === "compressive_strength");
    assert.equal(p.status, "conflict");
  });
});

describe("проверка ответа 3.2", () => {
  const ev = [
    { id: "E1", kind: "observation", productName: "ШОВ", property: "Прочность сцепления", value: "0,5 МПа" },
    { id: "E2", kind: "variant", productName: "ГКЛ", label: "фасовка", value: "лист 12,5 мм", variant: "лист 12,5 мм", perPallet: 51 },
  ];
  test("«5 МПа» при «0,5 МПа» в данных — выдумка", () => {
    assert.deepEqual(ctxmod.checkAnswer("Прочность 5 МПа [E1]", ev).unsupported, ["5 МПа"]);
  });
  test("то же число с другой единицей — не из источника", () => {
    assert.deepEqual(ctxmod.checkAnswer("Прочность 0,5 кг [E1]", ev).unsupported, ["0,5 кг"]);
    assert.deepEqual(ctxmod.checkAnswer("Лист 12,5 мм: 51 шт на поддоне [E2]", ev).mismatched, []);
  });
  test("чужой товар в ответе — отмечается", () => {
    const allowed = new Set([ids.shov]);
    const r = ctxmod.checkAnswer("ШОВ — 0,5 МПа [E1]. Лучше взять КОРОЕД.", ev, { catalog, allowedProductIds: allowed });
    assert.deepEqual(r.foreignProducts, ["КОРОЕД"]);
    assert.equal(r.grounded, false);
  });
  test("участники спора из строки того же свойства — из данных; число из прошлого ответа — мягкая пометка", () => {
    const withLine = [{ ...ev[0], line: "- Прочность сцепления: 0,5 МПа [E1] — НЕРЕШЁННЫЙ; вопрос сверки: D4 (участники: 0,5 МПа / не менее 0,3 МПа)" }];
    const r = ctxmod.checkAnswer("ШОВ: 0,5 МПа [E1] — спор D4: 0,5 / не менее 0,3 МПа", withLine);
    assert.deepEqual([r.mismatched, r.unsupported], [[], []]);
    const h = ctxmod.checkAnswer("Ранее было: 1,0 МПа при изгибе.", ev, { historyText: "Прочность на изгиб: не менее 1,0 МПа [E12]" });
    assert.deepEqual([h.fromHistory, h.unsupported, h.grounded], [["1,0 МПа"], [], true]);
    const fake = ctxmod.checkAnswer("Прочность 9,9 МПа.", ev, { historyText: "Прочность 1,0 МПа" });
    assert.deepEqual(fake.unsupported, ["9,9 МПа"], "чего нет ни в данных, ни в истории — выдумка");
    const note = ctxmod.checkAnswer("Для 7 суток данных нет.", ev, { contextText: "- Для других условий данные есть (7 сут) — их к вопросу не применять." });
    assert.deepEqual(note.unsupported, []);
  });

  test("«на 1 кг» — единица расчёта, не значение", () => {
    assert.deepEqual(ctxmod.checkAnswer("0,5 МПа на 1 кг [E1]", ev).unsupported, []);
  });
});

describe("30 детерминированных случаев", () => {
  const cases = JSON.parse(readFileSync(resolve(apiRoot, "test/fixtures/ai-eval-cases-3-2.json"), "utf8")).cases;
  test("в наборе 30 случаев нужных групп и полей", () => {
    assert.equal(cases.length, 30);
    const count = (g) => cases.filter((c) => c.group === g).length;
    assert.deepEqual([count("search"), count("product"), count("specs"), count("conditions"), count("variants"), count("comparison"), count("conflicts")], [5, 5, 5, 4, 4, 4, 3]);
    for (const c of cases) for (const k of ["turns", "expected_intent", "expected_entities", "expected_tools", "expected_evidence", "expected_behavior", "forbidden_behavior"]) assert.ok(k in c, `${c.id}: ${k}`);
  });
  for (const c of cases) {
    test(`#${c.id} ${c.group}: ${c.turns.join(" → ")}`, async () => {
      const { last } = await evalmod.runConversation(c, { provider: mock });
      const out = evalmod.evaluateCase32(c, last, { slugOf });
      assert.ok(out.pass, out.fails.join("; "));
      assert.equal(last.grounding.invalidCitations.length, 0);
    });
  }
  test("все 30 случаев × три роли — ни одной записи в базу", async () => {
    const n = changes();
    for (const c of cases) for (const scope of ["public", "staff", "admin"]) await evalmod.runConversation(c, { provider: mock, scope });
    assert.equal(changes(), n);
  });
});
