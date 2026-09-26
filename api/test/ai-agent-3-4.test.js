// Habez AI Phase 3.4: Factory Intelligence. Документы как производная
// запись над наблюдениями, статусы связи завод ↔ товар (четыре состояния),
// марка ≠ завод, ассортимент ≠ производство, права по ролям, маршрутизация,
// многоходовая беседа, проверка ответа и детерминированные случаи.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-3-4.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let ids, get, all, run, agent, mock, tools, model, docs, route, router, check, evalmod, slugOf, catalog;
const T = (scope) => ({ tenantId: 1, scope });
const changes = () => get("SELECT total_changes() AS n").n;
const ask = (question, extra = {}) => agent.runAgent({ tenantId: 1, scope: "staff", question, provider: mock, ...extra });
const DIRECTOR = "Тестов Директор Директорович";

before(async () => {
  ids = await prepareAiDb();
  ({ get, all, run } = await import("../src/db/index.js"));
  // Как в рабочей базе: сайт, ОГРН и имя директора в настройках организации.
  // Имя — личные данные: в ответы помощника оно не попадает.
  run(`UPDATE tenants SET inn='0910003701', settings=json_set(settings, '$.site', 'https://www.habez-gips.ru', '$.ogrn', '1020900752311', '$.director', ?) WHERE id=1`, DIRECTOR);
  agent = await import("../src/ai/agent/runtime/agent.js");
  mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
  tools = await import("../src/ai/agent/tools/index.js");
  model = await import("../src/ai/agent/factory/model.js");
  docs = await import("../src/ai/agent/factory/documents.js");
  route = await import("../src/ai/agent/factory/route.js");
  router = await import("../src/ai/agent/retrieval/router.js");
  check = await import("../src/ai/agent/factory/check.js");
  evalmod = await import("../src/ai/agent/eval/eval-3-2.js");
  slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
  catalog = all("SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.sections, p.spec_tables, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id");
});

const data = (scope = "staff") => model.loadFactoryData(T(scope));
const rel = (slug, scope = "staff") => { const d = data(scope); return model.productFactory(d, d.products.find((p) => p.slug === slug)); };

describe("документы — производная запись над наблюдениями", () => {
  test("дата документа, дата записи в №1 и дата внесения — раздельно; дата из названия помечена", () => {
    assert.equal(docs.dateFromTitle("Письмо главного технолога завода от 05.09.2026"), "2026-09-05");
    assert.equal(docs.dateFromTitle("Прайс завода от 6 сентября 2026"), "2026-09-06");
    assert.equal(docs.dateFromTitle("Паспорт качества"), null);
    assert.equal(docs.revisionFromTitle("ТУ на ТЕПЛОКОМ, редакция 2"), "2");
    assert.equal(docs.revisionFromTitle("Паспорт качества"), null, "редакция не выдумывается");
    const d = data().documents;
    const letter = d.find((x) => x.reference === "technologist-note-2026-09-05");
    assert.deepEqual([letter.date.value, letter.date.basis, letter.providedBy], ["2026-09-05", "document", ["factory_technologist"]]);
    const pack = d.find((x) => x.reference === "app1-commit-3bbbfb3");
    assert.equal(pack.date, null, "у пакета паспортов даты документа нет");
    assert.equal(pack.recordedInApp1, "2026-09-10", "дата записи в №1 — отдельно");
    assert.ok(pack.capturedAt && pack.titleKnown === false && /название документа не записано/.test(pack.title));
  });
  test("один документ на несколько товаров — без копий документа", () => {
    const d = data().documents.filter((x) => x.reference === "app1-commit-3bbbfb3");
    assert.equal(d.length, 1);
    assert.deepEqual(d[0].products.map((p) => p.slug).sort(), ["paint-facade", "paint-interior", "polymer-waterproofing"]);
  });
  test("не документы: подставленное программой, без первоисточника, вывод модели", () => {
    const types = new Set(data("admin").documents.map((x) => x.type));
    for (const t of ["generated_default", "unknown_legacy_origin", "ai_inference", "manual_entry"]) assert.ok(!types.has(t), t);
  });
  test("разные даты документов одного вида — расхождение, победитель по дате не выбирается", () => {
    const c = data().docConflicts.dates.find((x) => x.type === "quality_passport" && x.docs.length === 2);
    assert.ok(c && c.docs.map((x) => x.date).sort().join() === "2026-08-01,2026-09-15");
    const v = data().docConflicts.value;
    assert.ok(v.some((x) => /Бетоноконтакт/i.test(x.product)), "разные значения срока хранения отмечены");
  });
});

