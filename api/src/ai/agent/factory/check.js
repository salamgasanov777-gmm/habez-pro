// Habez AI Phase 3.4: проверка ответа о заводах и документах. Дополняет
// checkAnswer (числа, ссылки, скрытое, чужие товары):
//
//   factoryMismatch   — «ШОВ производится на Хабезском заводе» без оговорки,
//                       когда система связь так не оценила (не CONFIRMED);
//   inventedDocuments — назван вид документа, которого в данных нет
//                       («сертификат соответствия», «протокол испытаний»),
//                       и это не отрицание («сертификата в данных нет»);
//   unsupportedDates  — дата, которой нет ни в данных, ни в вопросе.
const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const HEDGE = /косвенн|не (указан|подтвержд|назван|установлен|следует|сказано)|прямо не|предполага|нет (данных|сведений|прямого)|неизвестн|вывод|возможно|по косвенным/;
const MADE = /(производит(ся|ь)?|производятся|производ[а-я]* на|изготовл|изготавлива|выпуска[а-я]*|сделан)/;
const DENIAL = /(^|[^а-я])(нет|не|отсутству)([^а-я]|$)/;

export function factoryMismatch(answer, items = []) {
  const out = new Set();
  const lines = low(answer).split(/\n+|(?<=[.!?])\s+/);
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
  for (const line of low(answer).split(/\n+|(?<=[.!?])\s+/)) {
    for (const [re, type] of DOC_WORDS) {
      if (!re.test(line) || have.has(type) || (type === "certificate" && have.has("certificate"))) continue;
      if (DENIAL.test(line)) continue;
      out.add(line.match(re)[0]);
    }
  }
  return [...out];
}

const DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2})/g;
const iso = (m) => (m[4] ? `${m[4]}-${m[5]}-${m[6]}` : `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
export const datesIn = (text) => new Set([...String(text ?? "").matchAll(DATE_RE)].map(iso));
export function unsupportedDates(answer, dataText, question = "") {
  const known = new Set([...datesIn(dataText), ...datesIn(question)]);
  return [...datesIn(answer)].filter((d) => !known.has(d));
}
