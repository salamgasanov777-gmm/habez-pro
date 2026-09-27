// Habez AI 3.5: проверка ответа о конкурентах. Дополняет checkAnswer
// (числа, ссылки, скрытое, товары Habez) и проверки 3.4 (документы, даты):
//
//   entityHallucination  — компания или товар конкурента, которых нет в
//                          данных ответа (или вовсе нет в справочнике);
//   priceHallucination   — сумма, которой нет среди цен в данных; цена без
//                          ссылки на наблюдение цены;
//   sourceHallucination  — сайт или адрес, которых нет в данных;
//   analogyHallucination — «полный аналог», «такой же», «идентичен», когда
//                          связь не подтверждена, частичная или спорная;
//   verdict              — «лучше / хуже / выгоднее / качественнее /
//                          надёжнее / рекомендую / победитель» как вывод;
//   missingAsWorse       — «нет данных» подано как ноль, отсутствие или
//                          худший показатель.
// Отрицание и оговорка («система не выбирает лучший», «нельзя сказать, что
// хуже») ошибкой не считаются.
import { unknownNames, normalizeText } from "../retrieval/entities.js";
import { detectCompetitors } from "./detect.js";

const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const linesOf = (t) => String(t || "").split(/\n+|(?<=[.!?])\s+(?=[А-ЯA-Z])/);
const NEGATED = /(^|[^а-я])(не|нельзя|нет|без)([^а-я]|$)|не выбира|не определя|не оценива|не делает вывод/;

const VERDICT = /(^|[^а-я])(лучше|хуже|выгодн[а-я]*|качественн[а-я]*|надежн[а-я]*|рекоменду[а-я]*|советую|победител[а-я]*|предпочтительн[а-я]*|оптимальн[а-я]* выбор)(?=$|[^а-я])/;
// Слово из вопроса пользователя, взятое в кавычки или после «вы спрашиваете»,
// «на вопрос», — цитата вопроса, а не вывод.
export function verdict(answer, question = "") {
  const out = [];
  const asked = low(question);
  for (const line of linesOf(low(answer))) {
    const m = line.match(VERDICT);
    if (!m || NEGATED.test(line)) continue;
    const quoted = [...line.matchAll(/[«"“]([^»"”]+)[»"”]/g)].some((x) => x[1].includes(m[2]));
    if (asked.includes(m[2]) && (quoted || /спрашива|спросил|вопрос/.test(line))) continue;
    out.push(m[2]);
  }
  return [...new Set(out)];
}

const SAME = /(полн[а-я]* аналог|точн[а-я]* аналог|такой же|то же самое|идентич[а-я]*|одинаков[а-я]*|равноцен[а-я]*|взаимозаменя[а-я]*|100 ?% аналог)/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Наш товар назван отдельным словом: «шов» внутри «u-шов» — не ШОВ.
const namesOurs = (line, n) => new RegExp(`(^|[^а-яa-z0-9-])${esc(n)}[а-я]{0,2}(?![а-яa-z0-9])`).test(line);
// Связи, о которых строка: по товару конкурента, а если у него несколько
// пар с нашими товарами — по нашему товару, названному в строке.
function pairsOf(line, pairs) {
  const cands = pairs.filter((p) => p.names.some((n) => n && line.includes(n)));
  const withOurs = cands.filter((p) => (p.ours || []).some((o) => o && namesOurs(line, o)));
  return withOurs.length ? withOurs : cands;
}
// При противоречии позиция, отнесённая к источнику или сотруднику, — не вывод.
const ATTRIBUTED = /источник|указыва|указан|сотрудник|решени/;
// pairs: [{ names: ["т-шов", …], ours: ["шов"], status, relation }] — связи из данных ответа.
export function analogyHallucination(answer, pairs = []) {
  const out = [];
  for (const line of linesOf(low(answer))) {
    const m = line.match(SAME);
    if (!m || NEGATED.test(line.replace(m[0], ""))) continue;
    const pair = pairsOf(line, pairs)[0];
    // Полное совпадение допустимо только для подтверждённого аналога; для
    // частичного, спорного, предположения — ошибка. Непонятно, о чём, — тоже.
    if (!pair || !(pair.status === "CONFIRMED" && pair.relation === "analog") || /идентич|одинаков|такой же|то же самое/.test(m[0])) out.push(m[0]);
  }
  // «Аналог» без оговорки о предполагаемой или спорной связи.
  for (const line of linesOf(low(answer))) {
    if (!/(^|[^а-я])аналог/.test(line) || /предполож|не подтвержд|частичн|противореч|не является|не аналог|спорн|не установ/.test(line)) continue;
    const pair = pairsOf(line, pairs).find((p) => p.status === "INFERRED" || (p.status === "CONFLICTED" && !ATTRIBUTED.test(line)));
    if (pair) out.push(`аналог (${pair.status})`);
  }
  return [...new Set(out)];
}

const MONEY = /(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(₽|руб(?:\.|л[а-я]*)?)(?![а-я])/giu;
const DATE = /\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2}/;
// prices: наблюдения цен из данных ответа ({ id, amountMinor }).
export function priceHallucination(answer, prices = []) {
  const known = new Set(prices.map((p) => p.amountMinor));
  const byId = new Map(prices.map((p) => [p.id, p]));
  const out = { invented: [], uncited: [] };
  const lines = String(answer || "").split(/\n+/).map((line) => ({ line, refs: [...line.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]),
    amounts: [...line.matchAll(MONEY)].map((m) => ({ text: m[0].trim(), minor: Math.round(Number(m[1].replace(/\s/g, "").replace(",", ".")) * 100) })) }));
  // Сумма, которая где-то в ответе стоит рядом со ссылкой на цену: итоговая
  // фраза «(450 ₽ и 470 ₽) приведены как есть» её лишь повторяет.
  const cited = new Set(lines.filter((l) => l.refs.some((r) => byId.has(r))).flatMap((l) => l.amounts.map((a) => a.minor)));
  for (const { line, refs, amounts } of lines) {
    for (const a of amounts) {
      if (!known.has(a.minor)) out.invented.push(a.text);
      else if (!refs.some((r) => byId.has(r)) && !DATE.test(line) && !cited.has(a.minor)) out.uncited.push(a.text);
    }
  }
  return { invented: [...new Set(out.invented)], uncited: [...new Set(out.uncited)] };
}

// Сайты и адреса: только те, что есть в данных.
const URL = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|com|рф|net|org|su|info|pro|shop|online)(?:\/[^\s)»"]*)?)/giu;
export function sourceHallucination(answer, dataText) {
  const data = low(dataText);
  return [...new Set([...String(answer || "").matchAll(URL)].map((m) => m[1]).filter((u) => !data.includes(low(u).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""))))];
}

