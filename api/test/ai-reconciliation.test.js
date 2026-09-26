// Habez AI, Phase 2.2C — сверка данных перед переносом.
// Здесь закреплено: старая запись не становится «карточкой», публичной или
// подтверждённой только из-за переноса; происхождение не теряется; спорные
// значения сосуществуют; замена — только явно; новые базы не получают
// выдуманных «40 на поддоне»; сверка ничего не пишет в базу.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, chmodSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-reconcile.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";
process.env.AI_EVIDENCE_ENABLED = "1";

let app, owner, db, get, all, insert, run, ev;
const json = (res) => JSON.parse(res.body);
const post = (url, payload) => app.inject({ method: "POST", url, payload, headers: owner });
const observe = async (payload) => {
  const res = await post("/api/ai/observations", payload);
  return { res, o: res.statusCode === 201 ? json(res).observation : null };
};
const tech = { sourceType: "factory_technologist", providedBy: "factory_technologist", providedAt: "2026-09-05", sourceReference: "technologist-note-2026-09-05", accessLevel: "public" };
let shov, standart, antipleseni;
let changedSpec, aiSpec, manualSpec, verifiedSpec;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ db, get, all, insert, run } = await import("../src/db/index.js"));
  ev = await import("../src/ai/knowledge/evidence.js");
  const { signJwt } = await import("../src/lib/crypto.js");
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  owner = { authorization: `Bearer ${signJwt({ sub: get("SELECT id FROM users WHERE role='owner'").id, role: "owner", tenant: 1 })}` };
  shov = get("SELECT id FROM products WHERE slug='shov'").id;
  standart = get("SELECT id FROM products WHERE slug='standart'").id;
  antipleseni = get("SELECT id FROM products WHERE slug='antipleseni'").id;

  // Подготовка четырёх видов старых строк — только в тестовой базе.
  // 1) карточку изменили после переноса: строка больше не доказывается;
  changedSpec = get("SELECT * FROM ai_product_specs WHERE product_id=? AND imported_from='badge' LIMIT 1", shov);
  const badges = JSON.parse(get("SELECT badges FROM products WHERE id=?", shov).badges)
    .map((b) => (b.value === changedSpec.display_value ? { ...b, value: `${b.value} (изменено)` } : b));
  run("UPDATE products SET badges=? WHERE id=?", JSON.stringify(badges), shov);
  // 2) вывод модели; 3) ручной ввод; 4) подтверждённая строка карточки.
  aiSpec = insert("ai_product_specs", { tenant_id: 1, product_id: antipleseni, spec_key: "open_time", label: "Открытое время", display_value: "15 мин", value_num: 15, normalized_unit: "min", comparator: "exact", origin: "ai_inference", imported_from: "manual", verification_status: "unverified" });
  manualSpec = insert("ai_product_specs", { tenant_id: 1, product_id: antipleseni, spec_key: "adjust_time", label: "Время корректировки", display_value: "10 мин", value_num: 10, normalized_unit: "min", comparator: "exact", origin: "habez_internal", imported_from: "manual", verification_status: "unverified" });
  verifiedSpec = get("SELECT id FROM ai_product_specs WHERE product_id=? AND imported_from='spec_table' LIMIT 1", standart).id;
  run("UPDATE ai_product_specs SET verification_status='verified', verified_at='2026-09-24 12:00:00', checked_at='2026-09-24 12:00:00' WHERE id=?", verifiedSpec);
  // Строка, у которой карточка изменена, тоже «подтверждена» — перенос не должен это сохранить.
  run("UPDATE ai_product_specs SET verification_status='verified' WHERE id=?", changedSpec.id);
  ev.backfillFromSpecs(1);
});

after(async () => { await app?.close(); });

const obsOf = (specId) => get("SELECT * FROM ai_spec_observations WHERE legacy_spec_id=?", specId);

test("происхождение не доказано → unknown_legacy_origin, internal, не подтверждено", async () => {
  const o = obsOf(changedSpec.id);
  assert.equal(o.source_type, "unknown_legacy_origin");
  assert.equal(o.access_level, "internal");
  assert.equal(o.verification_status, "unverified", "«подтверждено» не переносится на недоказанное");
  assert.equal(o.original_value, changedSpec.display_value, "значение сохранено как было");
  const res = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified" }, headers: owner });
  assert.equal(res.statusCode, 400, "подтвердить недоказанное нельзя");
});

