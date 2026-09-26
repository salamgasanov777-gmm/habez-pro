// Habez AI 3.5: какие компании, марки и товары конкурентов названы в
// вопросе. Правила — как у поиска наших товаров (retrieval/resolver.js):
//   100  точное имя, короткое имя, имя в кавычках       «Т-Шов», ТестСмесь
//    90  то же с падежным окончанием                    «ТестСмеси», «Т-Шова»
//    70  опечатка (Дамерау — Левенштейн ≤ 1, для имён от 9 букв ≤ 2), только
//        для «сильных» имён от 5 букв из одного слова без дефиса и цифр
// «Слабое» имя — одно слово, которое встречается в нашем каталоге как обычное
// слово («Старт», «Финиш»): оно называет конкурента, только если написано с
// заглавной буквы или в кавычках. Уверенного совпадения нет — не угадываем.
import { normalizeText, ENDINGS } from "../retrieval/entities.js";
import { editDistance } from "../retrieval/resolver.js";

// Формы собственности и кавычки в имени компании не различают.
const LEGAL = /(^|\s)(ооо|оао|зао|пао|ао|ип|llc|ltd)(?=\s|$)/g;
const clean = (s) => normalizeText(s).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stem = (a) => (a.length >= 5 && /[аяьйоеиы]$/.test(a) ? a.slice(0, -1) : null);

function aliasesOf(item) {
  const out = new Set();
  for (const n of item.names || []) {
    const c = clean(n);
    if (c.length >= 3) out.add(c);
    for (const m of String(n).matchAll(/[«"“]([^»"”]+)[»"”]/g)) { const q = clean(m[1]); if (q.length >= 3) out.add(q); }
  }
  return [...out];
}

// Слова каталога Habez: имя из одного такого слова — «слабое».
export function catalogWords(catalog = []) {
  const words = new Set();
  for (const p of catalog) for (const w of normalizeText(`${p.name} ${p.short_name || ""} ${p.summary || ""} ${p.category || ""}`).split(/[^a-zа-я0-9-]+/)) if (w.length >= 3) words.add(w);
  return words;
}

const CASE = ["а", "и", "ы", "у", "е", "ой", "ей", "ю", "ом", "ем"];
function spans(text, alias) {
  const out = [];
  // Формы: имя с окончанием; имя без последней гласной + падежное окончание
  // («ТестСмеси»); у имени с дефисом склоняется первая часть («Марки-U»).
  const forms = [[escape(alias), ENDINGS, true]];
  const st = stem(alias);
  if (st) forms.push([escape(st), CASE, false]);
  const dash = alias.match(/^([a-zа-я]{4,})-(.+)$/);
  if (dash && /[аяоеиы]$/.test(dash[1])) forms.push([`${escape(dash[1].slice(0, -1))}(?:${CASE.join("|")})-${escape(dash[2])}`, ENDINGS, false]);
  for (const [src, endings, base] of forms) {
    const re = new RegExp(`(^|[^a-zа-я0-9])(${src})([a-zа-я]{0,2})(?=$|[^a-zа-я0-9])`, "g");
    let m;
    while ((m = re.exec(text))) {
      if (!endings.includes(m[3])) continue;
      const start = m.index + m[1].length;
      out.push({ at: start, end: start + m[2].length + m[3].length, exact: base && m[2] === alias && m[3] === "" });
    }
  }
  return out;
}

// Написано ли имя «как имя» в исходном вопросе: с заглавной, заглавными или
// в кавычках (для слабых имён).
function writtenAsName(original, alias) {
  const re = new RegExp(`(^|[^А-Яа-яЁёA-Za-z0-9-])([«"“]\\s*)?(${escape(alias)})`, "giu");
  for (const m of original.replace(/ё/g, "е").replace(/Ё/g, "Е").matchAll(re)) if (m[2] || /^[A-ZА-ЯЁ]/.test(m[3])) return true;
  return false;
}

export function detectCompetitors(question, registry = [], { weakWords = new Set() } = {}) {
  if (!registry.length) return [];
  const original = String(question || "");
  const text = normalizeText(original);
  const hits = [];
  for (const item of registry) {
    for (const a of aliasesOf(item)) {
      const weak = !/[\s\d-]/.test(a) && weakWords.has(a);
      for (const s of spans(text, a)) {
        if (weak && !writtenAsName(original, a)) continue;
        hits.push({ item, alias: a, at: s.at, end: s.end, score: s.exact ? 100 : 90, via: s.exact ? "exact" : "alias" });
      }
    }
  }
  // Опечатки: только сильные имена из одного слова от 5 букв.
  const taken = (i) => hits.some((h) => i >= h.at && i < h.end);
  for (const m of text.matchAll(/[a-zа-я0-9-]{5,}/g)) {
    if (taken(m.index)) continue;
    for (const item of registry) {
      for (const a of aliasesOf(item)) {
        // Имена с дефисом или цифрами («Т-Шов», «Ч-Шов») различаются как раз
        // одной буквой — опечатку для них не ищем.
        if (/[\s\d-]/.test(a) || a.length < 5 || weakWords.has(a)) continue;
        const lim = a.length >= 9 ? 2 : 1;
        if (m[0] !== a && editDistance(m[0], a) <= lim) hits.push({ item, alias: a, at: m.index, end: m.index + m[0].length, score: 70, via: "typo" });
      }
    }
  }
  // Длинное имя «съедает» вложенное короткое; одно место — одно имя.
  hits.sort((x, y) => (y.end - y.at) - (x.end - x.at) || y.score - x.score || x.at - y.at);
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => h.at < k.end && h.end > k.at && !(h.item.type === k.item.type && h.item.id === k.item.id))) continue;
    if (kept.some((k) => k.item.type === h.item.type && k.item.id === h.item.id)) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.at - b.at);
}
