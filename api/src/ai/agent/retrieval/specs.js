// Habez AI Agent (Phase 3.2): что именно спрашивают — правилами, без модели.
//
//   resolveSpecs(q)       термины пользователя → канонические ключи
//                         («прочность сцепления» → adhesion_strength);
//                         голое «прочность» — группа, помеченная как
//                         неоднозначная, а не адгезия;
//   parseConditions(q)    «через 28 суток», «при толщине 1 мм», «на мешок»,
//                         «1:4», «при +20 °C» → условия в словаре модели;
//   matchVariant(q, vs)   «12,5 мм», «мешок 25 кг» → фасовка товара;
//   conditionOfProperty   условие свойства (в т. ч. из ключа …_28d).
import { SPEC_KEYS } from "../../knowledge/spec-dictionary.js";
import { VARIANT_KEYS } from "../../knowledge/evidence-model.js";

const norm = (s) => ` ${String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ")} `;
const L = "(?:^|[^а-яa-z0-9])"; // граница слова для кириллицы

// Точные термины → ключи. Порядок важен только для читаемости: каждый
// термин проверяется независимо, результат — объединение.
const TERMS = [
  { re: /сцеплен|адгези|отрыв/, keys: ["adhesion_strength"], label: "прочность сцепления" },
  { re: /сжат/, keys: ["compressive_strength", "compressive_strength_28d"], label: "прочность на сжатие" },
  { re: /изгиб|растяжен/, keys: ["flexural_strength"], label: "прочность на изгиб" },
  { re: /начал[оа]? схватыв/, keys: ["setting_time_start"], label: "начало схватывания" },
  { re: /(врем|срок)[а-я]* схватыв|схватыва(ется|ние)(?! начал)/, keys: ["setting_time", "setting_time_start"], label: "время схватывания" },
  { re: /жизнеспособ|врем[а-я]* работы/, keys: ["pot_life"], label: "жизнеспособность раствора" },
  { re: /открыт[а-я]* врем/, keys: ["open_time"], label: "открытое время" },
  { re: /корректир/, keys: ["adjust_time"], label: "время корректировки" },
  { re: /высых|сохнет|сушк/, keys: ["drying_time"], label: "время высыхания" },
  { re: /(?:^|[^а-я])(хожден|ходить)/, keys: ["walk_on_time"], label: "время хождения" },
  { re: /набор[а-я]* прочност/, keys: ["strength_gain_initial", "strength_gain_full"], label: "набор прочности" },
  { re: /(расход|сколько|количеств)[а-я]* вод|вод[аыу]? (на|для)|затворен|водно/, keys: ["water_per_bag", "water_ratio", "water_mix_ratio"], label: "расход воды" },
  { re: /расход(?![а-я]* вод)/, keys: ["consumption", "consumption_per_mm", "consumption_per_10mm"], label: "расход" },
  { re: /(?<!при )толщин[а-я]* (сло|нанес)(?![а-я]*\s*\d)|сло[йяе] (до|от)|(?<!при )толщин[а-я]* покрыт/, keys: ["layer_thickness", "layer_thickness_wall", "layer_thickness_floor"], label: "толщина слоя" },
  { re: /(?<!при )толщин(?![а-я]* сло)(?![а-я]*\s*\d)/, keys: ["thickness", "layer_thickness"], label: "толщина" },
  { re: /морозо/, keys: ["frost_resistance"], label: "морозостойкость" },
  { re: /водопоглощ/, keys: ["water_absorption"], label: "водопоглощение" },
  { re: /водостойк|влагостойк/, keys: ["water_resistant", "suitable_indoor_wet"], label: "водостойкость" },
  { re: /срок[а-я]* хранен|хранит/, keys: ["shelf_life", "storage_temperature"], label: "срок хранения" },
  { re: /температур/, keys: ["base_temperature", "service_temperature", "storage_temperature"], label: "температура" },
  { re: /крупност|фракци|заполнител|наполнител/, keys: ["max_aggregate"], label: "крупность заполнителя" },
  { re: /плотност/, keys: ["density", "bulk_density"], label: "плотность" },
  { re: /насыпн/, keys: ["bulk_density"], label: "насыпной вес" },
  { re: /цвет/, keys: ["color"], label: "цвет" },
  { re: /основ[аеуы]? |вяжущ|состав/, keys: ["binder"], label: "основа" },
  { re: /размер[а-я]* плит/, keys: ["max_tile_size", "max_tile_size_wall", "max_tile_size_floor"], label: "размер плитки" },
  { re: /размер[а-я]* лист|формат лист/, keys: ["sheet_size"], label: "размер листа" },
  { re: /площад/, keys: ["sheet_area"], label: "площадь листа" },
  { re: /т[её]пл[а-я]* пол/, keys: ["suitable_warm_floor"], label: "тёплый пол" },
  { re: /фасад|наружн|снаружи|улиц/, keys: ["suitable_facade", "suitable_outdoor"], label: "наружные работы" },
  { re: /(в|для) ванн|влажн/, keys: ["suitable_indoor_wet"], label: "влажные помещения" },
  { re: /(на|по) (поддон|паллет)|листов|мешков|штук на|сколько (шт|лист|меш)/, keys: ["per_pallet"], label: "количество на поддоне" },
  { re: /gtin|штрих/, keys: ["gtin"], label: "штрихкод GTIN" },
  { re: /ntin/, keys: ["ntin"], label: "код NTIN" },
];
// Голое «прочность»: все её виды, и это неоднозначно.
const STRENGTH_GROUP = ["adhesion_strength", "compressive_strength", "compressive_strength_28d", "flexural_strength"];

export const specLabel = (key) => SPEC_KEYS[key]?.label || VARIANT_KEYS[key]?.label || key;
export const VARIANT_SPEC_KEYS = new Set(Object.keys(VARIANT_KEYS));

