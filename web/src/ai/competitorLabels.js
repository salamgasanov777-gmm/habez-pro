// Подписи раздела «Конкуренты» (3.5 Competitor Intelligence). В базе — ключи,
// человеку — понятные слова. Оценочных слов («лучший», «хуже», «выгоднее»,
// «победитель») здесь нет и быть не должно.

export const COMPANY_KIND = {
  manufacturer: "производитель", brand_owner: "владелец марки", dealer: "дилер", distributor: "дистрибьютор",
  retail_chain: "торговая сеть", marketplace: "маркетплейс", unknown: "вид не указан",
};
export const COMPETITOR_STATUS = { competitor: "конкурент", not_competitor: "не конкурент", unknown: "не отмечено" };
export const COMPETITOR_PILL = { competitor: "pending", not_competitor: "", unknown: "" };
export const MARKET_STATUS = { active: "выпускается", discontinued: "снят с производства", unknown: "не известно" };
export const ACCESS = { public: "открытые", internal: "внутренние", confidential: "конфиденциальные" };
export const SOURCE_TYPE = {
  technical_document: "технический документ", quality_passport: "паспорт качества", label: "этикетка", marking_card: "маркировочная карточка",
  factory_catalog: "каталог производителя", price_list: "прайс", public_source: "внешний источник", measurement: "замер",
};
// Вид первоисточника значения (модель наблюдений 2.2B) — для ячеек сравнения.
export const SOURCE_KIND = {
  ...SOURCE_TYPE, product_card: "карточка товара", catalog_card: "карточка товара", factory_technologist: "письмо технолога завода",
  factory_site: "сайт завода", manual_entry: "ручной ввод без документа", generated_default: "подставлено программой",
  ai_inference: "вывод AI (не факт)", unknown_legacy_origin: "первоисточник не установлен",
};
export const STATEMENT = { declared: "заявлено", measured: "замер", norm: "норма", instruction: "указание по применению", replacement: "замена", unknown: "не указано" };
export const PRICE_KIND = { retail: "розница", wholesale: "опт", dealer: "дилерская", rrp: "РРЦ", promo: "акция", marketplace: "маркетплейс" };
export const BASIS_UNIT = { pack: "за фасовку", kg: "за кг", l: "за литр", m2: "за м²", pcs: "за штуку", other: "другое" };
export const VAT = { with_vat: "с НДС", without_vat: "без НДС", unknown: "НДС не указан" };
export const RELATION = { analog: "аналог", partial_analog: "частичный аналог", not_analog: "не аналог" };
export const BASIS = { source: "указано в источнике", employee_decision: "решение сотрудника", explicit_source_statement: "указано в источнике", user_decision: "решение сотрудника" };
export const ANALOG_STATUS = { CONFIRMED: "подтверждено", INFERRED: "предположение", CONFLICTED: "противоречие", UNKNOWN: "нет данных" };
export const VERIFICATION = { unverified: "не проверено", verified: "подтверждено", disputed: "спорно", stale: "устарело", rejected: "отклонено" };
export const PROPERTY_STATUS = { single: "одно значение", agreed: "источники согласны", conflict: "расхождение", history: "только история" };
export const LIFECYCLE = { active: "действует", superseded: "заменено", withdrawn: "снято" };

export const money = (minor, cur = "RUB") => `${(minor / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === "RUB" ? "₽" : cur}`;
