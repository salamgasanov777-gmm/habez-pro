// Habez AI 3.5 Competitor Intelligence — HTTP панели: права трёх ролей,
// запись только администратором, проверка полей, жизненный цикл, журнал,
// изоляция компаний-арендаторов, сравнение в формате инструмента.
// Данные — синтетические (helpers/competitor-fixture.js).
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";
import { seedCompetitors } from "./helpers/competitor-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-competitors-http.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let app, get, all, ids, fx;
const H = {};
const json = (res) => JSON.parse(res.body);
const req = (method, url, headers, payload) => app.inject({ method, url, headers, payload });
const audits = (action) => get("SELECT COUNT(*) AS n FROM audit_log WHERE action=?", action).n;

before(async () => {
  ids = await prepareAiDb();
  fx = await seedCompetitors();
  ({ get, all } = await import("../src/db/index.js"));
  const { insert } = await import("../src/db/index.js");
  const { hashPassword } = await import("../src/lib/crypto.js");
  const { build } = await import("../src/server.js");
  app = await build();
  // Учётные записи со случайными паролями — только в тестовой базе.
  for (const [role, tenant] of [["customer", 1], ["manager", 1], ["admin", 1], ["admin", fx.t2]]) {
    const password = randomBytes(12).toString("base64url");
    const email = `http-${role}-${tenant}@test.habez.local`;
    insert("users", { tenant_id: tenant, email, name: `HTTP ${role}`, role, status: "active", password_hash: hashPassword(password) });
    const tenantHost = tenant === 1 ? {} : { "x-tenant": "tenant-two" };
    const res = await req("POST", "/api/auth/login", tenantHost, { email, password });
    H[`${role}${tenant === 1 ? "" : "2"}`] = { authorization: `Bearer ${json(res).accessToken}`, ...tenantHost };
  }
});
after(async () => { await app?.close(); });

describe("чтение по ролям", () => {
  test("гость — 401, покупатель — 403, данных нет", async () => {
    for (const url of ["/api/ai/competitors", `/api/ai/competitors/${fx.companies.ts.id}`, `/api/ai/competitor-products/${fx.products.tShov.id}`,
      `/api/ai/competitor-analogs?productId=${ids.shov}`, `/api/ai/competitor-compare?productId=${ids.shov}&competitorProductId=${fx.products.tShov.id}`]) {
      const g = await req("GET", url, {});
      assert.equal(g.statusCode, 401, url);
      const c = await req("GET", url, H.customer);
      assert.equal(c.statusCode, 403, url);
      assert.ok(!c.body.includes("ТестСмесь") && !g.body.includes("ТестСмесь"));
    }
  });
  test("менеджер: список, карточки, без конфиденциального (только число скрытого)", async () => {
    const list = json(await req("GET", "/api/ai/competitors", H.manager));
    const ts = list.items.find((c) => c.name === "ТестСмесь");
    assert.deepEqual([ts.brands.sort(), ts.products, ts.regions.includes("Тестовый край")], [["Марка-U", "Марка-Т"].sort(), 4, true]);
    assert.ok(ts.sources >= 2);
    assert.ok(!list.items.some((c) => c.name === "Секрет-Групп"));
    const search = json(await req("GET", "/api/ai/competitors?search=%D0%A2-%D0%A8%D0%BE%D0%B2", H.manager));
    assert.deepEqual(search.items.map((c) => c.name), ["ТестСмесь"], "поиск по имени товара");
    const card = json(await req("GET", `/api/ai/competitor-products/${fx.products.tShov.id}`, H.manager));
    assert.equal(card.product.brand, "Марка-Т");
    assert.ok(card.prices.groups.some((g) => g.basisUnit === "kg") && card.prices.groups.some((g) => g.basisUnit === "pack"));
    assert.ok(!JSON.stringify(card.prices).includes("39000"));
    assert.equal(card.prices.hidden, 1, "конфиденциальная цена — только числом");
    assert.ok(card.analogs.some((a) => a.product.short === "ШОВ" && a.status === "CONFIRMED"));
    assert.equal((await req("GET", `/api/ai/competitor-products/${fx.products.sMix.id}`, H.manager)).statusCode, 404);
  });
  test("администратор видит конфиденциальное", async () => {
    const card = json(await req("GET", `/api/ai/competitor-products/${fx.products.tShov.id}`, H.admin));
    assert.ok(JSON.stringify(card.prices).includes("39000"));
    assert.ok(json(await req("GET", "/api/ai/competitors", H.admin)).items.some((c) => c.name === "Секрет-Групп"));
  });
  test("аналоги нашего товара и статус пары: предположение помечено", async () => {
    const a = json(await req("GET", `/api/ai/competitor-analogs?productId=${ids.shov}`, H.manager));
    const inf = a.items.find((x) => x.status === "INFERRED");
    assert.deepEqual([inf.confirmed, inf.inferred, inf.relation], [false, true, null]);
    const st = json(await req("GET", `/api/ai/competitor-analogs/status?productId=${ids.standart}&competitorProductId=${fx.products.pKlei.id}`, H.manager));
    assert.deepEqual([st.status, st.confirmed, st.basis.length], ["CONFLICTED", false, 2]);
  });
  test("сравнение — тот же формат, что у инструмента ассистента", async () => {
    const cmp = json(await req("GET", `/api/ai/competitor-compare?productId=${ids.shov}&competitorProductId=${fx.products.tShov.id}`, H.manager));
    for (const k of ["items", "products", "rows", "analog", "prices"]) assert.ok(k in cmp, k);
    assert.ok(cmp.rows.some((r) => r.missing.length));
    assert.equal((await req("GET", `/api/ai/competitor-compare?productId=${ids.shov}&competitorProductId=999999`, H.manager)).statusCode, 404);
  });
});

