// Habez AI (Phase 4.2): общие проверки ответа — не зависят от домена.
// Код перенесён из runtime/context.js (checkAnswer) и base-handlers.js
// (пустой ответ, даты) без изменения правил.
//
//   citations  INVALID_CITATION — ссылка на номер, которого нет в данных ЭТОГО
//              ответа (номера прошлых ответов модель не видит)
//   numbers    UNSUPPORTED_NUMBER — числа с этой единицей нет в данных
//              («5 МПа» при «0,5 МПа»); MISMATCHED_NUMBER — число есть, но не
//              в записях, на которые ссылается строка, или с другой единицей;
//              UNCITED_NUMBER — без ссылки и нигде не стоит рядом со своей;
//              не ошибка (F18): заголовок «…:» над строками со ссылками на
//              записи с этим числом; число из вопроса, повторённое с
//              отрицанием, — пометка ECHOED_NUMBER;
//              ECHOED_NUMBER (info) — число из вопроса повторено, чтобы его
//              опровергнуть; HISTORY_NUMBER (info) — из прошлого ответа беседы,
//              не перепроверено (историю присылает браузер)
//   products   FOREIGN_PRODUCT — товар Habez, которого нет ни в данных ответа,
//              ни в их тексте
//   empty-answer EMPTY_ANSWER — модель не вернула ни слова
//   dates      UNSUPPORTED_DATE — даты нет ни в данных, ни в вопросе
import { detectProducts } from "../retrieval/entities.js";
import { facts, supports, evidenceText } from "./text.js";
import { finding, textsOf, uniqueFindings } from "./contract.js";

// Поля прежнего результата checkAnswer — в этом порядке их отдаёт grounding.
export const coreGrounding = () => ({ unsupported: [], mismatched: [], uncited: [], echoed: [], invalidCitations: [], forbidden: 0, foreignProducts: [], fromHistory: [] });

const CITATION = { INVALID_CITATION: "error" };
export const citationsCheck = {
  id: "citations", layer: "common", codes: CITATION,
  run: ({ a, byId }) => a.cited.filter((id) => !byId.has(id)).map((id) => finding(CITATION, "INVALID_CITATION", id)),
  report(findings, g) { g.invalidCitations = textsOf(findings, "INVALID_CITATION"); },
};

const DENIAL = /(^|[^а-яё])(нет|не)([^а-яё]|$)|отсутству|не подтвержд/i;
const NUMBER = { UNSUPPORTED_NUMBER: "error", MISMATCHED_NUMBER: "error", UNCITED_NUMBER: "error", ECHOED_NUMBER: "info", HISTORY_NUMBER: "info" };
export const numbersCheck = {
  id: "numbers", layer: "common", codes: NUMBER,
  run({ a, byId, data, asked, past }) {
    const out = [];
    const add = (code, claim, i) => out.push(finding(NUMBER, code, claim, i + 1));
    // Данные, на которые ссылается строка ответа.
    const lines = a.lines.map((l) => {
      const refs = l.refs.filter((id) => byId.has(id));
      return { ...l, refs, f: refs.length ? facts(refs.map((id) => evidenceText(byId.get(id))).join(" \n ")) : null };
    });
    // Числа, которые где-то в ответе стоят рядом со своей ссылкой: итоговая
    // строка «участники: 0,5 / 0,3» без ссылок их лишь повторяет.
    const citedPairs = new Set();
    for (const l of lines) if (l.f) for (const n of l.numbers) for (const v of n.values) if (supports(l.f, v, n.fam)) citedPairs.add(`${v}|${n.fam}`);
    // Заголовок (строка без ссылок, в конце «:») относится к строкам сразу под
    // ним — пока в них есть ссылки: «Розница, за мешок 25 кг:» над ценами (F18).
    const under = (i) => {
      const ids = [];
      for (let j = i + 1; j < lines.length && lines[j].refs.length; j += 1) ids.push(...lines[j].refs);
      return ids.length ? facts(ids.map((id) => evidenceText(byId.get(id))).join(" \n ")) : null;
    };
    const denies = (text) => DENIAL.test(text.replace(/не (менее|более|ранее|позднее|выше|ниже)/gi, ""));
    lines.forEach((l, i) => {
      for (const n of l.numbers) {
        // «на 1 кг», «на 1 м²», «на 1 мешок» — единица расчёта, не значение.
        if (/на\s*$/i.test(l.text.slice(Math.max(0, n.index - 4), n.index)) && n.first === "1" && n.single) continue;
        for (const v of n.values) {
          const inQuestion = asked.all.has(v);
          if (!supports(data, v, n.fam)) {
            // Число из вопроса повторено, чтобы его опровергнуть, — не ошибка.
            // Со ссылкой и без отрицания — подано как данные.
            if (inQuestion && (!l.refs.length || DENIAL.test(l.text.replace(/не (менее|более|ранее|позднее|выше|ниже)/gi, "")))) add("ECHOED_NUMBER", n.claim, i);
            else if (!l.refs.length && supports(past, v, n.fam)) add("HISTORY_NUMBER", n.claim, i);
            else add("UNSUPPORTED_NUMBER", n.claim, i);
          } else if (l.f && !supports(l.f, v, n.fam)) {
            // Число из вопроса («7 и 28 суток»), подтверждённое ссылкой в другой
            // строке ответа, здесь лишь упомянуто — не смешение источников.
            if (!(inQuestion && citedPairs.has(`${v}|${n.fam}`))) add("MISMATCHED_NUMBER", n.claim, i);
          } else if (!l.f && !citedPairs.has(`${v}|${n.fam}`)) {
            // Без ссылки — ошибка, кроме двух повторов с привязкой к источнику
            // (F18): заголовок над записями, где это число с той же единицей
            // есть; число из вопроса с той же единицей, повторённое в строке с
            // отрицанием («мешок 25 кг нельзя пересчитать») — пометка, как
            // любое опровергнутое число из вопроса.
            const key = `${v}|${n.fam}`;
            if (/:\s*$/.test(l.text) && under(i)?.pairs.has(key)) continue;
            if (asked.pairs.has(key) && denies(l.text)) add("ECHOED_NUMBER", n.claim, i);
            else add("UNCITED_NUMBER", n.claim, i);
          }
        }
      }
    });
    return uniqueFindings(out);
  },
  report(findings, g) {
    g.unsupported = textsOf(findings, "UNSUPPORTED_NUMBER");
    g.mismatched = textsOf(findings, "MISMATCHED_NUMBER");
    g.uncited = textsOf(findings, "UNCITED_NUMBER");
    g.echoed = textsOf(findings, "ECHOED_NUMBER");
    g.fromHistory = textsOf(findings, "HISTORY_NUMBER");
  },
};

