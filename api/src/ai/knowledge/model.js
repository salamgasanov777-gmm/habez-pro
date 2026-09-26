// Habez AI, слой знаний: словари и правила, общие для сервера и проверок.
// Здесь нет обращений к базе — только то, что описывает смысл данных,
// чтобы правила достоверности лежали в одном месте и проверялись тестами.

// Откуда сведение получено. Порядок важен: чем ниже в списке, тем меньше
// доверия. habez_internal — данные самого завода, ai_inference — вывод модели.
export const ORIGINS = [
  "habez_internal",        // прайс, карточка, слова владельца
  "official_manufacturer", // сайт или документ производителя (в том числе конкурента)
  "official_dealer",       // сайт или прайс дилера
  "external_source",       // отраслевые новости, агрегаторы, прочее
  "monitored",             // получено автоматическим наблюдением (фаза 7)
  "ai_inference",          // вывод модели: НИКОГДА не факт, только мнение
];

// Базовое доверие к происхождению, 0–100. Используется, когда доверие
// не задано руками: выше внутреннего не поднимаем, вывод модели — низко.
export const ORIGIN_TRUST = {
  habez_internal: 95,
  official_manufacturer: 80,
  official_dealer: 60,
  external_source: 40,
  monitored: 55,
  ai_inference: 20,
};

// Вывод модели не может быть подтверждённым фактом. Это правило — причина,
// по которой слой знаний вообще существует: иначе AI начнёт цитировать сам
// себя как источник. Человек, проверивший утверждение, заводит отдельный
// факт с настоящим источником, а не «повышает» догадку.
export const ORIGINS_NEVER_VERIFIED = ["ai_inference"];

export const VERIFICATION_STATUSES = [
  "unverified", // принято к сведению, никто не подтверждал
  "verified",   // подтверждено человеком по источнику
  "disputed",   // источники противоречат друг другу
  "stale",      // источник давно не проверялся, данные могли устареть
  "rejected",   // признано неверным; не удаляем — помним, что ошибались
];

// Разрешённые переходы. Смысл: подтвердить или отклонить можно почти из
// любого состояния, а вот «отклонено» снова стало правдой — только через
// проверку человеком, поэтому rejected → verified есть, но rejected → stale нет.
export const STATUS_TRANSITIONS = {
  unverified: ["verified", "disputed", "stale", "rejected"],
  verified: ["disputed", "stale", "rejected"],
  disputed: ["verified", "rejected", "unverified"],
  stale: ["verified", "disputed", "rejected", "unverified"],
  rejected: ["unverified", "verified"],
};

export const canTransition = (from, to) => (STATUS_TRANSITIONS[from] || []).includes(to);

// Тип источника. subject_type — на что указывает факт; в первой фазе это
// собственные товары и фасовки Habez, компания целиком и рынок вообще.
// Конкуренты появятся отдельной сущностью в фазе 3 — здесь их намеренно нет.
export const SOURCE_TYPES = [
  "habez_internal", "manufacturer_site", "dealer_site", "marketplace",
  "price_list", "news_media", "manual_research", "document",
];
export const SOURCE_STATUSES = ["active", "paused", "archived"];

export const SUBJECT_TYPES = ["product", "variant", "category", "company", "market"];

// Тип факта: что именно утверждается. Список открытый по смыслу, но
// ограниченный по составу — иначе одно и то же поле назовут тремя способами.
export const FACT_TYPES = [
  "spec",          // характеристика: прочность, время схватывания
  "consumption",   // расход на м²
  "packaging",     // фасовка, вес, паллета
  "price",         // цена: наша, дилерская, наблюдаемая
  "availability",  // наличие, остаток
  "application",   // область применения
  "document",      // паспорт, сертификат, инструкция
  "company",       // сведение о компании
  "market",        // рыночное наблюдение вообще
  "other",
];

// Сколько живёт факт до перепроверки, в днях. По истечении Data Quality
// (фаза 7) переведёт его в stale; пока срок просто хранится и показывается.
export const RECHECK_DAYS = {
  price: 30,
  availability: 14,
  packaging: 180,
  spec: 365,
  consumption: 365,
  application: 365,
  document: 365,
  company: 180,
  market: 90,
  other: 180,
};

export const defaultConfidence = (origin) => ORIGIN_TRUST[origin] ?? 30;

export const recheckAfter = (factType, observedAt = new Date()) => {
  const days = RECHECK_DAYS[factType] ?? 180;
  const d = new Date(observedAt);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 19).replace("T", " ");
};
