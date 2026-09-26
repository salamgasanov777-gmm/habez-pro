// Habez AI Phase 3.1: контрольный набор из 15 вопросов, споры, шесть
// инструментов и проверка ответа (validator). Модель — заглушка: ответ
// собирается из данных, сеть не нужна. Текст ответа настоящей модели на
// этом же наборе проверяет npm run ai:eval.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { apiRoot, prepareAiDb, LEVEL_VALUES, SECRET_REF } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-grounding.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let ids, get, all, insert, agent, mock, tools, ctxmod, evalmod, slugOf, conflictsMod;
const T = (scope) => ({ tenantId: 1, scope });

before(async () => {
  ids = await prepareAiDb();
  ({ get, all, insert } = await import("../src/db/index.js"));
  const ev = await import("../src/ai/knowledge/evidence.js");
  // Одно свойство в двух возрастах: 7 и 28 суток — разные условия, не спор.
  for (const [age, value] of [[7, "не менее 4 МПа"], [28, "не менее 7,5 МПа"]]) {
    ev.createObservation(1, { productId: ids.styazhka, specKey: "compressive_strength", originalValue: value, sourceType: "quality_passport",
      sourceReference: `passport-styazhka-${age}`, conditions: { age_days: age }, conditionText: `Прочность на сжатие в возрасте ${age} суток`, accessLevel: "internal" }, null);
  }
  // Черновик: гость его не видит, сотрудник — видит.
  const cat = get("SELECT category_id AS c FROM products WHERE id=?", ids.shov).c;
  ids.draft = insert("products", { tenant_id: 1, slug: "chernovik", name: "Шпаклёвка «ЧЕРНОВИК»", short_name: "ЧЕРНОВИК", category_id: cat, status: "draft", summary: "Черновик карточки" });
  agent = await import("../src/ai/agent/runtime/agent.js");
  mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
  tools = await import("../src/ai/agent/tools/index.js");
  conflictsMod = await import("../src/ai/agent/retrieval/conflicts.js");
  ctxmod = await import("../src/ai/agent/runtime/context.js");
  evalmod = await import("../src/ai/agent/eval/grounding-eval.js");
  slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
});

const ask = (scope, question, history = []) => agent.runAgent({ tenantId: 1, scope, question, history, provider: mock });
const prop = (r, key, pred = () => true) => r.context.properties.filter((p) => p.key === key && pred(p));
const changes = () => get("SELECT total_changes() AS n").n;

describe("контрольный набор: 15 вопросов", () => {
  test("в наборе 15 вопросов пяти групп, у каждого — ожидаемое поведение", () => {
    const cases = evalmod.loadEvalCases();
    assert.equal(cases.length, 15);
    assert.deepEqual([...new Set(cases.map((c) => c.group))].sort(), ["comparison", "conditions", "conflict", "product", "unsupported"]);
    assert.ok(cases.every((c) => c.behavior && c.check));
  });

  for (const c of JSON.parse(readFileSync(resolve(apiRoot, "test/fixtures/ai-eval-cases.json"), "utf8")).cases) {
    test(`#${c.id} ${c.group}: ${c.question}`, async () => {
      const r = await ask("staff", c.question);
      const out = evalmod.evaluateCase(c, r, { slugOf });
      assert.ok(out.pass, out.fails.join("; "));
      assert.equal(r.grounding.invalidCitations.length, 0);
      assert.equal(r.grounding.unsupported.length, 0, `заглушка берёт только данные: ${r.grounding.unsupported}`);
    });
  }

  test("#14: выдуманный товар — модель не вызывается, ответ «товара нет»", async () => {
    const r = await ask("public", "Расскажи про штукатурку ГИПСОМАКС-900");
    assert.equal(r.model, null);
    assert.match(r.answer, /«ГИПСОМАКС-900» в каталоге Habez нет/);
    assert.deepEqual(r.found, [], "похожие штукатурки за него не выдаются");
  });

  test("имена с падежами и заглавными: «ПОБЕДУ», «стяжки», «Хабез» не находит гипсокартон", async () => {
    const detect = (q) => agent.runAgent({ tenantId: 1, scope: "staff", question: q, provider: mock }).then((r) => r.products.map((id) => slugOf.get(id)));
    assert.deepEqual(await detect("Расскажи про стяжку"), ["styazhka"]);
    assert.deepEqual(await detect("Какие фасовки у Хабез?"), []);
    assert.deepEqual((await ask("staff", "Что подходит для «тёплого пола»?")).unknown, [], "задача в кавычках — не товар");
    assert.deepEqual((await ask("staff", "Расскажи про ШОВ")).unknown, []);
  });
});

