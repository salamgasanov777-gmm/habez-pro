// Habez AI (Phase 4.2): повторная проверка сохранённых ответов — без модели,
// без базы, без сети. Вход — файл входов проверки (capture-check-inputs.js
// или отчёт с полем checkInput):
//
//   node src/ai/agent/eval/recheck.js <файл.json> [--mutate]
//
// Для каждого ответа: итог (PASS/FAIL и находки) и совпадает ли grounding с
// сохранённым. --mutate — ещё и испорченные копии каждого ответа: каждая
// порча должна дать свою ошибку (иначе проверка её пропускает).
import { readFileSync } from "node:fs";
import { recheck } from "../checks/recheck.js";

// Порча ответа → код ошибки, который она обязана вызвать. Порча не зависит от
// данных ответа: номер ссылки, число, дата, сайт, сумма заведомо выдуманы.
export const MUTATIONS = [
  { id: "citation", code: "INVALID_CITATION", spoil: (a) => `${a} [E9999]` },
  { id: "number", code: "UNSUPPORTED_NUMBER", spoil: (a) => `${a}\nДополнительно: 987,6 МПа.` },
  { id: "date", code: "UNSUPPORTED_DATE", spoil: (a) => `${a}\nДокумент от 31.12.2031.` },
  { id: "verdict", code: "COMPETITOR_VERDICT", domain: "competitor", spoil: (a) => `${a}\nВывод: ШОВ лучше.` },
  { id: "source", code: "INVENTED_SOURCE", domain: "competitor", spoil: (a) => `${a}\nПодробнее: fake-shop-9999.ru.` },
  { id: "price", code: "INVENTED_PRICE", domain: "competitor", spoil: (a) => `${a}\nЦена — 98 765 ₽.` },
];

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const errorsOf = (r) => [...new Set(r.findings.filter((f) => f.severity === "error").map((f) => f.code))];

export function recheckFile(data, { mutate = false } = {}) {
  const items = data.items || (data.results || []).filter((x) => x.checkInput).map((x, i) => ({ id: x.id ?? i, input: x.checkInput, expected: { grounding: x.grounding } }));
  const out = { total: items.length, passed: 0, sameAsSaved: 0, differs: [], mutations: { total: 0, caught: 0, missed: [] }, lines: [] };
  for (const it of items) {
    const r = recheck(it.input);
    if (r.passed) out.passed += 1;
    const matches = !it.expected?.grounding || same(r.grounding, it.expected.grounding);
    if (matches) out.sameAsSaved += 1; else out.differs.push(it.id);
    out.lines.push(`${r.passed ? "PASS" : "FAIL"} ${it.id}${matches ? "" : "  ≠ сохранённый итог"}${r.findings.length ? `\n     ${r.findings.map((f) => `${f.severity === "error" ? "✗" : "·"} ${f.code}: ${f.text}`).join("\n     ")}` : ""}`);
    if (!mutate || it.input.fixed) continue;
    for (const m of MUTATIONS) {
      if (m.domain && !it.input.domains?.[m.domain]?.active) continue;
      out.mutations.total += 1;
      if (errorsOf(recheck(it.input, { answer: m.spoil(it.input.answer) })).includes(m.code)) out.mutations.caught += 1;
      else out.mutations.missed.push(`${it.id}:${m.id}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error("Укажите файл входов проверки."); process.exit(2); }
  const res = recheckFile(JSON.parse(readFileSync(file, "utf8")), { mutate: process.argv.includes("--mutate") });
  console.log(res.lines.join("\n"));
  console.log(`\nИтог: PASS ${res.passed} из ${res.total}; совпадает с сохранённым — ${res.sameAsSaved} из ${res.total}${res.differs.length ? ` (иначе: ${res.differs.join(", ")})` : ""}`);
  if (res.mutations.total) console.log(`Порча ответов: поймано ${res.mutations.caught} из ${res.mutations.total}${res.mutations.missed.length ? ` (пропущено: ${res.mutations.missed.join(", ")})` : ""}`);
}
