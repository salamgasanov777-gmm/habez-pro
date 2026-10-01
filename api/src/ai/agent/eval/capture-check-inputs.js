// Habez AI (Phase 4.2): входы проверки для старых отчётов live-оценки (до
// 4.2 вход не сохранялся). Сохранённый ответ модели подставляется как есть
// (вызовы инструментов — тоже из отчёта), модель не вызывается; данные [E#]
// собираются заново из ИЗОЛИРОВАННОЙ копии базы, на которой шла оценка,
// только чтением. Текст данных сверяется с сохранённым: не совпал — вход не
// пишется. Дальше — eval/recheck.js без базы.
//
//   DATABASE_FILE=<копия базы> node src/ai/agent/eval/capture-check-inputs.js <отчёт.json> <выход.json>
import { readFileSync, writeFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { config } from "../../../config.js";

// Путь к базе — как его откроет сервер (config.js), после всех «..» и
// ссылок: только существующая копия в var/ai-eval или в scratchpad, не
// рабочая база api/var/hgz.db.
const real = (f) => (existsSync(f) ? realpathSync(f) : null);
const file = real(config.db.file);
const production = real(resolve(config.root, "var/hgz.db")) ?? resolve(config.root, "var/hgz.db");
const evalDir = real(resolve(config.root, "var/ai-eval"));
if (!process.env.DATABASE_FILE || !file || file === production || !((evalDir && file.startsWith(evalDir + sep)) || file.includes(`${sep}scratchpad${sep}`))) {
  console.error("Отказ: DATABASE_FILE — только существующая изолированная копия базы (var/ai-eval или scratchpad), не рабочая база.");
  process.exit(2);
}
const [reportFile, outFile] = process.argv.slice(2);
if (!reportFile || !outFile) { console.error("Укажите отчёт и файл для входов проверки."); process.exit(2); }
const { db, get } = await import("../../../db/index.js");
const { runAgent } = await import("../runtime/agent.js");
db.exec("PRAGMA query_only = ON");

const report = JSON.parse(readFileSync(reportFile, "utf8"));
const before = get("SELECT total_changes() AS n").n;
const items = [];
const problems = [];
for (const c of report.results) {
  let state = {};
  let refBase = 0;
  const history = [];
  for (const [i, turn] of c.turns.entries()) {
    const uses = turn.toolsModel || [];
    let call = 0;
    const provider = {
      name: "replay", model: turn.model || "replay", capabilities: { streaming: true, tools: uses.length > 0, maxOutputTokens: 4000 },
      async* stream() {
        call += 1;
        if (call === 1 && uses.length) {
          for (const u of uses) yield { type: "tool_use", id: u.id, name: u.name, input: u.input };
          yield { type: "done", stopReason: "tool_use", usage: {} };
          return;
        }
        yield { type: "text", text: turn.answer };
        yield { type: "done", stopReason: "end_turn", usage: {} };
      },
    };
    const r = await runAgent({ tenantId: 1, scope: c.scope, question: turn.question, history, state, refBase, provider });
    const id = `${c.id}#${i + 1}`;
    const okData = r.context.text === turn.evidenceBundle;
    const okAnswer = r.answer === turn.answer;
    if (!okData || !okAnswer) problems.push(`${id}: ${okData ? "" : "данные не совпали с сохранёнными; "}${okAnswer ? "" : "ответ не совпал"}`);
    else items.push({ id, question: turn.question, scope: c.scope, expected: { grounding: turn.grounding }, input: r.checkInput });
    history.push({ role: "user", content: turn.question }, { role: "assistant", content: turn.answer });
    state = r.state;
    refBase = r.refBase + r.context.evidence.length;
  }
}
if (get("SELECT total_changes() AS n").n !== before) { console.error("Отказ: в базу что-то записано."); process.exit(1); }
writeFileSync(outFile, `${JSON.stringify({ kind: "habez-ai-check-inputs", version: 1, source: reportFile, items }, null, 1)}\n`, { mode: 0o600 });
chmodSync(outFile, 0o600);
console.log(`Входов проверки: ${items.length}; не совпало: ${problems.length}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}\nФайл: ${outFile} — в нём скрытые от роли значения, хранить только локально (var/ai-eval, не в git).`);
