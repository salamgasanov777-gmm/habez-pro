// Habez AI 3.5 Competitor Intelligence — интеграция с ассистентом: пять
// инструментов чтения, распознавание имён, маршруты, беседа, ответы без
// модели, правила для модели, проверка ответа и 48 детерминированных
// случаев. Данные — только синтетические (helpers/competitor-fixture.js).
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";
import { seedCompetitors } from "./helpers/competitor-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-3-5.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let ids, fx, get, all, agent, mock, tools, detect, check, router, prompts, evalmod, slugOf, catalog, registry;
const T = (scope, tenantId = 1) => ({ tenantId, scope });
const changes = () => get("SELECT total_changes() AS n").n;
const ask = (question, extra = {}) => agent.runAgent({ tenantId: 1, scope: "staff", question, provider: mock, ...extra });
// «Модель», которая отвечает заданным текстом, — для проверки ответа.
const saying = (text) => ({ name: "scripted", model: "scripted", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
  async* stream() { yield { type: "text", text }; yield { type: "done", stopReason: "end_turn", usage: {} }; } });

before(async () => {
  ids = await prepareAiDb();
  fx = await seedCompetitors();
  ({ get, all } = await import("../src/db/index.js"));
  agent = await import("../src/ai/agent/runtime/agent.js");
  mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
  tools = await import("../src/ai/agent/tools/index.js");
  detect = await import("../src/ai/agent/competitor/detect.js");
  check = await import("../src/ai/agent/competitor/check.js");
  router = await import("../src/ai/agent/retrieval/router.js");
  prompts = await import("../src/ai/agent/prompts/system.js");
  evalmod = await import("../src/ai/agent/eval/eval-3-2.js");
  const C = await import("../src/ai/competitors/index.js");
  registry = C.competitorRegistry({ tenantId: 1, role: "manager" });
  slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
  catalog = all("SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.sections, p.spec_tables, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=1");
  for (const s of ["finish", "zhako", "akvalayt"]) ids[s] = get("SELECT id FROM products WHERE slug=?", s)?.id;
});

describe("распознавание имён конкурентов", () => {
  const hit = (q) => detect.detectCompetitors(q, registry, { weakWords: detect.catalogWords(catalog) }).map((h) => `${h.item.type}:${h.item.name}`);
  test("точное имя, регистр, падеж, короткое имя, опечатка", () => {
    assert.deepEqual(hit("Что известно о ТестСмеси?"), ["company:ТестСмесь"]);
    assert.deepEqual(hit("тестсмесь"), ["company:ТестСмесь"]);
    assert.deepEqual(hit("Сравни с Т-Шовом"), ["product:Шпаклёвка для швов «Т-Шов»"]);
    assert.deepEqual(hit("Расскажи про ТестСмес"), ["company:ТестСмесь"]);
    assert.deepEqual(hit("Какие товары марки Марка-U?"), ["brand:Марка-U"]);
  });
  test("обычные слова не становятся конкурентами; нет уверенного совпадения — пусто", () => {
    for (const q of ["Какая прочность у шпаклёвки?", "Расскажи про ШОВ", "Что использовать для швов ГКЛ?", "Тест смесей на прочность", "Какая марка цемента?"]) assert.deepEqual(hit(q), [], q);
    assert.deepEqual(hit("Что известно о Зета-Микс?"), []);
  });
  test("гостю справочник не загружается, сотруднику — без конфиденциального, чужой компании — нет", async () => {
    const C = await import("../src/ai/competitors/index.js");
    assert.throws(() => C.competitorRegistry({ tenantId: 1, role: "customer" }), (e) => e.status === 403);
    assert.ok(!registry.some((r) => /Секрет|С-Смесь|ЧужаяСмесь|Ч-Шов/.test(r.name)));
    assert.ok(C.competitorRegistry({ tenantId: 1, role: "admin" }).some((r) => r.name === "Секрет-Групп"));
  });
});

