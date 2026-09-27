// Habez AI, фаза 1: слой знаний. Проверяется то, ради чего он существует —
// у каждого сведения есть источник и происхождение, вывод модели никогда не
// становится подтверждённым фактом, чужая компания не видна, права
// соблюдаются, каждое изменение попадает в журнал.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-ai-knowledge.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";
process.env.AI_ENABLED = "1";

let app, ownerT, adminHeaders, managerHeaders, dealerHeaders;
let sourceId, productId, otherTenantProductId, factId;
const json = (res) => JSON.parse(res.body);
const auth = (t) => ({ authorization: `Bearer ${t}` });

const login = async (email, password) =>
  json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }));

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });

  ({ build: app } = await import("../src/server.js"));
  app = await app();

  ownerT = await login("admin@habez.local", "admin12345");
  adminHeaders = auth(ownerT.accessToken);
  managerHeaders = auth((await login("manager@habez.local", "manager12345")).accessToken);
  dealerHeaders = auth((await login("dealer@habez.local", "dealer12345")).accessToken);

  productId = json(await app.inject("/api/catalog/products/akvalayt")).product.id;

  // Вторая компания с собственным товаром — для проверки изоляции.
  const { db, insert } = await import("../src/db/index.js");
  db.exec("INSERT INTO tenants (slug, name) VALUES ('other', 'Другой завод')");
  const otherTenant = db.prepare("SELECT id FROM tenants WHERE slug='other'").get().id;
  otherTenantProductId = insert("products", { tenant_id: otherTenant, slug: "secret", name: "Секретный товар другого завода" });
  insert("ai_sources", { tenant_id: otherTenant, source_type: "price_list", name: "Прайс другого завода", trust_base: 80 });
  insert("ai_facts", {
    tenant_id: otherTenant, fact_type: "price", subject_type: "product", subject_id: otherTenantProductId,
    subject_label: "Секретный товар другого завода", attribute: "цена розничная", value_num: 999,
    origin: "habez_internal", verification_status: "verified", confidence: 90,
  });
});

after(async () => { await app?.close(); });

// ── Источники ──────────────────────────────────────────────────────────────

test("источник создаётся администратором и виден в списке", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/ai/sources", headers: adminHeaders,
    payload: { sourceType: "price_list", name: "Прайс завода 6 сентября 2026", publisher: "Хабезский гипсовый завод" },
  });
  assert.equal(res.statusCode, 201);
  const { source } = json(res);
  sourceId = source.id;
  assert.equal(source.status, "active");
  assert.equal(source.trustBase, 85, "прайсу завода доверия больше, чем новостям");

  const list = json(await app.inject({ url: "/api/ai/sources", headers: managerHeaders }));
  assert.ok(list.items.some((s) => s.id === sourceId));
});

test("источник с тем же адресом дважды не заводится", async () => {
  const payload = { sourceType: "manufacturer_site", name: "Сайт конкурента", url: "https://example.invalid/catalog" };
  assert.equal((await app.inject({ method: "POST", url: "/api/ai/sources", headers: adminHeaders, payload })).statusCode, 201);
  const again = await app.inject({ method: "POST", url: "/api/ai/sources", headers: adminHeaders, payload });
  assert.equal(again.statusCode, 409);
});

test("менеджер не может создать или изменить источник", async () => {
  const create = await app.inject({
    method: "POST", url: "/api/ai/sources", headers: managerHeaders,
    payload: { sourceType: "news_media", name: "Отраслевые новости" },
  });
  assert.equal(create.statusCode, 403);
  const patch = await app.inject({
    method: "PATCH", url: `/api/ai/sources/${sourceId}`, headers: managerHeaders, payload: { name: "Подмена" },
  });
  assert.equal(patch.statusCode, 403);
});

// ── Факты и связь с товаром Habez ──────────────────────────────────────────

test("факт создаётся и ссылается на существующий товар Habez", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/ai/facts", headers: managerHeaders,
    payload: {
      factType: "spec", subjectType: "product", subjectId: productId,
      attribute: "прочность на сжатие", valueNum: 2, valueText: "не менее 2 МПа", unit: "МПа",
      sourceId, origin: "habez_internal",
    },
  });
  assert.equal(res.statusCode, 201);
  const { fact } = json(res);
  factId = fact.id;
  assert.equal(fact.subject.type, "product");
  assert.equal(fact.subject.id, productId);
  assert.match(fact.subject.label, /АКВАЛАЙТ|Аквалайт|аквалайт/i, "подпись объекта берётся из каталога");
  assert.equal(fact.verificationStatus, "unverified", "новое сведение всегда непроверенное");
  assert.equal(fact.source.id, sourceId);
  assert.ok(fact.recheckAfter, "срок перепроверки проставлен");
});

