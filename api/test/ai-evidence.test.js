// Habez AI, Phase 2.2B: наблюдения из разных источников.
// Главное, что здесь проверяется: второе значение свойства не затирает
// первое; «заменяет» не удаляет старое; 7 и 28 суток — разные наблюдения;
// фасовки 9,5 и 12,5 мм хранятся отдельно; мл/м² не превращается в г/м²;
// почта не попадает в происхождение; старые 726 характеристик на месте.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalConditions, personalDataIn } from "../src/ai/knowledge/evidence-model.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-evidence.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";
process.env.AI_EVIDENCE_ENABLED = "1";

let app, db, get, all, insert;
let adminHeaders, managerHeaders, dealerHeaders;
let shov, antipleseni, gkl, alienProductId, alienObsId;
let specsCountBefore, specsHashBefore;
const json = (res) => JSON.parse(res.body);
const auth = (t) => ({ authorization: `Bearer ${t}` });
const login = async (email, password) =>
  json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }));
const specsHash = () => createHash("sha256").update(JSON.stringify(all("SELECT * FROM ai_product_specs ORDER BY id"))).digest("hex");

const technologist = {
  sourceType: "factory_technologist", providedBy: "factory_technologist",
  providedAt: "2026-09-05", sourceReference: "technologist-note-2026-09-05", accessLevel: "public",
};
const post = (url, payload, headers = adminHeaders) => app.inject({ method: "POST", url, payload, headers });
const observe = async (payload, headers) => {
  const res = await post("/api/ai/observations", payload, headers);
  return { res, o: res.statusCode === 201 ? json(res).observation : null };
};

// ── Чистые функции ─────────────────────────────────────────────────────────

describe("условия и приватность без базы", () => {
  test("условие приводится к одному виду", () => {
    assert.equal(canonicalConditions({ age_days: 7 }).key, "age_days=7");
    assert.equal(canonicalConditions({ age_days: "7" }).key, "age_days=7", "«7» строкой — то же условие");
    assert.equal(canonicalConditions({ per: "Bag", layer_mm: 1 }).key, "layer_mm=1;per=bag", "порядок ключей не важен");
    assert.equal(canonicalConditions({}).key, "");
    assert.notEqual(canonicalConditions({ age_days: 7 }).key, canonicalConditions({ age_days: 28 }).key);
    assert.throws(() => canonicalConditions({ weather: "дождь" }), /Неизвестное условие/);
    assert.throws(() => canonicalConditions({ age_days: "неделя" }), /числом/);
  });

  test("почта и телефон распознаются, обычные ссылки — нет", () => {
    assert.ok(personalDataIn("письмо от ivan.petrov@example.ru"));
    assert.ok(personalDataIn("тел. +7 (928) 123-45-67"));
    assert.equal(personalDataIn("technologist-note-2026-09-05"), null);
    assert.equal(personalDataIn("ГОСТ 31357-2007, партия 2026-09-10"), null);
  });
});

