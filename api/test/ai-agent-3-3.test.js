// Habez AI Phase 3.3: Product Intelligence. Сценарии применения, механизм
// пригодности (пять состояний), подбор без рейтинга, паспорт товара,
// инструкция из данных, совместимость, права на подборе, проверка «подходит»
// вопреки статусу, многоходовой подбор и 46 детерминированных случаев.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-3-3.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let ids, get, all, agent, mock, tools, uc, suit, sel, prof, evalmod, slugOf;
const T = (scope) => ({ tenantId: 1, scope });
const changes = () => get("SELECT total_changes() AS n").n;
const ask = (question, extra = {}) => agent.runAgent({ tenantId: 1, scope: "staff", question, provider: mock, ...extra });

before(async () => {
  ids = await prepareAiDb();
  ({ get, all } = await import("../src/db/index.js"));
  for (const s of ["sindika", "finish", "ekonom", "zhako", "akvalayt"]) ids[s] = get("SELECT id FROM products WHERE slug=?", s)?.id;
  agent = await import("../src/ai/agent/runtime/agent.js");
  mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();
  tools = await import("../src/ai/agent/tools/index.js");
  uc = await import("../src/ai/agent/intel/usecases.js");
  suit = await import("../src/ai/agent/intel/suitability.js");
  sel = await import("../src/ai/agent/intel/select.js");
  prof = await import("../src/ai/agent/intel/profile.js");
  evalmod = await import("../src/ai/agent/eval/eval-3-2.js");
  slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
});

const evaluate = (slug, useCaseId, scope = "staff") => {
  const id = get("SELECT id FROM products WHERE slug=?", slug).id;
  const product = tools.callTool("get_product", { productId: id }, T(scope));
  const sp = tools.callTool("get_product_specs", { productId: id }, T(scope));
  return suit.evaluateSuitability({ product, sp, useCase: uc.useCaseById(useCaseId) });
};

describe("сценарии применения", () => {
  test("задача пользователя → канонический сценарий", () => {
    for (const [q, id] of [["Что использовать для швов ГКЛ?", "drywall_joint_treatment"], ["заделка стыков гипсокартона", "drywall_joint_treatment"],
      ["Что подходит для ГКЛ?", "drywall_base"], ["Что для монтажа ПГП?", "board_bonding"], ["штукатурка для фасада", "facade_plastering"],
      ["для ванной", "wet_rooms"], ["Что есть от плесени?", "mold_treatment"], ["Чем выровнять пол?", "floor_leveling"], ["Чем клеить плитку?", "tile_laying"],
      ["клей для тёплого пола", "warm_floor"], ["для внутренних работ", "interior_works"]]) {
      assert.equal(uc.resolveUseCase(q)?.id, id, q);
    }
    assert.equal(uc.resolveUseCase("Какая погода завтра?"), null, "сценарий не выдумывается");
  });
  test("у каждого сценария — разделы-кандидаты, группы признаков и важные характеристики", () => {
    for (const u of uc.USE_CASES) {
      assert.ok(u.types instanceof RegExp && u.requires.length && u.requires.every((g) => g.length) && Array.isArray(u.keySpecs), u.id);
    }
  });
  test("название товара-кандидата — не задача («АНТИПЛЕСЕНЬ» ≠ «от плесени»), основание — задача («швы ГКЛ»)", async () => {
    assert.equal((await ask("Какое время высыхания у АНТИПЛЕСЕНЬ?")).useCase, null);
    assert.equal((await ask("Что использовать для швов ГКЛ?")).useCase, "drywall_joint_treatment");
  });
});

