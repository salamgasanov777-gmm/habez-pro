// Habez AI, Phase 2.2D: известные исправления по утверждённым решениям
// D1–D10 (docs/HABEZ-AI-PHASE-2-2D-IMPLEMENTATION-PLAN.md). Только описание:
// выполняет его reconciliation.js — на копии при прогоне и в рабочей базе
// только по команде с подтверждённым отпечатком плана.
//
// По решениям: связей «заменяет» НЕ создаётся ни одной. Где источник пишет
// «вместо», но условие, ключ или единица расходятся, заводится вопрос
// сверки (ai_reconciliation_items) в статусе unresolved.
//
// Происхождение — безопасными ссылками, без имени и почты технолога.
// Значения сверены с приложением №1 (products.json и история, только чтение).

const technologist = (date, extra = {}) => ({
  sourceType: "factory_technologist",
  providedBy: "factory_technologist",
  providedAt: date,
  sourceReference: `technologist-note-${date}`,
  sourceName: `Письмо главного технолога завода от ${date.split("-").reverse().join(".")}`,
  // Решение D9: до сверки всё внутреннее, в том числе новое.
  accessLevel: "internal",
  ...extra,
});

// item — вопрос сверки между этим наблюдением и старой записью legacyKey:
//   candidate_replacement      — источник пишет «вместо», но замена не
//                                оформляется (разное условие или единица);
//   semantic_mapping_candidate — возможно, два ключа описывают одно свойство;
//   value_conflict             — одно свойство, разные значения.
export const REPAIRS = [
  {
    id: "shov-adhesion", product: "shov", legacyKey: "adhesion_strength",
    decision: "D4",
    observation: {
      specKey: "adhesion_strength", label: "Прочность сцепления раствора с основанием в возрасте 7 сут",
      originalValue: "не менее 0,3 МПа", conditions: { age_days: 7 },
      conditionText: "Прочность сцепления раствора с основанием в возрасте 7 сут",
      statementType: "replacement",
      ...technologist("2026-09-05", {
        evidenceNote: "Документ по ШОВу (мешок 25 кг). «0,3 МПа вместо 0,5» — запись о письме в истории приложения №1, коммит 1e43732. Оригинал — в почте владельца",
      }),
    },
    upstream: { ref: "app1-commit-1e43732", recordedAt: "2026-09-05" },
    item: { kind: "candidate_replacement", note: "Источник пишет «вместо», но у старого значения возраста нет, у нового — 7 сут. Замена не создаётся (D4)" },
  },
  {
    id: "shov-setting", product: "shov", legacyKey: "setting_time",
    decision: "D3, D6",
    observation: {
      specKey: "setting_time_start", label: "Начало схватывания, не ранее",
      originalValue: "70 минут", statementType: "replacement",
      ...technologist("2026-09-05", { evidenceNote: "«начало схватывания 70 мин вместо 60» — запись о письме, коммит 1e43732 приложения №1" }),
    },
    upstream: { ref: "app1-commit-1e43732", recordedAt: "2026-09-05" },
    item: { kind: "semantic_mapping_candidate", note: "setting_time («Время схватывания») и setting_time_start («Начало схватывания») — разные ключи; тождество не доказано (D6). Замены и псевдонима нет (D3)" },
  },
  {
    id: "shov-compressive", product: "shov", legacyKey: "compressive_strength",
    decision: "D2",
    observation: {
      specKey: "compressive_strength", label: "Прочность раствора на сжатие в возрасте 7 сут",
      originalValue: "не менее 2,5 МПа", conditions: { age_days: 7 },
      conditionText: "Прочность раствора на сжатие в возрасте 7 сут",
      statementType: "declared",
      ...technologist("2026-09-05"),
    },
    upstream: { ref: "app1-commit-1e43732", recordedAt: "2026-09-05" },
    item: { kind: "candidate_replacement", note: "«Вместо» не заявлено; у старого значения возраста нет. Оба сохраняются, замены нет (D2)" },
  },
  {
    id: "antipleseni-consumption", product: "antipleseni", legacyKey: "consumption",
    decision: "D5",
    observation: {
      specKey: "consumption", label: "Расход",
      originalValue: "200 г/м²", statementType: "replacement",
      ...technologist("2026-09-08", {
        evidenceNote: "«расход 200 г/м² вместо 90–100 мл/м²» — запись об ответе, коммит b4866a5 приложения №1; на этикетке (коммит 4f97b6e) — «около 200 грамм на 1 м²»",
      }),
    },
    upstream: { ref: "app1-commit-b4866a5", recordedAt: "2026-09-08" },
    item: { kind: "value_conflict", note: "мл/м² и г/м² — разные величины; не пересчитывается, не заменяется, одна ли это метрика — не утверждается (D5)" },
  },
  {
    // D10: ключ water_per_bag («Расход воды на мешок», л) уже есть в словаре
    // и используется у ШОВа, ЖАНЕ М100 и КОРОЕДа 3,5. Основание «на мешок»
    // хранится ключом и условием per=bag, фасовка — variant_id единственного
    // мешка товара (правило D10, а не вывод из текста).
    id: "koroed-water", product: "koroed", legacyKey: "water_ratio",
    decision: "D10",
    variantRule: "only_bag_variant",
    observation: {
      specKey: "water_per_bag", label: "Вода для приготовления растворной смеси",
      originalValue: "5–7 литров", conditions: { per: "bag" }, conditionText: "на 1 мешок",
      statementType: "instruction", sourceType: "product_card",
      sourceReference: "habez-pro-card/section/Порядок работы", sourceName: "Карточки товаров Habez Pro",
      accessLevel: "internal",
      evidenceNote: "«берут 5–7 литров воды на 1 мешок в зависимости от требуемой консистенции» — раздел «Порядок работы» карточки; первоисточник — исходный каталог 31.08 (не установлен)",
    },
    upstream: { ref: "app1-commit-e4ddf47", recordedAt: "2026-08-31" },
    item: { kind: "semantic_mapping_candidate", note: "старая запись water_ratio «5–7 л» (таблица, без основания) и water_per_bag «5–7 литров на 1 мешок» — вероятно одно значение; старая запись не меняется (D10)" },
  },
];