test("факт без источника не принимается (кроме вывода AI)", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/ai/facts", headers: managerHeaders,
    payload: { factType: "spec", subjectType: "product", subjectId: productId, attribute: "без источника", valueText: "что-то", origin: "external_source" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error.message, /источник/i);
});

test("факт о несуществующем товаре не создаётся", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/ai/facts", headers: managerHeaders,
    payload: { factType: "spec", subjectType: "product", subjectId: 999999, attribute: "прочность", valueText: "2 МПа", sourceId, origin: "habez_internal" },
  });
  assert.equal(res.statusCode, 404);
});

test("повторная запись того же факта из того же источника отклоняется", async () => {
  const payload = {
    factType: "spec", subjectType: "product", subjectId: productId,
    attribute: "прочность на сжатие", valueNum: 2, valueText: "не менее 2 МПа", unit: "МПа",
    sourceId, origin: "habez_internal",
  };
  assert.equal((await app.inject({ method: "POST", url: "/api/ai/facts", headers: managerHeaders, payload })).statusCode, 409);
});

// ── Происхождение: главное правило ─────────────────────────────────────────

test("вывод AI не может стать подтверждённым фактом", async () => {
  const created = json(await app.inject({
    method: "POST", url: "/api/ai/facts", headers: managerHeaders,
    payload: {
      factType: "market", subjectType: "market", attribute: "оценка спроса",
      valueText: "спрос на грунтовки вероятно вырастет весной", origin: "ai_inference",
    },
  }));
  assert.equal(created.fact.origin, "ai_inference");
  assert.equal(created.fact.verificationStatus, "unverified");
  assert.ok(created.fact.confidence <= 30, "доверие к выводу модели низкое");

  const res = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${created.fact.id}/verification`,
    headers: adminHeaders, payload: { status: "verified" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error.message, /Вывод AI нельзя подтвердить/);

  const after = json(await app.inject({ url: `/api/ai/facts/${created.fact.id}`, headers: adminHeaders }));
  assert.equal(after.fact.verificationStatus, "unverified", "статус не изменился");

  // Отклонить вывод модели можно — это не превращает его в факт.
  const rejected = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${created.fact.id}/verification`,
    headers: adminHeaders, payload: { status: "rejected", note: "не подтвердилось" },
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(json(rejected).fact.verificationStatus, "rejected");
});

// ── Статусы проверки ───────────────────────────────────────────────────────

test("подтверждает только администратор, переходы соблюдаются", async () => {
  const byManager = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${factId}/verification`, headers: managerHeaders, payload: { status: "verified" },
  });
  assert.equal(byManager.statusCode, 403, "менеджер не подтверждает факты");

  const ok = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${factId}/verification`,
    headers: adminHeaders, payload: { status: "verified", note: "сверено с прайсом" },
  });
  assert.equal(ok.statusCode, 200);
  const fact = json(ok).fact;
  assert.equal(fact.verificationStatus, "verified");
  assert.ok(fact.verifiedBy?.id, "записан тот, кто подтвердил");
  assert.ok(fact.verifiedAt && fact.checkedAt);

  // verified → stale допустим, verified → unverified напрямую — нет.
  const back = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${factId}/verification`, headers: adminHeaders, payload: { status: "unverified" },
  });
  assert.equal(back.statusCode, 400);
  assert.match(json(back).error.message, /Нельзя перейти/);
});

test("правка значения снимает подтверждение", async () => {
  const res = await app.inject({
    method: "PATCH", url: `/api/ai/facts/${factId}`, headers: managerHeaders,
    payload: { valueNum: 2.5, valueText: "не менее 2,5 МПа" },
  });
  assert.equal(res.statusCode, 200);
  const fact = json(res).fact;
  assert.equal(fact.value.num, 2.5);
  assert.equal(fact.verificationStatus, "unverified", "изменённое значение больше не подтверждено");
  assert.equal(fact.verifiedBy, null);
});

// ── Изоляция компаний ──────────────────────────────────────────────────────

test("факты и источники другой компании недоступны", async () => {
  const list = json(await app.inject({ url: "/api/ai/facts?limit=200", headers: adminHeaders }));
  assert.ok(!list.items.some((f) => f.subject.label?.includes("другого завода")), "чужой факт не попал в список");
  assert.ok(!JSON.stringify(list).includes("Секретный товар"), "название чужого товара не утекло");

  const sources = json(await app.inject({ url: "/api/ai/sources", headers: adminHeaders }));
  assert.ok(!sources.items.some((s) => s.name.includes("другого завода")));

  // Прямое обращение по идентификатору чужого факта и источника.
  const { get } = await import("../src/db/index.js");
  const alienFact = get("SELECT f.id FROM ai_facts f JOIN tenants t ON t.id=f.tenant_id WHERE t.slug='other'").id;
  const alienSource = get("SELECT s.id FROM ai_sources s JOIN tenants t ON t.id=s.tenant_id WHERE t.slug='other'").id;
  assert.equal((await app.inject({ url: `/api/ai/facts/${alienFact}`, headers: adminHeaders })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/ai/sources/${alienSource}`, headers: adminHeaders })).statusCode, 404);
  assert.equal((await app.inject({
    method: "PATCH", url: `/api/ai/facts/${alienFact}/verification`, headers: adminHeaders, payload: { status: "rejected" },
  })).statusCode, 404, "чужой факт нельзя изменить");
});

