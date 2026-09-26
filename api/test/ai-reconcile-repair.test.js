// Habez AI, Phase 2.2D — будущая фактическая операция сверки на тестовой
// базе: перенос, вопросы сверки, поддоны, идемпотентность, откат, проекции.
// Рабочая база здесь не участвует.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-repair.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";
process.env.AI_EVIDENCE_ENABLED = "1";
process.env.AI_EVIDENCE_READ_MODE = "evidence";

let app, owner, manager, db, get, all, insert, run, R, P, ev;
let ids = {};
let manifest;
let generatedVariants = [];
let confirmed = [];
const json = (res) => JSON.parse(res.body);
const T = 1;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });
  ({ db, get, all, insert, run } = await import("../src/db/index.js"));
  R = await import("../src/ai/knowledge/reconciliation.js");
  P = await import("../src/ai/knowledge/evidence-projection.js");
  ev = await import("../src/ai/knowledge/evidence.js");
  for (const slug of ["shov", "standart", "antipleseni", "koroed"]) ids[slug] = get("SELECT id FROM products WHERE slug=?", slug).id;

  // Как в рабочей базе до исправления seed.js: 40 у каждого мешка от 25 кг.
  run("UPDATE variants SET per_pallet=40 WHERE pack_unit='кг' AND pack_size>=25");
  generatedVariants = all("SELECT id FROM variants WHERE per_pallet=40 ORDER BY id").map((r) => r.id);
  // Подтверждённые заводом поддоны: строка в карточке, свои числа.
  const cat = get("SELECT category_id FROM products WHERE id=?", ids.shov).category_id;
  const alebastr = insert("products", { tenant_id: T, slug: "alebastr-t", name: "Алебастр (тест)", category_id: cat, status: "published",
    spec_tables: JSON.stringify([{ title: "Технические характеристики", rows: [["Количество на поддоне", "50 мешков"]] }]) });
  const gkl = insert("products", { tenant_id: T, slug: "gkl-t", name: "ГКЛ (тест)", category_id: cat, status: "published",
    spec_tables: JSON.stringify([{ title: "Технические характеристики", rows: [["Листов на паллете", "63 шт (9,5 мм) / 51 шт (12,5 мм)"]] }]) });
  confirmed = [
    insert("variants", { tenant_id: T, product_id: alebastr, unit: "мешок 25 кг", pack_size: 25, pack_unit: "кг", per_pallet: 50 }),
    insert("variants", { tenant_id: T, product_id: gkl, unit: "лист 9,5 мм", pack_size: 9.5, pack_unit: "мм", per_pallet: 63 }),
    insert("variants", { tenant_id: T, product_id: gkl, unit: "лист 12,5 мм", pack_size: 12.5, pack_unit: "мм", per_pallet: 51 }),
  ];
  // Старый вывод AI — должен остаться выводом AI.
  ids.aiSpec = insert("ai_product_specs", { tenant_id: T, product_id: ids.antipleseni, spec_key: "open_time", label: "Открытое время", display_value: "15 мин", value_num: 15, normalized_unit: "min", comparator: "exact", origin: "ai_inference", imported_from: "manual", verification_status: "unverified" });

  // Манифест: как у реестра сверки. Две строки ШОВа — «паспорт», прочее —
  // исходный каталог без источника.
  const specs = all("SELECT s.*, p.slug FROM ai_product_specs s JOIN products p ON p.id=s.product_id ORDER BY s.id");
  const known = new Set(specs.filter((s) => s.slug === "standart").slice(0, 2).map((s) => s.id));
  manifest = R.loadManifest({
    legacy: specs.map((s) => ({ spec_id: s.id, product: s.slug, spec_key: s.spec_key, value: s.display_value,
      upstream: known.has(s.id) ? "quality_passport" : "initial_catalog_unrecorded",
      app1_commit: known.has(s.id) ? "3bbbfb3" : "e4ddf47", app1_date: known.has(s.id) ? "2026-09-10" : "2026-08-31" })),
    register: [],
  });

  const { signJwt } = await import("../src/lib/crypto.js");
  ({ build: app } = await import("../src/server.js"));
  app = await app();
  owner = { authorization: `Bearer ${signJwt({ sub: get("SELECT id FROM users WHERE role='owner'").id, role: "owner", tenant: T })}` };
  manager = { authorization: `Bearer ${signJwt({ sub: get("SELECT id FROM users WHERE role='manager'").id, role: "manager", tenant: T })}` };
});