// Товары в ответе: только те, что есть в данных этого ответа. Имя товара,
// которое само — обычное слово («стандарт» про ГОСТ), товаром считается,
// только если написано с заглавной (как имя).
const COMMON_WORDS = new Set(["стандарт"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRODUCT = { FOREIGN_PRODUCT: "error" };
export const productsCheck = {
  id: "products", layer: "common", codes: PRODUCT,
  run({ a, input }) {
    const { catalog, allowedProductIds, maskNames = [] } = input;
    if (!catalog || !allowedProductIds) return [];
    const text = a.text;
    const allowed = new Set(allowedProductIds);
    const asName = (p) => !COMMON_WORDS.has(String(p.short_name || "").toLowerCase()) || new RegExp(`(?:^|[^а-яё])${String(p.short_name).charAt(0).toUpperCase()}${String(p.short_name).slice(1).toLowerCase()}|${String(p.short_name).toUpperCase()}`).test(text);
    // Имена из справочников доменов («П-Финиш» — товар конкурента) не
    // считаются упоминанием нашего товара («ФИНИШ»): их вырезаем.
    const masked = [...new Set(maskNames.flatMap((n) => [n, ...[...String(n).matchAll(/[«"“]([^»"”]+)[»"”]/g)].map((m) => m[1])]).map((n) => String(n).trim()).filter((n) => n.length >= 3))]
      .sort((x, y) => y.length - x.length)
      .reduce((t, n) => t.replace(new RegExp(`(^|[^A-Za-zА-Яа-яЁё0-9-])${escapeRe(n)}[а-яё]{0,3}(?=$|[^A-Za-zА-Яа-яЁё0-9-])`, "giu"), "$1 "), text);
    return detectProducts(masked, catalog).filter((p) => !allowed.has(p.id) && asName(p)).map((p) => finding(PRODUCT, "FOREIGN_PRODUCT", p.short_name || p.name));
  },
  report(findings, g) { g.foreignProducts = textsOf(findings, "FOREIGN_PRODUCT"); },
};

const EMPTY = { EMPTY_ANSWER: "error" };
export const emptyAnswerCheck = {
  id: "empty-answer", layer: "common", codes: EMPTY,
  run: ({ input }) => (input.emptyAnswer ? [finding(EMPTY, "EMPTY_ANSWER", "пустой ответ модели")] : []),
  report(findings, g) { g.emptyAnswer = findings.length > 0; },
};

// Даты: «01.02.2025» и «2025-02-01» — одна дата.
const DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2})/g;
const iso = (m) => (m[4] ? `${m[4]}-${m[5]}-${m[6]}` : `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
export const datesIn = (text) => new Set([...String(text ?? "").matchAll(DATE_RE)].map(iso));
export function unsupportedDates(answer, dataText, question = "") {
  const known = new Set([...datesIn(dataText), ...datesIn(question)]);
  return [...datesIn(answer)].filter((d) => !known.has(d));
}
const DATE = { UNSUPPORTED_DATE: "error" };
export const datesCheck = {
  id: "dates", layer: "common", codes: DATE,
  run: ({ a, input }) => unsupportedDates(a.text, input.contextText, input.question).map((d) => finding(DATE, "UNSUPPORTED_DATE", d)),
  report(findings, g) { g.unsupportedDates = textsOf(findings, "UNSUPPORTED_DATE"); },
};
