// Phase 4.1: контракт реестра обработчиков. Поведение ассистента
// проверяет эталон (ai-routing-golden*.test.js); здесь — устройство:
// порядок приоритета, форма этапа, отсутствие доменных веток в agent.js и
// подключение нового домена регистрацией.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiRoot } from "./helpers/ai-fixture.js";

Object.assign(process.env, { DATABASE_FILE: resolve(apiRoot, "var/test-ai-registry.db"), NODE_ENV: "test", LOG_LEVEL: "silent", AI_ENABLED: "1", AI_PROVIDER: "mock" });

const H = await import("../src/ai/agent/runtime/handlers.js");
const R = await import("../src/ai/agent/retrieval/router.js");

test("порядок этапов, проверок и сводок — как до 4.1", () => {
  assert.deepEqual(H.STAGES.map((s) => s.id), ["competitor", "resolution", "criteria", "factory", "intel", "profile-factory", "unknown-notes", "plan", "application-search"]);
  assert.deepEqual(H.CHECKS.map((c) => c.id), ["suitability-status", "empty-answer", "factory", "dates", "competitor"]);
  assert.deepEqual(H.DIGESTS.map((d) => d.id), ["factory", "competitor"]);
  assert.deepEqual(R.DOMAIN_ROUTES.map((d) => d.id), ["competitor", "factory"]);
});

test("форма: этап — id, when, run; проверка — id, run; домен маршрута — id, detect, apply", () => {
  for (const s of H.STAGES) assert.deepEqual([typeof s.id, typeof s.when, typeof s.run], ["string", "function", "function"], s.id);
  for (const c of H.CHECKS) assert.deepEqual([typeof c.id, typeof c.run], ["string", "function"], c.id);
  for (const d of H.DIGESTS) assert.equal(typeof d.lines, "function", d.id);
  for (const d of R.DOMAIN_ROUTES) assert.deepEqual([typeof d.id, typeof d.detect, typeof d.apply], ["string", "function", "function"], d.id);
  assert.equal(new Set(H.STAGES.map((s) => s.id)).size, H.STAGES.length, "id этапов не повторяются");
});

test("в agent.js нет веток отдельных доменов — только реестр", () => {
  const src = readFileSync(resolve(apiRoot, "src/ai/agent/runtime/agent.js"), "utf8");
  for (const s of ["COMPETITOR_INTENTS", "FACTORY_INTENTS", "runCompetitor", "runFactory", "runIntel", "suitabilityMismatch", "factoryMismatch", "analogyHallucination", "if (!mode"]) assert.ok(!src.includes(s), s);
  assert.ok(src.includes("runStages(") && src.includes("runChecks(") && src.includes("digestLines("));
});

test("новый домен подключается регистрацией: первый, кто задал режим, перехватывает вопрос", () => {
  const seen = [];
  const stage = (id, mode) => ({ id, when: (t) => !t.mode, run: (t) => { seen.push(id); if (mode) t.mode = mode; } });
  const t = H.runStages({ mode: null }, [stage("new-domain", "NEW_MODE"), stage("later-domain", "OTHER"), { id: "enrich", when: () => true, run: () => seen.push("enrich") }]);
  assert.equal(t.mode, "NEW_MODE");
  assert.deepEqual(seen, ["new-domain", "enrich"]);
  const draft = { intent: undefined };
  const x = {};
  const domains = [{ id: "a", detect: () => null, apply: () => assert.fail() }, { id: "b", detect: () => ({ intent: "b_intent" }), apply: (d, hit) => { d.intent = hit.intent; } }, { id: "c", detect: () => assert.fail(), apply: () => assert.fail() }];
  assert.deepEqual([R.detectDomain(x, draft, domains), draft.intent], ["b", "b_intent"]);
  assert.equal(R.detectDomain(x, { intent: undefined }, [domains[0]]), null, "никто не узнал — базовые правила");
});
