// Habez AI, 3.5 Competitor Intelligence — фундамент: миграция, справочник
// конкурентов, наблюдения характеристик и цен, аналоги, сравнение, права,
// журнал. Только синтетические данные («ТестСмесь», «Пример-Гипс»,
// «Марка-Т», «Марка-U») — названий настоящих компаний здесь нет.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-competitors.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

let C, ids, get, all, run, insert;
let admin, staff, guest, other;   // контексты вызова
let src, src2, otherSrc;           // источники (ai_sources)
const today = new Date().toISOString().slice(0, 10);

const expectError = (fn, status, re) => assert.throws(fn, (e) => e.status === status && (!re || re.test(e.message)), `ожидалась ошибка ${status}`);
const auditCount = (action) => get("SELECT COUNT(*) AS n FROM audit_log WHERE action=?", action).n;

before(async () => {
  ids = await prepareAiDb();
  ({ get, all, run, insert } = await import("../src/db/index.js"));
  C = await import("../src/ai/competitors/index.js");
  const adminId = insert("users", { tenant_id: 1, email: "ci-admin@test.habez.local", name: "CI admin", role: "admin", status: "active" });
  const managerId = insert("users", { tenant_id: 1, email: "ci-manager@test.habez.local", name: "CI manager", role: "manager", status: "active" });
  // Вторая компания-арендатор — для проверки изоляции.
  const t2 = insert("tenants", { slug: "tenant-two", name: "Другая компания" });
  const admin2 = insert("users", { tenant_id: t2, email: "ci-admin2@test.habez.local", name: "CI admin 2", role: "admin", status: "active" });
  admin = { tenantId: 1, role: "admin", actorId: adminId };
  staff = { tenantId: 1, role: "manager", actorId: managerId };
  guest = { tenantId: 1, role: "customer", actorId: null };
  other = { tenantId: t2, role: "admin", actorId: admin2 };
  src = insert("ai_sources", { tenant_id: 1, source_type: "manufacturer_site", name: "Синтетический сайт производителя", trust_base: 50 });
  src2 = insert("ai_sources", { tenant_id: 1, source_type: "price_list", name: "Синтетический прайс дилера", trust_base: 50 });
  otherSrc = insert("ai_sources", { tenant_id: t2, source_type: "manual_research", name: "Источник другой компании", trust_base: 50 });
});

describe("миграция: только новые таблицы", () => {
  test("восемь таблиц и защита истории на месте", () => {
    const names = all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_regions','ai_companies','ai_brands','ai_competitor_products','ai_competitor_packs','ai_competitor_observations','ai_price_observations','ai_competitor_analogs')").map((r) => r.name);
    assert.equal(names.length, 8);
    const triggers = all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_ai_%'").map((r) => r.name);
    for (const t of ["trg_ai_cobs_no_delete", "trg_ai_price_no_delete", "trg_ai_analog_no_delete", "trg_ai_cobs_immutable", "trg_ai_price_immutable", "trg_ai_analog_immutable"]) assert.ok(triggers.includes(t), t);
    assert.ok(get("SELECT name FROM migrations WHERE name='2026-09-ai-competitors'"));
  });
  test("products и ai_spec_observations не изменены: столбцов конкурентов в них нет", () => {
    const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(!cols("products").some((c) => /competitor/.test(c)));
    assert.ok(!cols("ai_spec_observations").some((c) => /competitor/.test(c)));
  });
});

let company, company2, brandT, brandU, product, product2, packA, packB, region1, region2;

