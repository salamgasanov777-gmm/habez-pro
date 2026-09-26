// Habez AI, Phase 2.2B — контрольные проверки перед переносом данных.
// Здесь закреплены правила, которые легко нарушить незаметно: никакого
// «победителя» по дате, номеру, порядку, доверию или статусу; ничего
// подставленного программой — покупателю; конфиденциальное — только
// администратору; условие — только с цитатой; замена между разными
// характеристиками — только решением владельца.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-evidence-gate.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";
process.env.AI_EVIDENCE_ENABLED = "1";

// resolveGroup и publicationDecision — чистые функции; импорт evidence.js
// открывает базу, поэтому база создаётся до импорта.
for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
{
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });
}
const { resolveGroup, legacyDrift, backfillFromSpecs, legacySourceType } = await import("../src/ai/knowledge/evidence.js");
const { publicationDecision } = await import("../src/ai/knowledge/evidence-model.js");
const { parseSpecValue } = await import("../src/ai/knowledge/units.js");
const { db, get, all, insert } = await import("../src/db/index.js");
const { signJwt } = await import("../src/lib/crypto.js");

// Наблюдение в том виде, в каком его отдаёт view().
let seq = 0;
function obs(raw, extra = {}) {
  const p = parseSpecValue(raw);
  seq++;
  return {
    id: extra.id ?? seq, originalValue: raw, statementType: "declared", sourceType: "product_card",
    lifecycleStatus: "active", verificationStatus: "unverified", accessLevel: "public",
    value: { num: p.valueNum, min: p.valueMin, max: p.valueMax, bool: p.valueBool, text: p.valueText },
    normalizedUnit: p.normalizedUnit, unitLabel: p.normalizedUnit, comparator: p.comparator,
    capturedAt: "2026-09-24 10:00:00", providedAt: null, extractionConfidence: null,
    ...extra,
  };
}
const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (["observationIds", "supporting"].includes(k) ? undefined : v)));