test("факт нельзя привязать к товару другой компании", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/ai/facts", headers: managerHeaders,
    payload: { factType: "spec", subjectType: "product", subjectId: otherTenantProductId, attribute: "попытка подсмотреть", valueText: "x", sourceId, origin: "habez_internal" },
  });
  assert.equal(res.statusCode, 404);
  assert.ok(!res.body.includes("Секретный товар"));
});

// ── Права и доступность раздела ────────────────────────────────────────────

test("покупателю и дилеру раздел знаний закрыт, гостю — тоже", async () => {
  for (const url of ["/api/ai/facts", "/api/ai/sources", "/api/ai/summary", "/api/ai/meta"]) {
    assert.equal((await app.inject({ url })).statusCode, 401, `${url} без входа`);
    assert.equal((await app.inject({ url, headers: dealerHeaders })).statusCode, 403, `${url} для дилера`);
  }
});

// ── Журнал ─────────────────────────────────────────────────────────────────

test("создание, правка и смена статуса записаны в журнал", async () => {
  const history = json(await app.inject({ url: `/api/ai/facts/${factId}/history`, headers: adminHeaders }));
  const actions = history.items.map((i) => i.action);
  assert.ok(actions.includes("ai.fact.create"), "создание в журнале");
  assert.ok(actions.includes("ai.fact.update"), "правка в журнале");
  assert.ok(actions.includes("ai.fact.verification"), "смена статуса в журнале");

  const verification = history.items.find((i) => i.action === "ai.fact.verification");
  assert.equal(verification.diff.was, "unverified");
  assert.equal(verification.diff.now, "verified");
  assert.ok(verification.actor, "видно, кто менял");

  const { all } = await import("../src/db/index.js");
  const sourceLog = all("SELECT action FROM audit_log WHERE entity='ai_source'").map((r) => r.action);
  assert.ok(sourceLog.includes("ai.source.create"), "создание источника в журнале");
});

// ── Сводка и фильтры ───────────────────────────────────────────────────────

test("сводка и фильтры считают только свою компанию", async () => {
  const s = json(await app.inject({ url: "/api/ai/summary", headers: adminHeaders }));
  // Своих фактов два: характеристика товара и вывод модели. Факт чужой
  // компании в сводку попасть не должен, поэтому именно 2, а не 3.
  assert.equal(s.total, 2, "в сводке только свои факты");
  assert.equal(typeof s.byStatus.unverified, "number");
  assert.ok(s.sources >= 2);

  const byOrigin = json(await app.inject({ url: "/api/ai/facts?origin=ai_inference", headers: adminHeaders }));
  assert.ok(byOrigin.items.length >= 1);
  assert.ok(byOrigin.items.every((f) => f.origin === "ai_inference"));

  const bySubject = json(await app.inject({ url: `/api/ai/facts?subjectType=product&subjectId=${productId}`, headers: adminHeaders }));
  assert.ok(bySubject.items.every((f) => f.subject.id === productId));

  const bad = await app.inject({ url: "/api/ai/facts?status=выдумка", headers: adminHeaders });
  assert.equal(bad.statusCode, 400, "неизвестный статус в фильтре отвергается");
});

// ── Выключенный раздел ─────────────────────────────────────────────────────

test("при AI_ENABLED=0 маршрутов /api/ai/* не существует", async () => {
  const off = execFileSync("node", ["--input-type=module", "-e", `
    const { build } = await import("./src/server.js");
    const app = await build();
    const r = await app.inject("/api/ai/facts");
    console.log(r.statusCode);
    await app.close();
  `], { cwd: apiRoot, encoding: "utf8", env: { ...process.env, DATABASE_FILE: testDb, AI_ENABLED: "0" } });
  assert.equal(off.trim().split("\n").pop(), "404", "раздел выключен — маршрута нет");
});