// ── API ────────────────────────────────────────────────────────────────────

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });

  ({ db, get, all, insert } = await import("../src/db/index.js"));
  specsCountBefore = get("SELECT COUNT(*) AS n FROM ai_product_specs").n;
  specsHashBefore = specsHash();

  ({ build: app } = await import("../src/server.js"));
  app = await app();
  adminHeaders = auth((await login("admin@habez.local", "admin12345")).accessToken);
  managerHeaders = auth((await login("manager@habez.local", "manager12345")).accessToken);
  dealerHeaders = auth((await login("dealer@habez.local", "dealer12345")).accessToken);

  shov = get("SELECT id FROM products WHERE slug='shov'").id;
  antipleseni = get("SELECT id FROM products WHERE slug='antipleseni'").id;
  // Гипсокартон с двумя толщинами — как в рабочей базе (в сиде его нет).
  const cat = get("SELECT category_id FROM products WHERE id=?", shov).category_id;
  gkl = { id: insert("products", { tenant_id: 1, slug: "gkl-test", name: "Гипсокартонный лист (тест)", category_id: cat }) };
  gkl.v95 = insert("variants", { tenant_id: 1, product_id: gkl.id, unit: "лист 9,5 мм", pack_size: 9.5, pack_unit: "мм", per_pallet: 63 });
  gkl.v125 = insert("variants", { tenant_id: 1, product_id: gkl.id, unit: "лист 12,5 мм", pack_size: 12.5, pack_unit: "мм", per_pallet: 51 });

  db.exec("INSERT INTO tenants (slug, name) VALUES ('other3', 'Чужой завод')");
  const alien = get("SELECT id FROM tenants WHERE slug='other3'").id;
  alienProductId = insert("products", { tenant_id: alien, slug: "alien-ev", name: "Товар чужого завода" });
  alienObsId = insert("ai_spec_observations", {
    tenant_id: alien, product_id: alienProductId, spec_key: "compressive_strength", original_value: "99 МПа",
    value_num: 99, normalized_unit: "MPa", source_type: "product_card", source_reference: "x",
    access_level: "public", content_hash: "alien-hash",
  });
});

after(async () => { await app?.close(); });

test("миграция: старые характеристики на месте и не изменились", async () => {
  // Миграция уже прошла в before (migrate.js), перенос — после неё; второй
  // прогон миграции ничего не должен менять.
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env: { ...process.env, DATABASE_FILE: testDb }, stdio: "ignore" });
  assert.ok(get("SELECT name FROM migrations WHERE name='2026-09-ai-evidence'"), "миграция отмечена");
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_product_specs").n, specsCountBefore);
  assert.equal(specsHash(), specsHashBefore, "ни одно значение, источник или статус не изменились");
  const listed = json(await app.inject({ url: "/api/ai/specs?limit=1", headers: managerHeaders }));
  assert.equal(listed.total, specsCountBefore, "все характеристики доступны через старый API");
});

test("перенос в наблюдения сохраняет значение, единицу, канал и дату; всё internal и непроверенное (D8, D9)", async () => {
  const { backfillFromSpecs } = await import("../src/ai/knowledge/evidence.js");
  const r = backfillFromSpecs(1);
  assert.equal(r.created, specsCountBefore);
  const bad = get(`SELECT COUNT(*) AS n FROM ai_product_specs s JOIN ai_spec_observations o ON o.legacy_spec_id=s.id
    WHERE s.display_value IS NOT o.original_value OR s.value_num IS NOT o.value_num OR s.value_min IS NOT o.value_min
       OR s.value_max IS NOT o.value_max OR s.normalized_unit IS NOT o.normalized_unit
       OR s.observed_at IS NOT o.captured_at OR o.verification_status <> 'unverified' OR o.access_level <> 'internal'
       OR o.source_id IS NOT NULL OR o.capture_ref NOT LIKE 'ai_sources#' || s.source_id || ' /%'`).n;
  assert.equal(bad, 0);
  assert.equal(backfillFromSpecs(1).created, 0, "повторный перенос ничего не дублирует");
  assert.equal(specsHash(), specsHashBefore, "перенос не трогает ai_product_specs");
});

test("два источника одного свойства: оба сохраняются, выбор не делается", async () => {
  const a = await observe({ productId: shov, specKey: "flexural_strength", originalValue: "1 МПа", sourceType: "product_card", sourceReference: "card-a" });
  const b = await observe({ productId: shov, specKey: "flexural_strength", originalValue: "1,2 МПа", statementType: "declared", ...technologist });
  assert.equal(a.res.statusCode, 201, a.res.body);
  assert.equal(b.res.statusCode, 201, b.res.body);
  const list = json(await app.inject({ url: `/api/ai/observations?productId=${shov}&specKey=flexural_strength`, headers: managerHeaders }));
  assert.equal(list.total, 2, "второе значение не затёрло первое");
  const ev = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: managerHeaders }));
  const g = ev.properties.find((p) => p.specKey === "flexural_strength" && p.conditionKey === "");
  assert.equal(g.resolution.current.status, "pending_user_decision", "расхождение без правила — ждёт решения");
  assert.equal(g.resolution.current.value, null, "значение не выбрано ни по дате, ни по источнику");
  // Тот же документ с тем же значением второй раз — не дубль, а отказ.
  const dup = await observe({ productId: shov, specKey: "flexural_strength", originalValue: "1,2 МПа", statementType: "declared", ...technologist });
  assert.equal(dup.res.statusCode, 409);
});