describe("действующее значение: без неявного победителя", () => {
  test("два разных значения → ждёт решения, значения нет", () => {
    const r = resolveGroup([obs("0,5 МПа"), obs("0,3 МПа", { sourceType: "factory_technologist" })]).current;
    assert.equal(r.status, "pending_user_decision");
    assert.equal(r.value, null);
    assert.equal(r.candidates.length, 2);
  });

  test("дата документа и дата записи победителя не выбирают", () => {
    const old = { providedAt: "2026-08-31", capturedAt: "2026-09-01 00:00:00" };
    const fresh = { providedAt: "2026-09-25", capturedAt: "2026-09-25 00:00:00" };
    const a = resolveGroup([obs("12 месяцев", old), obs("6 месяцев", fresh)]).current;
    const b = resolveGroup([obs("12 месяцев", fresh), obs("6 месяцев", old)]).current;
    assert.equal(a.status, "pending_user_decision");
    assert.deepEqual(strip(a), strip(b), "перестановка дат ничего не меняет");
  });

  test("номер записи и порядок вставки победителя не выбирают", () => {
    const x = obs("0,5 МПа", { id: 1 }); const y = obs("0,6 МПа", { id: 2 });
    const x2 = { ...x, id: 2 }; const y2 = { ...y, id: 1 };
    const a = resolveGroup([x, y]).current;
    const b = resolveGroup([y2, x2]).current;
    assert.equal(a.status, "pending_user_decision");
    assert.deepEqual(strip(a), strip(b), "варианты упорядочены по значению, а не по номеру");
  });

  test("уверенность разбора, статус проверки и вид источника победителя не выбирают", () => {
    const r = resolveGroup([
      obs("0,5 МПа", { extractionConfidence: 100, verificationStatus: "verified", sourceType: "quality_passport" }),
      obs("0,6 МПа", { extractionConfidence: 5 }),
    ]).current;
    assert.equal(r.status, "pending_user_decision");
    assert.equal(r.value, null);
  });

  test("согласие: итог — значение и все подтверждающие, без «представителя»", () => {
    const a = obs("70 минут", { id: 10 }); const b = obs("70 мин", { id: 11, sourceType: "factory_technologist" });
    const r1 = resolveGroup([a, b]).current;
    const r2 = resolveGroup([b, a]).current;
    assert.equal(r1.status, "agreed");
    assert.deepEqual(r1.supporting, [10, 11]);
    assert.deepEqual(r1, r2, "порядок наблюдений не меняет итог");
    assert.deepEqual(r1.value.displays, ["70 мин", "70 минут"]);
    assert.equal(r1.verification, "none");
    assert.ok(!("id" in r1.value) && !("sourceType" in r1.value), "в итоге нет одного выбранного наблюдения");
  });

  test("«0,3 МПа» и «не менее 0,3 МПа» — разные утверждения", () => {
    assert.equal(resolveGroup([obs("0,3 МПа"), obs("не менее 0,3 МПа")]).current.status, "pending_user_decision");
  });

  test("тип replacement без связи ничего не заменяет, но виден как сигнал", () => {
    const old = obs("90–100 мл/м²", { id: 20 });
    const neu = obs("200 г/м²", { id: 21, statementType: "replacement", sourceType: "factory_technologist" });
    const r = resolveGroup([old, neu]);
    assert.equal(r.current.status, "pending_user_decision");
    assert.equal(r.current.reason, "different_units");
    assert.deepEqual(r.unlinkedReplacementClaims, [21]);
    const linked = resolveGroup([{ ...old, lifecycleStatus: "superseded" }, neu], new Map(), new Set([21]));
    assert.equal(linked.current.status, "agreed", "после связи «заменяет» старое выходит из выбора");
    assert.deepEqual(linked.unlinkedReplacementClaims, []);
    assert.equal(linked.history[0].id, 20, "заменённое остаётся в истории");
  });

  test("приоритет применяется только если задан для каждого вида", () => {
    const list = [obs("0,5 МПа", { sourceType: "product_card" }), obs("0,3 МПа", { sourceType: "factory_technologist" })];
    assert.equal(resolveGroup(list, new Map([["factory_technologist", 90]])).current.status, "pending_user_decision");
    const r = resolveGroup(list, new Map([["factory_technologist", 90], ["product_card", 10]])).current;
    assert.equal(r.status, "resolved_by_policy");
    assert.equal(r.value.num, 0.3);
    assert.equal(r.overruled.length, 1, "проигравшее значение не прячется");
  });
});

describe("правило публикации", () => {
  const agreedOn = (o) => ({ status: "agreed", supporting: [o.id] });
  test("подтверждённое публичное согласованное — можно", () => {
    const o = obs("63 шт", { verificationStatus: "verified" });
    assert.equal(publicationDecision(o, agreedOn(o)).publishable, true);
  });
  test("generated_default и вывод AI — никогда", () => {
    for (const sourceType of ["generated_default", "ai_inference"]) {
      const o = obs("40", { sourceType, verificationStatus: "verified" });
      assert.deepEqual(publicationDecision(o, agreedOn(o)), { publishable: false, reason: "generated_or_ai" });
    }
  });
  test("непроверенное, внутреннее, заменённое и спорное — нет", () => {
    const o = obs("63 шт");
    assert.equal(publicationDecision(o, agreedOn(o)).reason, "not_verified");
    const i = obs("63 шт", { verificationStatus: "verified", accessLevel: "internal" });
    assert.equal(publicationDecision(i, agreedOn(i)).reason, "access_level_not_public");
    const s = obs("63 шт", { verificationStatus: "verified", lifecycleStatus: "superseded" });
    assert.equal(publicationDecision(s, agreedOn(s)).reason, "not_active");
    const c = obs("63 шт", { verificationStatus: "verified" });
    assert.equal(publicationDecision(c, { status: "pending_user_decision", supporting: [] }).reason, "unresolved");
  });
});

// ── API ────────────────────────────────────────────────────────────────────

let app, owner, admin, manager, dealer, customer;
let shov, koroed, gkl;
const json = (res) => JSON.parse(res.body);
const token = (id, role) => ({ authorization: `Bearer ${signJwt({ sub: id, role, tenant: 1 })}` });
const post = (url, payload, headers) => app.inject({ method: "POST", url, payload, headers });
const observe = async (payload, headers = owner) => {
  const res = await post("/api/ai/observations", payload, headers);
  return { res, o: res.statusCode === 201 ? json(res).observation : null };
};
const tech = { sourceType: "factory_technologist", providedBy: "factory_technologist", providedAt: "2026-09-05", sourceReference: "technologist-note-2026-09-05", accessLevel: "public" };
const specsHash = () => createHash("sha256").update(JSON.stringify(all("SELECT * FROM ai_product_specs ORDER BY id"))).digest("hex");
let specsHashBefore;