describe("пригодность: пять состояний", () => {
  test("SUPPORTED — все группы признаков (ШОВ: назначение + основание ГКЛ)", () => {
    const r = evaluate("shov", "drywall_joint_treatment");
    assert.equal(r.status, "SUPPORTED");
    assert.ok(r.supporting.some((s) => s.kind === "text") && r.supporting.some((s) => s.kind === "prop"));
  });
  test("PARTIALLY_SUPPORTED — часть групп (ФИНИШ: основание ГКЛ есть, о швах не сказано)", () => {
    const r = evaluate("finish", "drywall_joint_treatment");
    assert.equal(r.status, "PARTIALLY_SUPPORTED");
    assert.ok(r.missing.length === 1);
  });
  test("NOT_SUPPORTED — явное «НЕТ» (Синдика: «швы ГКЛ — НЕТ», ШОВ: «фасады — НЕТ»)", () => {
    assert.equal(evaluate("sindika", "drywall_joint_treatment").status, "NOT_SUPPORTED");
    assert.equal(evaluate("shov", "facade_plastering").status, "NOT_SUPPORTED");
  });
  test("INSUFFICIENT_DATA — признаков нет ни за, ни против; это не «не подходит»", () => {
    const r = evaluate("ekonom", "wet_rooms");
    assert.equal(r.status, "INSUFFICIENT_DATA");
    assert.equal(r.against.length, 0);
  });
  test("CONFLICTED — спор по нужному признаку (администратор видит конфиденциальное «ДА» против «НЕТ»)", () => {
    assert.equal(evaluate("shov", "facade_plastering", "admin").status, "CONFLICTED");
  });
  test("конфиденциальное не влияет на оценку гостю и сотруднику", () => {
    assert.equal(evaluate("shov", "facade_plastering", "public").status, "NOT_SUPPORTED");
    assert.equal(evaluate("shov", "facade_plastering", "staff").status, "NOT_SUPPORTED");
  });
});

describe("подбор", () => {
  test("кандидаты — только разделы сценария; основание (ГКЛ) и чужие разделы не попадают", () => {
    const res = sel.selectProducts({ ctx: T("staff"), useCase: uc.useCaseById("drywall_joint_treatment"), calls: [] });
    assert.ok(res.length > 3);
    assert.ok(res.every((x) => /шпакл|штукатур/i.test(x.p.category)), "только шпаклёвки и штукатурки");
    assert.ok(!res.some((x) => x.p.slug === "gkl"));
  });
  test("группы по статусу, внутри — порядок каталога, а не рейтинг", () => {
    const res = sel.selectProducts({ ctx: T("staff"), useCase: uc.useCaseById("facade_plastering"), calls: [] });
    const order = ["SUPPORTED", "PARTIALLY_SUPPORTED", "CONFLICTED", "INSUFFICIENT_DATA", "NOT_SUPPORTED"];
    for (let i = 1; i < res.length; i += 1) {
      const a = order.indexOf(res[i - 1].r.status);
      const b = order.indexOf(res[i].r.status);
      assert.ok(a < b || (a === b && res[i - 1].position <= res[i].position), `${res[i - 1].p.slug} → ${res[i].p.slug}`);
    }
  });
  test("фасовка из вопроса отмечается у каждого кандидата", () => {
    const res = sel.selectProducts({ ctx: T("staff"), useCase: uc.useCaseById("drywall_joint_treatment"), size: "25 кг", calls: [] });
    assert.equal(res.find((x) => x.p.slug === "shov").packaging, true);
    assert.equal(sel.sizeFromQuestion("А если нужна фасовка 25 кг?"), "25 кг");
  });
  test("ответ подбора: статусы и объяснения — от системы, модель их только излагает", async () => {
    const r = await ask("Что использовать для швов ГКЛ?");
    assert.equal(r.mode, "PRODUCT_SELECTION");
    const shov = r.suitability.find((s) => s.slug === "shov");
    assert.equal(shov.status, "SUPPORTED");
    assert.ok(shov.supporting.length && shov.refs.length, "основания со ссылками [E#]");
    for (const s of r.suitability) for (const k of ["product", "status", "supporting", "against", "conflicting", "missing", "reason"]) assert.ok(k in s, k);
    assert.match(r.context.text, /НЕ меняй их, не ранжируй/);
  });
});