test("приоритет видов источника работает только если задан владельцем", async () => {
  const { productEvidence } = await import("../src/ai/knowledge/evidence.js");
  const g = () => productEvidence(1, shov, "owner").properties.find((p) => p.specKey === "flexural_strength" && p.conditionKey === "");
  insert("ai_source_type_priorities", { tenant_id: 1, source_type: "factory_technologist", priority: 90 });
  assert.equal(g().resolution.current.status, "pending_user_decision", "приоритет задан не для всех видов — не решаем");
  insert("ai_source_type_priorities", { tenant_id: 1, source_type: "product_card", priority: 50 });
  const r = g().resolution.current;
  assert.equal(r.status, "resolved_by_policy");
  assert.deepEqual(r.value.displays, ["1,2 МПа"]);
  db.exec("DELETE FROM ai_source_type_priorities");
});

test("замена: новое помечает старое superseded, старое не удаляется", async () => {
  const oldObs = (await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "0,5 МПа", sourceType: "product_card", sourceReference: "habez-pro-card/badge/test", accessLevel: "public" })).o;
  const newObs = (await observe({
    productId: shov, specKey: "adhesion_strength", originalValue: "не менее 0,3 МПа",
    conditions: { age_days: 7 }, conditionText: "в возрасте 7 сут", statementType: "replacement", ...technologist,
  })).o;
  // Условие у нового другое (7 сут), поэтому «по словам источника» нельзя —
  // только решением владельца (R8).
  const byText = await post(`/api/ai/observations/${newObs.id}/relations`, {
    toObservationId: oldObs.id, relationType: "replaces", basis: "explicit_source_statement", basisNote: "0,3 МПа вместо 0,5",
  });
  assert.equal(byText.statusCode, 400, byText.body);
  const rel = await post(`/api/ai/observations/${newObs.id}/relations`, {
    toObservationId: oldObs.id, relationType: "replaces", basis: "user_decision", basisNote: "владелец: 0,3 МПа вместо 0,5",
  });
  assert.equal(rel.statusCode, 201, rel.body);
  const after = json(await app.inject({ url: `/api/ai/observations/${oldObs.id}`, headers: managerHeaders })).observation;
  assert.equal(after.lifecycleStatus, "superseded");
  assert.equal(after.originalValue, "0,5 МПа", "старое значение сохранено как было");
  assert.ok(after.relations.some((r) => r.relationType === "replaces" && r.from === newObs.id && r.to === oldObs.id));

  const ev = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: managerHeaders }));
  const oldGroup = ev.properties.find((p) => p.specKey === "adhesion_strength" && p.conditionKey === "");
  assert.ok(oldGroup.resolution.history.some((h) => h.id === oldObs.id && h.lifecycleStatus === "superseded"), "старое видно в истории");
  const newGroup = ev.properties.find((p) => p.specKey === "adhesion_strength" && p.conditionKey === "age_days=7");
  assert.deepEqual(newGroup.resolution.current.supporting, [newObs.id]);

  // Круг и повтор не допускаются.
  const cycle = await post(`/api/ai/observations/${oldObs.id}/relations`, {
    toObservationId: newObs.id, relationType: "replaces", basis: "user_decision",
  });
  assert.equal(cycle.statusCode, 400);
  const again = await post(`/api/ai/observations/${newObs.id}/relations`, {
    toObservationId: oldObs.id, relationType: "replaces", basis: "user_decision", basisNote: "повтор",
  });
  assert.equal(again.statusCode, 409);
  // «По словам источника» без цитаты или ссылки — нельзя.
  const other = (await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "0,4 МПа", sourceType: "label", sourceReference: "label-x" })).o;
  const noBasis = await post(`/api/ai/observations/${other.id}/relations`, {
    toObservationId: newObs.id, relationType: "conflicts_with", basis: "explicit_source_statement",
  });
  assert.equal(noBasis.statusCode, 400);
  assert.ok(get("SELECT id FROM ai_spec_observations WHERE id=?", oldObs.id), "строка старого наблюдения на месте");
});