before(async () => {
  specsHashBefore = specsHash();
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  const mk = (role) => insert("users", { tenant_id: 1, email: `${role}-gate@habez.local`, name: role, role, status: "active" });
  owner = token(get("SELECT id FROM users WHERE role='owner' LIMIT 1").id, "owner");
  admin = token(mk("admin"), "admin");
  manager = token(get("SELECT id FROM users WHERE role='manager' LIMIT 1").id, "manager");
  dealer = token(get("SELECT id FROM users WHERE role='dealer' LIMIT 1").id, "dealer");
  customer = token(mk("customer"), "customer");
  shov = get("SELECT id FROM products WHERE slug='shov'").id;
  koroed = get("SELECT id FROM products WHERE slug='koroed'").id;
  const cat = get("SELECT category_id FROM products WHERE id=?", shov).category_id;
  gkl = { id: insert("products", { tenant_id: 1, slug: "gkl-gate", name: "ГКЛ (тест)", category_id: cat, status: "published" }) };
  gkl.v95 = insert("variants", { tenant_id: 1, product_id: gkl.id, unit: "лист 9,5 мм", pack_size: 9.5, pack_unit: "мм", per_pallet: null, is_default: 1 });
  gkl.v125 = insert("variants", { tenant_id: 1, product_id: gkl.id, unit: "лист 12,5 мм", pack_size: 12.5, pack_unit: "мм", per_pallet: null });
});

after(async () => { await app?.close(); });

test("условие без дословной цитаты не принимается", async () => {
  const { res } = await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "не менее 0,3 МПа", conditions: { age_days: 7 }, ...tech });
  assert.equal(res.statusCode, 400);
  const ok = await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "не менее 0,3 МПа", conditions: { age_days: 7 }, conditionText: "в возрасте 7 сут", ...tech });
  assert.equal(ok.res.statusCode, 201);
  assert.equal(ok.o.conditionText, "в возрасте 7 сут");
});

test("«5–7 л на 1 мешок»: основание хранится структурно и отдельно от «5–7 л»", async () => {
  const card = { sourceType: "product_card", sourceReference: "habez-pro-card/section/Порядок работы", accessLevel: "public" };
  const plain = await observe({ productId: koroed, specKey: "water_ratio", originalValue: "5–7 л", ...card, sourceReference: "habez-pro-card/spec_table/x" });
  const bag = await observe({ productId: koroed, specKey: "water_ratio", originalValue: "5–7 литров", conditions: { per: "bag" }, conditionText: "на 1 мешок", statementType: "instruction", ...card });
  assert.equal(bag.res.statusCode, 201, bag.res.body);
  assert.deepEqual(bag.o.conditions, { per: "bag" }, "«на мешок» — поле условия, а не только текст");
  assert.equal(bag.o.conditionKey, "per=bag");
  assert.equal(bag.o.variantId, null, "к фасовке «мешок 25 кг» не привязано: в тексте её нет");
  assert.notEqual(bag.o.normalizedUnit, "l/kg", "в л/кг не пересчитано");
  const ev = json(await app.inject({ url: `/api/ai/products/${koroed}/evidence`, headers: manager }));
  const groups = ev.properties.filter((p) => p.specKey === "water_ratio" && (p.observations.some((o) => o.id === plain.o.id) || p.observations.some((o) => o.id === bag.o.id)));
  assert.equal(groups.length, 2, "с условием и без — разные свойства");
});

