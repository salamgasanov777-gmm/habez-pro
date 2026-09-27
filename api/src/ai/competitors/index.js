// Habez AI, 3.5 Competitor Intelligence (roadmap: Phase 3 — Competitors).
// Доменный слой: справочник конкурентов, наблюдения характеристик и цен,
// аналоги и сравнение. Только ручной ввод администратором; чтение — по
// ролям. Инструментов ассистента с записью нет и не будет.
export * from "./model.js";
export * from "./regions.js";
export * from "./companies.js";
export * from "./brands.js";
export * from "./products.js";
export * from "./packs.js";
export * from "./observations.js";
export * from "./prices.js";
export * from "./analogs.js";
export * from "./compare.js";
export * from "./registry.js";
export * from "./overview.js";
export { analogStatusOf, priceGroups, pricesComparable, priceGroupKey, propertyGroups } from "./resolve.js";
