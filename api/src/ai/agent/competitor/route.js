// Habez AI 3.5: вопросы о конкурентах — правилами, без модели.
//
//   competitor_lookup      «Что известно о ТестСмеси?», «Кто производит Т-Шов?»,
//                          «Какие конкуренты есть?»
//   competitor_products    «Какие товары у Марки-Т?», «Какие шпаклёвки у ТестСмеси?»
//   analog_lookup          «Какие аналоги у ШОВ?», «Есть ли у ШОВ ещё аналоги?»
//   competitor_comparison  «Сравни ШОВ с Т-Шовом», «Сравни ШОВ с товаром ТестСмесь»
//   competitor_price       «Сколько стоит Т-Шов?», «А цена?»
//
// Вход: вопрос (нижний регистр), названные конкуренты (detect.js), наши
// товары из вопроса и беседы, состояние. Выход — намерение и цели или null
// (вопрос не о конкурентах: работают правила 3.1–3.4).
export const COMPETITOR_INTENTS = new Set(["competitor_lookup", "competitor_products", "analog_lookup", "competitor_comparison", "competitor_price"]);

const PRICE = /(^|[^а-я])(цен[аыуеой]|стоит|стоимост|почем|почём|прайс)/;
const COMPARE = /сравн|отлича|разниц|против(?![а-я])|(^|[^а-я])vs(?![a-z])/;
const ANALOG = /аналог|альтернатив|чем (можно )?заменить|замен[аы] (у|среди|от) конкурент/;
const PRODUCTS = /какие (еще |ещё |другие )?(товар|продукц|смес|шпакл|штукатур|кле[йи]|грунт|краск|позици|издели|материал)|что (еще |ещё )?(производит|выпускает|продает|продаёт|есть у)|ассортимент|список товар|товары (у|марки|компании)/;
const COMPETITOR_WORD = /конкурент/;
const OTHER_BRAND = /(друг[а-я]* (их |его |ее |её )?марк|втор[а-я]* марк|у другой марки)/;

export function competitorIntent(q, { hits = [], ours = [], oursFrom = null, state = {}, scope = "staff", unknown = [], hasRegistry = false }) {
  const companies = hits.filter((h) => h.item.type === "company").map((h) => h.item);
  const brands = hits.filter((h) => h.item.type === "brand").map((h) => h.item);
  const products = hits.filter((h) => h.item.type === "product").map((h) => h.item);
  const prev = { company: state.current_competitor_company ?? null, brand: state.current_competitor_brand ?? null, product: state.current_competitor_product ?? null };
  const inConversation = /^competitor_|^analog_/.test(state.last_intent || "");
  const named = hits.length > 0;
  const short = q.trim().split(/\s+/).length <= 4;
  const base = { companies, brands, products, from: named ? "question" : null, otherBrand: false };

  // Гость: вопрос о конкурентах узнаётся только по словам, не по именам
  // (имена ему не загружаются) — ответ без модели и без данных.
  if (scope === "public") {
    if (COMPETITOR_WORD.test(q) || (ANALOG.test(q) && /конкурент|других производител|у других/.test(q))) return { intent: "competitor_lookup", ...base, forbidden: true };
    return null;
  }

  // «А у другой их марки?» — другая марка той же компании; вопрос тот же.
  if (!named && OTHER_BRAND.test(q) && prev.company) {
    const intent = ["competitor_price", "competitor_comparison"].includes(state.last_intent) ? state.last_intent : "competitor_products";
    return { intent, ...base, from: "state", otherBrand: true };
  }
  // «А цена?» — о товаре конкурента из беседы.
  if (!named && PRICE.test(q) && prev.product && (short || inConversation)) return { intent: "competitor_price", ...base, from: "state" };
  // Аналоги нашего товара (из вопроса или беседы).
  if (ANALOG.test(q) && (ours.length || products.length || (!named && state.current_product))) return { intent: "analog_lookup", ...base, from: named ? "question" : oursFrom || "state" };
  if (!named) {
    // «Сравни ШОВ с «Т-Супер»»: названия нет ни у нас, ни в справочнике —
    // честное «нет в данных» без модели.
    if (hasRegistry && unknown.length && COMPARE.test(q) && ours.length === 1) return { intent: "competitor_comparison", ...base, unknownOnly: true };
    // «Что известно о компании Т-Супер?» — имени нет ни у нас, ни в справочнике.
    if (hasRegistry && unknown.length && !ours.length && /компани|фирм|бренд|(^|[^а-я])марк/.test(q)) return { intent: "competitor_lookup", ...base, unknownOnly: true };
    // «Какие конкуренты есть?» — список компаний со статусом «конкурент».
    if (COMPETITOR_WORD.test(q)) return { intent: "competitor_lookup", ...base, list: true };
    // «Сравни с ним ещё раз», «А чем он отличается?» — продолжение сравнения.
    if (inConversation && prev.product && COMPARE.test(q) && (ours.length || state.current_product)) return { intent: "competitor_comparison", ...base, from: "state" };
    return null;
  }
  if (PRICE.test(q)) return { intent: "competitor_price", ...base };
  if (COMPARE.test(q) && (ours.length || state.current_product)) return { intent: "competitor_comparison", ...base };
  if (PRODUCTS.test(q) && (companies.length || brands.length)) return { intent: "competitor_products", ...base };
  return { intent: "competitor_lookup", ...base };
}

// Phase 4.1: домен «конкуренты» в реестре маршрутизатора (router.js →
// DOMAIN_ROUTES) — раньше заводов: «Что производит ТестСмесь?» — вопрос о
// конкуренте. Код правки маршрута перенесён из router.js без изменений.
export const competitorRoute = {
  id: "competitor",
  detect: (x) => competitorIntent(x.q, { hits: x.compHits, ours: x.products, oursFrom: x.productsFrom, state: x.state, scope: x.scope, unknown: x.unknown, hasRegistry: x.hasRegistry }),
  apply(d, ci, x) {
    d.intent = ci.intent;
    d.factory = null; d.ambiguous = [];
    d.competitor = { companies: ci.companies.map((c) => c.id), brands: ci.brands.map((c) => c.id), products: ci.products.map((c) => c.id), from: ci.from,
      otherBrand: ci.otherBrand, list: !!ci.list, forbidden: !!ci.forbidden, hits: x.compHits.map((h) => ({ type: h.item.type, id: h.item.id, name: h.item.name, via: h.via })) };
    // Наш товар — из вопроса; для сравнения и аналогов — ещё из беседы.
    // Для сравнения наш товар нужен всегда; для аналогов — только если не
    // назван товар конкурента («Какой товар Habez — аналог Т-Шов?»).
    if (!d.products.length && x.prevProduct && (d.intent === "competitor_comparison" || (d.intent === "analog_lookup" && !ci.products.length))) { d.products = [x.prevProduct]; d.productsFrom = "state"; d.reference = "single"; }
    if (["competitor_lookup", "competitor_products", "competitor_price"].includes(d.intent) && d.productsFrom !== "question") { d.products = []; d.productsFrom = null; d.reference = null; }
  },
};
