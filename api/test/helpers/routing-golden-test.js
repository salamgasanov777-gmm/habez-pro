// Общий тест эталона (Phase 4.1). GOLDEN_WRITE=1 — записать эталон (только
// с кода до рефакторинга); без неё — сравнить.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { apiRoot, prepareAiDb } from "./ai-fixture.js";

export function goldenSuite(variant, { competitors }) {
  Object.assign(process.env, {
    DATABASE_FILE: resolve(apiRoot, `var/test-ai-golden-${variant}.db`), NODE_ENV: "test", PAYMENT_PROVIDER: "none", LOG_LEVEL: "silent",
    AI_ENABLED: "1", AI_EVIDENCE_ENABLED: "1", AI_AGENT_ENABLED: "1", AI_AGENT_PUBLIC: "1", AI_PROVIDER: "mock",
  });
  delete process.env.OPENROUTER_API_KEY;
  const file = resolve(apiRoot, `test/fixtures/ai-routing-golden-${variant}.json`);

  test(`эталон поведения (${variant}): маршрут, режим, инструменты, модель, проверка ответа — как до рефакторинга`, async () => {
    await prepareAiDb();
    if (competitors) await (await import("./competitor-fixture.js")).seedCompetitors();
    const { collectGolden } = await import("./routing-golden.js");
    const { get } = await import("../../src/db/index.js");
    const before = get("SELECT total_changes() AS n").n;
    const now = await collectGolden();
    assert.equal(get("SELECT total_changes() AS n").n, before, "ассистент ничего не записал");
    if (process.env.GOLDEN_WRITE === "1") { writeFileSync(file, `${JSON.stringify(now)}\n`); return; }
    const want = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(now).sort(), Object.keys(want).sort(), "набор случаев");
    const diffs = Object.keys(want).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(want[k]));
    for (const k of diffs.slice(0, 5)) assert.deepEqual(now[k], want[k], k);
    assert.deepEqual(diffs, []);
  });
}