describe("компании", () => {
  test("создание и чтение; запись сама по себе не делает компанию конкурентом", () => {
    company = C.createCompany(admin, { name: "ТестСмесь", kind: "manufacturer", website: "https://testsmes.example" });
    assert.equal(company.competitorStatus, "unknown");
    assert.equal(C.getCompany(staff, company.id).name, "ТестСмесь");
    company2 = C.createCompany(admin, { name: "Пример-Гипс", kind: "manufacturer", competitorStatus: "competitor" });
    assert.deepEqual(C.listCompanies(staff, { competitorStatus: "competitor" }).map((c) => c.name), ["Пример-Гипс"]);
    expectError(() => C.createCompany(admin, { name: "тестсмесь" }), 409, /уже есть/);
  });
  test("изменение пишется в журнал «было → стало»", () => {
    const n = auditCount("ai.competitor.company.update");
    C.updateCompany(admin, company.id, { competitorStatus: "competitor" });
    assert.equal(auditCount("ai.competitor.company.update"), n + 1);
    const diff = JSON.parse(get("SELECT diff FROM audit_log WHERE action='ai.competitor.company.update' ORDER BY id DESC LIMIT 1").diff);
    assert.deepEqual(diff.competitor_status, { was: "unknown", now: "competitor" });
  });
  test("изоляция компаний-арендаторов", () => {
    const foreign = C.createCompany(other, { name: "ТестСмесь" });
    expectError(() => C.getCompany(admin, foreign.id), 404);
    assert.ok(!C.listCompanies(admin).some((c) => c.id === foreign.id));
    expectError(() => C.updateCompany(admin, foreign.id, { notes: "x" }), 404);
  });
  test("снятие: запись остаётся с причиной, из действующих уходит; удалить нельзя (функции нет)", () => {
    const tmp = C.createCompany(admin, { name: "Временная ТестКомпания" });
    expectError(() => C.withdrawCompany(admin, tmp.id, ""), 400, /причину/);
    const w = C.withdrawCompany(admin, tmp.id, "заведена по ошибке");
    assert.deepEqual([w.lifecycleStatus, w.withdrawnReason], ["withdrawn", "заведена по ошибке"]);
    assert.ok(!C.listCompanies(staff).some((c) => c.id === tmp.id));
    assert.ok(C.listCompanies(staff, { includeWithdrawn: true }).some((c) => c.id === tmp.id));
    assert.ok(!Object.keys(C).some((k) => /^delete/i.test(k)), "в слое нет функций удаления");
  });
  test("личные контакты в заметке не принимаются", () => {
    expectError(() => C.createCompany(admin, { name: "ТестКонтакт", notes: "звонить manager@example.ru" }), 400, /почты/);
  });
});

describe("марки", () => {
  test("марка принадлежит компании; марка — не компания", () => {
    brandT = C.createBrand(admin, { companyId: company.id, name: "Марка-Т" });
    brandU = C.createBrand(admin, { companyId: company.id, name: "Марка-U" });
    assert.deepEqual(C.listBrands(staff, company.id).map((b) => b.name).sort(), ["Марка-U", "Марка-Т"].sort());
    assert.ok(C.listBrands(staff, company.id).every((b) => b.companyId === company.id));
    // Марка с тем же названием, что у компании, остаётся маркой этой компании.
    const sameName = C.createBrand(admin, { companyId: company2.id, name: "Пример-Гипс" });
    assert.equal(C.getBrand(staff, sameName.id).companyId, company2.id);
    assert.equal(C.listCompanies(staff).filter((c) => c.name === "Пример-Гипс").length, 1, "новой компании не появилось");
  });
  test("марку нельзя перенести к другой компании", () => {
    expectError(() => C.updateBrand(admin, brandT.id, { companyId: company2.id }), 400);
  });
});

describe("товары конкурента", () => {
  test("товар связан с компанией, маркой и нашим разделом каталога — и не попадает в products", () => {
    const productsBefore = get("SELECT COUNT(*) AS n FROM products").n;
    const shovCat = get("SELECT category_id FROM products WHERE id=?", ids.shov).category_id;
    product = C.createCompetitorProduct(admin, { companyId: company.id, brandId: brandT.id, categoryId: shovCat, name: "Шпаклёвка для швов «Т-Шов»", shortName: "Т-Шов" });
    product2 = C.createCompetitorProduct(admin, { companyId: company.id, brandId: brandU.id, name: "Штукатурка «U-Старт»", shortName: "U-Старт" });
    assert.deepEqual([product.companyId, product.brandId, product.categoryId], [company.id, brandT.id, shovCat]);
    assert.equal(get("SELECT COUNT(*) AS n FROM products").n, productsBefore);
    assert.ok(!get("SELECT id FROM products WHERE name LIKE '%Т-Шов%'"));
  });
  test("марка другой компании и чужой раздел не принимаются", () => {
    const brandP = C.createBrand(admin, { companyId: company2.id, name: "Марка-П" });
    expectError(() => C.createCompetitorProduct(admin, { companyId: company.id, brandId: brandP.id, name: "Смесь-Х" }), 400, /другой компании/);
    const foreignCat = insert("categories", { tenant_id: other.tenantId, slug: "x", name: "Чужой раздел" });
    expectError(() => C.createCompetitorProduct(admin, { companyId: company.id, categoryId: foreignCat, name: "Смесь-Y" }), 400, /Раздел/);
  });
});

