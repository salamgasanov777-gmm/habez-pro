// Habez AI, фаза 2: характеристики товаров числами.
// Главное, что здесь проверяется: «2 МПа» и «2,5 МПа» стали числами и
// сравниваются правильно; исходная строка сохранилась; отсутствующее
// значение не превратилось в догадку; чужая компания не видна.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { parseSpecValue, compareSpecs } from "../src/ai/knowledge/units.js";
import { keyForLabel, skipReason, SPEC_KEYS } from "../src/ai/knowledge/spec-dictionary.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-specs.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";

let app, adminHeaders, managerHeaders, dealerHeaders;
let productA, productB, alienProductId, sourceId, specId;
const json = (res) => JSON.parse(res.body);
const auth = (t) => ({ authorization: `Bearer ${t}` });
const login = async (email, password) =>
  json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }));

// ── Разбор значений: чистые функции, без базы ─────────────────────────────

describe("нормализация значений", () => {
  test("«2 МПа» и «2,5 МПа» становятся числами и сравниваются", () => {
    const a = parseSpecValue("2 МПа");
    const b = parseSpecValue("2,5 МПа");
    assert.equal(a.valueNum, 2);
    assert.equal(b.valueNum, 2.5);
    assert.equal(a.normalizedUnit, "MPa");
    assert.equal(b.normalizedUnit, "MPa");
    assert.equal(compareSpecs(a, b), -1, "2 МПа меньше 2,5 МПа");
    assert.equal(compareSpecs(b, a), 1);
    assert.equal(compareSpecs(a, parseSpecValue("2 МПа")), 0);
    // Запятая как разделитель не должна давать 25 вместо 2,5.
    assert.ok(b.valueNum < 3, "«2,5» — это два с половиной, а не двадцать пять");
  });

  test("исходная строка сохраняется всегда", () => {
    for (const raw of ["не менее 0,5 МПа", "3–70 мм", "белый", "ДА", "0,6–0,65 л/1 кг смеси"]) {
      assert.equal(parseSpecValue(raw).displayValue, raw, "исходное написание не теряется");
    }
  });

  test("единицы приводятся внутри одной величины", () => {
    assert.deepEqual(pick(parseSpecValue("30 кг")), { num: 30, unit: "kg" });
    assert.deepEqual(pick(parseSpecValue("200 г")), { num: 0.2, unit: "kg" });
    assert.deepEqual(pick(parseSpecValue("2 часа")), { num: 120, unit: "min" });
    assert.deepEqual(pick(parseSpecValue("48 ч")), { num: 2880, unit: "min" });
    assert.deepEqual(pick(parseSpecValue("40 мин")), { num: 40, unit: "min" });
    assert.deepEqual(pick(parseSpecValue("1,5 см")), { num: 15, unit: "mm" });
    assert.deepEqual(pick(parseSpecValue("1 год")), { num: 12, unit: "month" });
    assert.deepEqual(pick(parseSpecValue("200 г/м²")), { num: 0.2, unit: "kg/m2" });
    assert.deepEqual(pick(parseSpecValue("120 мл/м²")), { num: 0.12, unit: "l/m2" });
  });

  test("разные величины не смешиваются: мл/м² не становится кг/м²", () => {
    const ml = parseSpecValue("120 мл/м²");
    const kg = parseSpecValue("0,12 кг/м²");
    assert.notEqual(ml.normalizedUnit, kg.normalizedUnit);
    assert.equal(compareSpecs(ml, kg), null, "объём и масса не сравниваются напрямую");
    assert.equal(compareSpecs(parseSpecValue("2 МПа"), parseSpecValue("60 мин")), null);
  });

  test("диапазон даёт границы, а не выдуманную середину", () => {
    const r = parseSpecValue("3–70 мм");
    assert.equal(r.valueMin, 3);
    assert.equal(r.valueMax, 70);
    assert.equal(r.valueNum, null, "у диапазона нет одного числа");
    assert.equal(r.comparator, "range");
    const t = parseSpecValue("от +5°C до +30°C");
    assert.equal(t.valueMin, 5);
    assert.equal(t.valueMax, 30);
    const minus = parseSpecValue("-15°…+30°");
    assert.equal(minus.valueMin, -15);
    assert.equal(minus.valueMax, 30);
  });

  test("«не менее» и «не ранее» сохраняют смысл границы", () => {
    const a = parseSpecValue("не менее 0,5 МПа");
    assert.equal(a.valueNum, 0.5);
    assert.equal(a.comparator, "min");
    assert.equal(parseSpecValue("не ранее 60 мин").comparator, "min");
    assert.equal(parseSpecValue("не более 3 мм").comparator, "max");
    assert.equal(parseSpecValue("около 60 мин").comparator, "approx");
  });

  test("нечисловое остаётся текстом, число не выдумывается", () => {
    for (const raw of ["белый", "портландцемент", "соответствует ГОСТ 29319", "керамическая"]) {
      const p = parseSpecValue(raw);
      assert.equal(p.valueNum, null);
      assert.equal(p.valueMin, null);
      assert.equal(p.valueBool, null);
      assert.equal(p.valueText, raw);
    }
    // Перечисление фасовок — не характеристика: в число не сводится.
    const many = parseSpecValue("ведро 6 кг, 11 кг, 20 кг");
    assert.equal(many.valueNum, null);
    assert.match(many.note, /нескольк/);
  });

  test("ДА и НЕТ становятся логическим значением, F50 — циклами", () => {
    assert.equal(parseSpecValue("ДА").valueBool, true);
    assert.equal(parseSpecValue("НЕТ").valueBool, false);
    assert.equal(parseSpecValue("возможно").valueBool, true);
    const f = parseSpecValue("F50");
    assert.equal(f.valueNum, 50);
    assert.equal(f.normalizedUnit, "cycles");
  });

  test("словарь: подписи из карточек находят ключ, фасовки пропускаются", () => {
    assert.equal(keyForLabel("Прочность не менее"), "compressive_strength");
    assert.equal(keyForLabel("Адгезия (прочность на отрыв)"), "adhesion_strength");
    assert.equal(keyForLabel("Внутренние помещения с повышенным уровнем влажности (ванные…)"), "suitable_indoor_wet");
    assert.equal(keyForLabel("Такой характеристики не бывает"), null);
    assert.ok(skipReason("Упаковка"), "фасовка живёт в variants");
    assert.ok(skipReason("Штрихкод GTIN, 9,5 мм"), "штрихкод — не характеристика");
    for (const [key, meta] of Object.entries(SPEC_KEYS)) {
      assert.ok(meta.label && meta.group, `${key}: у ключа есть подпись и группа`);
    }
  });
});

