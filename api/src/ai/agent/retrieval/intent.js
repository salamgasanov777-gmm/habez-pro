// Намерение вопроса и нужные характеристики — правилами, без модели: это
// дёшево, предсказуемо и проверяется тестами.
const norm = (s) => ` ${String(s || "").toLowerCase().replace(/ё/g, "е")} `;
// В JS \b не видит границ русских слов — вместо него «не буква» явно.
const B = "(?:^|[^а-яa-z0-9])";

export const INTENTS = ["compare", "packaging", "spec", "recommend", "overview", "search"];

export function detectIntent(question) {
  const q = norm(question);
  if (new RegExp(`${B}(сравн|vs${B}|разниц|отлича|чем .* лучше)`).test(q) || new RegExp(`${B}или${B}.*\\?`).test(q)) return "compare";
  if (new RegExp(`фасовк|упаковк|мешк|ведр|канистр|поддон|паллет|${B}лист(ов|ы|а)?${B}|штрихкод|sku`).test(q)) return "packaging";
  if (/прочн|расход|сколько|время|схватыв|высыхан|жизнеспособ|вод[аыу]|температур|морозо|адгези|сцеплен|характеристик|плотност|крупност|толщин|марк[аи]/.test(q)) return "spec";
  if (/подход|подобрат|посовет|какие .*(для|чтобы)|чем .*(заделать|выровнять|клеить|зашпаклевать)|для чего|что взять/.test(q)) return "recommend";
  if (new RegExp(`расскажи|что такое|что за|опиши|информац|${B}про${B}`).test(q)) return "overview";
  return "search";
}

// Ключи словаря, о которых спрашивают. Пусто — нужны все.
// Сначала точные («прочность сцепления» — только адгезия), общее «прочность»
// — только если точного нет.
const STRENGTH_HINTS = [
  [/адгези|сцеплен|отрыв/, (k) => /adhesion/.test(k)],
  [/сжат/, (k) => /compressive/.test(k)],
  [/изгиб/, (k) => /flexural/.test(k)],
];
const SPEC_HINTS = [
  [/прочн/, (k) => /strength|adhesion/.test(k)],
  [/расход/, (k) => /consumption|water/.test(k)],
  [/вод[аыуе]/, (k) => /water/.test(k)],
  [/схватыв/, (k) => /setting/.test(k)],
  [/высыхан|сохнет|сушк/, (k) => /drying/.test(k)],
  [/жизнеспособ|время работы|открытое время/, (k) => /pot_life|open_time|adjust_time/.test(k)],
  [/температур/, (k) => /temperature/.test(k)],
  [/морозо/, (k) => /frost/.test(k)],
  [/толщин|сло[йя]/, (k) => /thickness|layer/.test(k)],
  [/срок|хранен/, (k) => /shelf_life|storage/.test(k)],
];

export function specFilter(question) {
  const q = norm(question);
  const exact = STRENGTH_HINTS.filter(([re]) => re.test(q)).map(([, f]) => f);
  const preds = [...exact, ...SPEC_HINTS.filter(([re]) => re.test(q) && !(exact.length && String(re) === "/прочн/")).map(([, f]) => f)];
  return preds.length ? (key) => preds.some((f) => f(key)) : null;
}

// Слова для поиска по каталогу: без служебных, с синонимами.
const STOP = new Set(["какие", "какой", "какая", "какое", "есть", "для", "это", "что", "как", "про", "расскажи", "habez", "хабез",
  "подходят", "подходит", "подойдет", "смеси", "сухие", "смесь", "товар", "товары", "можно", "нужно", "мне", "ваши", "у", "вас", "и", "или", "в", "на", "с", "по"]);
const SYNONYMS = {
  швов: ["шов", "стык", "швов", "шва"], швы: ["шов", "стык", "швов"], шов: ["шов", "стык"], стыков: ["стык"],
  гкл: ["гкл", "гипсокартон"], гипсокартона: ["гкл", "гипсокартон"], плитки: ["плит"], плитку: ["плит"],
  заделки: ["задел"], заделать: ["задел"], выравнивания: ["выравн"], пола: ["пол"], фасада: ["фасад"], ванной: ["влаж"],
};

export function searchTerms(question) {
  const words = norm(question).replace(/[^a-zа-я0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
  const out = new Set();
  for (const w of words) {
    // Окончание срезаем осторожно: «погода» → «погод», а не «пого» (иначе
    // совпадёт с «погодных условиях» в любом описании).
    for (const s of SYNONYMS[w] || [w.length >= 8 ? w.slice(0, -2) : w.length >= 6 ? w.slice(0, -1) : w]) out.add(s);
  }
  return [...out];
}