test("условия: 7 и 28 суток — разные наблюдения, а не спор", async () => {
  const d7 = await observe({ productId: shov, specKey: "compressive_strength", originalValue: "не менее 2,5 МПа", conditions: { age_days: 7 }, conditionText: "в возрасте 7 сут", statementType: "declared", ...technologist });
  const d28 = await observe({ productId: shov, specKey: "compressive_strength", originalValue: "не менее 4 МПа", conditions: { age_days: 28 }, conditionText: "в возрасте 28 сут", statementType: "declared", ...technologist });
  assert.equal(d7.res.statusCode, 201, d7.res.body);
  assert.equal(d28.res.statusCode, 201, d28.res.body);
  assert.notEqual(d7.o.id, d28.o.id);
  const ev = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: managerHeaders }));
  const g7 = ev.properties.find((p) => p.specKey === "compressive_strength" && p.conditionKey === "age_days=7");
  const g28 = ev.properties.find((p) => p.specKey === "compressive_strength" && p.conditionKey === "age_days=28");
  assert.equal(g7.resolution.current.status, "agreed");
  assert.equal(g28.resolution.current.status, "agreed");
  assert.equal(g7.resolution.current.value.num, 2.5);
  assert.equal(g28.resolution.current.value.num, 4);
  const bad = await observe({ productId: shov, specKey: "compressive_strength", originalValue: "3 МПа", conditions: { weather: "sun" }, conditionText: "в солнечную погоду", ...technologist });
  assert.equal(bad.res.statusCode, 400, "неизвестное условие не принимается");
});

test("фасовки: 9,5 и 12,5 мм хранят разные значения одного ключа", async () => {
  const card = { sourceType: "product_card", sourceReference: "habez-pro-card/spec_table/Технические характеристики", accessLevel: "public" };
  const a = await observe({ productId: gkl.id, variantId: gkl.v95, specKey: "per_pallet", originalValue: "63 шт", conditionText: "(9,5 мм)", ...card });
  const b = await observe({ productId: gkl.id, variantId: gkl.v125, specKey: "per_pallet", originalValue: "51 шт", conditionText: "(12,5 мм)", ...card });
  assert.equal(a.res.statusCode, 201, a.res.body);
  assert.equal(b.res.statusCode, 201, b.res.body);
  const ev = json(await app.inject({ url: `/api/ai/products/${gkl.id}/evidence`, headers: managerHeaders }));
  const groups = ev.properties.filter((p) => p.specKey === "per_pallet");
  assert.equal(groups.length, 2, "две фасовки — две группы, а не спор");
  assert.deepEqual(groups.map((g) => g.resolution.current.value.num).sort(), [51, 63]);
  assert.ok(groups.every((g) => g.resolution.current.status === "agreed"));
  const gtin = await observe({ productId: gkl.id, variantId: gkl.v95, specKey: "gtin", originalValue: "4640004021319", sourceType: "marking_card", sourceReference: "marking-card-2026-09-08" });
  assert.equal(gtin.o.value.text, "4640004021319", "штрихкод — строка, а не число");
  assert.equal(gtin.o.value.num, null);
  const noVariant = await observe({ productId: gkl.id, specKey: "per_pallet", originalValue: "63", ...card });
  assert.equal(noVariant.res.statusCode, 400, "фасовочный ключ без фасовки не принимается");
  const foreignVariant = await observe({ productId: shov, variantId: gkl.v95, specKey: "per_pallet", originalValue: "63", ...card });
  assert.equal(foreignVariant.res.statusCode, 404, "фасовка другого товара не подходит");
  // Каталог не изменился.
  assert.equal(get("SELECT per_pallet FROM variants WHERE id=?", gkl.v95).per_pallet, 63);
});