describe("завод и связи завод ↔ товар", () => {
  test("завод из реквизитов: название, юрлицо, адрес — как адрес организации; полей, которых нет в данных, нет", () => {
    const h = data().home;
    assert.equal(h.id, "home");
    assert.equal(h.location.kind, "organization_address");
    for (const k of ["area", "capacity", "employees", "productivity", "director"]) assert.ok(!(k in h), k);
    assert.equal(data("public").home.requisites, null, "ИНН и ОГРН гостю не отдаются");
    assert.equal(data("staff").home.requisites.ogrn, "1020900752311");
  });
  test("четыре состояния: CONFIRMED, INFERRED, UNKNOWN, CONFLICTED", () => {
    assert.equal(rel("melissa").status, "CONFIRMED", "этикетка называет изготовителя");
    assert.equal(rel("shov").status, "INFERRED", "письмо технолога и паспорт — косвенно");
    assert.equal(rel("koroed").status, "UNKNOWN", "только карточка");
    assert.equal(rel("teplokom").status, "CONFLICTED", "два изготовителя");
    assert.deepEqual(model.RELATION_STATUSES, ["CONFIRMED", "INFERRED", "UNKNOWN", "CONFLICTED"]);
  });
  test("вывод не становится подтверждением; основания названы", () => {
    const r = rel("shov");
    const home = r.production.find((x) => x.factoryId === "home");
    assert.equal(home.status, "INFERRED");
    assert.ok(home.basis.length >= 2 && home.basis.every((b) => ["document", "card"].includes(b.kind)));
  });
  test("две площадки — не противоречие; другой завод в данных — отдельная сущность", () => {
    const r = rel("nal");
    assert.deepEqual(r.production.map((x) => x.status), ["CONFIRMED", "CONFIRMED"]);
    assert.ok(data().factories.has(r.production.find((x) => x.factoryId !== "home").factoryId));
  });
  test("ассортимент ≠ производство: прайс и сайт завода не дают даже «косвенно»", () => {
    const r = rel("gkl");
    assert.equal(r.status, "UNKNOWN");
    assert.deepEqual(r.assortment.map((a) => a.kind).sort(), ["catalog", "factory_site", "price_list"]);
    assert.equal(r.catalog.status, "CONFIRMED", "товар в каталоге завода — факт");
  });
  test("марка — не завод; ГОСТ/ТУ — не документ завода; «Изготовитель гарантирует» — изготовитель без имени", () => {
    const gkl = rel("gkl");
    assert.ok(gkl.brands.includes("ХАБЕЗ") && gkl.status === "UNKNOWN");
    const shov = rel("shov");
    assert.ok(shov.norm && !shov.production.some((x) => x.basis.some((b) => b.text.includes(shov.norm))));
    // Карточка: изготовитель без имени — не основание; с именем завода — прямое указание.
    const d = data();
    const card = (text) => model.productFactory(d, { id: 999999, slug: "card-test", name: "Смесь «ТЕСТ»", category: "Шпаклевка", sections: JSON.stringify([{ title: "Гарантия производителя", text }]) });
    const unnamed = card("Изготовитель гарантирует соответствие смеси требованиям ГОСТ.");
    assert.deepEqual([unnamed.status, unnamed.unnamedManufacturer.length], ["UNKNOWN", 1]);
    assert.equal(card("Изготовитель: ООО «Хабезский гипсовый завод».").status, "CONFIRMED");
  });
  test("права: гость — без наблюдений; сотрудник — без конфиденциального, но знает, что нужна сверка", () => {
    assert.equal(data("public").observations.length, 0);
    assert.equal(rel("shov", "public").status, "UNKNOWN", "гостю письма технолога не видны");
    assert.ok(rel("shov", "public").internalDocuments > 0, "гостю можно назвать число внутренних документов");
    const k = rel("kompozit", "staff");
    assert.deepEqual([k.status, k.needsReview], ["UNKNOWN", true]);
    assert.ok(!JSON.stringify(k).includes("Стороннее"));
    const a = rel("kompozit", "admin");
    assert.ok(a.production.some((x) => x.factory.includes("Стороннее") && x.status === "CONFIRMED"));
    assert.equal(rel("teplokom", "public").needsReview, true);
  });
  test("товарные группы и поиск заводов: общие слова («завод», «смесей») завод не выбирают", () => {
    assert.equal(model.groupFromQuestion("какие сухие смеси выпускает завод")?.label, "сухие смеси");
    assert.equal(model.groupFromQuestion("какие краски")?.label, "краски");
    const d = data();
    assert.deepEqual(model.searchFactories(d, ["завод"]).map((f) => f.id), ["home"]);
    assert.ok(model.searchFactories(d, ["черкесский"])[0].id.startsWith("m-"));
    assert.deepEqual(model.searchFactories(d, ["habez"]).map((f) => f.id), ["home"]);
  });
});