test("9,5 и 12,5 мм не перезаписывают друг друга (GTIN и поддон)", async () => {
  const mark = { sourceType: "marking_card", sourceReference: "marking-card-2026-09-08", accessLevel: "public" };
  const a = await observe({ productId: gkl.id, variantId: gkl.v95, specKey: "gtin", originalValue: "4640004021319", ...mark });
  const b = await observe({ productId: gkl.id, variantId: gkl.v125, specKey: "gtin", originalValue: "4640004021326", ...mark });
  // То же значение у другой фасовки — отдельное наблюдение, не дубль.
  const same = await observe({ productId: gkl.id, variantId: gkl.v125, specKey: "per_pallet", originalValue: "51", ...mark });
  const same2 = await observe({ productId: gkl.id, variantId: gkl.v95, specKey: "per_pallet", originalValue: "51", ...mark });
  for (const r of [a, b, same, same2]) assert.equal(r.res.statusCode, 201, r.res.body);
  const ev = json(await app.inject({ url: `/api/ai/products/${gkl.id}/evidence`, headers: manager }));
  const gtins = ev.properties.filter((p) => p.specKey === "gtin");
  assert.equal(gtins.length, 2);
  assert.ok(gtins.every((g) => g.resolution.current.status === "agreed"));
  assert.deepEqual(gtins.map((g) => g.resolution.current.value.text).sort(), ["4640004021319", "4640004021326"]);
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE product_id=?", gkl.id).n, 4, "ни одно не затёрто");
});

test("непроверенное и подставленное количество на поддоне не попадает в каталог", async () => {
  await observe({ productId: gkl.id, variantId: gkl.v95, specKey: "per_pallet", originalValue: "77", sourceType: "generated_default", sourceReference: "seed-test", accessLevel: "public" });
  const catRes = await app.inject({ url: "/api/catalog/products/gkl-gate" });
  assert.equal(catRes.statusCode, 200, catRes.body);
  const cat = json(catRes);
  assert.ok(cat.product.variants.every((v) => v.perPallet === null), "каталог не берёт поддон из наблюдений");
  assert.ok(!catRes.body.includes("77") && !catRes.body.includes("marking-card"), "ни значение, ни происхождение не утекли");
  const ev = json(await app.inject({ url: `/api/ai/products/${gkl.id}/evidence`, headers: owner }));
  const gen = ev.properties.flatMap((p) => p.observations).find((o) => o.sourceType === "generated_default");
  const decision = ev.properties.find((p) => p.observations.includes(gen) || p.observations.some((o) => o.id === gen.id)).publication[gen.id];
  assert.deepEqual(decision, { publishable: false, reason: "generated_or_ai" });
});

test("вывод AI создаётся непроверенным и не подтверждается", async () => {
  const { o } = await observe({ productId: shov, specKey: "open_time", originalValue: "20 мин", sourceType: "ai_inference", accessLevel: "internal" });
  assert.equal(o.verificationStatus, "unverified");
  const res = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified" }, headers: owner });
  assert.equal(res.statusCode, 400);
  const bogus = await post("/api/ai/observations", { productId: shov, specKey: "open_time", originalValue: "25 мин", sourceType: "ai_inference", verificationStatus: "verified" }, owner);
  assert.equal(bogus.statusCode, 400, "статус при создании передать нельзя");
});

test("замена между разными характеристиками — только решением владельца", async () => {
  const card = { sourceType: "product_card", sourceReference: "habez-pro-card/badge/gate", accessLevel: "public" };
  const oldObs = (await observe({ productId: shov, specKey: "setting_time", originalValue: "60 мин", ...card })).o;
  const neu = (await observe({ productId: shov, specKey: "setting_time_start", originalValue: "70 минут", statementType: "replacement", ...tech })).o;
  const explicit = await post(`/api/ai/observations/${neu.id}/relations`, { toObservationId: oldObs.id, relationType: "replaces", basis: "explicit_source_statement", basisNote: "70 вместо 60" }, owner);
  assert.equal(explicit.statusCode, 400);
  assert.equal(get("SELECT lifecycle_status FROM ai_spec_observations WHERE id=?", oldObs.id).lifecycle_status, "active");
  const decided = await post(`/api/ai/observations/${neu.id}/relations`, { toObservationId: oldObs.id, relationType: "replaces", basis: "user_decision", basisNote: "владелец подтвердил" }, owner);
  assert.equal(decided.statusCode, 201);
  const kept = json(await app.inject({ url: `/api/ai/observations/${oldObs.id}`, headers: manager })).observation;
  assert.equal(kept.lifecycleStatus, "superseded");
  assert.equal(kept.originalValue, "60 мин", "заменённое не удалено и не изменено");
  const listed = json(await app.inject({ url: `/api/ai/observations?productId=${shov}&lifecycle=superseded`, headers: manager }));
  assert.ok(listed.items.some((x) => x.id === oldObs.id));
});

