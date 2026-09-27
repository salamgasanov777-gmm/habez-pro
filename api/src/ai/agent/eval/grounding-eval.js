// Проверка ответа агента по контрольному набору (test/fixtures/ai-eval-cases.json).
// Один код для теста с моделью-заглушкой и для прогона с настоящей моделью
// (npm run ai:eval). Проверки над данными (поиск, споры, контекст) — всегда;
// над текстом ответа — только когда текст писала настоящая модель или
// ответ собран без модели (live: true или check.model === false).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const EVAL_CASES_FILE = resolve(here, "../../../../test/fixtures/ai-eval-cases.json");
export const loadEvalCases = (file = EVAL_CASES_FILE) => JSON.parse(readFileSync(file, "utf8")).cases;

// «Победитель» в споре: слова, которыми одно значение объявляют верным.
// «Система не выбирает одно значение как окончательное» — не победитель.
const WINNER = /(правильн|верн|актуальн|точн)(ое|ым|ая) значени|устаревш|следует (использовать|ориентироваться)|технолог уточнил|ориентируйтесь на/i;
const NO_DATA = /нет (данных|в данных|такого|сведений)|(данных|сведений)[^.]{0,25} нет|в данных[^.]{0,40}(нет|не указан|отсутству)|не (указан|найден)|отсутству/i;
const DENY = /(^|[^а-я])(нет|не)([^а-я]|$)|не подтвержда|не соответству|такого значения/i;

export function evaluateCase(c, r, { slugOf = new Map(), live = false } = {}) {
  const k = c.check || {};
  const fails = [];
  const warn = [];
  const props = r.context?.properties || [];
  const has = (cond, msg) => { if (!cond) fails.push(msg); };

  if (k.intent) has(r.intent === k.intent, `намерение ${r.intent}, ожидалось ${k.intent}`);
  if (k.products) {
    const got = r.products.map((id) => slugOf.get(id) ?? id);
    has(JSON.stringify(got) === JSON.stringify(k.products), `товары ${JSON.stringify(got)}, ожидалось ${JSON.stringify(k.products)}`);
  }
  if (k.model !== undefined) has((r.model !== null) === k.model, k.model ? "модель не вызвана" : "модель вызвана, хотя данных нет");
  for (const key of k.conflictKeys || []) {
    has(props.some((p) => p.key === key && ["conflict", "unresolved"].includes(p.status)), `нет спора по ${key}`);
  }
  if (k.onlyKeys) {
    const extra = props.filter((p) => p.key && !k.onlyKeys.includes(p.key)).map((p) => p.key);
    has(!extra.length, `лишние характеристики: ${[...new Set(extra)].join(", ")}`);
  }
  if (k.variants) {
    const units = (r.context?.variants || []).map((v) => v.unit);
    for (const v of k.variants) has(units.includes(v), `нет фасовки ${v}`);
    const refs = (r.context?.variants || []).map((v) => v.ref);
    has(new Set(refs).size === refs.length, "фасовки делят одну ссылку");
  }
  if (k.keyWithCondition) {
    const { key, conditionIncludes } = k.keyWithCondition;
    has(props.some((p) => p.key === key && String(p.conditionText || "").includes(conditionIncludes)), `нет ${key} с условием «${conditionIncludes}»`);
  }
  if (k.noConflicts) {
    const bad = props.filter((p) => ["conflict", "unresolved"].includes(p.status)).map((p) => p.label);
    has(!bad.length, `лишние споры: ${bad.join(", ")}`);
  }
  if (k.missingNote) has(/По характеристике из вопроса у этого товара данных нет/.test(r.context?.text || ""), "нет пометки «данных нет»");
  if (k.unknown) has(JSON.stringify(r.unknown || []) === JSON.stringify(k.unknown), `неизвестные товары ${JSON.stringify(r.unknown)}`);

  if (live || k.model === false) {
    const a = String(r.answer || "");
    const g = r.grounding || {};
    has(!g.invalidCitations?.length, `несуществующие ссылки: ${g.invalidCitations?.join(", ")}`);
    has(!g.unsupported?.length, `числа не из данных: ${g.unsupported?.join(", ")}`);
    has(!g.mismatched?.length, `число не из указанного источника: ${g.mismatched?.join(", ")}`);
    has(!g.forbidden, "в ответе скрытые данные");
    if (g.uncited?.length) warn.push(`без ссылки: ${g.uncited.join(", ")}`);
    for (const s of k.answerIncludes || []) has(a.includes(s), `в ответе нет «${s}»`);
    for (const s of k.answerExcludes || []) has(!a.includes(s), `в ответе есть «${s}»`);
    if (k.noWinner) has(!WINNER.test(a), `выбран «победитель»: ${a.match(WINNER)?.[0]}`);
    if (k.noData) has(NO_DATA.test(a), "ответ не говорит, что данных нет");
    if (k.falseNumber) {
      has(!(g.mismatched || []).concat(g.unsupported || []).some((x) => x.startsWith(k.falseNumber.split(" ")[0])), `ложное ${k.falseNumber} подано как данные`);
      has(!a.includes(k.falseNumber) || DENY.test(a), `ложное ${k.falseNumber} не опровергнуто`);
    }
  }
  return { id: c.id, group: c.group, question: c.question, pass: !fails.length, fails, warn };
}