describe("маршрут: пять намерений и прежние вопросы", () => {
  const r = (q, state = {}) => router.routeQuestion(q, { catalog, state });
  test("намерения Phase 3.4", () => {
    for (const [q, intent] of [["Что известно о заводе?", "factory_profile"], ["Расскажи про завод", "factory_profile"], ["Где находится завод?", "factory_lookup"],
      ["Какая мощность завода?", "factory_lookup"], ["Что производит Habez?", "factory_products"], ["Какие краски выпускает завод?", "factory_products"],
      ["Какие товарные группы относятся к заводу?", "factory_products"], ["Какие виды гипсокартона есть в ассортименте?", "factory_products"],
      ["На каком заводе производится ШОВ?", "product_factory"], ["Где производится ШОВ?", "product_factory"], ["Кто производитель МЕЛИССЫ?", "product_factory"],
      ["Какие документы есть на ШОВ?", "factory_documents"], ["Есть ли паспорт на ШОВ?", "factory_documents"], ["Какой документ подтверждает прочность ШОВ?", "factory_documents"],
      ["Какие источники используются?", "factory_documents"], ["Что указано в паспорте качества краски ИНТЕРЬЕР?", "factory_documents"]]) {
      assert.equal(r(q).intent, intent, q);
    }
  });
  test("прежние вопросы не перехвачены", () => {
    for (const [q, intent] of [["Откуда значение прочности сцепления у ШОВ?", "source"], ["Какие есть фасовки ГКЛ?", "packaging"], ["Что использовать для швов ГКЛ?", "application"],
      ["Расскажи про ШОВ", "product_lookup"], ["Сравни ШОВ и Стандарт", "comparison"], ["Как применять КОРОЕД?", "usage"]]) {
      assert.equal(r(q).intent, intent, q);
    }
  });
  test("«гипсокартон» в вопросе о документах — группа товаров, а не уточнение", () => {
    // В тестовой базе лист один (находится по имени), в рабочей — четыре (группа).
    const x = r("Какие документы есть на гипсокартон?");
    assert.deepEqual([x.intent, x.ambiguousProducts.length], ["factory_documents", 0]);
    assert.ok(x.products.length && x.products.every((p) => /гипсокартон/i.test(p.name)));
  });
  test("вид документа, характеристика и «ещё» распознаются", () => {
    assert.deepEqual(route.docTypesFromQuestion("есть ли паспорт"), ["quality_passport"]);
    assert.ok(r("Какой документ подтверждает прочность сцепления ШОВ?").specs.keys.includes("adhesion_strength"));
    assert.equal(r("Какие ещё товары выпускает этот завод?", { current_factory: "home", last_intent: "product_factory" }).factory.more, true);
  });
});

describe("многоходовая беседа", () => {
  test("ШОВ → «Где его производят?» → «этот завод» → «эти товары»", async () => {
    let state = {};
    let refBase = 0;
    const history = [];
    const turn = async (q) => {
      const x = await ask(q, { state, refBase, history: [...history] });
      history.push({ role: "user", content: q }, { role: "assistant", content: x.answer });
      state = x.state; refBase += x.context.evidence.length;
      return x;
    };
    const a = await turn("Расскажи про ШОВ");
    assert.equal(a.profile.factory.status, "INFERRED", "в паспорте — раздел «Производитель / завод»");
    const b = await turn("Где его производят?");
    assert.deepEqual([b.intent, b.route.productSlugs, b.route.productsFrom, state.current_factory], ["product_factory", ["shov"], "state", "home"]);
    const c = await turn("Какие ещё товары выпускает этот завод?");
    assert.equal(c.intent, "factory_products");
    assert.ok(!c.factory.items.some((x) => x.slug === "shov"));
    const d = await turn("Какие документы есть по этим товарам?");
    assert.equal(d.intent, "factory_documents");
    assert.ok(d.documents.length >= 4);
    assert.ok(refBase > a.context.evidence.length + b.context.evidence.length, "номера [E#] сквозные");
  });
});

