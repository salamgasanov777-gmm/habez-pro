// Habez AI, Phase 2.2B: словари модели наблюдений. Без обращений к базе —
// только смысл данных, чтобы правила лежали в одном месте и проверялись
// тестами. Подробно — docs/HABEZ-AI-EVIDENCE-MODEL.md.
import { createHash } from "node:crypto";
import { SPEC_KEYS } from "./spec-dictionary.js";

// Вид доказательства. Порядок здесь — просто список, НЕ приоритет: какой
// вид весомее, решает владелец (таблица ai_source_type_priorities).
export const EVIDENCE_SOURCE_TYPES = [
  "product_card",          // карточка товара (Habez Pro или приложение №1)
  "factory_technologist",  // письмо или ответ главного технолога завода
  "technical_document",    // ТУ, техническое описание
  "quality_passport",      // паспорт качества партии
  "label",                 // заводская этикетка
  "marking_card",          // маркировочная карточка (GTIN, NTIN)
  "factory_catalog",       // страница заводского каталога
  "factory_site",          // сайт завода (habez-gips.ru) — публикация, не документ
  "price_list",            // прайс завода
  "measurement",           // собственный замер
  "manual_entry",          // внесено вручную в панели без указания документа (перенос старых ручных записей)
  "public_source",         // сайт, публикация третьей стороны
  "generated_default",     // значение, подставленное программой (seed.js)
  "ai_inference",          // вывод модели
  "unknown_legacy_origin", // старая запись, происхождение которой не доказано
];

// Эти виды никогда не становятся подтверждённым значением: это не
// сведения, а догадка программы или модели. Подтверждённое значение
// заводится отдельным наблюдением с настоящим источником.
// unknown_legacy_origin — туда же: подтверждать нечего, пока не найден
// документ; найденный документ заводится новым наблюдением.
export const NEVER_VERIFIED_SOURCE_TYPES = ["generated_default", "ai_inference", "unknown_legacy_origin"];

// Что утверждает источник.
export const STATEMENT_TYPES = [
  "declared",     // заявлено производителем («не менее 0,5 МПа»)
  "measured",     // фактический замер («фактически 50 %»)
  "norm",         // нормативное значение («норма по ГОСТ — 550 Н»)
  "instruction",  // технологическое условие («5–7 л воды на мешок»)
  "replacement",  // источник сам пишет, что значение идёт «вместо» прежнего
  "unknown",      // из текста не следует ни одно из перечисленного
];

// Замер и норма не спорят с заявленным значением: «50–57 %» и «фактически
// 50 %» — два разных утверждения. Поэтому итог считается раздельно.
export const STATEMENT_CLASS = {
  declared: "claimed", replacement: "claimed", unknown: "claimed", instruction: "claimed",
  measured: "measured", norm: "norm",
};

export const ACCESS_LEVELS = ["public", "internal", "confidential"];

// Кто передал сведения — только роль. Имя и почту не храним: репозиторий
// публичный, а для доказательности достаточно роли и даты документа.
export const PROVIDED_BY_ROLES = [
  "factory_technologist", "factory_management", "factory_laboratory",
  "owner", "sales_manager", "dealer", "unknown",
];

export const LIFECYCLE_STATUSES = ["active", "superseded", "withdrawn"];

export const RELATION_TYPES = ["replaces", "conflicts_with", "confirms", "clarifies"];
export const RELATION_BASES = ["explicit_source_statement", "user_decision"];

// Условия значения. Список закрытый: иначе «7 сут», «7 суток» и «неделя»
// станут тремя разными условиями и наблюдения не сгруппируются.
export const CONDITION_KEYS = {
  age_days: { label: "Возраст, сут", type: "number" },
  layer_mm: { label: "Толщина слоя, мм", type: "number" },
  temperature_c: { label: "Температура, °C", type: "number" },
  layers: { label: "Число слоёв", type: "number" },
  per: { label: "На единицу", type: "text" },          // kg | bag | m2 | l
  pack: { label: "Фасовка", type: "text" },            // «мешок 25 кг»
  dilution: { label: "Разбавление", type: "text" },    // «1:9»
  substrate: { label: "Основание", type: "text" },
  note: { label: "Прочее условие", type: "text" },
};