test("старый вывод AI остаётся ai_inference и не публикуется", () => {
  const o = obsOf(aiSpec);
  assert.equal(o.source_type, "ai_inference");
  assert.equal(o.access_level, "internal");
  const ev2 = ev.productEvidence(1, antipleseni, "owner");
  const g = ev2.properties.find((p) => p.observations.some((x) => x.id === o.id));
  assert.equal(g.publication[o.id].publishable, false);
});

test("старый ручной ввод не становится «карточкой товара»", () => {
  assert.equal(obsOf(manualSpec).source_type, "manual_entry");
});

test("перенос ничего не публикует: все старые наблюдения internal", () => {
  const levels = all("SELECT access_level, COUNT(*) AS n FROM ai_spec_observations WHERE legacy_spec_id IS NOT NULL GROUP BY 1");
  assert.deepEqual(levels.map((r) => r.access_level), ["internal"]);
});

test("происхождение старой записи не теряется", () => {
  const s = get("SELECT * FROM ai_product_specs WHERE id=?", verifiedSpec);
  const o = obsOf(verifiedSpec);
  // D8: строка найдена в карточке — это канал, а не первоисточник; без
  // манифеста первоисточник не доказан.
  assert.equal(o.source_type, "unknown_legacy_origin");
  assert.equal(o.capture_channel, "habez_pro_product_card", "канал доказан строкой карточки");
  assert.ok(o.capture_ref.startsWith(`ai_sources#${s.source_id} / spec_table /`), "ссылка на строку карточки");
  // D9: проверка старой строки не переносится; она остаётся в самой строке.
  assert.equal(o.verification_status, "unverified");
  assert.equal(get("SELECT verification_status FROM ai_product_specs WHERE id=?", verifiedSpec).verification_status, "verified", "старая строка не тронута");
  assert.equal(o.legacy_spec_id, s.id);
  assert.equal(o.backfill_key, `legacy-spec:${s.id}`);
  assert.equal(o.captured_at, s.observed_at);
  assert.equal(o.legacy_origin, s.origin);
  assert.equal(o.provided_at, null, "дата документа не подставляется");
  assert.equal(o.source_reference, `habez-pro-spec#${s.id}`);
  assert.notEqual(o.label, null);
  assert.ok(o.evidence_note.includes("строка найдена в текущей карточке"));
  // Подпись — из карточки, а не словарная.
  const card = JSON.parse(get("SELECT spec_tables FROM products WHERE id=?", standart).spec_tables);
  assert.ok(card.some((t) => t.rows.some((r) => r[0] === o.label)), "подпись совпадает со строкой карточки");
});

test("публикация требует всего сразу: проверено, не догадка, действует, согласие", async () => {
  const { publicationDecision } = await import("../src/ai/knowledge/evidence-model.js");
  const base = { id: 1, accessLevel: "public", sourceType: "product_card", verificationStatus: "verified", lifecycleStatus: "active" };
  const ok = { status: "agreed", supporting: [1] };
  assert.equal(publicationDecision(base, ok).publishable, true);
  assert.equal(publicationDecision({ ...base, sourceType: "unknown_legacy_origin" }, ok).reason, "unknown_provenance");
  assert.equal(publicationDecision({ ...base, sourceType: "generated_default" }, ok).reason, "generated_or_ai");
  assert.equal(publicationDecision({ ...base, verificationStatus: "unverified" }, ok).reason, "not_verified");
  assert.equal(publicationDecision({ ...base, lifecycleStatus: "superseded" }, ok).reason, "not_active");
  assert.equal(publicationDecision(base, { status: "pending_user_decision", supporting: [] }).reason, "unresolved");
});