test("подставленное программой (per_pallet = 40) нельзя подтвердить", async () => {
  const v = get("SELECT id, product_id FROM variants WHERE product_id=? LIMIT 1", shov);
  const { o } = await observe({ productId: shov, variantId: v.id, specKey: "per_pallet", originalValue: "40", sourceType: "generated_default", sourceReference: "api/src/db/seed.js" });
  assert.equal(o.verificationStatus, "unverified");
  assert.equal(o.value.num, 40);
  const res = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified" }, headers: adminHeaders });
  assert.equal(res.statusCode, 400);
});

test("единицы: 90–100 мл/м² не превращается в 200 г/м²", async () => {
  const oldObs = (await observe({ productId: antipleseni, specKey: "consumption", originalValue: "90–100 мл/м²", sourceType: "product_card", sourceReference: "habez-pro-card/spec_table/test" })).o;
  const newObs = (await observe({ productId: antipleseni, specKey: "consumption", originalValue: "200 г/м²", statementType: "replacement", ...technologist, providedAt: "2026-09-08", sourceReference: "technologist-note-2026-09-08" })).o;
  assert.equal(oldObs.normalizedUnit, "l/m2");
  assert.equal(oldObs.value.min, 0.09);
  assert.equal(oldObs.value.max, 0.1);
  assert.equal(oldObs.originalValue, "90–100 мл/м²");
  assert.equal(newObs.normalizedUnit, "kg/m2");
  assert.equal(newObs.value.num, 0.2);
  const ev = json(await app.inject({ url: `/api/ai/products/${antipleseni}/evidence`, headers: managerHeaders }));
  const g = ev.properties.find((p) => p.specKey === "consumption" && p.conditionKey === "");
  assert.equal(g.resolution.current.status, "pending_user_decision", "разные величины — не выбираем и не пересчитываем");
  assert.equal(g.resolution.current.reason, "different_units");
  const units = g.resolution.current.candidates.map((c) => c.unit).sort();
  assert.deepEqual(units, ["kg/m2", "l/m2"]);
  assert.equal(get("SELECT normalized_unit FROM ai_spec_observations WHERE id=?", oldObs.id).normalized_unit, "l/m2", "старое в базе не пересчитано");
});

test("заявленное, замер и норма не спорят друг с другом", async () => {
  const base = { productId: antipleseni, specKey: "non_volatile", sourceType: "quality_passport", sourceReference: "passport-2026-09-10" };
  await observe({ ...base, originalValue: "50–57 %", statementType: "declared" });
  await observe({ ...base, originalValue: "50 %", statementType: "measured" });
  const ev = json(await app.inject({ url: `/api/ai/products/${antipleseni}/evidence`, headers: managerHeaders }));
  const g = ev.properties.find((p) => p.specKey === base.specKey && p.conditionKey === "");
  assert.equal(g.resolution.current.status, "agreed");
  assert.deepEqual(g.resolution.current.value.displays, ["50–57 %"]);
  assert.deepEqual(g.resolution.measured.value.displays, ["50 %"]);
});