describe("фасовки", () => {
  test("несколько фасовок, разные веса и единицы, штрихкод", () => {
    packA = C.createPack(admin, { competitorProductId: product.id, unitLabel: "мешок 25 кг", packSize: 25, packUnit: "кг", weightKg: 25, barcode: "4600000000017" });
    packB = C.createPack(admin, { competitorProductId: product.id, unitLabel: "мешок 5 кг", packSize: 5, packUnit: "кг", weightKg: 5 });
    C.createPack(admin, { competitorProductId: product2.id, unitLabel: "ведро 10 л", packSize: 10, packUnit: "л" });
    assert.deepEqual(C.listPacks(staff, product.id).map((p) => [p.unitLabel, p.weightKg]), [["мешок 25 кг", 25], ["мешок 5 кг", 5]]);
    assert.equal(C.listPacks(staff, product.id)[0].barcode, "4600000000017");
    expectError(() => C.createPack(admin, { competitorProductId: product2.id, unitLabel: "мешок 30 кг", barcode: "4600000000017" }), 409);
    expectError(() => C.createPack(admin, { competitorProductId: product.id, unitLabel: "x", barcode: "12ab" }), 400);
  });
});

describe("наблюдения характеристик", () => {
  let o1, o2;
  test("два наблюдения одного свойства из разных источников и дат — оба хранятся, победителя нет", () => {
    o1 = C.createObservation(admin, { competitorProductId: product.id, specKey: "adhesion_strength", originalValue: "не менее 0,5 МПа", sourceType: "technical_document", sourceId: src, providedAt: "2026-05-01", statementType: "declared" });
    o2 = C.createObservation(admin, { competitorProductId: product.id, specKey: "adhesion_strength", originalValue: "0,6 МПа", sourceType: "public_source", sourceId: src2, providedAt: "2026-08-01", statementType: "declared" });
    const { properties } = C.productObservations(staff, product.id);
    const p = properties.find((x) => x.specKey === "adhesion_strength");
    assert.equal(p.observations.length, 2);
    assert.equal(p.resolution.current.status, "pending_user_decision", "более поздняя дата победителя не делает");
    assert.equal(p.resolution.current.value, null);
  });
  test("новое наблюдение старое не меняет; замена — отдельным действием, старое остаётся", () => {
    const o3 = C.createObservation(admin, { competitorProductId: product.id, specKey: "adhesion_strength", originalValue: "0,7 МПа", sourceType: "technical_document", sourceId: src, providedAt: "2026-09-01", statementType: "declared" });
    assert.equal(C.getObservation(staff, o1.id).lifecycleStatus, "active");
    expectError(() => C.supersedeObservation(admin, o1.id, o3.id, ""), 400);
    const old = C.supersedeObservation(admin, o1.id, o3.id, "в новой редакции документа значение другое");
    assert.deepEqual([old.lifecycleStatus, old.replacedById, old.originalValue], ["superseded", o3.id, "не менее 0,5 МПа"]);
    const all3 = C.productObservations(staff, product.id).observations.filter((x) => x.specKey === "adhesion_strength");
    assert.equal(all3.length, 3, "история на месте");
  });
  test("удалить и переписать наблюдение нельзя даже в обход слоя", () => {
    assert.throws(() => run("DELETE FROM ai_competitor_observations WHERE id=?", o2.id), /удаление запрещено/);
    assert.throws(() => run("UPDATE ai_competitor_observations SET original_value='9 МПа' WHERE id=?", o2.id), /не меняются/);
  });
  test("без источника, с чужим источником, с условием без цитаты — не принимается", () => {
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "technical_document" }), 400, /sourceId/);
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "technical_document", sourceId: otherSrc }), 404);
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "compressive_strength", originalValue: "3 МПа", sourceType: "technical_document", sourceId: src, conditions: { age_days: 28 } }), 400, /цитат/);
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "generated_default", sourceId: src }), 400);
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "no_such_key", originalValue: "1", sourceType: "technical_document", sourceId: src }), 400);
  });
  test("условия и фасовки — разные свойства; фасовка чужого товара не принимается", () => {
    C.createObservation(admin, { competitorProductId: product.id, specKey: "compressive_strength", originalValue: "2 МПа", conditions: { age_days: 7 }, conditionText: "в возрасте 7 сут", sourceType: "technical_document", sourceId: src });
    C.createObservation(admin, { competitorProductId: product.id, specKey: "compressive_strength", originalValue: "3 МПа", conditions: { age_days: 28 }, conditionText: "в возрасте 28 сут", sourceType: "technical_document", sourceId: src });
    const props = C.productObservations(staff, product.id).properties.filter((p) => p.specKey === "compressive_strength");
    assert.equal(props.length, 2);
    assert.ok(props.every((p) => p.resolution.current.status === "agreed"));
    const foreignPack = C.listPacks(staff, product2.id)[0];
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, packId: foreignPack.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "technical_document", sourceId: src }), 400, /другому товару/);
  });
  test("повтор того же утверждения из того же источника отклоняется", () => {
    expectError(() => C.createObservation(admin, { competitorProductId: product.id, specKey: "adhesion_strength", originalValue: "0,6 МПа", sourceType: "public_source", sourceId: src2, providedAt: "2026-08-01", statementType: "declared" }), 409);
  });
  test("изоляция: чужая компания не видит и не пишет", () => {
    expectError(() => C.productObservations(other, product.id), 404);
    expectError(() => C.createObservation(other, { competitorProductId: product.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "technical_document", sourceId: otherSrc }), 404);
  });
});