test("ШОВ: 0,5 и 0,3 МПа сосуществуют, одним значением не отдаются", async () => {
  const a = await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "0,5 МПа", sourceType: "product_card", sourceReference: "habez-pro-card/badge/r1", accessLevel: "public" });
  const b = await observe({ productId: shov, specKey: "adhesion_strength", originalValue: "не менее 0,3 МПа", statementType: "replacement", ...tech });
  assert.equal(a.res.statusCode, 201); assert.equal(b.res.statusCode, 201);
  const e = json(await app.inject({ url: `/api/ai/products/${shov}/evidence`, headers: owner }));
  const g = e.properties.find((p) => p.specKey === "adhesion_strength" && p.conditionKey === "");
  assert.equal(g.resolution.current.status, "pending_user_decision");
  assert.equal(g.resolution.current.value, null);
  assert.ok(g.observations.some((o) => o.id === a.o.id) && g.observations.some((o) => o.id === b.o.id));
  assert.ok(g.resolution.unlinkedReplacementClaims.includes(b.o.id), "«вместо» без связи виден как сигнал");
});

test("СТАНДАРТ: 0,5 и «не менее 0,6» МПа сосуществуют, победителя нет", async () => {
  await observe({ productId: standart, specKey: "adhesion_strength", originalValue: "0,5 МПа", label: "Прочность на отрыв не менее", sourceType: "product_card", sourceReference: "habez-pro-card/badge/r2", accessLevel: "public" });
  await observe({ productId: standart, specKey: "adhesion_strength", originalValue: "не менее 0,6 МПа", label: "Адгезия (прочность на отрыв)", sourceType: "product_card", sourceReference: "habez-pro-card/spec_table/r2", accessLevel: "public" });
  const e = json(await app.inject({ url: `/api/ai/products/${standart}/evidence`, headers: owner }));
  const g = e.properties.find((p) => p.specKey === "adhesion_strength" && p.conditionKey === "");
  assert.equal(g.resolution.current.status, "pending_user_decision");
  const displays = g.resolution.current.candidates.flatMap((c) => c.displays);
  assert.ok(displays.includes("0,5 МПа") && displays.includes("не менее 0,6 МПа"));
  // Старый путь по-прежнему отдаёт одно значение — это известное ограничение, а не истина.
  const legacy = json(await app.inject({ url: `/api/ai/specs?productId=${standart}&specKey=adhesion_strength`, headers: owner }));
  assert.equal(legacy.items.length, 1);
});

test("замена создаётся только явно: другая единица или фасовка — только решением", async () => {
  const old = (await observe({ productId: antipleseni, specKey: "consumption", originalValue: "90–100 мл/м²", sourceType: "product_card", sourceReference: "habez-pro-card/spec_table/r3" })).o;
  const neu = (await observe({ productId: antipleseni, specKey: "consumption", originalValue: "200 г/м²", statementType: "replacement", ...tech, sourceReference: "technologist-note-2026-09-08" })).o;
  const byText = await post(`/api/ai/observations/${neu.id}/relations`, { toObservationId: old.id, relationType: "replaces", basis: "explicit_source_statement", basisNote: "200 г/м² вместо 90–100 мл/м²" });
  assert.equal(byText.statusCode, 400, "мл/м² → г/м² «по словам источника» нельзя");
  assert.equal(get("SELECT lifecycle_status FROM ai_spec_observations WHERE id=?", old.id).lifecycle_status, "active");
  assert.equal(get("SELECT normalized_unit FROM ai_spec_observations WHERE id=?", old.id).normalized_unit, "l/m2", "не пересчитано");

  const v = get("SELECT id FROM variants WHERE product_id=?", shov).id;
  const cat = get("SELECT category_id FROM products WHERE id=?", shov).category_id;
  const p2 = insert("products", { tenant_id: 1, slug: "gkl-rec", name: "ГКЛ (тест 2.2C)", category_id: cat });
  const v1 = insert("variants", { tenant_id: 1, product_id: p2, unit: "лист 9,5 мм" });
  const v2 = insert("variants", { tenant_id: 1, product_id: p2, unit: "лист 12,5 мм" });
  const mark = { sourceType: "marking_card", sourceReference: "marking-card-r4" };
  const a = (await observe({ productId: p2, variantId: v1, specKey: "gtin", originalValue: "4640004021319", ...mark })).o;
  const b = (await observe({ productId: p2, variantId: v2, specKey: "gtin", originalValue: "4640004021326", ...mark })).o;
  const cross = await post(`/api/ai/observations/${b.id}/relations`, { toObservationId: a.id, relationType: "replaces", basis: "explicit_source_statement", basisNote: "x" });
  assert.equal(cross.statusCode, 400, "12,5 мм не заменяет 9,5 мм «по словам источника»");
  assert.ok(v, "фасовка ШОВа есть");

  // Та же характеристика, фасовка, условие и единица — можно.
  const s1 = (await observe({ productId: shov, specKey: "shelf_life", originalValue: "6 месяцев", sourceType: "product_card", sourceReference: "habez-pro-card/spec_table/r5" })).o;
  const s2 = (await observe({ productId: shov, specKey: "shelf_life", originalValue: "12 месяцев", statementType: "replacement", ...tech })).o;
  const ok = await post(`/api/ai/observations/${s2.id}/relations`, { toObservationId: s1.id, relationType: "replaces", basis: "explicit_source_statement", basisNote: "12 месяцев вместо 6" });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(get("SELECT lifecycle_status FROM ai_spec_observations WHERE id=?", s1.id).lifecycle_status, "superseded");
  assert.ok(get("SELECT id FROM ai_spec_observations WHERE id=?", s1.id), "заменённое на месте");
});