after(async () => { await app?.close(); });

const legacyCount = () => get("SELECT COUNT(*) AS n FROM ai_product_specs").n;
let firstRun;

test("до записи: нет подтверждения — нет записи; режим evidence без переноса ничего не «улучшает»", async () => {
  const before = R.fingerprint();
  const plan = R.buildPlan(T, { manifest });
  assert.deepEqual(plan.errors, []);
  assert.throws(() => R.applyPlan(T, { manifest, confirmHash: "не-тот" }), /не совпадает/);
  assert.throws(() => R.applyPlan(T, { manifest }), /не совпадает/);
  assert.deepEqual(R.fingerprint(), before, "ничего не записано");
  const res = json(await app.inject({ url: `/api/ai/specs?productId=${ids.standart}&specKey=adhesion_strength`, headers: manager }));
  assert.equal(res.items[0].evidence.status, "not_backfilled");
  assert.equal(res.items[0].displayValue, "не менее 0,6 МПа", "до переноса отдаётся старое значение как есть (P6)");
});

test("сбой внутри транзакции не оставляет половины", () => {
  db.exec("CREATE TRIGGER t_fail BEFORE INSERT ON ai_reconciliation_items BEGIN SELECT RAISE(ABORT, 'искусственный сбой'); END;");
  const before = R.fingerprint();
  const plan = R.buildPlan(T, { manifest, withPallets: true });
  assert.throws(() => R.applyPlan(T, { manifest, withPallets: true, confirmHash: plan.hash }), /искусственный сбой/);
  assert.deepEqual(R.fingerprint(), before, "ни наблюдений, ни поддонов — всё откатилось");
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_repair_runs").n, 0);
  db.exec("DROP TRIGGER t_fail");
});

test("перенос без поддонов: каждая старая строка — ровно одно наблюдение; 40 не тронуто", () => {
  const plan = R.buildPlan(T, { manifest });
  firstRun = R.applyPlan(T, { manifest, confirmHash: plan.hash, actor: "test" });
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE legacy_spec_id IS NOT NULL").n, legacyCount());
  assert.equal(get("SELECT COUNT(*) AS n FROM (SELECT legacy_spec_id FROM ai_spec_observations WHERE legacy_spec_id IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1)").n, 0);
  assert.equal(get("SELECT COUNT(*) AS n FROM variants WHERE per_pallet=40").n, generatedVariants.length, "без --with-pallets поддоны не трогаются");
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_observation_relations").n, 0, "связей «заменяет» нет");
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE verification_status<>'unverified' OR access_level<>'internal'").n, 0);
  const runRow = get("SELECT * FROM ai_repair_runs WHERE id=?", firstRun.runId);
  assert.equal(runRow.status, "applied");
  assert.ok(get("SELECT id FROM audit_log WHERE action='ai.reconcile.apply' AND entity_id=?", firstRun.runId));
});

test("повторный прогон ничего не дублирует", () => {
  const before = R.counts(T);
  const plan = R.buildPlan(T, { manifest });
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.summary.preserved_observations, firstRun.plan.inserts.length, "всё записанное в первый раз узнано по backfill_key");
  R.applyPlan(T, { manifest, confirmHash: plan.hash, actor: "test" });
  const after = R.counts(T);
  for (const k of ["observations", "items", "members", "relations", "per_pallet_40"]) assert.equal(after[k], before[k], k);
});

test("первоисточник: известный — по манифесту, неизвестный — unknown_legacy_origin, всё internal", async () => {
  const kinds = Object.fromEntries(all("SELECT source_type, COUNT(*) AS n FROM ai_spec_observations WHERE legacy_spec_id IS NOT NULL GROUP BY 1").map((r) => [r.source_type, r.n]));
  assert.equal(kinds.quality_passport, 2);
  assert.equal(kinds.ai_inference, 1, "старый вывод AI остался выводом AI");
  assert.equal(kinds.unknown_legacy_origin, legacyCount() - 3);
  assert.ok(!kinds.product_card, "«карточка» — канал, а не первоисточник");
  const o = get("SELECT * FROM ai_spec_observations WHERE source_type='quality_passport' LIMIT 1");
  assert.equal(o.upstream_ref, "app1-commit-3bbbfb3");
  assert.equal(o.upstream_recorded_at, "2026-09-10");
  assert.equal(o.provided_at, null, "дата записи в №1 — не дата документа");
  assert.equal(o.capture_channel, "habez_pro_product_card");
  const unk = get("SELECT id FROM ai_spec_observations WHERE source_type='unknown_legacy_origin' LIMIT 1").id;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/ai/observations/${unk}/verification`, payload: { status: "verified" }, headers: owner })).statusCode, 400);
  const aiObs = get("SELECT id FROM ai_spec_observations WHERE legacy_spec_id=?", ids.aiSpec).id;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/ai/observations/${aiObs}/verification`, payload: { status: "verified" }, headers: owner })).statusCode, 400, "вывод AI не подтверждается");
});