test("происхождение сохраняется полностью", async () => {
  const { o } = await observe({
    productId: shov, specKey: "layer_thickness", originalValue: "0,2–3 мм", statementType: "declared",
    ...technologist, sourceName: "Письмо главного технолога завода от 05.09.2026",
    evidenceNote: "документ по ШОВу, мешок 25 кг", label: "Толщина слоя",
  });
  const got = json(await app.inject({ url: `/api/ai/observations/${o.id}`, headers: managerHeaders })).observation;
  for (const [k, v] of Object.entries({
    sourceType: "factory_technologist", sourceReference: "technologist-note-2026-09-05", providedBy: "factory_technologist",
    providedAt: "2026-09-05", sourceName: "Письмо главного технолога завода от 05.09.2026", accessLevel: "public",
    evidenceNote: "документ по ШОВу, мешок 25 кг", originalValue: "0,2–3 мм", verificationStatus: "unverified",
  })) assert.equal(got[k], v, k);
  assert.ok(got.capturedAt);
  assert.equal(got.value.min, 0.2);
  const noSource = await observe({ productId: shov, specKey: "layer_thickness", originalValue: "1 мм", sourceType: "factory_technologist" });
  assert.equal(noSource.res.statusCode, 400, "без источника наблюдение не принимается");
});

test("приватность: почта и имя не попадают в происхождение", async () => {
  for (const field of ["sourceReference", "sourceName", "evidenceNote", "conditionText", "label"]) {
    const { res } = await observe({ productId: shov, specKey: "color", originalValue: "белый", ...technologist, [field]: "письмо от tech.person@example.ru" });
    assert.equal(res.statusCode, 400, `${field}: почта отклонена`);
  }
  const phone = await observe({ productId: shov, specKey: "color", originalValue: "белый", ...technologist, evidenceNote: "звонил +7 928 111-22-33" });
  assert.equal(phone.res.statusCode, 400);
  const person = await observe({ productId: shov, specKey: "color", originalValue: "белый", ...technologist, providedBy: "Иван Петров" });
  assert.equal(person.res.statusCode, 400, "providedBy — только роль");
  const rows = all("SELECT * FROM ai_spec_observations");
  assert.ok(rows.every((r) => !JSON.stringify(r).includes("@example.ru")), "в базу почта не попала");
  const planText = readFileSync(resolve(apiRoot, "src/ai/knowledge/evidence-plan.js"), "utf8");
  assert.equal(personalDataIn(planText), null, "в плане исправлений нет контактов");
});