describe("цены", () => {
  test("регионы, виды цены, даты, основы — всё хранится отдельно", () => {
    region1 = C.createRegion(admin, { name: "Тестовый край", kind: "region" });
    region2 = C.createRegion(admin, { name: "Пробная область", kind: "region" });
    const base = { competitorProductId: product.id, packId: packA.id, currency: "RUB", priceKind: "retail", priceBasis: "за мешок 25 кг", basisUnit: "pack", basisQty: 25, sourceId: src2 };
    C.createPrice(admin, { ...base, amountMinor: 45000, regionId: region1.id, observedAt: "2026-08-01" });
    C.createPrice(admin, { ...base, amountMinor: 47000, regionId: region1.id, observedAt: "2026-09-01" });
    C.createPrice(admin, { ...base, amountMinor: 46000, regionId: region2.id, observedAt: "2026-09-01" });
    C.createPrice(admin, { ...base, amountMinor: 39000, priceKind: "dealer", regionId: region1.id, observedAt: "2026-09-01", accessLevel: "confidential" });
    C.createPrice(admin, { competitorProductId: product.id, amountMinor: 1800, currency: "RUB", priceKind: "retail", priceBasis: "за кг", basisUnit: "kg", sourceId: src2, regionId: region1.id, observedAt: "2026-09-01" });
    const { prices, groups } = C.productPrices(admin, product.id);
    assert.equal(prices.length, 5);
    assert.equal(groups.length, 4, "регион, вид цены и основа — разные группы");
    const g = groups.find((x) => x.regionId === region1.id && x.priceKind === "retail" && x.basisUnit === "pack");
    assert.deepEqual(g.observations.map((o) => o.amountMinor), [45000, 47000], "по дате; действующая не выбирается");
    assert.equal(g.status, "OBSERVED");
  });
  test("«за мешок 25 кг» и «за кг» не сравниваются и не пересчитываются", () => {
    const { groups } = C.productPrices(admin, product.id);
    const bag = groups.find((x) => x.basisUnit === "pack" && x.priceKind === "retail");
    const kg = groups.find((x) => x.basisUnit === "kg");
    assert.equal(C.pricesComparable(bag.observations[0], kg.observations[0]), false);
    assert.ok(!Object.keys(kg).some((k) => /per_?kg|normalized/i.test(k)));
    assert.equal(kg.observations[0].amountMinor, 1800);
  });
  test("разные суммы на одну дату в одной группе — CONFLICTED, обе на месте", () => {
    C.createPrice(admin, { competitorProductId: product.id, packId: packA.id, amountMinor: 48000, currency: "RUB", priceKind: "retail", priceBasis: "за мешок 25 кг", basisUnit: "pack", basisQty: 25, sourceId: src, regionId: region1.id, observedAt: "2026-09-01" });
    const g = C.productPrices(admin, product.id).groups.find((x) => x.regionId === region1.id && x.priceKind === "retail" && x.basisUnit === "pack");
    assert.equal(g.status, "CONFLICTED");
    assert.deepEqual(g.conflicts[0].amounts, [47000, 48000]);
  });
  test("без источника и без даты — не принимается; дата из будущего — тоже", () => {
    const base = { competitorProductId: product.id, amountMinor: 100, priceKind: "retail", priceBasis: "за мешок", basisUnit: "pack" };
    expectError(() => C.createPrice(admin, { ...base, observedAt: "2026-09-01" }), 400, /sourceId/);
    expectError(() => C.createPrice(admin, { ...base, sourceId: src2 }), 400, /observedAt/);
    expectError(() => C.createPrice(admin, { ...base, sourceId: src2, observedAt: "2999-01-01" }), 400, /не позже/);
    expectError(() => C.createPrice(admin, { ...base, sourceId: src2, observedAt: "2026-09-01", basisUnit: undefined }), 400);
    expectError(() => C.createPrice(admin, { ...base, amountMinor: 1.5, sourceId: src2, observedAt: "2026-09-01" }), 400);
  });
  test("старые цены сохраняются: замена и снятие не удаляют; удалить в обход нельзя", () => {
    const base = { competitorProductId: product2.id, amountMinor: 30000, currency: "RUB", priceKind: "retail", priceBasis: "за мешок 30 кг", basisUnit: "pack", basisQty: 30, sourceId: src2, observedAt: "2026-07-01" };
    const a = C.createPrice(admin, base);
    const b = C.createPrice(admin, { ...base, amountMinor: 3000, observedAt: "2026-07-02" });
    expectError(() => C.supersedePrice(admin, a.id, C.createPrice(admin, { ...base, priceKind: "promo", observedAt: "2026-07-03" }).id, "x"), 400, /той же группы/);
    const old = C.supersedePrice(admin, b.id, a.id, "в прайсе опечатка");
    assert.equal(old.lifecycleStatus, "superseded");
    C.withdrawPrice(admin, a.id, "проверочная запись");
    assert.equal(C.productPrices(admin, product2.id).prices.length, 3);
    assert.throws(() => run("DELETE FROM ai_price_observations WHERE id=?", a.id), /удаление запрещено/);
    assert.throws(() => run("UPDATE ai_price_observations SET amount_minor=1 WHERE id=?", a.id), /не меняются/);
  });
});

