// Прогон контрольного набора (15 вопросов) на настоящей модели.
//
//   npm run ai:eval                         уровень staff, база из DATABASE_FILE
//   npm run ai:eval -- --scope public       как гость
//   npm run ai:eval -- --only 7,8,9         только эти вопросы
//
// Каждый вопрос стоит денег (OpenRouter). База открывается в режиме
// «только чтение» (PRAGMA query_only): SQLite откажет в любой записи.
// Отпечаток всех таблиц до и после печатается — они должны совпасть.
// Полный отчёт с ответами — в api/var/ai-eval/ (в git не попадает):
// в ответах сотруднику есть внутренние данные.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../../../config.js";
import { db, all } from "../../../db/index.js";
import { getProvider } from "../provider/index.js";
import { runAgent } from "../runtime/agent.js";
import { loadEvalCases, evaluateCase } from "./grounding-eval.js";

const arg = (name, d = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const scope = arg("scope", "staff");
const only = arg("only") ? new Set(arg("only").split(",").map(Number)) : null;

db.exec("PRAGMA query_only = ON");

const fingerprint = () => createHash("sha256").update(JSON.stringify(
  all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' ORDER BY name")
    .map(({ name }) => [name, all(`SELECT * FROM "${name}"`).map((r) => JSON.stringify(r)).sort()]),
)).digest("hex");

const provider = getProvider();
if (provider.name === "mock" && !process.argv.includes("--mock")) {
  console.error("Нужна настоящая модель: AI_PROVIDER=openrouter и OPENROUTER_API_KEY в окружении (для заглушки — --mock).");
  process.exit(2);
}
const slugOf = new Map(all("SELECT id, slug FROM products").map((r) => [r.id, r.slug]));
const before = fingerprint();
const started = new Date().toISOString();
console.log(`Habez AI eval · ${provider.name} ${provider.model} · уровень ${scope} · база ${config.db.file}`);
console.log(`отпечаток базы до: ${before}\n`);

const results = [];
for (const c of loadEvalCases()) {
  if (only && !only.has(c.id)) continue;
  const r = await runAgent({ tenantId: 1, scope, question: c.question, provider });
  const ev = evaluateCase(c, r, { slugOf, live: true });
  results.push({ ...ev, behavior: c.behavior, answer: r.answer, grounding: r.grounding, withheld: r.withheld, timings: r.timings,
    usage: r.usage, citations: r.citations.length, conflicts: r.conflicts, model: r.model, stopReason: r.stopReason });
  console.log(`${ev.pass ? "PASS" : "FAIL"} #${c.id} ${c.question}  (${r.timings.totalMs} мс${ev.warn.length ? `; ${ev.warn.join("; ")}` : ""})`);
  for (const f of ev.fails) console.log(`     ✗ ${f}`);
}
const after = fingerprint();
const sum = (f) => results.reduce((n, r) => n + (f(r) || 0), 0);
const llm = results.filter((r) => r.model);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = {
  started, provider: provider.name, model: provider.model, scope, total: results.length, passed: results.filter((r) => r.pass).length,
  tokens: { in: sum((r) => r.usage?.input_tokens), out: sum((r) => r.usage?.output_tokens) },
  latencyMs: {
    retrieval: { median: med(results.map((r) => r.timings.retrievalMs)), max: Math.max(...results.map((r) => r.timings.retrievalMs)) },
    context: { median: med(results.map((r) => r.timings.contextMs)), max: Math.max(...results.map((r) => r.timings.contextMs)) },
    firstToken: { median: med(llm.map((r) => r.timings.llmFirstTokenMs)), max: Math.max(...llm.map((r) => r.timings.llmFirstTokenMs)) },
    llm: { median: med(llm.map((r) => r.timings.llmMs)), max: Math.max(...llm.map((r) => r.timings.llmMs)) },
    total: { median: med(results.map((r) => r.timings.totalMs)), max: Math.max(...results.map((r) => r.timings.totalMs)) },
  },
  fingerprintBefore: before, fingerprintAfter: after, dbUnchanged: before === after,
};
console.log(`\nИтог: ${summary.passed} из ${summary.total} · токены ${summary.tokens.in} / ${summary.tokens.out}`);
console.log(`время (медиана): поиск ${summary.latencyMs.retrieval.median} мс, контекст ${summary.latencyMs.context.median} мс, первый токен ${summary.latencyMs.firstToken.median} мс, модель ${summary.latencyMs.llm.median} мс, всего ${summary.latencyMs.total.median} мс`);
console.log(`отпечаток базы после: ${after} — ${summary.dbUnchanged ? "без изменений" : "ИЗМЕНИЛСЯ"}`);
const dir = resolve(config.root, "var/ai-eval");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `eval-${scope}-${started.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(`отчёт: ${file}`);
process.exit(summary.passed === summary.total && summary.dbUnchanged ? 0 : 1);
