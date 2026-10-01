// Habez AI (Phase 4.2): запуск проверок ответа и итог.
//
//   вход (input.js) → разбор ответа один раз (text.js) → проверки реестра
//   (registry.js: общие, доменные, политика) → находки → итог
//
// Итог: { passed, findings, results, grounding, citations }.
//   findings  [{ check, layer, code, severity, text, line? }]; повторы — как
//             прежде у каждой проверки (числа и скрытое — без повторов)
//   results   по проверке: [{ id, layer, findings }]; не относящейся к ответу
//             (applies) — нет
//   grounding прежний объект проверки в ответе API: поля и порядок те же
//   citations записи [E#], на которые сослался ответ (есть в данных)
// Готовый ответ сервера (fixed) не проверяется: находок нет, поля — пустые.
// Проверки ничего не пишут и не ходят в сеть и в базу.
import { parseAnswer, facts, evidenceText } from "./text.js";
import { coreGrounding } from "./common.js";
import { CHECKS } from "./registry.js";

function prepare(input) {
  const evidence = input.evidence || [];
  return {
    input,
    a: parseAnswer(input.answer),
    byId: new Map(evidence.map((e) => [e.id, e])),
    data: facts(`${evidence.map(evidenceText).join(" \n ")} \n ${input.contextText || ""}`),
    asked: facts(input.question),
    past: facts(input.historyText),
  };
}

export function runAnswerChecks(input, checks = CHECKS) {
  const ctx = input.fixed ? null : prepare(input);
  const grounding = { grounded: true, ...coreGrounding() };
  const results = [];
  for (const c of checks) {
    if (c.applies && !c.applies(input)) continue;
    const findings = ctx ? c.run(ctx, input.domains?.[c.id] ?? null) : [];
    results.push({ id: c.id, layer: c.layer, findings });
    c.report(findings, grounding);
  }
  const findings = results.flatMap((r) => r.findings.map((f) => ({ check: r.id, layer: r.layer, ...f })));
  grounding.grounded = !findings.some((f) => f.severity === "error");
  return {
    passed: grounding.grounded, findings, results, grounding,
    citations: ctx ? ctx.a.cited.filter((id) => ctx.byId.has(id)).map((id) => ctx.byId.get(id)) : [],
  };
}