test("D1 «Стандарт»: 0,5 и 0,6 сосуществуют; победителя нет ни в проекции, ни публично", async () => {
  const vals = all("SELECT original_value FROM ai_spec_observations WHERE product_id=? AND spec_key='adhesion_strength' AND condition_key=''", ids.standart).map((r) => r.original_value).sort();
  assert.deepEqual(vals, ["0,5 МПа", "не менее 0,6 МПа"]);
  const item = get("SELECT * FROM ai_reconciliation_items WHERE item_key LIKE 'AUTO:standart:%adhesion_strength%'");
  assert.equal(item.status, "unresolved");
  assert.equal(item.decision_ref, "D1");
  const res = json(await app.inject({ url: `/api/ai/specs?productId=${ids.standart}&specKey=adhesion_strength`, headers: manager }));
  const row = res.items[0];
  assert.equal(row.value.num, null, "проекция не выбирает число");
  assert.equal(row.verificationStatus, "disputed");
  assert.match(row.displayValue, /0,5 МПа/); assert.match(row.displayValue, /0,6 МПа/);
  assert.ok(["unresolved", "conflict"].includes(row.evidence.status));
  const pub = P.publicProjection(T, ids.standart).find((p) => p.specKey === "adhesion_strength" && p.conditionKey === "");
  assert.equal(pub.publishable, false);
  const cmp = json(await app.inject({ url: `/api/ai/products/compare?ids=${ids.standart},${ids.shov}`, headers: manager }));
  const cr = cmp.rows.find((r) => r.specKey === "adhesion_strength");
  assert.equal(cr.values.find((v) => v?.productId === ids.standart).num, null, "в сравнении — без числа");
});

test("D2–D4, D6: ШОВ — никаких замен, отдельные свойства, открытые вопросы", async () => {
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_observation_relations").n, 0);
  const d4 = get("SELECT * FROM ai_reconciliation_items WHERE item_key='D4:shov:adhesion_strength'");
  assert.equal(d4.kind, "candidate_replacement"); assert.equal(d4.status, "unresolved");
  const roles = all("SELECT m.role, o.original_value, o.condition_key FROM ai_reconciliation_members m JOIN ai_spec_observations o ON o.id=m.observation_id WHERE m.item_id=? ORDER BY m.role DESC", d4.id);
  // В тестовой базе (снимок 04.09) старое значение ШОВа — «не менее 0,5 МПа» из таблицы.
  assert.deepEqual(roles.map((r) => [r.role, r.condition_key]), [["older", ""], ["newer", "age_days=7"]]);
  assert.match(roles[0].original_value, /0,5 МПа/); assert.equal(roles[1].original_value, "не менее 0,3 МПа");
  assert.equal(get("SELECT lifecycle_status FROM ai_spec_observations WHERE product_id=? AND spec_key='adhesion_strength' AND condition_key=''", ids.shov).lifecycle_status, "active", "старое не superseded");
  // D3 / D6: разные ключи, кандидат «одно свойство», без псевдонима.
  const d3 = get("SELECT * FROM ai_reconciliation_items WHERE item_key='D3:shov:setting_time~setting_time_start'");
  assert.equal(d3.kind, "semantic_mapping_candidate");
  assert.equal(d3.related_spec_key, "setting_time_start");
  assert.ok(get("SELECT id FROM ai_spec_observations WHERE product_id=? AND spec_key='setting_time' AND original_value='60 мин'", ids.shov), "60 мин остаётся под своим ключом");
  // D2 и 7 / 28 суток: разные условия — разные свойства, не спор.
  const e = ev.productEvidence(T, ids.shov, "owner");
  const comp = e.properties.filter((g) => g.specKey === "compressive_strength").map((g) => g.conditionKey).sort();
  assert.deepEqual(comp, ["", "age_days=7"]);
  assert.ok(e.properties.filter((g) => g.specKey === "compressive_strength").every((g) => g.resolution.current.status === "agreed"));
  assert.ok(get("SELECT id FROM ai_reconciliation_items WHERE item_key='D2:shov:compressive_strength' AND status='unresolved'"));
  // Проекция: по свойствам с открытым вопросом — без числа.
  const intel = json(await app.inject({ url: `/api/ai/products/${ids.shov}/intelligence`, headers: manager }));
  for (const key of ["adhesion_strength", "setting_time", "compressive_strength"]) {
    const s = intel.specs.find((x) => x.specKey === key);
    assert.equal(s.evidence.status, "unresolved", key);
    assert.equal(s.value.num, null, key);
  }
  assert.ok(intel.evidence.openItems.some((i) => i.key === "D4:shov:adhesion_strength"));
  assert.ok(intel.evidence.scopedProperties.some((p) => p.specKey === "compressive_strength" && p.conditionKey === "age_days=7"));
});