test("изоляция компаний: чужие наблюдения не видны и не связываются", async () => {
  const list = json(await app.inject({ url: "/api/ai/observations?limit=500", headers: adminHeaders }));
  assert.ok(list.items.every((o) => o.productId !== alienProductId));
  assert.equal((await app.inject({ url: `/api/ai/observations/${alienObsId}`, headers: adminHeaders })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/ai/products/${alienProductId}/evidence`, headers: adminHeaders })).statusCode, 404);
  const onAlien = await observe({ productId: alienProductId, specKey: "color", originalValue: "белый", ...technologist });
  assert.equal(onAlien.res.statusCode, 404);
  const mine = get("SELECT id FROM ai_spec_observations WHERE tenant_id=1 LIMIT 1").id;
  const link = await post(`/api/ai/observations/${mine}/relations`, { toObservationId: alienObsId, relationType: "confirms", basis: "user_decision" });
  assert.equal(link.statusCode, 404);
});

test("права: подтверждает и связывает только администратор", async () => {
  const { o } = await observe({ productId: shov, specKey: "color", originalValue: "оттенок белого", ...technologist }, managerHeaders);
  assert.ok(o, "менеджер заводит наблюдение");
  const byManager = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified" }, headers: managerHeaders });
  assert.equal(byManager.statusCode, 403);
  const other = get("SELECT id FROM ai_spec_observations WHERE tenant_id=1 AND product_id=? AND id<>? LIMIT 1", shov, o.id).id;
  const relByManager = await post(`/api/ai/observations/${o.id}/relations`, { toObservationId: other, relationType: "replaces", basis: "user_decision" }, managerHeaders);
  assert.equal(relByManager.statusCode, 403);
  const confidential = await observe({ productId: shov, specKey: "color", originalValue: "серый", ...technologist, accessLevel: "confidential" }, managerHeaders);
  assert.equal(confidential.res.statusCode, 403, "конфиденциальное заводит администратор");
  assert.equal((await app.inject({ url: "/api/ai/observations", headers: dealerHeaders })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/ai/observations" })).statusCode, 401);

  const ok = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified", note: "сверено с письмом" }, headers: adminHeaders });
  assert.equal(ok.statusCode, 200);
  assert.equal(json(ok).observation.verificationStatus, "verified");
  const hist = json(await app.inject({ url: `/api/ai/observations/${o.id}/history`, headers: managerHeaders }));
  assert.ok(hist.items.some((h) => h.action === "ai.observation.verification"), "подтверждение в журнале");
  assert.ok(hist.items.some((h) => h.action === "ai.observation.create"));
});

test("уровень доступа: конфиденциальное менеджеру не видно", async () => {
  const { o } = await observe({ productId: shov, specKey: "color", originalValue: "слоновая кость", ...technologist, accessLevel: "confidential" });
  assert.ok(o);
  assert.equal((await app.inject({ url: `/api/ai/observations/${o.id}`, headers: managerHeaders })).statusCode, 404);
  const mgr = json(await app.inject({ url: `/api/ai/observations?productId=${shov}&limit=500`, headers: managerHeaders }));
  assert.ok(mgr.items.every((x) => x.accessLevel !== "confidential"));
  assert.equal((await app.inject({ url: `/api/ai/observations/${o.id}`, headers: adminHeaders })).statusCode, 200);
});

test("старые маршруты и покупательский каталог работают как прежде", async () => {
  for (const url of ["/api/ai/spec-keys", "/api/ai/products", "/api/ai/products/summary",
    `/api/ai/products/${shov}/intelligence`, `/api/ai/products/compare?ids=${shov},${antipleseni}`, "/api/ai/specs"]) {
    const res = await app.inject({ url, headers: managerHeaders });
    assert.equal(res.statusCode, 200, url);
  }
  const intel = json(await app.inject({ url: `/api/ai/products/${shov}/intelligence`, headers: managerHeaders }));
  assert.ok(!("observations" in intel), "ответ intelligence не расширялся");
  assert.equal(specsHash(), specsHashBefore, "работа с наблюдениями не тронула ai_product_specs");
  const cat = json(await app.inject({ url: "/api/catalog/products/shov" }));
  assert.ok(cat.product);
  assert.ok(!JSON.stringify(cat).includes("technologist-note"), "наблюдения не попадают в покупательский каталог");
});

test("откат миграции удаляет только новые таблицы", async () => {
  const copy = resolve(apiRoot, "var/test-ai-evidence-rollback.db");
  for (const s of ["", "-wal", "-shm"]) rmSync(copy + s, { force: true });
  db.exec(`VACUUM INTO '${copy}'`);
  const { DatabaseSync } = await import("node:sqlite");
  const c = new DatabaseSync(copy);
  const before = c.prepare("SELECT COUNT(*) AS n FROM ai_product_specs").get().n;
  c.exec(readFileSync(resolve(apiRoot, "src/ai/knowledge/evidence-rollback.sql"), "utf8"));
  assert.equal(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'ai_spec_observations%' OR name='ai_observation_relations'").get().n, 0);
  assert.equal(c.prepare("SELECT COUNT(*) AS n FROM ai_product_specs").get().n, before);
  c.close();
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env: { ...process.env, DATABASE_FILE: copy }, stdio: "ignore" });
  const c2 = new DatabaseSync(copy);
  assert.equal(c2.prepare("SELECT COUNT(*) AS n FROM ai_spec_observations").get().n, 0, "после повторной миграции таблицы пустые, но есть");
  c2.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(copy + s, { force: true });
});
