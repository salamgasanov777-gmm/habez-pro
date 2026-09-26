// Habez AI Phase 3.3: производный слой над данными товара — без новых
// таблиц, всё считается из карточки и наблюдений (get_product,
// get_product_specs).
//
//   buildProfile        паспорт товара: назначение, основные свойства,
//                       условия, применимость (ДА / НЕТ), фасовки, коды,
//                       известные расхождения, пробелы, источники;
//   extractApplication  как применять: подготовка, приготовление, вода,
//                       нанесение, слой, высыхание, условия, расход,
//                       хранение, безопасность — раздельно «указано в
//                       разделе карточки» и «структурированное значение»,
//                       и чего нет;
//   compatibility       совместимость: только то, что прямо написано
//                       (раздел карточки называет другой товар; основание
//                       ДА / НЕТ). Иначе — UNKNOWN, не «совместимо».
import { detectProducts } from "../retrieval/entities.js";
import { parseSpecValue } from "../../knowledge/units.js";

const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const boolOf = (d) => parseSpecValue(String(d ?? "")).valueBool;
const visible = (p) => p.values.filter((v) => !v.hidden);
const disputed = (p) => ["conflict", "unresolved"].includes(p.status) || p.hiddenDisagreement;

// Основные свойства — в этом порядке; остальное — по запросу.
const KEY_SPECS = ["adhesion_strength", "compressive_strength", "compressive_strength_28d", "flexural_strength", "setting_time", "setting_time_start",
  "pot_life", "open_time", "water_per_bag", "water_ratio", "water_mix_ratio", "layer_thickness", "layer_thickness_wall", "layer_thickness_floor",
  "consumption", "consumption_per_mm", "consumption_per_10mm", "max_aggregate", "frost_resistance", "drying_time", "walk_on_time",
  "thickness", "sheet_size", "sheet_area", "color", "binder", "shelf_life"];
const APPLICABILITY = /^(base_|suitable_|coating_|floor_|water_resistant)/;
const CONDITION_KEYS = ["base_temperature", "service_temperature", "storage_temperature"];
// Чего ждать от товара этого вида: отсутствие — «пробел», а не «нет».
const EXPECTED = [
  [/шпакл|штукатур|монтаж|клеи|клей|пол/i, ["adhesion_strength", "layer_thickness", "base_temperature", "shelf_life"]],
  [/грунт|краск/i, ["consumption", "drying_time", "shelf_life"]],
  [/гипсокартон|пазогреб/i, ["thickness", "sheet_size"]],
];

export function buildProfile(p, sp, { catalog = [] } = {}) {
  const props = sp?.properties || [];
  const keyed = (k) => props.filter((x) => x.key === k);
  const keySpecs = KEY_SPECS.flatMap(keyed).slice(0, 14);
  const flags = props.filter((x) => x.key && APPLICABILITY.test(x.key) && visible(x).length === 1 && boolOf(visible(x)[0].display) !== null);
  const yes = flags.filter((x) => boolOf(visible(x)[0].display) === true);
  const no = flags.filter((x) => boolOf(visible(x)[0].display) === false);
  const conditions = [...CONDITION_KEYS.flatMap(keyed), ...props.filter((x) => x.conditionKey && !keySpecs.includes(x))].slice(0, 8);
  const identifiers = props.filter((x) => ["gtin", "ntin"].includes(x.key) || /gtin|ntin|штрих|артикул/i.test(x.label));
  const conflicts = props.filter(disputed);
  const expected = (EXPECTED.find(([re]) => re.test(p.category || "")) || [null, []])[1];
  const gaps = expected.filter((k) => !keyed(k).length).map((k) => k);
  const sources = [...new Set(props.flatMap((x) => x.values.flatMap((v) => (v.evidence || []).map((e) => e.sourceType || e.kind))).filter(Boolean))];
  const purposeSections = (p.sections || []).filter((s) => /област|назнач|описан|применени/i.test(s.title));
  return {
    purpose: { summary: !!p.summary, sections: purposeSections.map((s) => s.title) },
    keySpecs, applicability: { yes, no }, conditions, variants: p.variants || [], identifiers, conflicts, gaps, sources,
    compatibility: compatibility(p, sp, catalog),
    // Свойства для контекста модели: не все 50, а те, что входят в паспорт.
    properties: [...new Set([...keySpecs, ...yes, ...no, ...conditions, ...identifiers, ...conflicts])],
  };
}