test("D5 АНТИПЛЕСЕНЬ: мл/м² и г/м² не пересчитаны и не заменены", () => {
  const rows = all("SELECT original_value, normalized_unit, value_min, value_max, value_num FROM ai_spec_observations WHERE product_id=? AND spec_key='consumption' ORDER BY normalized_unit", ids.antipleseni);
  assert.deepEqual(rows.map((r) => r.normalized_unit), ["kg/m2", "l/m2"]);
  assert.equal(rows[0].value_num, 0.2);
  assert.equal(rows[1].value_min, 0.09);
  const item = get("SELECT * FROM ai_reconciliation_items WHERE item_key LIKE 'AUTO:antipleseni:%consumption%'");
  assert.equal(item.decision_ref, "D5"); assert.equal(item.kind, "value_conflict");
});

test("D10 КОРОЕД: water_per_bag, 5–7 л, основание «на мешок» и фасовка — полями", () => {
  const o = get("SELECT * FROM ai_spec_observations WHERE backfill_key='plan:koroed-water'");
  assert.equal(o.spec_key, "water_per_bag");
  assert.equal(o.normalized_unit, "l");
  assert.equal(o.value_min, 5); assert.equal(o.value_max, 7);
  assert.deepEqual(JSON.parse(o.conditions_json), { per: "bag" });
  assert.equal(o.variant_id, get("SELECT id FROM variants WHERE product_id=?", ids.koroed).id);
  assert.equal(o.condition_text, "на 1 мешок");
  assert.ok(get("SELECT id FROM ai_spec_observations WHERE product_id=? AND spec_key='water_ratio' AND original_value='5–7 л'", ids.koroed), "старая запись на месте");
});

test("R1: поддоны 40 → NULL только явно; «40» сохранено; подтверждённые не тронуты; покупатель не видит", async () => {
  const plan = R.buildPlan(T, { manifest, withPallets: true });
  assert.equal(plan.pallets.length, generatedVariants.length);
  assert.deepEqual(plan.palletPreserved.map((x) => x.variantId).sort(), [...confirmed].sort());
  const res = R.applyPlan(T, { manifest, withPallets: true, confirmHash: plan.hash, actor: "test" });
  assert.equal(get("SELECT COUNT(*) AS n FROM variants WHERE per_pallet=40").n, 0);
  for (const v of generatedVariants) {
    assert.equal(get("SELECT per_pallet FROM variants WHERE id=?", v).per_pallet, null);
    const o = get("SELECT * FROM ai_spec_observations WHERE backfill_key=?", `pallet-default:${v}`);
    assert.equal(o.original_value, "40"); assert.equal(o.source_type, "generated_default");
    assert.equal(o.verification_status, "unverified"); assert.equal(o.access_level, "internal");
    assert.ok(get("SELECT id FROM ai_repair_changes WHERE run_id=? AND row_id=? AND before_value='40' AND after_value IS NULL", res.runId, v));
  }
  assert.deepEqual(confirmed.map((id) => get("SELECT per_pallet FROM variants WHERE id=?", id).per_pallet), [50, 63, 51]);
  const shovVariant = get("SELECT id FROM variants WHERE product_id=?", ids.shov).id;
  const pub = P.publicProjection(T, ids.shov).find((p) => p.specKey === "per_pallet" && p.variantId === shovVariant);
  assert.equal(pub.publishable, false);
  const cat = json(await app.inject({ url: "/api/catalog/products/shov" }));
  assert.ok(cat.product.variants.every((v) => v.perPallet === null), "покупатель не видит 40");
  // Откат этого прогона возвращает 40 и убирает только его наблюдения.
  const before = JSON.parse(get("SELECT fingerprint_before FROM ai_repair_runs WHERE id=?", res.runId).fingerprint_before);
  R.rollbackRun(T, res.runId, { actor: "test" });
  assert.equal(get("SELECT COUNT(*) AS n FROM variants WHERE per_pallet=40").n, generatedVariants.length);
  const after = R.fingerprint();
  for (const k of ["ai_product_specs", "variants", "products", "ai_spec_observations", "ai_reconciliation_items"]) assert.equal(after[k], before[k], k);
  assert.equal(get("SELECT status FROM ai_repair_runs WHERE id=?", res.runId).status, "rolled_back");
  assert.throws(() => R.rollbackRun(T, res.runId), /уже в статусе/);
});