describe("споры: победитель не выбирается", () => {
  test("Стандарт: 0,5 МПа и ≥0,6 МПа → unresolved (D1)", async () => {
    const [p] = prop(await ask("staff", "Какая прочность Стандарта?"), "adhesion_strength");
    assert.equal(p.status, "unresolved");
    assert.deepEqual(p.values.map((v) => v.display).sort(), ["0,5 МПа", "не менее 0,6 МПа"]);
    assert.ok(p.items.includes("D1"));
  });

  test("ШОВ: 0,5 и ≥0,3 (7 сут) → unresolved (D4), без замены", async () => {
    const r = await ask("staff", "Какая прочность ШОВ?");
    const ps = prop(r, "adhesion_strength");
    assert.ok(ps.length >= 2 && ps.every((p) => p.status === "unresolved" && p.items.includes("D4")));
    const shown = ps.flatMap((p) => p.values.map((v) => v.display));
    assert.ok(shown.some((v) => /0,5 МПа$/.test(v)) && shown.includes("не менее 0,3 МПа"), shown.join(" / "));
    assert.match(r.context.text, /D4 \(замена НЕ подтверждена/);
  });

  test("ШОВ: 2 и ≥2,5 → unresolved (D2)", async () => {
    const ps = prop(await ask("staff", "Какая прочность ШОВ?"), "compressive_strength");
    assert.ok(ps.every((p) => p.status === "unresolved" && p.items.includes("D2")));
    assert.deepEqual(ps.flatMap((p) => p.values.map((v) => v.display)).sort(), ["2 МПа", "не менее 2,5 МПа"]);
  });

  test("ШОВ: 60 и 70 мин → unresolved (D3/D6: одно ли это свойство — не решено)", async () => {
    const r = await ask("staff", "Какое время схватывания у ШОВ?");
    const a = prop(r, "setting_time");
    const b = prop(r, "setting_time_start");
    assert.ok(a.length && b.length);
    for (const p of [...a, ...b]) assert.equal(p.status, "unresolved");
    assert.match(r.context.text, /D3, D6 \(одно ли это свойство — не решено/);
  });

  test("АНТИПЛЕСЕНЬ: 90–100 мл/м² и 200 г/м² → unresolved (D5), единицы не пересчитываются", async () => {
    const r = await ask("staff", "Что с АНТИПЛЕСЕНЬ?");
    const [p] = prop(r, "consumption");
    assert.equal(p.status, "unresolved");
    assert.equal(new Set(p.values.map((v) => v.unit)).size, 2, "две разные единицы");
    assert.deepEqual(p.values.map((v) => v.display).sort(), ["200 г/м²", "90–100 мл/м²"]);
    assert.match(r.context.text, /единицы разные, НЕ пересчитывать/);
  });

  test("фасовки ГКЛ 9,5 и 12,5 мм — отдельные строки со своими ссылками, без спора", async () => {
    const r = await ask("staff", "Чем отличаются ГКЛ 9,5 и 12,5 мм?");
    const v = r.context.variants;
    assert.deepEqual(v.map((x) => x.unit), ["лист 9,5 мм", "лист 12,5 мм"]);
    assert.notEqual(v[0].ref, v[1].ref);
    assert.deepEqual(v.map((x) => x.perPallet), [63, 51]);
    assert.equal(r.conflicts, 0);
  });

  test("7 и 28 суток — разные условия, не спор", async () => {
    const r = await ask("staff", "Какая прочность у стяжки?");
    const ps = prop(r, "compressive_strength", (p) => /суток/.test(p.conditionText || ""));
    assert.equal(ps.length, 2);
    assert.notEqual(ps[0].conditionKey, ps[1].conditionKey);
    assert.ok(ps.every((p) => p.status === "single"));
  });

  test("КОРОЕД: 5–7 л → water_per_bag, условие per=bag, фасовка «мешок»; связь с water_ratio — вопрос D10", async () => {
    const r = await ask("staff", "Что означает 5–7 л у КОРОЕДа?");
    const [w] = prop(r, "water_per_bag");
    assert.ok(w, "есть ключ water_per_bag");
    assert.equal(w.conditionKey, "per=bag");
    assert.match(w.variant || "", /мешок/);
    assert.ok(w.items.includes("D10"));
    assert.doesNotMatch(r.context.text, /л\/кг/);
  });

  test("гостю споры сверки не раскрываются — только факт открытых вопросов", async () => {
    const r = await ask("public", "Какая прочность ШОВ?");
    assert.ok(r.context.properties.every((p) => !p.items.length));
    assert.match(r.context.text, /нерешённ\. вопрос/);
    assert.doesNotMatch(r.context.text, /D4|D2|technolog/);
  });
});

describe("шесть инструментов: права, только чтение, пустой результат", () => {
  const all3 = ["public", "staff", "admin"];

  test("search_products: только опубликованное; нет совпадений — пустой список", () => {
    for (const s of all3) {
      assert.ok(tools.callTool("search_products", { terms: ["шпакл"] }, T(s)).items.length > 0);
      assert.deepEqual(tools.callTool("search_products", { terms: ["абракадабра"] }, T(s)).items, []);
      assert.deepEqual(tools.callTool("search_products", { terms: [] }, T(s)).items, []);
      assert.ok(tools.callTool("search_products", { terms: ["черновик"] }, T(s)).items.every((i) => i.slug !== "chernovik"));
    }
  });

  test("get_product: черновик гостю — null, сотруднику — карточка; нет товара — null", () => {
    assert.equal(tools.callTool("get_product", { productId: ids.draft }, T("public")), null);
    assert.equal(tools.callTool("get_product", { productId: ids.draft }, T("staff")).slug, "chernovik");
    for (const s of all3) assert.equal(tools.callTool("get_product", { productId: 999999 }, T(s)), null);
  });

  test("get_product_specs: гостю — строки витрины; сотруднику — без конфиденциального; админу — всё", () => {
    const vals = (s) => JSON.stringify(tools.callTool("get_product_specs", { productId: ids.shov }, T(s)));
    const pub = vals("public");
    assert.ok(!pub.includes(LEVEL_VALUES.internal) && !pub.includes(LEVEL_VALUES.confidential) && !pub.includes("observation"));
    const staff = vals("staff");
    assert.ok(staff.includes(LEVEL_VALUES.public) && staff.includes(LEVEL_VALUES.internal) && !staff.includes(LEVEL_VALUES.confidential) && !staff.includes(SECRET_REF));
    const admin = vals("admin");
    assert.ok(admin.includes(LEVEL_VALUES.confidential) && admin.includes(SECRET_REF));
    for (const s of all3) assert.equal(tools.callTool("get_product_specs", { productId: 999999 }, T(s)), null);
  });

  test("get_product_specs: сотрудник видит не меньше гостя — каждая строка витрины есть и у него", () => {
    const { sameValueKey } = conflictsMod;
    // Значение: [ключ, текст, число (для всех), «ДА/НЕТ» тоже (внутри ключа)].
    const shown = (s, id) => tools.callTool("get_product_specs", { productId: id }, T(s)).properties
      .flatMap((p) => p.values.filter((v) => !v.hidden).map((v) => [p.key, String(v.display).toLowerCase(), sameValueKey(v.display), sameValueKey(v.display, { withBool: true })]));
    const lost = [];
    for (const { id, slug } of all("SELECT id, slug FROM products WHERE status='published'")) {
      const staff = shown("staff", id);
      const has = ([key, d, n, b]) => staff.some(([sk, sd, sn, sb]) => sd === d || sd.includes(d) || (n && sn === n) || (key && sk === key && b && sb === b));
      for (const v of shown("public", id)) if (!has(v)) lost.push(`${slug}: ${v[1]}`);
    }
    assert.deepEqual(lost, []);
  });

  test("get_product_evidence: гостю — forbidden; сотруднику — без конфиденциального; админу — всё", () => {
    assert.equal(tools.callTool("get_product_evidence", { productId: ids.shov }, T("public")).forbidden, true);
    const staff = JSON.stringify(tools.callTool("get_product_evidence", { productId: ids.shov }, T("staff")));
    assert.ok(staff.includes(LEVEL_VALUES.internal) && !staff.includes(LEVEL_VALUES.confidential) && !staff.includes(SECRET_REF));
    assert.ok(JSON.stringify(tools.callTool("get_product_evidence", { productId: ids.shov }, T("admin"))).includes(SECRET_REF));
    assert.equal(tools.callTool("get_product_evidence", { productId: 999999 }, T("staff")), null);
  });

  test("compare_products: права как у get_product_specs; недоступный товар выпадает", () => {
    const pub = tools.callTool("compare_products", { productIds: [ids.shov, ids.standart, ids.draft] }, T("public"));
    assert.deepEqual(pub.items.map((i) => i.product.id), [ids.shov, ids.standart]);
    assert.ok(!JSON.stringify(pub).includes(LEVEL_VALUES.internal));
    const staff = tools.callTool("compare_products", { productIds: [ids.shov, ids.standart] }, T("staff"));
    assert.ok(!JSON.stringify(staff).includes(LEVEL_VALUES.confidential));
    assert.deepEqual(tools.callTool("compare_products", { productIds: [999998, 999999] }, T("admin")).items, []);
    assert.throws(() => tools.callTool("compare_products", { productIds: [ids.shov] }, T("admin")), "меньше двух — ошибка аргументов");
  });

  test("search_knowledge: гостю — только витрина; сотруднику — без конфиденциального; нет совпадений — пусто", () => {
    const pub = tools.callTool("search_knowledge", { terms: ["шов", "мпа"], limit: 20 }, T("public")).items;
    assert.ok(pub.length > 0);
    assert.ok(pub.every((o) => ["product", "section", "card_row", "variant"].includes(o.type)), "гостю — ни наблюдений, ни вопросов сверки");
    assert.ok(!JSON.stringify(pub).includes(LEVEL_VALUES.internal) && !JSON.stringify(pub).includes(LEVEL_VALUES.confidential));
    const staff = tools.callTool("search_knowledge", { terms: ["мпа"], limit: 20 }, T("staff")).items;
    assert.ok(staff.some((o) => o.type === "observation") && staff.every((o) => o.access !== "confidential"));
    assert.ok(tools.callTool("search_knowledge", { terms: ["1,9 мпа"], limit: 20 }, T("admin")).items.some((o) => o.access === "confidential"));
    assert.ok(tools.callTool("search_knowledge", { terms: ["d4", "сверка"], limit: 20 }, T("staff")).items.some((o) => o.type === "question"), "вопросы сверки ищутся");
    assert.deepEqual(tools.callTool("search_knowledge", { terms: ["абракадабра"] }, T("admin")).items, []);
  });

  test("все десять — только чтение: ни одной записи в базу", () => {
    const n = changes();
    for (const s of all3) {
      tools.callTool("search_products", { terms: ["шов"] }, T(s));
      tools.callTool("get_product", { productId: ids.shov }, T(s));
      tools.callTool("get_product_specs", { productId: ids.shov }, T(s));
      tools.callTool("get_product_evidence", { productId: ids.shov }, T(s));
      tools.callTool("compare_products", { productIds: [ids.shov, ids.standart] }, T(s));
      tools.callTool("search_knowledge", { terms: ["мпа"] }, T(s));
      tools.callTool("search_factories", { terms: ["завод"] }, T(s));
      tools.callTool("get_factory", { factoryId: "home" }, T(s));
      tools.callTool("get_factory_products", { factoryId: "home" }, T(s));
      tools.callTool("get_factory_documents", { productIds: [ids.shov] }, T(s));
    }
    assert.equal(changes(), n);
    assert.deepEqual([...tools.TOOL_NAMES].sort(), ["compare_products", "get_factory", "get_factory_documents", "get_factory_products", "get_product", "get_product_evidence", "get_product_specs", "search_factories", "search_knowledge", "search_products"]);
  });

  test("агент целиком — только чтение (15 вопросов × 3 роли)", async () => {
    const n = changes();
    for (const c of evalmod.loadEvalCases()) for (const s of all3) await ask(s, c.question);
    assert.equal(changes(), n);
  });
});

describe("проверка ответа (validator)", () => {
  const ev = [
    { id: "E1", kind: "variant", productName: "ГКЛ", label: "фасовка", value: "лист 9,5 мм", variant: "лист 9,5 мм", perPallet: 63 },
    { id: "E2", kind: "variant", productName: "ГКЛ", label: "фасовка", value: "лист 12,5 мм", variant: "лист 12,5 мм", perPallet: 51 },
    { id: "E3", kind: "observation", productName: "ШОВ", property: "Прочность на сжатие", value: "не менее 2,5 МПа", condition: "в возрасте 7 сут" },
    { id: "E4", kind: "observation", productName: "ШОВ", property: "Прочность на сжатие", value: "2 МПа" },
  ];
  const check = (a, o) => ctxmod.checkAnswer(a, ev, o);

  test("ответ из данных — grounded", () => {
    const r = check("- Лист 9,5 мм: 63 шт на поддоне [E1]\n- Прочность на сжатие: не менее 2,5 МПа (7 сут) [E3]; 2 МПа [E4]");
    assert.equal(r.grounded, true, JSON.stringify(r));
    assert.deepEqual(r.citations.map((c) => c.id), ["E1", "E3", "E4"]);
  });

  test("число без evidence", () => {
    assert.deepEqual(check("Прочность: 3,7 МПа [E3]").unsupported, ["3,7 МПа"]);
  });

  test("ссылка на несуществующий E#", () => {
    const r = check("Прочность 2 МПа [E4][E12]");
    assert.deepEqual(r.invalidCitations, ["E12"]);
    assert.equal(r.grounded, false);
  });

  test("E# из другого сообщения: реестр у каждого ответа свой", async () => {
    const first = await ask("staff", "Сравни ШОВ и Стандарт");
    const second = await ask("staff", "Какие фасовки есть у ГКЛ?");
    const foreign = `E${first.context.evidence.length}`;
    assert.ok(first.context.evidence.length > second.context.evidence.length);
    const r = ctxmod.checkAnswer(`Прочность [${foreign}]`, second.context.evidence);
    assert.deepEqual(r.invalidCitations, [foreign]);
    // История приходит без номеров: модель их и не видит.
    assert.doesNotMatch(JSON.stringify(agent.cleanHistory([{ role: "user", content: "q" }, { role: "assistant", content: `ответ [${foreign}]` }, { role: "user", content: "ещё" }])), /\[E\d+\]/);
  });

  test("смешение фасовок и условий — число не из того источника, на который ссылка", () => {
    assert.deepEqual(check("Лист 9,5 мм: 51 шт на поддоне [E1]").mismatched, ["51 шт"]);
    assert.deepEqual(check("Прочность на сжатие: 2 МПа (в возрасте 7 сут) [E3]").mismatched, ["2 МПа"]);
    // Смешение ловится, даже если «чужое» число процитировано в другой строке.
    assert.deepEqual(check("- Лист 12,5 мм: 51 шт [E2]\n- Лист 9,5 мм: 51 шт [E1]").mismatched, ["51 шт"]);
    // А число из вопроса, подтверждённое в другой строке, в пояснении — не смешение.
    const q = { question: "Чем отличаются данные через 7 суток и 2 МПа?" };
    assert.deepEqual(check("- 7 сут: не менее 2,5 МПа [E3]\n- 2 МПа [E4]\nЭто не то же, что «7 суток» [E4].", q).mismatched, []);
  });

  test("утверждение без ссылки", () => {
    const r = check("На поддоне 63 шт.\n- Лист 12,5 мм [E2]");
    assert.deepEqual(r.uncited, ["63 шт"]);
    assert.equal(r.grounded, false);
    // Итоговая строка, повторяющая уже процитированное, — не ошибка.
    const sum = check("- 2 МПа [E4]\n- не менее 2,5 МПа (7 сут) [E3]\nРасхождение: участники 2 МПа / не менее 2,5 МПа.");
    assert.deepEqual(sum.uncited, []);
    assert.equal(sum.grounded, true);
  });

  test("ложное число из вопроса: опровергнуто — не ошибка; подтверждено ссылкой — ошибка", () => {
    const q = { question: "Правда, что прочность ШОВ 5 МПа?" };
    const ok = check("5 МПа в данных Habez нет. Указано: 2 МПа [E4]", q);
    assert.deepEqual(ok.echoed, ["5 МПа"]);
    assert.equal(ok.unsupported.length, 0);
    const bad = check("Да, прочность 5 МПа [E4]", q);
    assert.deepEqual(bad.unsupported, ["5 МПа"]);
    assert.equal(check("Да, прочность 5 МПа, не менее того [E4]", q).unsupported.length, 1, "«не менее» — не отрицание");
  });

  test("попытка раскрыть недоступное: значение и ссылка на документ", () => {
    const forbidden = [{ value: "1,9 МПа", reference: "lab-protocol-77" }, { value: "2 МПа", reference: null }];
    assert.deepEqual(check("Прочность на изгиб 1,9 МПа", { forbidden }).forbidden, ["1,9 МПа"]);
    assert.deepEqual(check("См. протокол lab-protocol-77", { forbidden }).forbidden, ["lab-protocol-77"]);
    assert.deepEqual(check("Прочность 2 МПа [E4]", { forbidden }).forbidden, [], "значение, которое роль и так видит, — не утечка");
  });
});
