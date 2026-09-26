// Переоценка сохранённого прогона (npm run ai:eval) текущей проверкой ответа
// без обращения к модели: ответ берётся из отчёта, контекст и номера [E#]
// собираются заново из той же базы — они детерминированы.
//
//   node src/ai/agent/eval/replay.js var/ai-eval/eval-staff-….json
import { readFileSync } from "node:fs";
import { db, all } from "../../../db/index.js";
import { runAgent } from "../runtime/agent.js";
import { loadEvalCases, evaluateCase } from "./grounding-eval.js";

db.exec("PRAGMA query_only = ON");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
const cases = new Map(loadEvalCases().map((c) => [c.id, c]));
let passed = 0;
for (const saved of report.results) {
  const provider = {
    name: "replay", model: saved.model || "replay", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
    async* stream() { yield { type: "text", text: saved.answer }; yield { type: "done", stopReason: saved.stopReason, usage: {} }; },
  };
  const r = await runAgent({ tenantId: 1, scope: report.summary.scope, question: saved.question, provider });
  const ev = evaluateCase(cases.get(saved.id), r, { slugOf, live: true });
  if (ev.pass) passed += 1;
  console.log(`${ev.pass ? "PASS" : "FAIL"} #${saved.id} ${saved.question}${ev.fails.length ? `\n     ✗ ${ev.fails.join("; ")}` : ""}`);
}
console.log(`\nИтог переоценки: ${passed} из ${report.results.length}`);