describe("маршрут: пять намерений 3.5 и прежние вопросы", () => {
  const r = (q, state = {}, scope = "staff") => router.routeQuestion(q, { catalog, state, competitors: scope === "public" ? [] : registry, scope });
  test("намерения", () => {
    for (const [q, intent] of [["Что известно о ТестСмеси?", "competitor_lookup"], ["Какие конкуренты есть?", "competitor_lookup"], ["Какие товары у ТестСмеси?", "competitor_products"],
      ["Какие аналоги у ШОВ?", "analog_lookup"], ["Сравни ШОВ с Т-Шовом", "competitor_comparison"], ["Сколько стоит Т-Шов?", "competitor_price"],
      ["Что производит ТестСмесь?", "competitor_products"], ["Кто производит Т-Шов?", "competitor_lookup"]]) assert.equal(r(q).intent, intent, q);
  });
  test("«ШОВ» внутри «Т-Шов» — не наш товар", () => {
    assert.deepEqual(r("Сколько стоит Т-Шов?").products.map((p) => p.slug), []);
    assert.deepEqual(r("Сравни ШОВ с Т-Шовом").products.map((p) => p.slug), ["shov"]);
    assert.deepEqual(r("U-Шов идентичен ШОВ?").products.map((p) => p.slug), ["shov"]);
    assert.deepEqual(r("Что известно о U-Шов?").products.map((p) => p.slug), []);
  });
  test("прежние вопросы 3.1–3.4 не перехвачены даже при загруженном справочнике", () => {
    for (const [q, intent] of [["Расскажи про ШОВ", "product_lookup"], ["Какая прочность у ШОВ?", "spec_lookup"], ["Сравни ШОВ и Стандарт", "comparison"], ["Какие есть фасовки ГКЛ?", "packaging"],
      ["Что использовать для швов ГКЛ?", "application"], ["Как применять КОРОЕД?", "usage"], ["Где производится ШОВ?", "product_factory"], ["Какие документы есть у ШОВ?", "factory_documents"],
      ["Что производит завод Зетагипс?", "factory_products"], ["Откуда значение прочности сцепления у ШОВ?", "source"]]) assert.equal(r(q).intent, intent, q);
  });
  test("гость: по словам — отказ, по имени — никакого распознавания", () => {
    assert.equal(r("Кто ваши конкуренты?", {}, "public").competitor.forbidden, true);
    assert.equal(r("Что известно о ТестСмеси?", {}, "public").competitor, null);
  });
  test("состояние: три поля конкурента проходят схему, чужие значения — нет", () => {
    assert.doesNotThrow(() => router.stateSchema.parse({ current_competitor_company: 1, current_competitor_brand: 2, current_competitor_product: 3 }));
    assert.throws(() => router.stateSchema.parse({ current_competitor_product: "Т-Шов" }));
  });
});