// Названные в ответе конкуренты: только те, что есть в данных ответа или в
// прошлых ответах беседы. Незнакомые имена (кавычки, заглавные) — если их
// нет ни в данных, ни в каталоге, ни в справочнике. Имя из вопроса
// пользователя можно повторить только в строке с отрицанием («Гипс-Альфа
// в данных нет»).
const LABEL = /^((не )?аналог|частичн[а-я]* аналог|подтвержд[а-я]*|предположени[а-я]*|противоречи[а-я]*|нет данных|НДС|РРЦ|ГОСТ|ТУ|МПА|INFERRED|CONFIRMED|CONFLICTED|UNKNOWN)$/i;
export function entityHallucination(answer, { registry = [], dataText = "", corpus = "", question = "", historyText = "" }) {
  const data = normalizeText(`${dataText} ${historyText}`);
  const known = detectCompetitors(answer, registry).filter((h) => !data.includes(h.alias)).map((h) => h.item.name);
  const asked = low(question);
  const deniedOnly = (n) => asked.includes(low(n)) && linesOf(answer).filter((l) => low(l).includes(low(n))).every((l) => NEGATED.test(low(l)));
  const unknown = unknownNames(answer, `${corpus} ${dataText} ${historyText} ${registry.map((r) => (r.names || []).join(" ")).join(" ")}`)
    .filter((n) => !LABEL.test(n.trim()) && !deniedOnly(n));
  return [...new Set([...known, ...unknown])];
}

// «Нет данных» как ноль, отсутствие или худший показатель. missingLabels —
// подписи строк сравнения, где у одной из сторон нет значения.
// «0 МПа», но не «1,0 МПа» и не «10 МПа».
const WORSE = /(хуже|уступа[а-я]*|слабее|проигрыва[а-я]*|не облада[а-я]*|не имеет|равн[а-я]* нулю|нулев[а-я]*|(?<![\d.,])0\s*(мпа|мин|мм|%))/;
export function missingAsWorse(answer, missingLabels = []) {
  const out = [];
  for (const line of linesOf(low(answer))) {
    // Подпись строки — в любом падеже: «прочность на изгиб» / «прочности на изгиб».
    const mentions = (l) => { const ws = low(l).split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 4); return ws.length && ws.every((w) => line.includes(w.slice(0, Math.max(4, w.length - 2)))); };
    if (!missingLabels.some((l) => l && mentions(l))) continue;
    const m = line.match(WORSE);
    // «Нет данных — это не значит, что хуже» — оговорка, не ошибка.
    if (m && !/не значит|не означает|нельзя считать|не следует/.test(line)) out.push(m[0]);
  }
  return [...new Set(out)];
}