describe("аналоги", () => {
  let p3;
  test("CONFIRMED по источнику; основание и источник видны", () => {
    C.createAnalog(admin, { productId: ids.shov, competitorProductId: product.id, relation: "analog", basis: "explicit_source_statement", sourceId: src, sourceReference: "таблица аналогов, стр. 2" });
    const s = C.analogStatus(staff, ids.shov, product.id);
    assert.deepEqual([s.status, s.relation], ["CONFIRMED", "analog"]);
    assert.equal(s.basis[0].sourceId, src);
  });
  test("источник обязателен для прямого указания; решение сотрудника — с обоснованием", () => {
    expectError(() => C.createAnalog(admin, { productId: ids.shov, competitorProductId: product2.id, relation: "analog", basis: "explicit_source_statement" }), 400, /источник/);
    expectError(() => C.createAnalog(admin, { productId: ids.shov, competitorProductId: product2.id, relation: "analog", basis: "user_decision" }), 400, /обоснован/);
  });
  test("частичный аналог — только с различиями; решение сотрудника → CONFIRMED с этим основанием", () => {
    expectError(() => C.createAnalog(admin, { productId: ids.standart, competitorProductId: product2.id, relation: "partial_analog", basis: "user_decision", note: "то же назначение" }), 400, /различ/);
    C.createAnalog(admin, { productId: ids.standart, competitorProductId: product2.id, relation: "partial_analog", basis: "user_decision", note: "то же назначение", differences: "другая фасовка и основа" });
    const s = C.analogStatus(staff, ids.standart, product2.id);
    assert.deepEqual([s.status, s.relation, s.basis[0].basis, s.basis[0].differences], ["CONFIRMED", "partial_analog", "user_decision", "другая фасовка и основа"]);
  });
  test("не аналог — тоже утверждение (CONFIRMED not_analog)", () => {
    C.createAnalog(admin, { productId: ids.koroed, competitorProductId: product2.id, relation: "not_analog", basis: "user_decision", note: "другое назначение" });
    assert.deepEqual([C.analogStatus(staff, ids.koroed, product2.id).status, C.analogStatus(staff, ids.koroed, product2.id).relation], ["CONFIRMED", "not_analog"]);
  });
  test("UNKNOWN: ни утверждений, ни признаков", () => {
    assert.equal(C.analogStatus(staff, ids.antipleseni, product2.id).status, "UNKNOWN");
  });
  test("INFERRED вычисляется (тот же раздел), но не записывается", () => {
    p3 = C.createCompetitorProduct(admin, { companyId: company2.id, categoryId: get("SELECT category_id FROM products WHERE id=?", ids.shov).category_id, name: "Шпаклёвка «П-Финиш»" });
    const n = get("SELECT COUNT(*) AS n FROM ai_competitor_analogs").n;
    const s = C.analogStatus(staff, ids.shov, p3.id);
    assert.equal(s.status, "INFERRED");
    assert.match(s.inferredBasis, /предположение/);
    const found = C.findAnalogs(staff, ids.shov);
    assert.deepEqual(found.map((x) => [x.competitorProduct.id, x.status]), [[product.id, "CONFIRMED"], [p3.id, "INFERRED"]]);
    assert.equal(get("SELECT COUNT(*) AS n FROM ai_competitor_analogs").n, n, "ни одной записи");
    assert.ok(!get("SELECT id FROM ai_competitor_analogs WHERE relation NOT IN ('analog','partial_analog','not_analog')"));
  });
  test("CONFLICTED, когда утверждения расходятся; снятое — в истории, статус пересчитан", () => {
    const r = C.createAnalog(admin, { productId: ids.shov, competitorProductId: product.id, relation: "not_analog", basis: "user_decision", note: "по составу не аналог" });
    assert.equal(C.analogStatus(staff, ids.shov, product.id).status, "CONFLICTED");
    C.withdrawAnalog(admin, r.id, "ошибка ввода");
    const s = C.analogStatus(staff, ids.shov, product.id);
    assert.equal(s.status, "CONFIRMED");
    assert.equal(s.history[0].withdrawnReason, "ошибка ввода");
    assert.throws(() => run("DELETE FROM ai_competitor_analogs WHERE id=?", r.id), /удаление запрещено/);
    assert.throws(() => run("UPDATE ai_competitor_analogs SET relation='analog' WHERE id=?", r.id), /не меняется/);
  });
  test("конфиденциальное утверждение: менеджер видит только «нужна сверка»", () => {
    C.createAnalog(admin, { productId: ids.shov, competitorProductId: p3.id, relation: "not_analog", basis: "user_decision", note: "внутренняя экспертиза", accessLevel: "confidential" });
    const s = C.analogStatus(staff, ids.shov, p3.id);
    assert.deepEqual([s.status, s.needsReview], ["INFERRED", true]);
    assert.ok(!JSON.stringify(s).includes("внутренняя экспертиза"));
    assert.deepEqual([C.analogStatus(admin, ids.shov, p3.id).status, C.analogStatus(admin, ids.shov, p3.id).relation], ["CONFIRMED", "not_analog"]);
  });
});