describe("пять инструментов: только чтение, роль, компания-арендатор", () => {
  const calls = (s, tenantId = 1) => [
    ["search_competitors", { terms: ["ТестСмесь", "Т-Шов"] }], ["get_competitor", { companyId: fx.companies.ts.id }],
    ["get_competitor_products", { companyId: fx.companies.ts.id }], ["find_analogs", { productId: ids.shov }],
    ["compare_with_competitor", { productId: ids.shov, competitorProductId: fx.products.tShov.id }],
  ].map(([n, a]) => [n, tools.callTool(n, a, T(s, tenantId))]);
  test("все пять — read_only, write: false; гостю модель их не видит", () => {
    for (const n of ["search_competitors", "get_competitor", "get_competitor_products", "find_analogs", "compare_with_competitor"]) {
      assert.deepEqual([tools.TOOL_SPECS[n].read_only, tools.TOOL_SPECS[n].write], [true, false], n);
      assert.ok(!tools.toolsForScope("public").some((t) => t.name === n));
      assert.ok(tools.toolsForScope("staff").some((t) => t.name === n));
    }
  });
  test("после каждого вызова total_changes не меняется — три роли", () => {
    for (const s of ["public", "staff", "admin"]) {
      const n = changes();
      calls(s);
      assert.equal(changes(), n, s);
    }
  });
  test("гость — отказ без данных", () => {
    for (const [n, out] of calls("public")) assert.deepEqual(out, { forbidden: true, reason: "Сведения о конкурентах доступны сотрудникам" }, n);
  });
  test("сотрудник — без конфиденциального; администратор — всё", () => {
    const staffJson = JSON.stringify(calls("staff"));
    assert.ok(!/С-Смесь|Секрет-Групп|"amountMinor":39000/.test(staffJson));
    const admin = Object.fromEntries(calls("admin"));
    assert.ok(admin.find_analogs.confirmed.some((x) => x.competitorProduct.short === "С-Смесь"));
    assert.ok(admin.compare_with_competitor.prices.some((g) => g.observations.some((o) => o.amountMinor === 39000)));
  });
  test("другая компания-арендатор не видит конкурентов первой", () => {
    const other = Object.fromEntries(calls("admin", fx.t2));
    assert.deepEqual(other.search_competitors.items, []);
    assert.equal(other.get_competitor, null);
    assert.equal(other.compare_with_competitor, null);
  });
  test("find_analogs: предположение — confirmed: false и основание heuristic; «не аналог» — не подтверждённый аналог", () => {
    const shov = tools.callTool("find_analogs", { productId: ids.shov }, T("staff"));
    for (const x of shov.inferred) assert.deepEqual([x.status, x.confirmed, x.basisKind, x.relation], ["INFERRED", false, "heuristic", null]);
    assert.ok(!JSON.stringify(shov.inferred).includes('"analog":true'));
    const koroed = tools.callTool("find_analogs", { productId: ids.koroed }, T("staff"));
    assert.deepEqual([koroed.notAnalog[0].relation, koroed.notAnalog[0].confirmed, koroed.confirmed.length], ["not_analog", false, 0]);
    const std = tools.callTool("find_analogs", { productId: ids.standart }, T("staff"));
    assert.deepEqual([std.conflicted[0].status, std.conflicted[0].confirmed, std.conflicted[0].relation], ["CONFLICTED", false, null]);
    const anti = tools.callTool("find_analogs", { productId: ids.antipleseni }, T("staff"));
    assert.deepEqual([anti.confirmed[0].relation, anti.confirmed[0].basis[0].differences], ["partial_analog", "нет противогрибковой добавки, другое назначение"]);
  });
  test("compare_with_competitor: строки 3.2, «нет данных», источники и даты, цены с основой и без пересчёта", () => {
    const cmp = tools.callTool("compare_with_competitor", { productId: ids.shov, competitorProductId: fx.products.tShov.id }, T("staff"));
    const adh = cmp.rows.find((r) => r.key === "adhesion_strength" && r.conditionKey === "");
    const theirs = adh.cells[-fx.products.tShov.id];
    assert.equal(theirs.status, "conflict");
    assert.ok(theirs.values.every((v) => v.evidence.every((e) => e.sourceName && "sourceDate" in e)));
    assert.ok(cmp.rows.some((r) => r.missing.length), "есть «нет данных»");
    const kg = cmp.prices.find((g) => g.basisUnit === "kg");
    const bag = cmp.prices.find((g) => g.basisUnit === "pack" && g.region === "Тестовый край");
    assert.deepEqual([kg.observations[0].amountMinor, kg.basis, bag.basisQty, bag.observations.map((o) => o.observedAt)], [1800, "за кг", 25, ["2026-08-01", "2026-09-01"]]);
    for (const o of bag.observations) for (const f of ["amountMinor", "currency", "priceKind", "basis", "basisQty", "basisUnit", "observedAt", "region", "seller", "source"]) assert.ok(o[f] !== undefined && o[f] !== null, f);
    assert.ok(!JSON.stringify(cmp.prices).match(/per_?kg|normalized/i));
    assert.ok(!JSON.stringify(cmp).match(/winner|better|лучше|хуже/i));
  });
});

describe("ответы без модели", () => {
  test("гость, неизвестный конкурент, неизвестный товар, нет данных, уточнение — модель не вызывается", async () => {
    for (const [q, scope, re] of [["Кто ваши конкуренты?", "public", /только сотрудникам/], ["Что известно о конкуренте «Зета-Микс»?", "staff", /ни в справочнике конкурентов/],
      ["Сравни ШОВ с «Т-Супер»", "staff", /Т-Супер/], ["Какая цена у П-Финиш?", "staff", /нет/], ["Какие аналоги у ГКЛ?", "staff", /нет товаров конкурентов/],
      ["Сравни ЖАКО с товаром ТестСмесь", "staff", /С каким товаром/], ["Сравни ШОВ с П-Финишем", "staff", /сравнивать нечего/]]) {
      const x = await ask(q, { scope, provider: saying("НЕ ДОЛЖНО ПРОЗВУЧАТЬ") });
      assert.equal(x.model, null, q);
      assert.match(x.answer, re, q);
    }
  });
});

