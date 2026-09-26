// Переоценка сохранённого прогона (npm run ai:eval) текущей проверкой ответа
// без обращения к модели: ответ берётся из отчёта, контекст и номера [E#]
// собираются заново из той же базы — они детерминированы.
//
//   node src/ai/agent/eval/replay.js var/ai-eval/eval-staff-….json
import { readFileSync } from "node:fs";
import { db, all } from "../../../db/index.js";
import { runAgent } from "../runtime/agent.js";
import { loadEvalCases, evaluateCase } from "./grounding-eval.js";
import { loadEval32, runConversation, evaluateCase32, EVAL33_FILE } from "./eval-3-2.js";
import { createMockProvider } from "../provider/mock.js";

db.exec("PRAGMA query_only = ON");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
let passed = 0;
// Наборы 3.2 / 3.3: беседа прогоняется заново, прошлые реплики — заглушкой,
// последняя — сохранённым ответом модели.
if (["3.2", "3.3"].includes(report.summary.set)) {
  const data = report.summary.set === "3.3" ? loadEval32(EVAL33_FILE) : loadEval32();
  const byId = new Map([...data.cases, ...(data.live_extra || [])].map((c) => [String(c.id), c]));
  for (const saved of report.results) {
    const c = byId.get(String(saved.id));
    const mock = createMockProvider();
    let turn = 0;
    const provider = {
      name: "replay", model: saved.model || "replay", capabilities: { streaming: true, tools: false, maxOutputTokens: 4000 },
      async* stream(args) {
        turn += 1;
        if (turn < c.turns.length - 0 && !args.messages.at(-1)?.content?.includes(`ВОПРОС: ${c.turns.at(-1)}`)) { yield* mock.stream(args); return; }
        yield { type: "text", text: saved.answer }; yield { type: "done", stopReason: "end_turn", usage: {} };
      },
    };
    const { last } = await runConversation(c, { provider });
    const ev = evaluateCase32(c, last, { slugOf, live: true });
    if (ev.pass) passed += 1;
    console.log(`${ev.pass ? "PASS" : "FAIL"} #${saved.id} ${c.turns.join(" → ")}${ev.fails.length ? `\n     ✗ ${ev.fails.join("; ")}` : ""}`);
  }
  console.log(`\nИтог переоценки: ${passed} из ${report.results.length}`);
  process.exit(0);
}
const cases = new Map(loadEvalCases().map((c) => [c.id, c]));
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