test("откат первого прогона возвращает состояние до операции", () => {
  const before = JSON.parse(get("SELECT fingerprint_before FROM ai_repair_runs WHERE id=?", firstRun.runId).fingerprint_before);
  // Второй (пустой) прогон ничего не создал, откатывать его нечего — но его запись есть.
  for (const r of all("SELECT id FROM ai_repair_runs WHERE status='applied' AND id<>? ORDER BY started_at DESC", firstRun.runId)) R.rollbackRun(T, r.id);
  R.rollbackRun(T, firstRun.runId);
  const after = R.fingerprint();
  for (const k of ["ai_product_specs", "variants", "products", "ai_spec_observations", "ai_reconciliation_items", "ai_reconciliation_members"]) assert.equal(after[k], before[k], k);
  assert.equal(get("SELECT COUNT(*) AS n FROM ai_spec_observations").n, 0);
});

test("откат останавливается, если значение изменили после прогона", () => {
  const plan = R.buildPlan(T, { manifest, withPallets: true });
  const res = R.applyPlan(T, { manifest, withPallets: true, confirmHash: plan.hash });
  run("UPDATE variants SET per_pallet=45 WHERE id=?", generatedVariants[0]);
  assert.throws(() => R.rollbackRun(T, res.runId), /изменили после прогона/);
  assert.equal(get("SELECT status FROM ai_repair_runs WHERE id=?", res.runId).status, "applied", "откат не выполнен частично");
  run("UPDATE variants SET per_pallet=NULL WHERE id=?", generatedVariants[0]);
  R.rollbackRun(T, res.runId);
});

test("манифест не от этой базы — план с ошибками, запись невозможна", () => {
  const bad = R.loadManifest({ legacy: [{ spec_id: 1, product: "чужой", spec_key: "x", value: "y" }], register: [] });
  const plan = R.buildPlan(T, { manifest: bad });
  assert.ok(plan.errors.length > 0);
  assert.throws(() => R.applyPlan(T, { manifest: bad, confirmHash: plan.hash }), /план с ошибками/);
});

test("приложение №1 не меняется: сверка только читает git, исправление его не знает", () => {
  const dir = mkdtempSync(join(tmpdir(), "habez-app1-"));
  writeFileSync(join(dir, "products.json"), JSON.stringify([{ id: 1, name: "Тест", badges: [{ label: "Прочность", value: "1 МПа" }], tables: [] }]));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  const head = git("rev-parse", "HEAD");
  const hash = createHash("sha256").update(readFileSync(join(dir, "products.json"))).digest("hex");
  execFileSync("node", ["src/ai/knowledge/reconcile-dry-run.js"], { cwd: apiRoot, env: { ...process.env, APP1_DIR: dir }, stdio: "ignore" });
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(createHash("sha256").update(readFileSync(join(dir, "products.json"))).digest("hex"), hash);
  for (const f of ["reconciliation.js", "reconcile-repair.js", "evidence-projection.js"]) {
    assert.ok(!/HGZ_app|APP1_DIR/.test(readFileSync(resolve(apiRoot, "src/ai/knowledge", f), "utf8")), `${f} не обращается к приложению №1`);
  }
  rmSync(dir, { recursive: true, force: true });
});