describe("правила для модели", () => {
  test("модуль «Конкуренты» — только в режимах 3.5; прежние правила на месте", () => {
    const p = prompts.composeSystemPrompt({ mode: "COMPETITOR_COMPARISON" });
    for (const s of ["существуют для тебя, только если", "«Аналог» не значит «одинаковый товар»", "ПРЕДПОЛОЖЕНИЕ", "с датой и источником", "Никаких вердиктов", "не ноль", "При расхождении"]) assert.ok(p.includes(s), s);
    assert.ok(p.includes("Правила точности") && p.includes("Правила безопасности"));
    assert.ok(!prompts.composeSystemPrompt({ mode: "FACT" }).includes("Конкуренты:"));
  });
});

describe("проверка ответа: выдумки и вердикты", () => {
  test("вердикт ловится, нейтральное перечисление и отрицание — нет", () => {
    assert.deepEqual(check.verdict("Т-Шов лучше ШОВ.\nИх выгоднее покупать."), ["лучше", "выгоднее"]);
    assert.deepEqual(check.verdict("Прочность сцепления: ШОВ — 0,5 МПа, Т-Шов — 0,6 МПа.\nСистема не выбирает, какой товар лучше."), []);
    assert.deepEqual(check.verdict("Рекомендую Т-Шов."), ["рекомендую"]);
  });
  test("«полный аналог», «идентичен» вопреки статусу", () => {
    const pairs = [{ names: ["т-шов"], status: "CONFIRMED", relation: "analog" }, { names: ["т-грунт"], status: "CONFIRMED", relation: "partial_analog" }, { names: ["п-финиш"], status: "INFERRED", relation: null }];
    assert.deepEqual(check.analogyHallucination("Т-Грунт — полный аналог АНТИПЛЕСЕНЬ.", pairs), ["полный аналог"]);
    assert.deepEqual(check.analogyHallucination("П-Финиш — аналог ШОВ.", pairs), ["аналог (INFERRED)"]);
    assert.deepEqual(check.analogyHallucination("Т-Шов идентичен ШОВ.", pairs), ["идентичен"]);
    assert.deepEqual(check.analogyHallucination("Т-Шов — аналог ШОВ по источнику [E3].\nП-Финиш — только предположение, не подтверждено.", pairs), []);
  });
  test("цена: не из данных — выдумка; из данных без ссылки и даты — без ссылки", () => {
    const prices = [{ id: "E5", amountMinor: 45000 }];
    assert.deepEqual(check.priceHallucination("Т-Шов стоит 999 ₽.", prices).invented, ["999 ₽"]);
    assert.deepEqual(check.priceHallucination("Т-Шов стоит 450,00 ₽.", prices).uncited, ["450,00 ₽"]);
    assert.deepEqual(check.priceHallucination("Т-Шов: 450,00 ₽ за мешок 25 кг на 2026-08-01 [E5].", prices), { invented: [], uncited: [] });
  });
  test("источник и сущность не из данных", () => {
    assert.deepEqual(check.sourceHallucination("Данные с сайта fake-zeta-gips.ru.", "Синтетический сайт https://testsmes.example"), ["fake-zeta-gips.ru"]);
    assert.deepEqual(check.sourceHallucination("Сайт компании — testsmes.example.", "https://testsmes.example"), []);
    assert.deepEqual(check.entityHallucination("Сравните также с «Супер-Гипс».", { registry, dataText: "ТестСмесь", corpus: "" }), ["Супер-Гипс"]);
    assert.deepEqual(check.entityHallucination("У Пример-Гипс есть П-Финиш.", { registry, dataText: "Т-Шов ТестСмесь", corpus: "" }).sort(), ["Пример-Гипс", "Шпаклёвка «П-Финиш»"].sort());
  });
  test("«нет данных» как «хуже» или ноль", () => {
    assert.deepEqual(check.missingAsWorse("По прочности на изгиб Т-Шов уступает ШОВ.", ["Прочность на изгиб"]), ["уступает"]);
    assert.deepEqual(check.missingAsWorse("Прочность на изгиб: у Т-Шов нет данных — это не значит, что хуже.", ["Прочность на изгиб"]), []);
  });
  test("ответ ассистента с выдумками помечен как непроверенный", async () => {
    const x = await ask("Сравни ШОВ с Т-Шовом", { provider: saying("Т-Шов лучше и выгоднее [E1].\nТ-Шов — полный аналог и стоит 999 ₽.\nСм. сайт fake-shop.ru и «Мега-Смесь».") });
    const g = x.grounding.competitor;
    assert.equal(x.grounding.grounded, false);
    assert.ok(g.verdict.includes("лучше") && g.inventedPrices.includes("999 ₽") && g.inventedSources.includes("fake-shop.ru") && g.inventedEntities.includes("Мега-Смесь"));
    const ok = await ask("Сравни ШОВ с Т-Шовом");
    assert.equal(ok.grounding.grounded, true, JSON.stringify(ok.grounding));
  });
});

