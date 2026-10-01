// Регресс 01.10.2026: «слово» длиннее, чем принимает схема инструмента
// поиска (search_products/search_knowledge — 40 знаков, search_factories —
// 60), роняло runAgent ошибкой ZodError, и посетитель видел «Habez AI не
// смог ответить». Такие слова выбрасываются из поиска, ответ — обычный.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { apiRoot, prepareAiDb } from "./helpers/ai-fixture.js";

Object.assign(process.env, {
  DATABASE_FILE: resolve(apiRoot, "var/test-ai-long-words.db"), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
  AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
});
delete process.env.OPENROUTER_API_KEY;

await prepareAiDb();
const { searchTerms } = await import("../src/ai/agent/retrieval/intent.js");
const { runAgent } = await import("../src/ai/agent/runtime/agent.js");
const mock = (await import("../src/ai/agent/provider/mock.js")).createMockProvider();

const LONG = [
  "1".repeat(50),
  "а".repeat(41),
  `Какие смеси для швов ${"б".repeat(45)}?`,
  `Что подойдёт для заделки швов ГКЛ ${"в".repeat(60)}`,
  `Какой завод производит ШОВ ${"г".repeat(70)}`,
  `${"x".repeat(41)} ${"y".repeat(100)} шпаклевка`,
];

test("searchTerms: слов длиннее 40 знаков нет, обычные слова на месте", () => {
  for (const q of LONG) assert.ok(searchTerms(q).every((w) => w.length <= 40), q);
  assert.deepEqual(searchTerms("1".repeat(50)), []);
  assert.deepEqual(searchTerms(`${"x".repeat(41)} шпаклевка`), searchTerms("шпаклевка"));
  assert.deepEqual(searchTerms("Какие смеси для швов ГКЛ?"), ["шов", "стык", "швов", "шва", "гкл", "гипсокартон"]);
  // Ровно 40 знаков — ещё слово (схема принимает), со срезанным окончанием.
  assert.deepEqual(searchTerms("я".repeat(40)), ["я".repeat(38)]);
});

for (const scope of ["public", "staff"]) {
  test(`длинное слово в вопросе — обычный ответ без ошибки (${scope})`, async () => {
    for (const question of LONG) {
      const r = await runAgent({ tenantId: 1, scope, question, provider: mock });
      assert.equal(typeof r.answer, "string", question);
      assert.ok(r.answer.length > 0, question);
      assert.doesNotMatch(r.answer, /не смог ответить/, question);
      assert.ok(r.mode, question);
    }
  });
}