describe("ответ: уровни сведений и проверка", () => {
  test("контекст разделяет факт завода, документ, наблюдение и вывод", async () => {
    const x = await ask("Где производится ШОВ?");
    for (const part of ["ФАКТ ЗАВОДА", "КОСВЕННО (вывод, прямо не подтверждено)", "ДОКУМЕНТ:", "в документе указано", "это НЕ дата документа"]) assert.ok(x.context.text.includes(part), part);
    assert.ok(x.citations.some((c) => c.kind === "document") && x.citations.some((c) => c.kind === "catalog"));
  });
  test("«производится на заводе» без основания, выдуманный документ и дата — ловятся", () => {
    const items = [{ short: "ШОВ", status: "INFERRED" }, { short: "МЕЛИССА", status: "CONFIRMED" }];
    assert.deepEqual(check.factoryMismatch("ШОВ производится на Хабезском гипсовом заводе.", items), ["ШОВ"]);
    assert.deepEqual(check.factoryMismatch("Есть косвенное указание, что ШОВ производится на Хабезском заводе, прямо это не подтверждено.", items), []);
    assert.deepEqual(check.factoryMismatch("МЕЛИССА производится на Хабезском заводе [E1].", items), []);
    assert.deepEqual(check.inventedDocuments("На ШОВ есть сертификат соответствия.", ["factory_technologist"]), ["сертификат соответств"]);
    assert.deepEqual(check.inventedDocuments("Сертификата соответствия в данных нет.", []), []);
    assert.deepEqual(check.unsupportedDates("Паспорт от 01.02.2025.", "письмо от 05.09.2026"), ["2025-02-01"]);
    assert.deepEqual(check.unsupportedDates("Письмо от 05.09.2026 [E1].", "дата документа: 2026-09-05"), []);
  });
  test("личные данные не попадают в ответ: имя директора, почта, телефон; технолог — роль", async () => {
    for (const scope of ["public", "staff", "admin"]) {
      for (const q of ["Что известно о заводе?", "Какие документы есть у ШОВ?", "Где находится завод?"]) {
        const x = await ask(q, { scope });
        const all = JSON.stringify({ c: x.context.text, a: x.answer, f: x.factory, d: x.documents });
        assert.ok(!all.includes(DIRECTOR) && !/@|\+7|8 \(9/.test(all), `${scope}: ${q}`);
      }
    }
  });
  test("пустой ответ модели не выдаётся за готовый", async () => {
    const empty = { name: "empty", model: "empty", capabilities: { streaming: true, tools: false, maxOutputTokens: 100 },
      async* stream() { yield { type: "done", stopReason: "end_turn", usage: {} }; } };
    const x = await ask("Где производится ШОВ?", { provider: empty });
    assert.equal(x.grounding.emptyAnswer, true);
    assert.equal(x.grounding.grounded, false);
    assert.match(x.answer, /повторите вопрос/);
  });
  test("модель называет товар коротким именем-словом («Гидроизоляция») — инструмент его находит", async () => {
    const { createToolRunner } = await import("../src/ai/agent/runtime/tool-runner.js");
    const { createBundle } = await import("../src/ai/agent/runtime/bundle.js");
    const bundle = createBundle({ scope: "staff" });
    const runner = createToolRunner({ ctx: T("staff"), catalog, bundle, budget: { maxToolCalls: 4 }, calls: [], allowed: new Set() });
    const out = runner("get_factory_documents", { products: ["Гидроизоляция"] });
    assert.ok(!/не найден/.test(out) && out.includes("гидроизоляция"), out.slice(0, 200));
  });
  test("гостю — ни одного документа из слоя знаний и ни одной ссылки на него", async () => {
    const x = await ask("Какие документы есть у краски ИНТЕРЬЕР?", { scope: "public" });
    assert.ok(!x.context.text.includes("ДОКУМЕНТ:") && !x.context.text.includes("app1-commit"));
    assert.ok(x.citations.every((c) => c.kind !== "document"));
  });
});

describe("детерминированные случаи Phase 3.4", () => {
  const set = JSON.parse(readFileSync(resolve(apiRoot, "test/fixtures/ai-eval-cases-3-4.json"), "utf8"));
  const cases = set.cases;
  test("в наборе 30+ случаев нужных групп, выборка live — 12", () => {
    const count = (g) => cases.filter((c) => c.group === g).length;
    assert.ok(cases.length >= 30);
    assert.ok(count("lookup") >= 5 && count("product_factory") >= 5 && count("factory_products") >= 5 && count("documents") >= 5
      && count("provenance") >= 4 && count("conflicts") >= 3 && count("multi_turn") >= 3);
    assert.equal(set.live.length, 12);
  });
  for (const c of cases) {
    test(`#${c.id} ${c.group}${c.scope ? ` (${c.scope})` : ""}: ${c.turns.join(" → ")}`, async () => {
      const { last } = await evalmod.runConversation(c, { provider: mock });
      const out = evalmod.evaluateCase32(c, last, { slugOf });
      assert.ok(out.pass, out.fails.join("; "));
    });
  }
  test("все случаи × три роли — ни одной записи в базу", async () => {
    const n = changes();
    for (const c of cases) for (const scope of ["public", "staff", "admin"]) await evalmod.runConversation(c, { provider: mock, scope });
    assert.equal(changes(), n);
  });
});