describe("запись: только администратор", () => {
  test("менеджер и покупатель — 403, гость — 401; в базе и журнале ничего", async () => {
    const n = get("SELECT COUNT(*) AS n FROM ai_companies").n;
    const a = get("SELECT COUNT(*) AS n FROM audit_log").n;
    for (const [h, code] of [[H.manager, 403], [H.customer, 403], [{}, 401]]) {
      for (const [m, url, body] of [["POST", "/api/ai/competitors", { name: "Попытка" }], ["PATCH", `/api/ai/competitors/${fx.companies.ts.id}`, { notes: "x" }],
        ["POST", `/api/ai/competitors/${fx.companies.ts.id}/withdraw`, { reason: "x" }], ["POST", "/api/ai/competitor-prices", {}], ["POST", "/api/ai/competitor-analogs", {}],
        ["POST", "/api/ai/competitor-observations", {}], ["POST", "/api/ai/competitor-products", {}], ["POST", "/api/ai/competitor-brands", {}], ["POST", "/api/ai/regions", { name: "x" }]]) {
        assert.equal((await req(m, url, h, body)).statusCode, code, `${m} ${url}`);
      }
    }
    assert.equal(get("SELECT COUNT(*) AS n FROM ai_companies").n, n);
    assert.equal(get("SELECT COUNT(*) AS n FROM audit_log").n, a);
  });
  let co, br, pr, pk;
  test("администратор: создать, изменить, снять — с журналом", async () => {
    let res = await req("POST", "/api/ai/competitors", H.admin, { name: "HTTP-ТестКомпания", kind: "manufacturer" });
    assert.equal(res.statusCode, 201);
    co = json(res).company;
    assert.equal(co.competitorStatus, "unknown");
    res = await req("PATCH", `/api/ai/competitors/${co.id}`, H.admin, { competitorStatus: "competitor", website: "https://http-test.example" });
    assert.equal(json(res).company.competitorStatus, "competitor");
    br = json(await req("POST", "/api/ai/competitor-brands", H.admin, { companyId: co.id, name: "HTTP-Марка" })).brand;
    assert.equal(json(await req("PATCH", `/api/ai/competitor-brands/${br.id}`, H.admin, { name: "HTTP-Марка-2" })).brand.name, "HTTP-Марка-2");
    pr = json(await req("POST", "/api/ai/competitor-products", H.admin, { companyId: co.id, brandId: br.id, name: "Смесь «HTTP-1»" })).product;
    assert.equal(json(await req("PATCH", `/api/ai/competitor-products/${pr.id}`, H.admin, { marketStatus: "active" })).product.marketStatus, "active");
    pk = json(await req("POST", "/api/ai/competitor-packs", H.admin, { competitorProductId: pr.id, unitLabel: "мешок 20 кг", packSize: 20, packUnit: "кг" })).pack;
    assert.equal(json(await req("PATCH", `/api/ai/competitor-packs/${pk.id}`, H.admin, { weightKg: 20 })).pack.weightKg, 20);
    assert.equal(json(await req("GET", `/api/ai/competitor-products/${pr.id}/packs`, H.manager)).items.length, 1);
    for (const a of ["company.create", "company.update", "brand.create", "brand.update", "product.create", "product.update", "pack.create", "pack.update"]) assert.ok(audits(`ai.competitor.${a}`) > 0, a);
    const diff = JSON.parse(get("SELECT diff FROM audit_log WHERE action='ai.competitor.company.update' AND entity_id=? ORDER BY id DESC", String(co.id)).diff);
    assert.deepEqual(diff.competitor_status, { was: "unknown", now: "competitor" });
    const actor = get("SELECT actor_id, ip FROM audit_log WHERE action='ai.competitor.company.create' AND entity_id=?", String(co.id));
    assert.ok(actor.actor_id && actor.ip);
  });
  test("наблюдение: без источника, с условием без цитаты, с чужим уровнем доступа — 400; подтверждение, замена, снятие", async () => {
    const base = { competitorProductId: pr.id, specKey: "setting_time", originalValue: "50 мин", sourceType: "technical_document", sourceId: fx.sources.s1 };
    assert.equal((await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, sourceId: undefined })).statusCode, 400);
    assert.equal((await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, conditions: { age_days: 7 } })).statusCode, 400);
    assert.equal((await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, accessLevel: "secret" })).statusCode, 400);
    assert.equal((await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, sourceType: "ai_inference" })).statusCode, 400);
    const o1 = json(await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, providedAt: "2026-06-01" })).observation;
    const o2 = json(await req("POST", "/api/ai/competitor-observations", H.admin, { ...base, originalValue: "55 мин", providedAt: "2026-09-01" })).observation;
    assert.equal(json(await req("POST", `/api/ai/competitor-observations/${o2.id}/verification`, H.admin, { status: "verified" })).observation.verificationStatus, "verified");
    assert.equal((await req("POST", `/api/ai/competitor-observations/${o1.id}/supersede`, H.admin, { replacedById: o2.id })).statusCode, 400, "без обоснования");
    assert.equal(json(await req("POST", `/api/ai/competitor-observations/${o1.id}/supersede`, H.admin, { replacedById: o2.id, note: "новая редакция" })).observation.lifecycleStatus, "superseded");
    assert.equal(json(await req("GET", `/api/ai/competitor-observations/${o1.id}`, H.manager)).observation.originalValue, "50 мин", "старое на месте");
    assert.equal((await req("POST", `/api/ai/competitor-observations/${o2.id}/withdraw`, H.admin, {})).statusCode, 400, "без причины");
    assert.equal(json(await req("POST", `/api/ai/competitor-observations/${o2.id}/withdraw`, H.admin, { reason: "проверка" })).observation.lifecycleStatus, "withdrawn");
    for (const a of ["observation.create", "observation.verification", "observation.supersede", "observation.withdraw"]) assert.ok(audits(`ai.competitor.${a}`) > 0, a);
  });
  test("цена: без источника, без даты, без основы, дробные копейки, чужая валюта — 400; добавление, снятие, проверка", async () => {
    const base = { competitorProductId: pr.id, packId: pk.id, amountMinor: 38000, currency: "RUB", priceKind: "retail", priceBasis: "за мешок 20 кг", basisUnit: "pack", basisQty: 20, sourceId: fx.sources.s2, observedAt: "2026-09-10" };
    for (const bad of [{ sourceId: undefined }, { observedAt: undefined }, { priceBasis: undefined }, { basisUnit: "мешок" }, { amountMinor: 380.5 }, { currency: "рубли" }, { observedAt: "10.09.2026" }]) {
      const res = await req("POST", "/api/ai/competitor-prices", H.admin, { ...base, ...bad });
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    const p = json(await req("POST", "/api/ai/competitor-prices", H.admin, base)).price;
    const list = json(await req("GET", `/api/ai/competitor-products/${pr.id}/prices`, H.manager));
    assert.equal(list.prices.length, 1);
    assert.equal(json(await req("POST", `/api/ai/competitor-prices/${p.id}/withdraw`, H.admin, { reason: "проверка" })).price.lifecycleStatus, "withdrawn");
    assert.equal(json(await req("GET", `/api/ai/competitor-products/${pr.id}/prices`, H.manager)).prices.length, 1, "снятая цена — в истории");
    assert.ok(audits("ai.competitor.price.create") > 0 && audits("ai.competitor.price.withdraw") > 0);
  });
  test("аналог: вид и основание из словаря, источник и обоснование обязательны; снятие", async () => {
    const base = { productId: ids.shov, competitorProductId: pr.id };
    for (const bad of [{ relation: "same", basis: "user_decision", note: "x" }, { relation: "analog", basis: "guess", note: "x" }, { relation: "analog", basis: "explicit_source_statement" },
      { relation: "analog", basis: "user_decision" }, { relation: "partial_analog", basis: "user_decision", note: "x" }]) {
      assert.equal((await req("POST", "/api/ai/competitor-analogs", H.admin, { ...base, ...bad })).statusCode, 400, JSON.stringify(bad));
    }
    const a = json(await req("POST", "/api/ai/competitor-analogs", H.admin, { ...base, relation: "partial_analog", basis: "user_decision", note: "то же назначение", differences: "другой наполнитель" })).analog;
    const st = json(await req("GET", `/api/ai/competitor-analogs/status?productId=${ids.shov}&competitorProductId=${pr.id}`, H.manager));
    assert.deepEqual([st.status, st.relation, st.basis[0].differences], ["CONFIRMED", "partial_analog", "другой наполнитель"]);
    assert.equal(json(await req("POST", `/api/ai/competitor-analogs/${a.id}/withdraw`, H.admin, { reason: "ошибка" })).analog.lifecycleStatus, "withdrawn");
    assert.ok(audits("ai.competitor.analog.create") > 0 && audits("ai.competitor.analog.withdraw") > 0);
  });
  test("снятие справочника: компания уходит из списка, остаётся в журнале", async () => {
    assert.equal(json(await req("POST", `/api/ai/competitor-packs/${pk.id}/withdraw`, H.admin, { reason: "проверка" })).pack.lifecycleStatus, "withdrawn");
    assert.equal(json(await req("POST", `/api/ai/competitor-products/${pr.id}/withdraw`, H.admin, { reason: "проверка" })).product.lifecycleStatus, "withdrawn");
    assert.equal(json(await req("POST", `/api/ai/competitor-brands/${br.id}/withdraw`, H.admin, { reason: "проверка" })).brand.lifecycleStatus, "withdrawn");
    assert.equal(json(await req("POST", `/api/ai/competitors/${co.id}/withdraw`, H.admin, { reason: "проверка" })).company.lifecycleStatus, "withdrawn");
    assert.ok(!json(await req("GET", "/api/ai/competitors", H.manager)).items.some((c) => c.id === co.id));
    assert.ok(audits("ai.competitor.company.withdraw") > 0);
  });
  test("журнал без личных данных и лишних полей", () => {
    const rows = all("SELECT diff FROM audit_log WHERE action LIKE 'ai.competitor.%'");
    assert.ok(rows.length > 10);
    assert.ok(!rows.some((r) => /@|password|token|content_hash|\+7/.test(r.diff || "")));
  });
});

describe("изоляция компаний-арендаторов", () => {
  test("администратор другой компании не видит и не меняет чужое", async () => {
    const list = json(await req("GET", "/api/ai/competitors", H.admin2));
    assert.ok(!list.items.some((c) => c.name === "ТестСмесь"));
    assert.equal((await req("GET", `/api/ai/competitors/${fx.companies.ts.id}`, H.admin2)).statusCode, 404);
    assert.equal((await req("PATCH", `/api/ai/competitors/${fx.companies.ts.id}`, H.admin2, { notes: "x" })).statusCode, 404);
    assert.equal((await req("GET", `/api/ai/competitor-products/${fx.products.tShov.id}`, H.admin2)).statusCode, 404);
    assert.equal((await req("POST", "/api/ai/competitor-observations", H.admin2, { competitorProductId: fx.products.tShov.id, specKey: "setting_time", originalValue: "1 мин", sourceType: "technical_document", sourceId: fx.sources.s1 })).statusCode, 404);
  });
});