describe("беседа из нескольких реплик", () => {
  test("сравнение → «А цена?» → «А у другой их марки?» → «Есть ли у ШОВ ещё аналоги?»", async () => {
    let state = {};
    let refBase = 0;
    const history = [];
    const turn = async (q) => {
      const x = await ask(q, { state, refBase, history: [...history] });
      history.push({ role: "user", content: q }, { role: "assistant", content: x.answer });
      state = x.state; refBase += x.context.evidence.length;
      return x;
    };
    const a = await turn("Сравни ШОВ с товаром ТестСмесь");
    assert.deepEqual([a.mode, a.competitor.competitorProduct, state.current_competitor_product], ["COMPETITOR_COMPARISON", "Шпаклёвка для швов «Т-Шов»", fx.products.tShov.id]);
    const b = await turn("А цена?");
    assert.deepEqual([b.intent, b.competitor.products], ["competitor_price", ["Шпаклёвка для швов «Т-Шов»"]]);
    const c = await turn("А у другой их марки?");
    assert.deepEqual([c.intent, c.competitor.products, state.current_competitor_brand], ["competitor_price", ["Шпаклёвка для швов «U-Шов»"], fx.brands.bU.id]);
    const d = await turn("Есть ли у ШОВ ещё аналоги?");
    assert.equal(d.intent, "analog_lookup");
    assert.ok(d.competitor.analogs.some((x) => x.status === "CONFIRMED") && d.competitor.analogs.some((x) => x.status === "INFERRED" && x.confirmed === false));
  });
});