describe("сравнение «наш ↔ их»", () => {
  test("строки по ключу и условию, «нет данных», расхождение без победителя, разные единицы", () => {
    const cmp = C.compareWithCompetitor(staff, ids.shov, product.id);
    assert.equal(cmp.analog.status, "CONFIRMED");
    const adh = cmp.rows.find((r) => r.key === "adhesion_strength" && r.conditionKey === "");
    assert.equal(adh.theirs.status, "conflict");
    assert.ok(adh.theirs.values.length >= 2);
    const onlyTheirs = cmp.rows.find((r) => r.key === "compressive_strength" && r.conditionKey === "age_days=28");
    assert.ok(onlyTheirs.theirs.values.includes("3 МПа"));
    assert.ok(cmp.rows.some((r) => r.ours.missing || r.theirs.missing), "есть «нет данных»");
    assert.ok(!JSON.stringify(cmp).match(/winner|better|лучше|хуже/i), "победителя и оценок нет");
    assert.ok(cmp.prices.length >= 3);
  });
  test("разные единицы — пометка, без пересчёта", () => {
    const px = C.createCompetitorProduct(admin, { companyId: company.id, name: "Грунт «Т-Грунт»" });
    // У АНТИПЛЕСЕНЬ расход — «200 г/м²» (масса на площадь), у товара
    // конкурента — «0,15 л/м²» (объём): разные величины.
    C.createObservation(admin, { competitorProductId: px.id, specKey: "consumption", originalValue: "0,15 л/м²", sourceType: "technical_document", sourceId: src });
    const row = C.compareWithCompetitor(staff, ids.antipleseni, px.id).rows.find((r) => r.key === "consumption");
    assert.ok(!row.ours.missing && !row.theirs.missing, "у обеих сторон есть расход");
    assert.equal(row.differentUnits, true);
    assert.deepEqual(row.theirs.values, ["0,15 л/м²"], "значение как в источнике, без пересчёта");
    assert.ok(row.ours.values.includes("200 г/м²"));
  });
});