const pick = (p) => ({ num: p.valueNum, unit: p.normalizedUnit });

// ── API ────────────────────────────────────────────────────────────────────

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  // Перенос характеристик из карточек — то же, что владелец запускает руками.
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });

  ({ build: app } = await import("../src/server.js"));
  app = await app();

  adminHeaders = auth((await login("admin@habez.local", "admin12345")).accessToken);
  managerHeaders = auth((await login("manager@habez.local", "manager12345")).accessToken);
  dealerHeaders = auth((await login("dealer@habez.local", "dealer12345")).accessToken);

  productA = json(await app.inject("/api/catalog/products/akvalayt")).product;
  productB = json(await app.inject("/api/catalog/products/pobeda80")).product;

  const { db, insert, get } = await import("../src/db/index.js");
  db.exec("INSERT INTO tenants (slug, name) VALUES ('other2', 'Чужой завод')");
  const alien = get("SELECT id FROM tenants WHERE slug='other2'").id;
  alienProductId = insert("products", { tenant_id: alien, slug: "alien", name: "Товар чужого завода" });
  insert("ai_product_specs", {
    tenant_id: alien, product_id: alienProductId, spec_key: "compressive_strength",
    label: "Прочность", display_value: "99 МПа", value_num: 99, normalized_unit: "MPa",
    origin: "habez_internal", verification_status: "verified",
  });
  sourceId = get("SELECT id FROM ai_sources WHERE tenant_id=1 LIMIT 1")?.id;
});