// Решения по спорам, которые находятся автоматически (одно свойство —
// разные значения). Ключ: «slug:spec_key».
export const AUTO_CONFLICT_DECISIONS = {
  "standart:adhesion_strength": { decision: "D1", note: "0,5 МПа (ярлык) и не менее 0,6 МПа (таблица) из одного исходного каталога; победителя, замены и публичного значения нет; declared/norm не выдумывать (D1)" },
  "antipleseni:consumption": { decision: "D5", note: "см. D5" },
  "paint-interior:non_volatile": { decision: "план 2.2A §6", note: "заявленное «50–57 %» и замер «50 %» одной строкой; разнести на declared/measured — после решения" },
  "paint-facade:non_volatile": { decision: "план 2.2A §6", note: "то же" },
  "nal:water_ratio": { decision: "ремонт разбора №1 (план 2.2A)", note: "одно значение: разбор потерял «/кг» из подписи строки таблицы" },
  "polymer-waterproofing:consumption": { decision: "ремонт разбора №4 (план 2.2A)", note: "одно значение: условие «при толщине 1 мм» записано в строке" },
};

// Спорное, по которому на этом этапе ничего не пишется (показывается в прогоне).
export const PENDING = [
  { product: "zhane", key: "pot_life", old: "3 часа", other: "описание: «в течение 40 минут наносить»", ref: "аудит технолога, решение №4" },
  { product: "zhane-m100", key: "pot_life", old: "3 часа", other: "описание: «в течение 40 минут наносить»", ref: "аудит технолога, решение №4" },
  { product: "kompozit", key: "pot_life", old: "не менее 45 минут", other: "описание: «использовать в течение 30 минут»", ref: "аудит технолога, решение №4" },
  { product: "meot", key: "pot_life", old: "3 часа", other: "описание: «время работы с готовым раствором 30 минут»", ref: "аудит технолога, решение №4" },
  { product: "lux", key: "drying_time", old: "120 мин", other: "описание (этикетка 07.09): «через 1 час»", ref: "аудит технолога, решение №5" },
  { product: null, key: "фасовки", old: "одна фасовка строкой", other: "ЛЮКС 10 л, Бетоноконтакт 12 кг, краски 6/11/20 кг, ФИНИШ 20 кг, гидроизоляция 5 кг, ПГП 80", ref: "план 2.2A, §4" },
  { product: "gkl, gklv", key: "ntin", old: "таблица «Маркировка»", other: "variants.barcode пуст, поля NTIN нет", ref: "план 2.2A, §5" },
];