describe("проверка фундамента (3.5, шаг 2)", () => {
  test("свойство только с замером — в сравнении не «нет данных», а замер с пометкой класса", () => {
    const px = C.createCompetitorProduct(admin, { companyId: company.id, name: "Смесь «Т-Замер»" });
    C.createObservation(admin, { competitorProductId: px.id, specKey: "setting_time", originalValue: "55 мин", statementType: "measured", sourceType: "measurement", sourceId: src });
    const row = C.compareWithCompetitor(staff, ids.shov, px.id).rows.find((r) => r.key === "setting_time" && r.conditionKey === "");
    assert.equal(row.theirs.missing, false);
    assert.deepEqual([row.theirs.statementClass, row.theirs.values], ["measured", ["55 мин"]]);
  });
  test("товары снятой компании не попадают в действующие и в аналоги", () => {
    const co = C.createCompany(admin, { name: "Снимаемая ТестКомпания" });
    const cat = get("SELECT category_id FROM products WHERE id=?", ids.shov).category_id;
    const px = C.createCompetitorProduct(admin, { companyId: co.id, categoryId: cat, name: "Смесь «Снимаемая»" });
    assert.ok(C.findAnalogs(staff, ids.shov).some((x) => x.competitorProduct.id === px.id));
    C.withdrawCompany(admin, co.id, "заведена по ошибке");
    assert.ok(!C.listCompetitorProducts(staff).some((p) => p.id === px.id));
    assert.ok(C.listCompetitorProducts(staff, { includeWithdrawn: true }).some((p) => p.id === px.id));
    assert.ok(!C.findAnalogs(staff, ids.shov).some((x) => x.competitorProduct.id === px.id));
  });
  test("статусы аналога на всех комбинациях (чистые правила)", () => {
    const r = (relation, lifecycleStatus = "active") => ({ id: Math.random(), relation, basis: "user_decision", lifecycleStatus });
    const st = (rows, o) => C.analogStatusOf(rows, o).status;
    assert.equal(st([], {}), "UNKNOWN");
    assert.equal(st([], { sameCategory: true }), "INFERRED");
    assert.equal(st([r("analog")], { sameCategory: true }), "CONFIRMED", "утверждение важнее предположения");
    assert.equal(st([r("analog"), r("analog")]), "CONFIRMED");
    assert.equal(st([r("analog"), r("partial_analog")]), "CONFLICTED");
    assert.equal(st([r("analog"), r("not_analog")]), "CONFLICTED");
    assert.equal(st([r("analog"), r("not_analog", "withdrawn")]), "CONFIRMED", "снятое не участвует");
    assert.equal(st([r("analog", "withdrawn")], { sameCategory: true }), "INFERRED", "только снятые — как нет утверждений");
    assert.equal(st([r("analog", "withdrawn")]), "UNKNOWN");
    assert.equal(C.analogStatusOf([r("analog")]).relation, "analog");
    assert.equal(C.analogStatusOf([r("analog"), r("not_analog")]).relation, null, "при конфликте вид связи не выбирается");
    assert.equal(C.analogStatusOf([], { hiddenRelations: ["not_analog"] }).needsReview, true);
    assert.equal(C.analogStatusOf([r("analog")], { hiddenRelations: ["analog"] }).needsReview, false);
  });
  test("группы цен: разные даты — не противоречие, одна дата — противоречие; снятые и заменённые вне групп", () => {
    const p = (id, amountMinor, observedAt, lifecycleStatus = "active") => ({ id, amountMinor, observedAt, lifecycleStatus, currency: "RUB", priceKind: "retail", basisUnit: "pack", basisQty: 25, vat: "unknown", packId: 1, regionId: 1 });
    const g1 = C.priceGroups([p(1, 100, "2026-01-01"), p(2, 200, "2026-02-01")]);
    assert.deepEqual([g1.length, g1[0].status], [1, "OBSERVED"]);
    const g2 = C.priceGroups([p(1, 100, "2026-01-01"), p(2, 200, "2026-01-01")]);
    assert.equal(g2[0].status, "CONFLICTED");
    const g3 = C.priceGroups([p(1, 100, "2026-01-01"), p(2, 200, "2026-01-01", "superseded"), p(3, 300, "2026-01-01", "withdrawn")]);
    assert.deepEqual([g3[0].status, g3[0].observations.length], ["OBSERVED", 1]);
  });
});