// Дефекты, найденные live-оценкой 3.5 на настоящей модели (копия базы с
// синтетикой). Каждый тест — один дефект; номер — как в отчёте.
describe("регрессия live-оценки 3.5", () => {
  test("F1 «1,0 МПа» — не «0 МПа»; настоящий ноль ловится", () => {
    assert.deepEqual(check.missingAsWorse("Прочность на изгиб: ШОВ — не менее 1,0 МПа; Т-Шов — нет данных.", ["Прочность на изгиб"]), []);
    assert.deepEqual(check.missingAsWorse("Прочность на изгиб: у Т-Шов 0 МПа.", ["Прочность на изгиб"]), ["0 мпа"]);
  });
  test("F2 имя из вопроса в отказе — не выдумка; в утверждении — выдумка", () => {
    const question = "Расскажи о компании ТестСмесь и её дочерней фирме «Гипс-Альфа».";
    assert.deepEqual(check.entityHallucination("По компании «Гипс-Альфа» в данных Habez информации нет.", { registry, dataText: "ТестСмесь", question }), []);
    assert.deepEqual(check.entityHallucination("«Гипс-Альфа» выпускает шпаклёвки.", { registry, dataText: "ТестСмесь", question }), ["Гипс-Альфа"]);
  });
  test("F3/F4 неизвестное имя без кавычек — «нет в данных» без модели", async () => {
    for (const q of ["Что известно о компании Т-Супер?", "Сравни ШОВ с Т-Супер."]) {
      const x = await ask(q, { provider: saying("НЕ ДОЛЖНО ПРОЗВУЧАТЬ") });
      assert.deepEqual([x.model, x.mode], [null, "NOT_FOUND"], q);
      assert.match(x.answer, /Т-Супер/);
    }
    assert.equal((await ask("Сравни ШОВ с Т-Шовом")).mode, "COMPETITOR_COMPARISON");
  });
  test("F5 число из поля записи (фасовки, различия, основа цены) — из этой записи", async () => {
    const { checkAnswer } = await import("../src/ai/agent/runtime/context.js");
    const ev = [{ id: "E1", kind: "competitor_record", label: "Товар", value: "Т-Шов", where: "фасовки: мешок 25 кг, мешок 5 кг" },
      { id: "E2", kind: "price", label: "цена (розница, за мешок 25 кг)", value: "470,00 ₽", basis: "за мешок 25 кг" }];
    const g = checkAnswer("Т-Шов: мешок 5 кг [E1].\nЦена: 470,00 ₽ за мешок 25 кг [E2].", ev);
    assert.deepEqual([g.mismatched, g.unsupported], [[], []]);
  });
  test("F6 частичные аналоги — отдельным блоком от полных", async () => {
    const x = await ask("Есть ли аналог у АНТИПЛЕСЕНЬ?");
    assert.match(x.context.text, /ПОДТВЕРЖДЕНО: ЧАСТИЧНЫЙ АНАЛОГ[^\n]*\n[^\n]*Т-Грунт/);
  });
  test("F7 товар конкурента «П-Финиш» — не наш «ФИНИШ»", async () => {
    const x = await ask("Какие аналоги у ШОВ?", { provider: saying("П-Финиш (Пример-Гипс) — только предположение по разделу, не подтверждено.") });
    assert.deepEqual(x.grounding.foreignProducts, []);
    const y = await ask("Какие аналоги у ШОВ?", { provider: saying("Есть ещё наш ФИНИШ.") });
    assert.deepEqual(y.grounding.foreignProducts, ["ФИНИШ"]);
  });
  test("F8 метка статуса в кавычках — не компания", () => {
    assert.deepEqual(check.entityHallucination("Статус «Не аналог» подтверждён, «Частичный аналог» — тоже.", { registry, dataText: "Т-Старт" }), []);
  });
  test("F9 сумма, уже названная со ссылкой, в итоговой фразе — не «без ссылки»", () => {
    const prices = [{ id: "E2", amountMinor: 45000 }, { id: "E3", amountMinor: 47000 }];
    assert.deepEqual(check.priceHallucination("- 450,00 ₽ [E2]\n- 470,00 ₽ [E3]\nОбе цены (450 ₽ и 470 ₽) приведены как есть.", prices).uncited, []);
    assert.deepEqual(check.priceHallucination("Обе цены (450 ₽ и 470 ₽) приведены как есть.", prices).uncited, ["450 ₽", "470 ₽"]);
  });
  test("F10 конкурент из прошлого ответа беседы — не выдумка", () => {
    assert.deepEqual(check.entityHallucination("Эту цену не сравниваю с ценами «Т-Шов».", { registry, dataText: "U-Шов", historyText: "Цены на «Т-Шов»: 470 ₽" }), []);
    assert.ok(check.entityHallucination("Эту цену не сравниваю с ценами «Т-Шов».", { registry, dataText: "U-Шов" }).length);
  });
  test("F11 сотруднику — число скрытых цен и «цен такого вида нет», без значений; администратору — цена", async () => {
    const staff = await ask("Какая дилерская цена Т-Шова?");
    assert.match(staff.context.text, /Цен вида «дилерская» среди доступных данных нет/);
    assert.match(staff.context.text, /ограниченным доступом: 1/);
    assert.ok(!/390|39000|dealer/.test(staff.context.text));
    const admin = await ask("Какая дилерская цена Т-Шова?", { scope: "admin" });
    assert.match(admin.context.text, /390,00 ₽/);
    assert.ok(!/ограниченным доступом|Цен вида/.test(admin.context.text));
  });
  test("F13 «U-Шов идентичен ШОВ?» — статус пары из вопроса в данных (предположение), «идентичен» ловится", async () => {
    const x = await ask("U-Шов идентичен ШОВ?");
    assert.match(x.context.text, /связь с товаром Habez ШОВ: ПРЕДПОЛОЖЕНИЕ[^\n]*тот же раздел каталога/);
    assert.ok(x.competitor.analogs.some((a) => a.product === "ШОВ" && a.status === "INFERRED" && a.confirmed === false));
    const bad = await ask("U-Шов идентичен ШОВ?", { provider: saying("Да, U-Шов идентичен ШОВ.") });
    assert.ok(bad.grounding.competitor.analogy.length && bad.grounding.grounded === false);
  });
  test("F14 у товара конкурента две пары — строка о подтверждённой паре не путается с предположением", () => {
    const pairs = [{ names: ["u-шов"], ours: ["аквалайт"], status: "CONFIRMED", relation: "analog" }, { names: ["u-шов"], ours: ["шов"], status: "INFERRED", relation: null }];
    assert.deepEqual(check.analogyHallucination("- Связь «U-Шов» — АКВАЛАЙТ: ПОДТВЕРЖДЕНО как аналог [E3].", pairs), []);
    assert.deepEqual(check.analogyHallucination("U-Шов — аналог ШОВ.", pairs), ["аналог (INFERRED)"]);
  });
  test("F15 противоречие: позиция источника названа как позиция — не вывод; без атрибуции — ошибка", () => {
    const pairs = [{ names: ["п-клей"], ours: ["стандарт"], status: "CONFLICTED", relation: null }];
    assert.deepEqual(check.analogyHallucination("Источник указывает П-Клей как аналог СТАНДАРТ [E3].", pairs), []);
    assert.deepEqual(check.analogyHallucination("П-Клей — аналог СТАНДАРТ.", pairs), ["аналог (CONFLICTED)"]);
  });
  test("F16 цитата вопроса пользователя — не вердикт; тот же вывод от себя — вердикт", () => {
    const q = "Сравни ШОВ с Т-Шовом и скажи, какой лучше, надёжнее и выгоднее.";
    assert.deepEqual(check.verdict("Вы спрашиваете, что лучше: ШОВ или Т-Шов.\nНа вопрос «какой надёжнее» отвечу фактами.", q), []);
    assert.deepEqual(check.verdict("Если нужна оценка «что лучше» — выбор остаётся за вами.", q), []);
    assert.deepEqual(check.verdict("Т-Шов лучше и надёжнее.", q), ["лучше"]);
    assert.deepEqual(check.verdict("Вы спрашиваете, что лучше.", "Сравни ШОВ с Т-Шовом"), ["лучше"]);
  });
  test("F12 история без висячих пробелов на месте ссылок; правило о ссылках и о виде цены в подсказке", () => {
    const h = agent.cleanHistory([{ role: "user", content: "q" }, { role: "assistant", content: "у Т-Шов есть фасовка 5 кг [E3].\nЦена 470 ₽ [E4][E5]" }, { role: "user", content: "ещё" }]);
    assert.equal(h[1].content, "у Т-Шов есть фасовка 5 кг.\nЦена 470 ₽");
    const p = prompts.composeSystemPrompt({ mode: "COMPETITOR_PRICE" });
    assert.ok(p.includes("ссылки убраны — это не образец") && p.includes("«Дилерская цена» — вид цены") && p.includes("Не считай и не предлагай посчитать цену"));
  });
});

