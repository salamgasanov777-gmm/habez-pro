// Habez AI (Phase 4.2): разбор ответа и данных для проверок — один раз.
//
// Числа с единицами («0,5 МПа», «5–7 л»), числа без единицы, ссылки [E#] по
// строкам. Правила перенесены из runtime/context.js (Phase 3.1–3.5) без
// изменений: проверки читают готовый разбор, а не разбирают текст сами.
// Защита от зависания на длинной цепочке цифр или пробелов без единицы
// (было: 2000 цифр — 10 с, 4000 — 80 с, сервер стоит):
//   (?!\d), (?!\s) — целая часть первого числа и пробелы берутся целиком, без
//     перебора: укороченная цепочка могла бы продолжиться только тем, что
//     принимает и полная, — совпадения те же;
//   \d{1,15} — в числе не больше 15 цифр подряд, иначе каждая позиция внутри
//     цепочки просматривает её до конца. Совпадения те же для любых чисел
//     до 15 цифр (штрихкод — 13).
export const NUM_UNIT = /(\d{1,15}(?!\d)(?:[.,]\d{1,15})?)\s*(?!\s)(?:–|-|—|…|\.\.\.)?\s*(?!\s)(\d{1,15}(?:[.,]\d{1,15})?)?\s*(?!\s)(мпа|мм|см|кг\/м³|кг\/м3|кг\/м²|кг\/м2|г\/м²|г\/м2|мл\/м²|мл\/м2|л\/кг|кг|г|мл|л(?:итр(?:а|ов)?)?|мин(?:ут[аы]?)?|ч(?:ас(?:а|ов)?)?|сут(?:ок|ки)?|месяц(?:а|ев)?|мес|м²|м2|м|%|шт|циклов|°c|°)(?![а-яa-z])/giu;
const NUM = /\d+(?:[.,]\d+)?/g;
export const canon = (s) => String(s).replace(",", ".").replace(/\.0+$/, "");
const FAMILY = [
  [/^мпа$/, "mpa"], [/^мм$/, "mm"], [/^см$/, "cm"], [/^м[²2]$/, "m2"], [/^м$/, "m"],
  [/^кг\/м[³3]$/, "kg_m3"], [/^кг\/м[²2]$/, "kg_m2"], [/^г\/м[²2]$/, "g_m2"], [/^мл\/м[²2]$/, "ml_m2"], [/^л\/кг$/, "l_kg"],
  [/^кг$/, "kg"], [/^г$/, "g"], [/^мл$/, "ml"], [/^л/, "l"], [/^мин/, "min"], [/^ч/, "h"], [/^сут/, "day"], [/^мес/, "month"],
  [/^%$/, "pct"], [/^шт$/, "pcs"], [/^циклов$/, "cycles"], [/^°/, "deg"],
];
export const family = (u) => (FAMILY.find(([re]) => re.test(String(u).toLowerCase())) || [null, String(u).toLowerCase()])[1];
// Числа одного совпадения NUM_UNIT: «5–7 л» — два числа.
export const numbersOf = (m) => [m[1], m[2]].filter(Boolean).map(canon);

// Номера ссылок [E4] — не числа ни в ответе, ни в данных, ни в вопросе и
// истории (F17, Phase 4.2): заменяются пробелами той же длины — места чисел
// в строке не сдвигаются.
export const withoutRefs = (s) => String(s ?? "").replace(/\[E\d+\]/g, (m) => " ".repeat(m.length));

// Пары «число|единица» и числа без единицы в тексте.
export function facts(text) {
  const s = withoutRefs(text);
  const pairs = new Set();
  const withUnit = new Set();
  for (const m of s.matchAll(NUM_UNIT)) {
    for (const n of numbersOf(m)) { pairs.add(`${n}|${family(m[3])}`); withUnit.add(n); }
  }
  const all = new Set((s.match(NUM) || []).map(canon));
  const bare = new Set([...all].filter((n) => !withUnit.has(n)));
  return { pairs, bare, all };
}
export const supports = (f, n, fam) => f.pairs.has(`${n}|${fam}`) || f.bare.has(n);

// Текст записи [E#] для сверки чисел. where — часть записи (фасовки товара
// конкурента, различия аналога); basis — основа цены («за мешок 25 кг»).
export const evidenceText = (e) => `${e.value ?? ""} ${e.label ?? ""} ${e.perPallet ? `${e.perPallet} шт` : ""} ${e.variant ?? ""} ${e.productName ?? ""} ${e.condition ?? ""} ${e.property ?? ""} ${e.line ?? ""} ${e.where ?? ""} ${e.basis ?? ""}`;

// Ответ, разобранный один раз: строки, ссылки по строкам, числа с единицами.
export function parseAnswer(answer) {
  const text = String(answer || "");
  const lines = text.split(/\n+/).map((line) => ({
    text: line,
    refs: [...line.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]),
    numbers: [...withoutRefs(line).matchAll(NUM_UNIT)].map((m) => ({ claim: m[0].trim(), index: m.index, values: numbersOf(m), fam: family(m[3]), single: !m[2], first: canon(m[1]) })),
  }));
  return {
    text, lower: text.toLowerCase(), lines,
    // Числа по всему тексту (перенос строки внутри «5\nМПа» — тоже число).
    whole: [...withoutRefs(text).matchAll(NUM_UNIT)].map((m) => ({ claim: m[0].trim(), values: numbersOf(m), fam: family(m[3]) })),
    cited: [...new Set([...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))],
  };
}

// Одноэлементный кеш: проверки доменов делят ответ на фразы по-своему —
// одинаковое деление одного ответа считается один раз.
export function lastValue(fn) {
  let has = false;
  let key;
  let value;
  return (s) => {
    if (!has || s !== key) { has = true; key = s; value = fn(s); }
    return value;
  };
}