test("доступ: гость, покупатель, дилер, сотрудник, администратор", async () => {
  const conf = (await observe({ productId: shov, specKey: "flexural_strength", originalValue: "1,4 МПа", sourceType: "measurement", sourceReference: "lab-protocol-7", accessLevel: "confidential" }, admin)).o;
  const pub = (await observe({ productId: shov, specKey: "flexural_strength", originalValue: "1 МПа", ...tech })).o;
  assert.ok(conf && pub);
  await post(`/api/ai/observations/${pub.id}/relations`, { toObservationId: conf.id, relationType: "conflicts_with", basis: "user_decision" }, admin);

  for (const url of ["/api/ai/observations", `/api/ai/observations/${pub.id}`, `/api/ai/products/${shov}/evidence`]) {
    assert.equal((await app.inject({ url })).statusCode, 401, `гость: ${url}`);
    assert.equal((await app.inject({ url, headers: customer })).statusCode, 403, `покупатель: ${url}`);
    assert.equal((await app.inject({ url, headers: dealer })).statusCode, 403, `дилер: ${url}`);
  }
  // Сотрудник: конфиденциального не видит ни в списке, ни в связях, ни в итоге.
  assert.equal((await app.inject({ url: `/api/ai/observations/${conf.id}`, headers: manager })).statusCode, 404);
  const list = json(await app.inject({ url: `/api/ai/observations?productId=${shov}&limit=500`, headers: manager }));
  assert.ok(!list.items.some((o) => o.id === conf.id));
  const one = json(await app.inject({ url: `/api/ai/observations/${pub.id}`, headers: manager })).observation;
  assert.ok(!one.relations.some((r) => r.to === conf.id || r.from === conf.id), "связь с конфиденциальным не видна");
  const evM = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: manager }));
  const gM = evM.properties.find((p) => p.specKey === "flexural_strength" && p.conditionKey === "");
  assert.equal(gM.resolution.current.status, "pending_user_decision", "скрытый спор не превращается в «согласно»");
  assert.ok(!JSON.stringify(evM).includes("1,4 МПа") && !JSON.stringify(evM).includes("lab-protocol-7"), "значение и ссылка скрыты");
  assert.ok(gM.resolution.current.candidates.some((c) => c.hidden === true));
  // Администратор видит всё.
  assert.equal((await app.inject({ url: `/api/ai/observations/${conf.id}`, headers: admin })).statusCode, 200);
  const evA = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: admin }));
  assert.ok(JSON.stringify(evA).includes("1,4 МПа"));
  // Покупательский каталог — без наблюдений и происхождения.
  const catBody = (await app.inject({ url: "/api/catalog/products/shov" })).body;
  for (const s of ["lab-protocol-7", "technologist-note", "factory_technologist", "1,4 МПа"]) assert.ok(!catBody.includes(s), s);
});

test("источник фазы 1 не принимает почту и телефон", async () => {
  const bad = await post("/api/ai/sources", { sourceType: "document", name: "Письмо от person@example.ru" }, owner);
  assert.equal(bad.statusCode, 400);
  const phone = await post("/api/ai/sources", { sourceType: "document", name: "Письмо технолога", publisher: "тел. 8 928 111-22-33" }, owner);
  assert.equal(phone.statusCode, 400);
  const ok = await post("/api/ai/sources", { sourceType: "document", name: "Письмо главного технолога завода от 05.09.2026" }, owner);
  assert.equal(ok.statusCode, 201);
});