describe("паспорт, применение, совместимость", () => {
  test("паспорт: разделы вместо всех характеристик подряд", async () => {
    const r = await ask("Расскажи про ШОВ");
    assert.equal(r.mode, "PRODUCT_PROFILE");
    for (const part of ["- назначение:", "- основные свойства:", "- применимость, указано ДА:", "- применимость, указано НЕТ:", "- известные расхождения:", "- источники:"]) assert.ok(r.context.text.includes(part), part);
    const full = tools.callTool("get_product_specs", { productId: ids.shov }, T("staff")).properties.length;
    assert.ok(r.context.properties.length <= full, "в контексте — не больше, чем есть");
    assert.ok(r.profile.keySpecs <= 14, "основных свойств — не больше 14");
  });
  test("применение: раздел карточки и значения отдельно, чего нет — названо", async () => {
    const r = await ask("Как применять КОРОЕД?");
    assert.equal(r.mode, "PRODUCT_APPLICATION");
    assert.ok(r.application.kinds.includes("вода") && r.application.missing.includes("расход"));
    assert.match(r.context.text, /общие строительные знания НЕ добавлять/);
  });
  test("совместимость: без прямого упоминания — UNKNOWN, ответ без модели", async () => {
    const r = await ask("Совместим ли ШОВ с СТАНДАРТ?");
    assert.deepEqual([r.mode, r.compatibility.status, r.model], ["INSUFFICIENT_DATA", "UNKNOWN", null]);
    const a = { id: 1, slug: "a", sections: [{ title: "Порядок работ", text: "Основание обработать грунтовкой «Эконом»." }] };
    const b = { id: ids.ekonom, slug: "ekonom", sections: [] };
    const catalog = all("SELECT p.id, p.slug, p.name, p.short_name, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id");
    assert.equal(prof.compatibilityBetween(a, b, catalog).status, "STATED");
  });
});

describe("проверка ответа: «подходит» вопреки статусу", () => {
  test("модель не может назвать подходящим то, что система так не оценила", () => {
    const items = [{ short: "ШОВ", status: "SUPPORTED" }, { short: "СТАНДАРТ", status: "INSUFFICIENT_DATA" }, { short: "ФИНИШ", status: "PARTIALLY_SUPPORTED" }];
    assert.deepEqual(suit.suitabilityMismatch("ШОВ подходит [E1].\nСТАНДАРТ тоже подходит.", items), ["СТАНДАРТ"]);
    assert.deepEqual(suit.suitabilityMismatch("СТАНДАРТ: данных недостаточно, чтобы сказать, подходит ли.\nФИНИШ подходит частично.", items), []);
    assert.deepEqual(suit.suitabilityMismatch("ФИНИШ — лучший выбор.", items), ["ФИНИШ"]);
  });
});

describe("многоходовой подбор", () => {
  test("подбор → «Почему?» → фасовка 25 кг → «А что у Стандарта?»", async () => {
    let state = {};
    let refBase = 0;
    const history = [];
    const turn = async (q) => {
      const r = await ask(q, { state, refBase, history: [...history] });
      history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
      state = r.state; refBase += r.context.evidence.length;
      return r;
    };
    const a = await turn("Что использовать для швов ГКЛ?");
    assert.deepEqual([state.current_use_case, state.current_product], ["drywall_joint_treatment", "shov"]);
    const b = await turn("Почему?");
    assert.deepEqual([b.intent, b.route.productSlugs, b.suitability[0].status], ["suitability", ["shov"], "SUPPORTED"]);
    const c = await turn("А если нужна фасовка 25 кг?");
    assert.equal(c.intent, "application");
    assert.ok(c.suitability.every((s) => s.packaging !== undefined));
    const d = await turn("А что у Стандарта?");
    assert.deepEqual([d.intent, d.useCase, d.suitability[0].status, d.mode], ["suitability", "drywall_joint_treatment", "INSUFFICIENT_DATA", "INSUFFICIENT_DATA"]);
    assert.ok(a.context.evidence.length && refBase > a.context.evidence.length);
  });
});

describe("46 детерминированных случаев Phase 3.3", () => {
  const cases = JSON.parse(readFileSync(resolve(apiRoot, "test/fixtures/ai-eval-cases-3-3.json"), "utf8")).cases;
  test("в наборе 46 случаев нужных групп", () => {
    const count = (g) => cases.filter((c) => c.group === g).length;
    assert.ok(cases.length >= 40);
    assert.ok(count("profile") >= 6 && count("selection") >= 8 && count("application") >= 8 && count("conditions") >= 5 && count("variants") >= 4 && count("comparison") >= 5 && count("conflicts") >= 4);
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
