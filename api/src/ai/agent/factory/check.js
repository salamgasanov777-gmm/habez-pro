// Habez AI Phase 3.4: проверка ответа о заводах и документах. Дополняет
// checkAnswer (числа, ссылки, скрытое, чужие товары):
//
//   factoryMismatch   — «ШОВ производится на Хабезском заводе» без оговорки,
//                       когда система связь так не оценила (не CONFIRMED);
//   inventedDocuments — назван вид документа, которого в данных нет
//                       («сертификат соответствия», «протокол испытаний»),
//                       и это не отрицание («сертификата в данных нет»);
//   unsupportedDates  — дата, которой нет ни в данных, ни в вопросе.
import { lastValue } from "../checks/text.js";
import { finding, textsOf } from "../checks/contract.js";

const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const HEDGE = /косвенн|не (указан|подтвержд|назван|установлен|следует|сказано)|прямо не|предполага|нет (данных|сведений|прямого)|неизвестн|вывод|возможно|по косвенным/;
const MADE = /(производит(ся|ь)?|производятся|производ[а-я]* на|изготовл|изготавлива|выпуска[а-я]*|сделан)/;
const DENIAL = /(^|[^а-я])(нет|не|отсутству)([^а-я]|$)/;
// Фразы ответа в нижнем регистре — один раз на ответ для обеих проверок.
const phrases = lastValue((answer) => low(answer).split(/\n+|(?<=[.!?])\s+/));

export function factoryMismatch(answer, items = []) {
  const out = new Set();
  const lines = phrases(answer);
  for (const it of items) {
    if (it.status === "CONFIRMED") continue;
    const name = low(it.short || it.product);
    if (!name || name.length < 2) continue;
    for (const line of lines) {
      if (!line.includes(name) || !MADE.test(line) || !/завод|хабез|habez|площадк/.test(line)) continue;
      if (HEDGE.test(line) || DENIAL.test(line)) continue;
      out.add(it.short || it.product);
    }
  }
  return [...out];
}

const DOC_WORDS = [
  [/сертификат[а-я]* соответств/, "certificate"], [/декларац[а-я]* соответств/, "declaration"], [/протокол[а-я]* испыт/, "test_report"],
  [/паспорт[а-я]* качеств/, "quality_passport"], [/этикетк/, "label"], [/маркировочн/, "marking_card"],
];
export function inventedDocuments(answer, availableTypes = []) {
  const have = new Set(availableTypes);
  const out = new Set();
  for (const line of phrases(answer)) {
    for (const [re, type] of DOC_WORDS) {
      if (!re.test(line) || have.has(type) || (type === "certificate" && have.has("certificate"))) continue;
      if (DENIAL.test(line)) continue;
      out.add(line.match(re)[0]);
    }
  }
  return [...out];
}

// Даты — общая проверка (checks/common.js); здесь — для прежних вызовов.
export { datesIn, unsupportedDates } from "../checks/common.js";

// Phase 4.2: проверка ответа о заводах (контракт — checks/contract.js).
// Данные — связи товар → завод со статусом и виды документов в данных.
const FACTORY = { FACTORY_MISMATCH: "error", INVENTED_DOCUMENT: "error" };
export const factoryAnswerCheck = {
  id: "factory", layer: "domain", codes: FACTORY,
  collect(t, final) {
    const { factory, profileFactory } = t;
    return {
      relItems: (factory?.productFactory || (profileFactory ? [profileFactory] : [])).map((it) => ({ status: it.status, short: it.short, product: it.product })),
      docTypesAvailable: [...new Set([...final.evidence.filter((e) => e.kind === "document").map((e) => e.sourceType),
        ...(factory?.documents || []).map((d) => d.type), ...(/сертифиц|сертификат/i.test(final.text) ? ["certificate"] : [])])],
      hasFactory: !!(factory || profileFactory),
    };
  },
  run({ a }, data) {
    if (!data) return [];
    return [...factoryMismatch(a.text, data.relItems).map((x) => finding(FACTORY, "FACTORY_MISMATCH", x)),
      ...(data.hasFactory ? inventedDocuments(a.text, data.docTypesAvailable).map((x) => finding(FACTORY, "INVENTED_DOCUMENT", x)) : [])];
  },
  report(findings, g) {
    g.factoryMismatch = textsOf(findings, "FACTORY_MISMATCH");
    g.inventedDocuments = textsOf(findings, "INVENTED_DOCUMENT");
  },
};