test("перенос: вид источника по происхождению, а не «всё — карточка»", () => {
  const card = { badges: JSON.stringify([{ label: "Прочность на отрыв", value: "0,5 МПа" }]), spec_tables: "[]" };
  const spec = { imported_from: "badge", source_ref: "ярлык карточки", spec_key: "adhesion_strength", display_value: "0,5 МПа", origin: "habez_internal" };
  // D8: строка найдена, но первоисточник выше карточки не указан → unknown.
  assert.equal(legacySourceType(spec, card), "unknown_legacy_origin", "канал доказан, первоисточник — нет");
  assert.equal(legacySourceType(spec, card, "quality_passport"), "quality_passport", "первоисточник из манифеста");
  assert.equal(legacySourceType(spec, card, "initial_catalog_unrecorded"), "unknown_legacy_origin");
  assert.equal(legacySourceType(spec, null, "quality_passport"), "unknown_legacy_origin", "без строки карточки манифест не помогает");
  assert.equal(legacySourceType(spec, null), "unknown_legacy_origin", "без карточки не доказано");
  assert.equal(legacySourceType({ ...spec, display_value: "0,7 МПа" }, card), "unknown_legacy_origin", "в карточке другое значение");
  assert.equal(legacySourceType({ ...spec, imported_from: "spec_table" }, card), "unknown_legacy_origin", "не тот вид строки");
  assert.equal(legacySourceType({ imported_from: "manual", origin: "ai_inference" }), "ai_inference");
  assert.equal(legacySourceType({ imported_from: "manual", origin: "habez_internal" }), "manual_entry");
});

test("расхождение двух хранилищ обнаруживается", async () => {
  backfillFromSpecs(1);
  assert.equal(legacyDrift(1).changed.length, 0);
  const spec = get("SELECT id FROM ai_product_specs WHERE product_id=? AND spec_key='adhesion_strength'", koroed);
  const res = await app.inject({ method: "PATCH", url: `/api/ai/specs/${spec.id}`, payload: { displayValue: "не менее 0,7 МПа" }, headers: manager });
  assert.equal(res.statusCode, 200, "старый путь работает");
  const drift = legacyDrift(1);
  assert.deepEqual(drift.changed.map((d) => d.spec_id), [spec.id]);
  const o = get("SELECT original_value FROM ai_spec_observations WHERE legacy_spec_id=?", spec.id);
  assert.equal(o.original_value, "не менее 0,5 МПа", "наблюдение само не переписывается");
});

test("откат не трогает старые данные", async () => {
  const copy = resolve(apiRoot, "var/test-ai-evidence-gate-rollback.db");
  for (const s of ["", "-wal", "-shm"]) rmSync(copy + s, { force: true });
  db.exec(`VACUUM INTO '${copy}'`);
  const { DatabaseSync } = await import("node:sqlite");
  const c = new DatabaseSync(copy);
  const h = () => createHash("sha256").update(JSON.stringify(c.prepare("SELECT * FROM ai_product_specs ORDER BY id").all())).digest("hex");
  const hf = () => createHash("sha256").update(JSON.stringify(c.prepare("SELECT * FROM ai_facts ORDER BY id").all())).digest("hex");
  const before = [h(), hf(), c.prepare("SELECT COUNT(*) AS n FROM products").get().n, c.prepare("SELECT COUNT(*) AS n FROM variants").get().n];
  c.exec(readFileSync(resolve(apiRoot, "src/ai/knowledge/evidence-rollback.sql"), "utf8"));
  const afterRollback = [h(), hf(), c.prepare("SELECT COUNT(*) AS n FROM products").get().n, c.prepare("SELECT COUNT(*) AS n FROM variants").get().n];
  assert.deepEqual(afterRollback, before, "характеристики, факты, товары и фасовки — побайтно те же");
  c.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(copy + s, { force: true });
});

test("старый путь ai_product_specs работает и не менялся наблюдениями", async () => {
  // Единственная правка — PATCH в тесте про расхождение, сделанный через старый API.
  const now = all("SELECT id, display_value FROM ai_product_specs ORDER BY id");
  assert.ok(now.length > 600);
  for (const url of ["/api/ai/spec-keys", "/api/ai/products", "/api/ai/products/summary", `/api/ai/products/${shov}/intelligence`, "/api/ai/specs"]) {
    assert.equal((await app.inject({ url, headers: manager })).statusCode, 200, url);
  }
  assert.notEqual(specsHash(), specsHashBefore, "контроль: отпечаток чувствителен к правке через старый API");
});