after(async () => { await app?.close(); });

test("перенос из карточек: товары получили характеристики с исходным значением", async () => {
  const overview = json(await app.inject({ url: "/api/ai/products", headers: managerHeaders }));
  const { get } = await import("../src/db/index.js");
  const inCatalog = get("SELECT COUNT(*) AS n FROM products WHERE tenant_id=1").n;
  assert.equal(overview.items.length, inCatalog, "в обзоре все товары каталога");
  const withSpecs = overview.items.filter((p) => p.specs > 0);
  // У нескольких товаров в карточке только подписи, которых нет в словаре
  // (профили, крепёж) — это нормально и видно в отчёте переноса.
  assert.ok(withSpecs.length / inCatalog >= 0.8, `характеристики есть у ${withSpecs.length} из ${inCatalog}`);

  const intel = json(await app.inject({ url: `/api/ai/products/${productA.id}/intelligence`, headers: managerHeaders }));
  assert.ok(intel.specs.length > 0);
  const adhesion = intel.specs.find((s) => s.specKey === "adhesion_strength");
  assert.ok(adhesion, "прочность сцепления перенесена");
  assert.equal(adhesion.normalizedUnit, "MPa");
  assert.ok(adhesion.value.num > 0, "значение стало числом");
  assert.match(adhesion.displayValue, /МПа/, "исходная строка сохранена");
  assert.equal(adhesion.origin, "habez_internal");
  assert.equal(adhesion.verificationStatus, "unverified", "перенесённое не считается подтверждённым");
  assert.ok(intel.variants.length > 0, "фасовки берутся из каталога, а не дублируются");
});

test("фасовки и штрихкоды в характеристики не переносятся", async () => {
  const all = json(await app.inject({ url: "/api/ai/specs?limit=300", headers: managerHeaders }));
  const bad = all.items.filter((s) => /упаковка|штрихкод|поддон/i.test(s.label));
  assert.deepEqual(bad, [], "то, что есть в variants, не дублируется");
});

test("сравнение товаров идёт по числам, а не по строкам", async () => {
  const res = await app.inject({ url: `/api/ai/products/compare?ids=${productA.id},${productB.id}`, headers: managerHeaders });
  assert.equal(res.statusCode, 200);
  const data = json(res);
  assert.equal(data.products.length, 2);
  const numericRow = data.rows.find((r) => r.comparable && r.unit === "MPa");
  assert.ok(numericRow, "есть строка сравнения в МПа");
  assert.ok(numericRow.best.max && numericRow.best.min, "видно, у кого больше");
  const values = numericRow.values.filter(Boolean).map((v) => v.num ?? v.min);
  assert.ok(values.every((v) => typeof v === "number"), "значения — числа");
  // Разные единицы к сравнению не допускаются.
  for (const row of data.rows) {
    if (row.comparable) {
      const units = new Set(row.values.filter(Boolean).map((v) => v.unit));
      assert.ok(units.size <= 1, `${row.specKey}: сравниваются только одинаковые единицы`);
    }
  }
});

test("ручная характеристика: создание, разбор, правка", async () => {
  const created = await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productA.id, specKey: "density", displayValue: "1350 кг/м³", sourceId, origin: "habez_internal" },
  });
  assert.equal(created.statusCode, 201);
  const spec = json(created).spec;
  specId = spec.id;
  assert.equal(spec.value.num, 1350);
  assert.equal(spec.normalizedUnit, "kg/m3");
  assert.equal(spec.verificationStatus, "unverified");

  // Вторая такая же характеристика у товара не заводится.
  const twin = await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productA.id, specKey: "density", displayValue: "1400 кг/м³", origin: "habez_internal" },
  });
  assert.equal(twin.statusCode, 409);

  const patched = json(await app.inject({
    method: "PATCH", url: `/api/ai/specs/${specId}`, headers: managerHeaders, payload: { displayValue: "1400 кг/м³" },
  })).spec;
  assert.equal(patched.value.num, 1400, "значение пересчитано");
  assert.equal(patched.displayValue, "1400 кг/м³");
});

