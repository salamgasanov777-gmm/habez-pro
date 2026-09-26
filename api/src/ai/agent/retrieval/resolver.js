// Habez AI Agent (Phase 3.2): какие товары названы в вопросе. Правилами,
// без модели, с понятным порядком (ranking):
//
//   100  точное имя / короткое имя / имя в кавычках    «ШОВ», «ГКЛО»
//    90  то же с падежным окончанием                   «ШОВа», «стандарта»
//    70  опечатка в имени (Дамерау — Левенштейн ≤ 1–2) «стандрат»
//    50  слова названия («гипсокартонный лист огнестойкий»)
//    40  предметное слово («гипсокартон», «пазогребневая плита») →
//        один товар — он, несколько — группа для уточнения
//
// Товар, которого нет в каталоге, не «находится» ничем из этого, и модель
// о нём не спрашивают (unknownNames в entities.js).
import { detectProductHits, normalizeText, unknownNames, GENERIC } from "./entities.js";

const BRAND = new Set(["хабез", "habez"]);
// Слова, которые есть в названиях, но товар сами не называют.
const STOP = new Set(["для", "и", "на", "в", "с", "по", "из", "мм", "лист", "листы", "смесь", "сухая", "гипсовая", "гипсовый", "цементная",
  "штукатурка", "шпаклевка", "клей", "плита", "грунтовка", "краска", "профиль", "наливной", "пол", "тонкослойная", "декоративная", "полнотелая",
  "пустотелая", "какой", "какая", "какие", "есть", "расскажи", "про", "что", "такое", "сравни", "чем", "отличаются", "у", "а", "его", "него"]);
// Предметные слова → общая основа в названиях товаров.
const DOMAIN = [
  { re: /гипсокартон|гкл(?![а-я])/, stem: "гипсокартонн" },
  { re: /пазогреб|пгп(?![а-я])/, stem: "пазогребнев" },
  { re: /профил/, stem: "профил" },
  { re: /грунтовк/, stem: "грунт" },
];
// «огнестойкий» — не «влагоогнестойкий»: отсюда просмотр назад.
const REFINE = [/влагоогнестойк/, /(?<!влаго)огнестойк/, /влагостойк/, /пустотел/, /полнотел/, /финиш/, /фасад/, /интерьер/, /150/];

// Дамерау — Левенштейн (перестановка соседних букв — одна ошибка).
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
const stripEnding = (w) => w.replace(/(ами|ями|ого|ему|ому|ыми|ими|ой|ей|ом|ем|ам|ям|ах|ях|ов|ев|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|а|я|у|ю|е|ы|и|о)$/, "");
const tokensOf = (s) => normalizeText(s).split(/[^a-zа-я0-9]+/).filter(Boolean);
const shortAliases = (p) => [normalizeText(p.short_name), ...[...String(p.name || "").matchAll(/«([^»]+)»/g)].map((m) => normalizeText(m[1]))]
  .filter((a) => a && a.length >= 5 && !/\s/.test(a) && !GENERIC.has(a));

export function resolveProducts(question, catalog) {
  const text = normalizeText(question);
  const matches = new Map(); // id → { product, score, via }
  const take = (product, score, via) => {
    const cur = matches.get(product.id);
    if (!cur || cur.score < score) matches.set(product.id, { product, score, via });
  };
  const covered = [];
  // 100 / 90: имена и падежи (entities.js).
  for (const h of detectProductHits(question, catalog)) {
    const exact = [normalizeText(h.product.short_name), normalizeText(h.product.name)].includes(h.alias)
      || [...String(h.product.name || "").matchAll(/«([^»]+)»/g)].some((m) => normalizeText(m[1]) === h.alias);
    take(h.product, exact ? 100 : 90, exact ? "exact" : "alias");
    covered.push(h.span);
  }
  const inCovered = (i) => covered.some(([a, b]) => i >= a && i < b);
  const words = [];
  for (const m of text.matchAll(/[a-zа-я0-9-]+/g)) if (!inCovered(m.index)) words.push(m[0]);

  // 70: опечатки в имени (слово от 5 букв, имя от 5 букв).
  for (const w of words) {
    if (w.length < 5 || STOP.has(w)) continue;
    for (const p of catalog) {
      for (const a of shortAliases(p)) {
        const lim = a.length >= 8 ? 2 : 1;
        if (editDistance(w, a) <= lim || editDistance(stripEnding(w), a) <= lim) take(p, 70, "typo");
      }
    }
  }

  // 50 / 40: слова названия и предметные слова.
  const ambiguous = [];
  const qStems = new Set(words.filter((w) => !STOP.has(w) && !BRAND.has(w) && w.length >= 3).map((w) => stripEnding(w).slice(0, 7)));
  const domain = DOMAIN.filter((d) => d.re.test(text));
  if (!matches.size && (qStems.size || domain.length)) {
    const scored = catalog.map((p) => {
      const nameStems = new Set(tokensOf(p.name).filter((t) => !STOP.has(t) && !BRAND.has(t) && t.length >= 3).map((t) => stripEnding(t).slice(0, 7)));
      const hit = [...qStems].filter((s) => [...nameStems].some((n) => n.startsWith(s) || s.startsWith(n))).length;
      const dom = domain.some((d) => normalizeText(p.name).includes(d.stem)) ? 1 : 0;
      return { p, hit, dom };
    }).filter((x) => x.hit > 0 || x.dom);
    for (const d of domain) {
      let group = scored.filter((x) => normalizeText(x.p.name).includes(d.stem));
      // «огнестойкий гипсокартон» — уточняющее слово сужает группу.
      for (const r of REFINE) {
        if (!r.test(text)) continue;
        const narrowed = group.filter((x) => r.test(normalizeText(x.p.name)));
        if (narrowed.length) group = narrowed;
      }
      if (group.length === 1) take(group[0].p, 40, "domain");
      else if (group.length > 1) ambiguous.push({ term: d.stem, candidates: group.map((x) => x.p) });
    }
    if (!domain.length) {
      const best = Math.max(0, ...scored.map((x) => x.hit));
      const top = scored.filter((x) => x.hit === best && best >= 2);
      if (top.length === 1) take(top[0].p, 50, "name_tokens");
    }
  }

  const list = [...matches.values()];
  // Порядок упоминания важен для сравнения («ШОВ и Стандарт»): сортируем по
  // месту в тексте среди найденных по имени.
  const byPos = (x) => { const h = detectProductHits(question, [x.product])[0]; return h ? h.at : 1e9; };
  list.sort((a, b) => byPos(a) - byPos(b) || b.score - a.score);
  const corpus = catalog.map((p) => `${p.name} ${p.short_name || ""} ${p.slug} ${p.summary || ""} ${p.sections || ""} ${p.spec_tables || ""}`).join(" ");
  return {
    products: list.map((x) => ({ ...x.product, score: x.score, via: x.via })),
    ambiguous: list.length ? [] : ambiguous,
    unknown: unknownNames(question, corpus),
  };
}