// Инструкция по применению из разделов карточки и структурированных значений.
const STEP_KINDS = [
  { kind: "preparation", label: "подготовка основания", title: /подготовк/, sentence: /основани[ея][^.]{0,80}(очист|сух|прочн|грунт)/ },
  { kind: "mixing", label: "приготовление раствора", title: /приготовл/, sentence: /(смеш|перемеш|затвор|засып|высып|развод|разбав)/ },
  { kind: "water", label: "вода", keys: ["water_per_bag", "water_ratio", "water_mix_ratio"], sentence: /вод[аыуе]/ },
  { kind: "application", label: "нанесение", title: /нанесен|порядок|применени/, sentence: /(нанос|наносит|нанесени|распредел|укладыва|шпател|валик|кист)/ },
  { kind: "layer", label: "толщина слоя", keys: ["layer_thickness", "layer_thickness_wall", "layer_thickness_floor"], sentence: /(толщин|сло[йяе])/ },
  { kind: "time", label: "время работы и высыхания", keys: ["pot_life", "open_time", "adjust_time", "setting_time", "setting_time_start", "drying_time", "walk_on_time"], sentence: /(высых|сохн|схватыв|жизнеспособ|в течение \d)/ },
  { kind: "conditions", label: "условия работы", keys: ["base_temperature"], sentence: /температур/ },
  { kind: "consumption", label: "расход", keys: ["consumption", "consumption_per_mm", "consumption_per_10mm"], sentence: /расход/ },
  { kind: "storage", label: "хранение", title: /хранен|транспорт/, keys: ["shelf_life", "storage_temperature"] },
  { kind: "safety", label: "меры безопасности", title: /безопасн|предосторож/ },
];
const sentences = (text) => String(text || "").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

// Разделы карточки, где словами сказано о спрошенном (вода, слой, время…):
// для вопроса о применении это тоже ответ, даже без числа.
export function applicationSections(p, keys = []) {
  const kinds = STEP_KINDS.filter((k) => (k.keys || []).some((key) => keys.includes(key)) && k.sentence);
  return (p.sections || []).filter((s) => sentences(s.text).some((sn) => kinds.some((k) => k.sentence.test(low(sn))))).map((s) => s.title);
}

export function extractApplication(p, sp) {
  const props = sp?.properties || [];
  const secs = p.sections || [];
  const items = [];
  const missing = [];
  for (const k of STEP_KINDS) {
    const structured = (k.keys || []).flatMap((key) => props.filter((x) => x.key === key));
    const text = [];
    for (const s of secs) {
      if (k.title && k.title.test(low(s.title))) { text.push({ section: s.title, text: String(s.text).slice(0, 500), whole: true }); continue; }
      if (k.sentence) for (const sn of sentences(s.text)) if (k.sentence.test(low(sn))) text.push({ section: s.title, text: sn.slice(0, 260) });
    }
    if (!structured.length && !text.length) { missing.push(k.label); continue; }
    items.push({ kind: k.kind, label: k.label, structured, text: text.slice(0, 3) });
  }
  return { items, missing };
}

// Совместимость: только прямые указания.
// Материалы-основания (лист, плита) — не «совместимый товар», а основание:
// о них говорят ключи base_*.
const SUBSTRATE = /гипсокартон|пазогреб|профил/i;
export function compatibility(p, sp, catalog = []) {
  const relations = [];
  for (const s of p.sections || []) {
    for (const sn of sentences(s.text)) {
      // Поиск по всему каталогу (иначе «первое слово названия» меняет смысл),
      // сам товар и материалы-основания — после.
      for (const hit of detectProducts(sn, catalog).filter((c) => c.id !== p.id && !SUBSTRATE.test(c.category || ""))) {
        if (!relations.some((r) => r.to === hit.slug && r.section === s.title)) relations.push({ type: "stated_with", to: hit.slug, toName: hit.short_name || hit.name, section: s.title, text: sn.slice(0, 240) });
      }
    }
  }
  const substrates = (sp?.properties || []).filter((x) => x.key && /^base_/.test(x.key) && visible(x).length === 1)
    .map((x) => ({ type: "substrate", label: x.label, status: boolOf(visible(x)[0].display) === true ? "SUITABLE" : boolOf(visible(x)[0].display) === false ? "NOT_SUITABLE" : "UNKNOWN", prop: x }));
  return { relations, substrates };
}

// Совместимость двух товаров: прямое упоминание в карточке одного из них.
export function compatibilityBetween(a, b, catalog) {
  const ab = compatibility(a, null, catalog).relations.filter((r) => r.to === b.slug);
  const ba = compatibility(b, null, catalog).relations.filter((r) => r.to === a.slug);
  return { status: ab.length || ba.length ? "STATED" : "UNKNOWN", relations: [...ab.map((r) => ({ ...r, from: a.slug })), ...ba.map((r) => ({ ...r, from: b.slug }))] };
}
