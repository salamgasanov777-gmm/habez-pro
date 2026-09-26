// Поиск упомянутых товаров по короткому имени, названию в кавычках и
// адресу страницы. С учётом падежей: «ШОВа», «Стандарта», «КОРОЕДа».
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[«»"“”]/g, " ").replace(/\s+/g, " ").trim();
// Окончания, после которых слово — то же имя: «шова» — это «шов», а
// «гклв» — уже другой товар.
const ENDINGS = ["", "а", "у", "е", "ом", "ой", "ы", "ов", "ам", "ах", "и", "ю", "я", "ем"];
// Короткие имена, которые сами по себе — обычные слова и товар не называют.
const GENERIC = new Set(["80", "цементная", "гидроизоляция", "финиш", "фасад", "интерьер", "пол-р35"]);

const BRAND = new Set(["хабез", "habez"]);
// Заглавные слова, которые называют не товар, а понятие.
const TECH_WORDS = new Set(["gtin", "ntin", "sku", "гост", "ту", "гвл", "гкл", "пгп", "мпа", "ндс", "pdf", "ai", "habez", "хабез"]);

const firstWord = (p) => norm(p.name).split(" ")[0] || "";

function aliases(p, uniqueFirst = new Set()) {
  const out = new Set();
  const short = norm(p.short_name);
  if (short && !GENERIC.has(short)) out.add(short);
  for (const m of String(p.name || "").matchAll(/«([^»]+)»/g)) out.add(norm(m[1]));
  if (p.slug && /^[a-z]{3,}$/.test(p.slug)) out.add(p.slug);
  // Имя заглавными в названии без кавычек: «Штукатурка гипсовая ПОБЕДА 80».
  // Марка завода («ХАБЕЗ», «HABEZ») товар не называет.
  // Окончание срезаем, падежи добавит findSpans: «ПОБЕДУ», «ПОБЕДОЙ».
  for (const m of String(p.name || "").matchAll(/(?:^|\s)([А-ЯЁA-Z]{4,})(?=\s|$)/g)) {
    const w = norm(m[1]);
    if (!BRAND.has(w)) out.add(w.length >= 5 ? w.replace(/[аяоеиы]$/, "") : w);
  }
  // Короткое имя — обычное слово («цементная»): товар называют первым словом
  // названия («стяжка», «стяжки»), если оно в каталоге одно. Окончание
  // срезаем — падежи добавит findSpans.
  if ((!short || GENERIC.has(short)) && uniqueFirst.has(firstWord(p))) out.add(firstWord(p).replace(/[аяоеиы]$/, ""));
  // Короткое имя, которое совпадает с обычным словом, называет товар
  // только вместе с названием: «шпаклёвка ФИНИШ», «краска ФАСАД».
  return [...out].filter((a) => a.length >= 3);
}

function findSpans(text, alias) {
  const spans = [];
  const re = new RegExp(`(^|[^a-zа-я0-9])(${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([a-zа-я]{0,2})(?=$|[^a-zа-я0-9])`, "g");
  let m;
  while ((m = re.exec(text))) {
    if (!ENDINGS.includes(m[3])) continue;
    const start = m.index + m[1].length;
    spans.push([start, start + m[2].length + m[3].length]);
  }
  return spans;
}

// products: [{id, slug, name, short_name}]. Возвращает товары в порядке
// упоминания; более длинное имя «съедает» вложенное короткое
// («КОРОЕД 3,5» не даёт лишнего «КОРОЕД»).
export function detectProducts(question, products) {
  return detectProductHits(question, products).map((h) => h.product);
}

// То же с местом в тексте и именем, по которому найдено: resolver.js
// по ним понимает, какие слова вопроса уже «заняты» товарами.
export function detectProductHits(question, products) {
  const text = norm(question);
  const counts = new Map();
  for (const p of products) counts.set(firstWord(p), (counts.get(firstWord(p)) || 0) + 1);
  const uniqueFirst = new Set([...counts].filter(([w, n]) => n === 1 && w.length >= 5).map(([w]) => w));
  const hits = [];
  const original = String(question || "");
  for (const p of products) {
    for (const a of aliases(p, uniqueFirst)) {
      // Имя-обычное слово («ФАСАД», «ФИНИШ») называет товар только вместе с
      // видом товара («краска ФАСАД») или написанное заглавными.
      if (GENERIC.has(a) && !text.includes(firstWord(p).slice(0, 5)) && !original.includes(a.toUpperCase())) continue;
      for (const s of findSpans(text, a)) hits.push({ p, s, len: a.length });
    }
  }
  hits.sort((x, y) => y.len - x.len || x.s[0] - y.s[0]);
  const taken = [];
  const out = new Map();
  for (const h of hits) {
    if (taken.some(([a, b]) => h.s[0] >= a && h.s[1] <= b && !(h.s[0] === a && h.s[1] === b))) continue;
    taken.push(h.s);
    if (!out.has(h.p.id)) out.set(h.p.id, { product: h.p, at: h.s[0], span: h.s, alias: text.slice(h.s[0], h.s[1]) });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}
export { aliases as productAliases, norm as normalizeText, ENDINGS, BRAND, GENERIC };

// Названия товаров в вопросе, которых нет в каталоге: «ГИПСОМАКС-900»,
// «Суперфиниш». Кандидат — текст в кавычках, слово заглавными (от 4 букв)
// или слово с цифрами через дефис. Неизвестен — если его нет нигде в
// каталоге: ни в названиях, ни в описаниях. Вопрос, набранный целиком
// заглавными, не разбирается: там заглавные ничего не значат.
export function unknownNames(question, corpus) {
  const q = String(question || "");
  const letters = q.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  const upper = letters.replace(/[^A-ZА-ЯЁ]/g, "");
  const shouting = letters.length > 12 && upper.length / letters.length > 0.6;
  const found = new Set();
  // В кавычках — только то, что похоже на имя (с заглавной или цифры):
  // «тёплый пол» в кавычках — задача, а не товар.
  for (const m of q.matchAll(/[«"“]([^»"”]{2,60})[»"”]/g)) if (/^[A-ZА-ЯЁ0-9]/.test(m[1].trim())) found.add(m[1].trim());
  if (!shouting) {
    for (const m of q.matchAll(/(?:^|[^A-Za-zА-Яа-яЁё0-9-])([A-ZА-ЯЁ][A-ZА-ЯЁ0-9]{3,}(?:[-‑][A-ZА-ЯЁa-zа-яё0-9]+)*)(?=$|[^A-Za-zА-Яа-яЁё0-9-])/g)) found.add(m[1]);
  }
  for (const m of q.matchAll(/(?:^|[^A-Za-zА-Яа-яЁё0-9-])([A-Za-zА-Яа-яЁё]{3,}[-‑][0-9]{2,}[A-Za-zА-Яа-яЁё0-9]*)(?=$|[^A-Za-zА-Яа-яЁё0-9-])/g)) found.add(m[1]);
  const hay = norm(corpus).replace(/‑/g, "-");
  return [...found].filter((name) => !TECH_WORDS.has(norm(name))).filter((name) => {
    const n = norm(name).replace(/‑/g, "-");
    // «ШОВа», «КОРОЕДа»: имя с падежным окончанием — тоже известное.
    const stems = [n, n.replace(/(а|у|е|ом|ой|ы|ов|и|ю|я|ем)$/, "")].filter((s) => s.length >= 3);
    return !stems.some((s) => hay.includes(s));
  });
}