export function resolveSpecs(question) {
  const q = norm(question);
  const found = [];
  for (const t of TERMS) if (t.re.test(q)) found.push({ label: t.label, keys: t.keys });
  let ambiguous = null;
  const precise = ["прочность сцепления", "прочность на сжатие", "прочность на изгиб", "набор прочности"];
  if (new RegExp(`${L}прочност`).test(q) && !found.some((f) => precise.includes(f.label))) {
    // «прочность» без уточнения: виды прочности — разные показатели.
    found.push({ label: "прочность", keys: STRENGTH_GROUP, ambiguous: true });
    ambiguous = "strength";
  }
  const keys = [...new Set(found.flatMap((f) => f.keys))];
  return { terms: found.map((f) => f.label), keys, ambiguous, groups: found };
}

// Условия из вопроса. Только то, что прямо написано.
export function parseConditions(question) {
  const q = norm(question);
  const out = {};
  const age = q.match(/(?:через|в возрасте|на|спустя)?\s*(\d{1,3})\s*(?:сут|суток|сутки|дн)/);
  if (age) out.age_days = Number(age[1]);
  if (/через (\d+ )?недел/.test(q) && !out.age_days) out.age_days = 7;
  // Слой — только «слой …»/«при … мм»: «толщина 9,5 мм» у листа — это фасовка.
  const layer = q.match(/(?:толщин[а-я]* сло[а-я]*|сло[йеяю])\s*(?:в|до|при)?\s*(\d+(?:[.,]\d+)?)\s*мм/) || q.match(/при\s*(?:толщин[а-я]*\s*)?(\d+(?:[.,]\d+)?)\s*мм/);
  if (layer) out.layer_mm = Number(layer[1].replace(",", "."));
  const temp = q.match(/(?:при|температур[а-я]*)\s*([+-]?\d{1,2})\s*°?\s*c?(?![а-я0-9])/);
  if (temp && /°|градус|температур/.test(q)) out.temperature_c = Number(temp[1]);
  const dil = q.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
  if (dil) out.dilution = `${dil[1]}:${dil[2]}`;
  if (new RegExp(`на\\s*(1\\s*)?(мешок|мешка|упаковк)`).test(q)) out.per = "bag";
  else if (/на\s*(1\s*)?(м²|м2|кв\.?\s*м|квадрат)/.test(q)) out.per = "m2";
  else if (/на\s*(1\s*)?кг/.test(q)) out.per = "kg";
  return out;
}

const sizeTokens = (s) => [...String(s || "").toLowerCase().replace(/,/g, ".").matchAll(/(\d+(?:\.\d+)?)\s*(мм|кг|л|шт)/g)].map((m) => `${Number(m[1])} ${m[2]}`);

// Фасовка из вопроса: совпадение размера («12,5 мм», «25 кг») с названием
// фасовки товара. Несколько фасовок одного размера — не выбираем.
// «9,5 и 12,5 мм»: единица стоит у последнего числа — достаётся и первому.
function askedSizes(question) {
  const q = String(question || "").toLowerCase().replace(/,/g, ".");
  const withUnit = sizeTokens(q);
  const units = [...new Set(withUnit.map((t) => t.split(" ")[1]))];
  if (units.length !== 1) return withUnit;
  const bare = [...q.matchAll(/(\d+(?:\.\d+)?)(?!\s*(?:\d|мм|кг|л|шт|сут|мпа|%|:))/g)].map((m) => `${Number(m[1])} ${units[0]}`);
  return [...new Set([...withUnit, ...bare])];
}

export function matchVariant(question, variants = []) {
  const asked = askedSizes(question);
  if (!asked.length) return null;
  const hits = variants.filter((v) => sizeTokens(v.unit).some((t) => asked.includes(t)));
  return hits.length === 1 ? hits[0] : null;
}
// Размеры фасовок, упомянутые в тексте строки («63 шт (9,5 мм) / 51 шт (12,5 мм)»).
export const variantSizesIn = (text) => sizeTokens(text);

// Условие свойства как объект: из conditionKey («age_days=7;per=bag») и из
// самого ключа (compressive_strength_28d → 28 суток, water_per_bag → на мешок).
export function conditionOfProperty(prop) {
  const out = {};
  for (const part of String(prop.conditionKey || "").split(";").filter(Boolean)) {
    const [k, v] = part.split("=");
    out[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  if (/_28d$/.test(prop.key || "")) out.age_days ??= 28;
  if (/_7d$/.test(prop.key || "")) out.age_days ??= 7;
  if (prop.key === "water_per_bag") out.per ??= "bag";
  if (prop.key === "consumption_per_mm") out.layer_mm ??= 1;
  if (prop.key === "consumption_per_10mm") out.layer_mm ??= 10;
  const text = String(prop.conditionText || prop.label || "").toLowerCase();
  const age = text.match(/(\d{1,3})\s*сут/);
  if (age) out.age_days ??= Number(age[1]);
  const layer = text.match(/(?:толщин[а-я]*|сло[йея])\s*(?:слоя\s*)?(\d+(?:[.,]\d+)?)\s*мм/);
  if (layer) out.layer_mm ??= Number(layer[1].replace(",", "."));
  return out;
}

// Подходит ли свойство под условия вопроса. Спрошено «через 28 суток» —
// значение на 7 суток не подходит; значение без указанного возраста
// подходит, но помечается «возраст не указан» (это делает контекст).
export function matchesConditions(prop, asked = {}) {
  const have = conditionOfProperty(prop);
  for (const [k, v] of Object.entries(asked)) {
    if (have[k] === undefined) continue;
    if (String(have[k]) !== String(v)) return false;
  }
  return true;
}