// Ключи уровня фасовки. В ai_product_specs их намеренно нет (они живут в
// variants), но наблюдения о них нужны: «40 на поддоне» из seed.js и
// «63 листа» из карточки — разные по доказательности сведения.
export const VARIANT_KEYS = {
  per_pallet: { label: "Количество на поддоне", unit: "pcs", group: "Фасовка" },
  gtin: { label: "Штрихкод GTIN", unit: null, group: "Маркировка" },
  ntin: { label: "Код NTIN", unit: null, group: "Маркировка" },
};

export const evidenceKeyMeta = (key) => SPEC_KEYS[key] || VARIANT_KEYS[key] || null;

// Канонический вид условий: ключи по алфавиту, числа как есть, текст —
// в нижнем регистре. {"age_days":7} → «age_days=7».
export function canonicalConditions(conditions = {}) {
  if (conditions === null || typeof conditions !== "object" || Array.isArray(conditions)) {
    throw new TypeError("Условия — объект вида {\"age_days\": 7}");
  }
  const clean = {};
  for (const [k, raw] of Object.entries(conditions)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const meta = CONDITION_KEYS[k];
    if (!meta) throw new TypeError(`Неизвестное условие: ${k}`);
    if (meta.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n)) throw new TypeError(`Условие ${k} должно быть числом`);
      clean[k] = n;
    } else {
      const s = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
      if (s.length > 120) throw new TypeError(`Условие ${k} слишком длинное`);
      clean[k] = s;
    }
  }
  const keys = Object.keys(clean).sort();
  const sorted = Object.fromEntries(keys.map((k) => [k, clean[k]]));
  return { conditions: sorted, key: keys.map((k) => `${k}=${clean[k]}`).join(";") };
}

// Личные контакты в происхождении не храним. Проверяются все свободные
// текстовые поля, куда могли бы вставить подпись письма.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const PHONE = /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/;
export const PRIVACY_CHECKED_FIELDS = [
  "sourceName", "sourceReference", "evidenceNote", "evidenceRef", "conditionText", "label", "verifyNote", "basisNote",
  "originalValue",
];
export function personalDataIn(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (EMAIL.test(s)) return "адрес почты";
  if (PHONE.test(s)) return "номер телефона";
  return null;
}

export function observationHash(o) {
  return createHash("sha256").update(JSON.stringify([
    o.productId, o.variantId ?? null, o.specKey, o.conditionKey ?? "",
    o.statementType, o.sourceType, o.sourceReference ?? null, String(o.originalValue).trim(),
  ])).digest("hex");
}

// ── Правило публикации ────────────────────────────────────────────────────
// Сейчас покупательский каталог наблюдения НЕ читает вообще (он берёт
// products и variants). Правило ниже — единственный разрешённый путь, если
// наблюдение когда-нибудь пойдёт на витрину или в ответ покупателю:
// все условия сразу, иначе — не публикуется.
export function publicationDecision(observation, classResolution) {
  const o = observation;
  if (o.accessLevel !== "public") return { publishable: false, reason: "access_level_not_public" };
  if (o.sourceType === "unknown_legacy_origin") return { publishable: false, reason: "unknown_provenance" };
  if (NEVER_VERIFIED_SOURCE_TYPES.includes(o.sourceType)) return { publishable: false, reason: "generated_or_ai" };
  if (o.verificationStatus !== "verified") return { publishable: false, reason: "not_verified" };
  if (o.lifecycleStatus !== "active") return { publishable: false, reason: "not_active" };
  if (!classResolution || !["agreed", "resolved_by_policy"].includes(classResolution.status)) {
    return { publishable: false, reason: "unresolved" };
  }
  if (!classResolution.supporting?.includes(o.id)) return { publishable: false, reason: "not_the_resolved_value" };
  return { publishable: true, reason: null };
}

// Вид первоисточника по классу коммита приложения №1 (reconcile-dry-run.js,
// COMMIT_CLASS). Всё, чего здесь нет (исходный каталог 31.08, правки без
// источника, «нет в №1»), — unknown_legacy_origin (решение D8).
export const UPSTREAM_SOURCE_TYPE = {
  factory_technologist: "factory_technologist",
  quality_passport: "quality_passport",
  label: "label",
  marking_card: "marking_card",
  factory_catalog: "factory_catalog",
  factory_site: "factory_site",
  price_list: "price_list",
  app1_owner_entry: "manual_entry",
};
export const upstreamSourceType = (upstream) => UPSTREAM_SOURCE_TYPE[upstream] || "unknown_legacy_origin";
