// Подписи для раздела знаний. Русские названия в одном месте: в базе
// хранятся короткие ключи, человеку нужны понятные слова.

export const ORIGIN_LABEL = {
  habez_internal: "Данные завода",
  official_manufacturer: "Сайт производителя",
  official_dealer: "Сайт дилера",
  external_source: "Внешний источник",
  monitored: "Наблюдение",
  ai_inference: "Вывод AI",
};

// Вывод AI отмечаем отдельно — он никогда не факт, и это должно быть видно.
export const ORIGIN_HINT = {
  habez_internal: "Прайс, карточка, слова владельца",
  official_manufacturer: "Официальный сайт или документ производителя",
  official_dealer: "Сайт или прайс дилера",
  external_source: "Новости, агрегаторы, прочее",
  monitored: "Получено автоматической проверкой источника",
  ai_inference: "Предположение модели. Подтверждённым фактом стать не может",
};

export const STATUS_LABEL = {
  unverified: "Не проверен",
  verified: "Подтверждён",
  disputed: "Противоречие",
  stale: "Устарел",
  rejected: "Отклонён",
};

// Классы берём из существующих стилей панели (pill), новых цветов не вводим.
export const STATUS_PILL = {
  unverified: "pending",
  verified: "paid",
  disputed: "pending",
  stale: "",
  rejected: "",
};

export const SOURCE_TYPE_LABEL = {
  habez_internal: "Данные завода",
  manufacturer_site: "Сайт производителя",
  dealer_site: "Сайт дилера",
  marketplace: "Маркетплейс",
  price_list: "Прайс-лист",
  news_media: "Отраслевые новости",
  manual_research: "Ручное исследование",
  document: "Документ",
};

export const SOURCE_STATUS_LABEL = { active: "Действует", paused: "Приостановлен", archived: "В архиве" };

export const FACT_TYPE_LABEL = {
  spec: "Характеристика",
  consumption: "Расход",
  packaging: "Фасовка",
  price: "Цена",
  availability: "Наличие",
  application: "Применение",
  document: "Документ",
  company: "О компании",
  market: "Рынок",
  other: "Прочее",
};

export const SUBJECT_TYPE_LABEL = {
  product: "Товар",
  variant: "Фасовка",
  category: "Раздел",
  company: "Компания",
  market: "Рынок",
};

export const ACTION_LABEL = {
  "ai.fact.create": "Факт заведён",
  "ai.fact.update": "Значение изменено",
  "ai.fact.verification": "Статус проверки изменён",
  "ai.source.create": "Источник заведён",
  "ai.source.update": "Источник изменён",
};

export const factValue = (f) => {
  const v = f.value?.text ?? (f.value?.num !== null && f.value?.num !== undefined ? String(f.value.num) : "");
  return [v, f.value?.unit].filter(Boolean).join(" ");
};