describe("права", () => {
  test("менеджер читает, но не пишет", () => {
    assert.ok(C.listCompanies(staff).length > 0);
    expectError(() => C.createCompany(staff, { name: "Попытка менеджера" }), 403);
    expectError(() => C.createObservation(staff, { competitorProductId: product.id, specKey: "setting_time", originalValue: "60 мин", sourceType: "technical_document", sourceId: src }), 403);
    expectError(() => C.createPrice(staff, { competitorProductId: product.id, amountMinor: 1, priceKind: "retail", priceBasis: "за мешок", basisUnit: "pack", sourceId: src2, observedAt: "2026-09-01" }), 403);
    expectError(() => C.createAnalog(staff, { productId: ids.shov, competitorProductId: product.id, relation: "analog", basis: "explicit_source_statement", sourceId: src }), 403);
    expectError(() => C.withdrawCompany(staff, company.id, "x"), 403);
  });
  test("администратор пишет", () => {
    assert.ok(C.createRegion(admin, { name: "Регион администратора" }).id);
  });
  test("гость и покупатель не получают ничего", () => {
    for (const fn of [() => C.listCompanies(guest), () => C.getCompany(guest, company.id), () => C.productObservations(guest, product.id),
      () => C.productPrices(guest, product.id), () => C.findAnalogs(guest, ids.shov), () => C.compareWithCompetitor(guest, ids.shov, product.id), () => C.listRegions(guest)]) {
      expectError(fn, 403, /сотрудникам/);
    }
    expectError(() => C.productPrices({ tenantId: 1, role: "dealer" }, product.id), 403);
  });
  test("менеджер не видит конфиденциальные цены и конфиденциальные товары", () => {
    assert.ok(!C.productPrices(staff, product.id).prices.some((p) => p.accessLevel === "confidential"));
    assert.ok(C.productPrices(admin, product.id).prices.some((p) => p.accessLevel === "confidential"));
    const secret = C.createCompetitorProduct(admin, { companyId: company.id, name: "Секретная смесь", accessLevel: "confidential" });
    expectError(() => C.getCompetitorProduct(staff, secret.id), 404);
    assert.ok(!C.listCompetitorProducts(staff).some((p) => p.id === secret.id));
    assert.ok(C.listCompetitorProducts(admin).some((p) => p.id === secret.id));
  });
});

describe("журнал", () => {
  test("каждое создание, замена и снятие — строка в audit_log с автором, без личных данных", () => {
    for (const a of ["ai.competitor.company.create", "ai.competitor.brand.create", "ai.competitor.product.create", "ai.competitor.pack.create", "ai.competitor.region.create",
      "ai.competitor.observation.create", "ai.competitor.observation.supersede", "ai.competitor.price.create", "ai.competitor.price.supersede", "ai.competitor.price.withdraw",
      "ai.competitor.analog.create", "ai.competitor.analog.withdraw", "ai.competitor.company.withdraw", "ai.competitor.company.update"]) {
      assert.ok(auditCount(a) > 0, a);
    }
    const rows = all("SELECT actor_id, diff FROM audit_log WHERE action LIKE 'ai.competitor.%'");
    assert.ok(rows.every((r) => r.actor_id !== null), "у каждой записи есть автор");
    assert.ok(!rows.some((r) => /@|\+7/.test(r.diff || "")));
  });
  test("отказ в праве ничего не пишет", () => {
    const n = get("SELECT COUNT(*) AS n FROM audit_log").n;
    try { C.createCompany(staff, { name: "Ещё попытка" }); } catch { /* ожидаемо */ }
    assert.equal(get("SELECT COUNT(*) AS n FROM audit_log").n, n);
  });
});

describe("ассистент: инструментов записи нет", () => {
  test("все инструменты агента, включая конкурентные, только читают", async () => {
    const tools = await import("../src/ai/agent/tools/index.js");
    assert.ok(Object.values(tools.TOOL_SPECS).every((t) => t.read_only === true && t.write === false));
    assert.ok(!tools.TOOL_NAMES.some((n) => /^(create|update|delete|withdraw|add|set)_/.test(n)), "инструментов записи нет");
  });
});