test("неизвестный ключ и пустое значение отклоняются", async () => {
  const badKey = await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productA.id, specKey: "выдуманная_характеристика", displayValue: "1" },
  });
  assert.equal(badKey.statusCode, 400);
  const empty = await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productA.id, specKey: "color", displayValue: "" },
  });
  assert.equal(empty.statusCode, 400, "характеристики без значения не бывает");
});

test("подтверждает только администратор, правка снимает подтверждение", async () => {
  const byManager = await app.inject({
    method: "PATCH", url: `/api/ai/specs/${specId}/verification`, headers: managerHeaders, payload: { status: "verified" },
  });
  assert.equal(byManager.statusCode, 403);

  const ok = json(await app.inject({
    method: "PATCH", url: `/api/ai/specs/${specId}/verification`, headers: adminHeaders,
    payload: { status: "verified", note: "сверено с паспортом" },
  })).spec;
  assert.equal(ok.verificationStatus, "verified");
  assert.ok(ok.verifiedBy?.id);

  const edited = json(await app.inject({
    method: "PATCH", url: `/api/ai/specs/${specId}`, headers: managerHeaders, payload: { displayValue: "1500 кг/м³" },
  })).spec;
  assert.equal(edited.verificationStatus, "unverified", "подтверждали другое число");
});

test("вывод AI нельзя подтвердить и здесь", async () => {
  const guess = json(await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productB.id, specKey: "hiding_power", displayValue: "вероятно высокая", origin: "ai_inference" },
  })).spec;
  const res = await app.inject({
    method: "PATCH", url: `/api/ai/specs/${guess.id}/verification`, headers: adminHeaders, payload: { status: "verified" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error.message, /Вывод AI/);
});

test("отсутствующая характеристика остаётся отсутствующей", async () => {
  const intel = json(await app.inject({ url: `/api/ai/products/${productB.id}/intelligence`, headers: managerHeaders }));
  const keys = intel.specs.map((s) => s.specKey);
  assert.ok(!keys.includes("water_absorption"), "чего нет в карточке — того нет и здесь");
  // Ни одна запись не выдумывает число там, где в источнике был текст.
  for (const s of intel.specs) {
    if (s.value.text !== null) {
      assert.equal(s.value.num, null, `${s.specKey}: текст не превращён в число`);
      assert.equal(s.value.min, null);
    }
  }
});