test("7 и 28 суток — условия, а не спор", async () => {
  await observe({ productId: standart, specKey: "compressive_strength", originalValue: "не менее 5 МПа", conditions: { age_days: 7 }, conditionText: "в возрасте 7 сут", ...tech });
  await observe({ productId: standart, specKey: "compressive_strength", originalValue: "не менее 10 МПа", conditions: { age_days: 28 }, conditionText: "в возрасте 28 сут", ...tech });
  const e = json(await app.inject({ url: `/api/ai/products/${standart}/evidence`, headers: owner }));
  const gs = e.properties.filter((p) => p.specKey === "compressive_strength" && p.conditionKey.startsWith("age_days="));
  assert.equal(gs.length, 2);
  assert.ok(gs.every((g) => g.resolution.current.status === "agreed"));
});

test("новая база не получает «40 на поддоне»; неизвестное — пусто", async () => {
  assert.equal(get("SELECT COUNT(*) AS n FROM variants WHERE per_pallet IS NOT NULL AND product_id IN (SELECT id FROM products WHERE slug NOT LIKE 'gkl-%')").n, 0);
  const cat = json(await app.inject({ url: "/api/catalog/products/shov" }));
  assert.ok(cat.product.variants.every((v) => v.perPallet === null));
  const seed = readFileSync(resolve(apiRoot, "src/db/seed.js"), "utf8");
  assert.ok(!/per_pallet:[^\n]*\b40\b/.test(seed), "в seed.js нет правила «→ 40»");
});

test("подставленное количество на поддоне не подтверждается", async () => {
  const v = get("SELECT id FROM variants WHERE product_id=?", shov).id;
  const { o } = await observe({ productId: shov, variantId: v, specKey: "per_pallet", originalValue: "40", sourceType: "generated_default", sourceReference: "api/src/db/seed.js" });
  const res = await app.inject({ method: "PATCH", url: `/api/ai/observations/${o.id}/verification`, payload: { status: "verified" }, headers: owner });
  assert.equal(res.statusCode, 400);
});

test("сверка только читает базу: отпечаток тот же, работает на файле без права записи", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "habez-rec-test-"));
  const copy = resolve(dir, "copy.db");
  db.exec(`VACUUM INTO '${copy}'`);
  chmodSync(copy, 0o444);
  const hash = () => createHash("sha256").update(readFileSync(copy)).digest("hex");
  const before = hash();
  const out = execFileSync("node", ["src/ai/knowledge/reconcile-dry-run.js"], {
    cwd: apiRoot, env: { ...process.env, DATABASE_FILE: copy, APP1_DIR: resolve(dir, "no-app1") }, encoding: "utf8",
  });
  assert.equal(hash(), before, "файл базы побайтно тот же");
  assert.match(out, /REAL DATA CHANGED: NO/);
  assert.match(out, /"legacy_records": \d+/);
  assert.match(out, /"public_eligible_now": 0/);
  rmSync(dir, { recursive: true, force: true });
});