describe("48 детерминированных случаев 3.5 и прежние наборы при загруженном справочнике", () => {
  const set = JSON.parse(readFileSync(resolve(apiRoot, "test/fixtures/ai-eval-cases-3-5.json"), "utf8"));
  test("в наборе 40+ случаев нужных групп", () => {
    const count = (g) => set.cases.filter((c) => c.group === g).length;
    assert.ok(set.cases.length >= 40);
    for (const g of ["search", "unknown", "products", "analogs", "comparison", "price", "rights", "isolation", "multi_turn", "regression", "precedence"]) assert.ok(count(g) >= 1, g);
  });
  for (const c of set.cases) {
    test(`#${c.id} ${c.group}${c.scope ? ` (${c.scope})` : ""}: ${c.turns.join(" → ")}`, async () => {
      const { last } = await evalmod.runConversation(c, { provider: mock });
      const out = evalmod.evaluateCase32(c, last, { slugOf });
      assert.ok(out.pass, out.fails.join("; "));
    });
  }
  for (const [name, file] of [["3.2", "ai-eval-cases-3-2.json"], ["3.3", "ai-eval-cases-3-3.json"], ["3.4", "ai-eval-cases-3-4.json"]].map(([n, f]) => [n, resolve(apiRoot, "test/fixtures", f)])) {
    test(`набор ${name} проходит целиком, когда в базе есть конкуренты`, async () => {
      const data = evalmod.loadEval32(file);
      const fails = [];
      for (const c of data.cases) {
        const { last } = await evalmod.runConversation(c, { provider: mock });
        const out = evalmod.evaluateCase32(c, last, { slugOf });
        if (!out.pass) fails.push(`#${c.id}: ${out.fails.join("; ")}`);
      }
      assert.deepEqual(fails, []);
    });
  }
  test("все случаи 3.5 × три роли — ни одной записи в базу", async () => {
    const n = changes();
    for (const c of set.cases) for (const scope of ["public", "staff", "admin"]) await evalmod.runConversation(c, { provider: mock, scope });
    assert.equal(changes(), n);
  });
});