test("изоляция компаний: чужие характеристики недоступны", async () => {
  const list = json(await app.inject({ url: "/api/ai/specs?limit=300", headers: adminHeaders }));
  assert.ok(!JSON.stringify(list).includes("Товар чужого завода"));
  assert.ok(!list.items.some((s) => s.displayValue === "99 МПа"));

  const { get } = await import("../src/db/index.js");
  const alienSpec = get("SELECT s.id FROM ai_product_specs s JOIN tenants t ON t.id=s.tenant_id WHERE t.slug='other2'").id;
  assert.equal((await app.inject({ url: `/api/ai/specs/${alienSpec}`, headers: adminHeaders })).statusCode, 404);
  assert.equal((await app.inject({
    method: "PATCH", url: `/api/ai/specs/${alienSpec}`, headers: adminHeaders, payload: { displayValue: "1 МПа" },
  })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/ai/products/${alienProductId}/intelligence`, headers: adminHeaders })).statusCode, 404);
  const toAlien = await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: alienProductId, specKey: "color", displayValue: "серый" },
  });
  assert.equal(toAlien.statusCode, 404, "к чужому товару характеристику не привязать");
});

test("права: дилеру и гостю раздел закрыт", async () => {
  for (const url of ["/api/ai/specs", "/api/ai/products", "/api/ai/spec-keys", `/api/ai/products/${productA.id}/intelligence`]) {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: dealerHeaders })).statusCode, 403);
  }
});

test("изменения характеристик попадают в журнал", async () => {
  const history = json(await app.inject({ url: `/api/ai/specs/${specId}/history`, headers: adminHeaders }));
  const actions = history.items.map((i) => i.action);
  assert.ok(actions.includes("ai.spec.create"));
  assert.ok(actions.includes("ai.spec.update"));
  assert.ok(actions.includes("ai.spec.verification"));
  const upd = history.items.find((i) => i.action === "ai.spec.update");
  assert.ok(upd.diff.was && upd.diff.now, "видно, что было и что стало");
});

test("повторный перенос ничего не дублирует", async () => {
  const before = json(await app.inject({ url: "/api/ai/products/summary", headers: managerHeaders }));
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], {
    cwd: apiRoot, env: { ...process.env, DATABASE_FILE: testDb }, stdio: "ignore",
  });
  const after = json(await app.inject({ url: "/api/ai/products/summary", headers: managerHeaders }));
  assert.equal(after.specs, before.specs, "число характеристик не выросло");
});

// ── Phase 2.1: правила Phase 1 для характеристик ──────────────────────────

test("характеристику без источника подтвердить нельзя (правило Phase 1 №3)", async () => {
  const noSource = json(await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productB.id, specKey: "dry_residue", displayValue: "60 %", origin: "habez_internal" },
  })).spec;
  assert.equal(noSource.source, null, "заведена без источника");
  const res = await app.inject({
    method: "PATCH", url: `/api/ai/specs/${noSource.id}/verification`, headers: adminHeaders, payload: { status: "verified" },
  });
  assert.equal(res.statusCode, 400, "без источника подтверждения нет");
  assert.match(json(res).error.message, /источник/i);
  const after = json(await app.inject({ url: `/api/ai/specs/${noSource.id}`, headers: adminHeaders })).spec;
  assert.equal(after.verificationStatus, "unverified");
});

test("снятие источника с подтверждённой характеристики снимает подтверждение", async () => {
  const spec = json(await app.inject({
    method: "POST", url: "/api/ai/specs", headers: managerHeaders,
    payload: { productId: productB.id, specKey: "non_volatile", displayValue: "50 %", sourceId, origin: "habez_internal" },
  })).spec;
  const verified = json(await app.inject({
    method: "PATCH", url: `/api/ai/specs/${spec.id}/verification`, headers: adminHeaders, payload: { status: "verified" },
  })).spec;
  assert.equal(verified.verificationStatus, "verified");
  const stripped = json(await app.inject({
    method: "PATCH", url: `/api/ai/specs/${spec.id}`, headers: managerHeaders, payload: { sourceId: null },
  })).spec;
  assert.equal(stripped.source, null);
  assert.equal(stripped.verificationStatus, "unverified", "подтверждение без источника не держится");
});

test("повторный перенос после правки карточки снимает подтверждение", async () => {
  const { get, run } = await import("../src/db/index.js");
  // Подтверждаем перенесённую характеристику товара A.
  const spec = get("SELECT id, display_value FROM ai_product_specs WHERE tenant_id=1 AND product_id=? AND spec_key='adhesion_strength'", productA.id);
  const ok = await app.inject({
    method: "PATCH", url: `/api/ai/specs/${spec.id}/verification`, headers: adminHeaders, payload: { status: "verified" },
  });
  assert.equal(ok.statusCode, 200);
  // Завод поменял значение в карточке — меняем в таблице характеристик товара.
  const p = get("SELECT spec_tables FROM products WHERE id=?", productA.id);
  const tables = JSON.parse(p.spec_tables).map((t) => ({
    ...t, rows: t.rows.map((r) => (/адгези|отрыв|сцеплен/i.test(r[0]) ? [r[0], "не менее 0,9 МПа"] : r)),
  }));
  run("UPDATE products SET spec_tables=? WHERE id=?", JSON.stringify(tables), productA.id);
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], {
    cwd: apiRoot, env: { ...process.env, DATABASE_FILE: testDb }, stdio: "ignore",
  });
  const after = get("SELECT display_value, value_num, verification_status FROM ai_product_specs WHERE id=?", spec.id);
  assert.equal(after.value_num, 0.9, "новое значение из карточки");
  assert.equal(after.verification_status, "unverified", "подтверждали прежнее число");
});
