// Habez AI Agent (Phase 3.2): маршрутизатор вопроса и состояние беседы.
// Правилами, без модели: дёшево, предсказуемо, проверяется тестами.
//
//   routeQuestion(q, { catalog, state }) →
//     { intent, products, productsFrom, ambiguousProducts, unknown,
//       specs: { terms, keys, ambiguous }, conditions, variantText,
//       reference, needs }
//   nextState(route, prev) → состояние для следующего вопроса
//
// intent: product_lookup | spec_lookup | comparison | application |
// packaging | condition | source | conflict | unknown.
//
// Состояние беседы — это не данные товаров, а «о чём сейчас речь»:
//   current_product, current_products, current_variant, current_spec,
//   current_specs, current_condition, last_intent
// Хранит его браузер (вместе с беседой), сервер проверяет и возвращает
// новое. В базу оно не пишется.
import { z } from "zod";
import { resolveProducts } from "./resolver.js";
import { resolveSpecs, parseConditions, VARIANT_SPEC_KEYS } from "./specs.js";
import { resolveUseCase, useCaseById } from "../intel/usecases.js";

// Phase 3.3: suitability — «подходит ли X для задачи», usage — «как
// применять», compatibility — «совместимы ли X и Y». application — подбор
// товаров под задачу.
export const INTENTS = ["product_lookup", "spec_lookup", "comparison", "application", "packaging", "condition", "source", "conflict",
  "suitability", "usage", "compatibility", "unknown"];

const slug = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const stateSchema = z.object({
  current_product: slug.nullable().optional(),
  current_products: z.array(slug).max(6).optional(),
  current_variant: z.object({ product: slug, unit: z.string().max(80) }).nullable().optional(),
  current_spec: z.string().max(80).nullable().optional(),
  current_specs: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(12).optional(),
  current_condition: z.record(z.union([z.string().max(20), z.number()])).nullable().optional(),
  last_intent: z.enum(INTENTS).nullable().optional(),
  // Агент задал уточняющий вопрос и ждёт: товар, фасовку или товары.
  awaiting: z.enum(["product", "variant", "products"]).nullable().optional(),
  // Phase 3.3: задача, о которой идёт речь («заделка швов ГКЛ»).
  current_use_case: z.string().regex(/^[a-z_]{1,40}$/).nullable().optional(),
}).strict();

const norm = (s) => ` ${String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()} `;
const B = "(?:^|[^а-яa-z0-9])";
const E = "(?=$|[^а-яa-z0-9])";

const PLURAL_REF = new RegExp(`${B}(их|они|обоих|оба|обе|обеих|эти (товары|смеси|два|две)|между ними|этих двух|из них|из двух)${E}`);
const SINGLE_REF = new RegExp(`${B}(него|его|он|она|оно|нему|ним|нем|нее|ее|ней|этого товара|этот товар|этой смеси|эта смесь|этого|этой|у него|у нее)${E}`);
const ELLIPSIS = /^\s*(а|и|ну|еще|тогда)\s/;

export function routeQuestion(question, { catalog, state = {} }) {
  const q = norm(question);
  const found = resolveProducts(question, catalog);
  const specs = resolveSpecs(question);
  const conditions = parseConditions(question);
  const bySlug = new Map(catalog.map((p) => [p.slug, p]));
  let products = found.products;
  let productsFrom = products.length ? "question" : null;
  let reference = null;
  const needs = [];

  // Отсылки к прошлому: «их» — товары беседы, «у него» — текущий товар.
  const prevProducts = (state.current_products || []).map((s) => bySlug.get(s)).filter(Boolean);
  const prevProduct = state.current_product ? bySlug.get(state.current_product) : null;
  // Продолжение: «А у Стандарта?», «А прочность?». Новая тема («расскажи
  // про…», «что такое…») — не продолжение, даже если фраза короткая.
  const newTopic = /расскажи|что такое|что за|опиши|сравни/.test(q);
  const elliptic = !newTopic && (ELLIPSIS.test(q) || q.trim().split(" ").length <= 3);
  // Короткий ответ на уточнение («ШОВ», «12,5 мм») продолжает прерванный вопрос.
  const answering = !!state.awaiting && q.trim().split(" ").length <= 4;
  const comparisonWords = new RegExp(`${B}(сравн|разниц|отлича|чем .* лучше|vs${E}|против${E})`).test(q);
  if (answering && state.awaiting === "variant" && !products.length && prevProduct) { products = [prevProduct]; productsFrom = "state"; reference = "single"; }
  if (!products.length && !found.ambiguous.length && !found.unknown.length) {
    if (PLURAL_REF.test(q) || (comparisonWords && prevProducts.length >= 2) || (elliptic && !SINGLE_REF.test(q) && state.last_intent === "comparison" && prevProducts.length >= 2)) {
      if (prevProducts.length >= 2) { products = prevProducts; productsFrom = "state"; reference = "plural"; } else needs.push("products");
    } else if (SINGLE_REF.test(q) || ((elliptic || (!newTopic && (prevProduct || prevProducts.length))) && (specs.keys.length || Object.keys(conditions).length))) {
      // Вопрос о характеристике без товара («Какая прочность через 28 суток?»)
      // — о том, о чём сейчас беседа. После сравнения — об обоих товарах.
      if (prevProduct) { products = [prevProduct]; productsFrom = "state"; reference = "single"; }
      else if (!SINGLE_REF.test(q) && state.last_intent === "comparison" && prevProducts.length >= 2) { products = prevProducts; productsFrom = "state"; reference = "plural"; }
      else if (prevProducts.length > 1) needs.push("which_product");
    }
  }

  // Задача (Phase 3.3): из вопроса или, для продолжения, из беседы.
  const why = /^\s*(а\s+)?(почему|зачем|на каком основании|чем (он|она) подходит)/.test(q);
  // Название товара-кандидата («АНТИПЛЕСЕНЬ») — не задача «плесень»:
  // задача по всему вопросу, затем — без имён тех товаров, что сами
  // кандидаты этой задачи. Имя основания («швы ГКЛ») остаётся.
  let useCase = resolveUseCase(question);
  if (useCase) {
    let named = String(question);
    for (const p of found.products.filter((x) => useCase.types.test(x.category || ""))) {
      for (const a of [p.short_name, ...[...String(p.name || "").matchAll(/«([^»]+)»/g)].map((m) => m[1])].filter(Boolean)) {
        named = named.replace(new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[а-яё]{0,3}`, "giu"), " ");
      }
    }
    useCase = resolveUseCase(named);
  }
  let useCaseFrom = useCase ? "question" : null;
  const followUp = ELLIPSIS.test(q) || why || PLURAL_REF.test(q) || SINGLE_REF.test(q) || /(этой|той же|этого) задач|для неё|для этого/.test(q);
  if (!useCase && state.current_use_case && followUp && ["application", "suitability", "comparison"].includes(state.last_intent)) {
    useCase = useCaseById(state.current_use_case); useCaseFrom = useCase ? "state" : null;
  }
  if (why && !products.length && prevProduct && useCase) { products = [prevProduct]; productsFrom = "state"; reference = "single"; }

  // «А у Стандарта?» — тот же вопрос о другом товаре: берём прошлые
  // характеристики и условия.
  let specsFrom = specs.keys.length ? "question" : null;
  let conds = conditions;
  if (!specs.keys.length && state.current_specs?.length && ((elliptic && ELLIPSIS.test(q)) || reference || answering) && ["spec_lookup", "condition", "comparison", "packaging"].includes(state.last_intent)) {
    specs.keys = state.current_specs;
    specs.terms = state.current_spec ? [state.current_spec] : [];
    specs.ambiguous = state.current_spec === "прочность" ? "strength" : null;
    specsFrom = "state";
    if (!Object.keys(conds).length && state.current_condition) conds = state.current_condition;
  }

  // Намерение.
  let intent;
  const specKeys = specs.keys.filter((k) => !VARIANT_SPEC_KEYS.has(k));
  const usageWords = /как (его |ее |их )?(правильно )?(применя|нанос|нанест|использова|развест|развод|приготов|готов|работать с)|инструкц|порядок (работ|нанесени|приготовлени)|технологи[яю] нанесени/.test(q);
  const suitWords = /подход|подойд|можно (ли )?(его |ее )?(использ|примен|нанос)|годит|пригод|использовать для|применять для/.test(q) || why;
  const selectWords = /какие|какой|какую|что (использ|взять|подойд|подход|выбрать)|чем [а-я]*(заделать|выровнять|клеить|приклеить|загрунтовать|обработать)|вариант|подбер|посовет/.test(q);
  const purposeWords = /для чего|назначени|что (он |она )?(собой )?представля|где (применя|использу)/.test(q);
  // Названный товар — основание задачи («для швов ГКЛ»), а не кандидат:
  // в сравнении и пригодности его нет.
  const isBase = (p) => useCase && !useCase.types.test(p.category || "") && /гкл|гипсокартон|гвл|пгп|пазогреб/i.test(`${p.name} ${p.short_name}`);
  const baseOnly = useCase && products.length && products.every(isBase);
  if (useCase && !baseOnly && products.some(isBase)) products = products.filter((p) => !isBase(p));
  if (products.length && purposeWords && !comparisonWords) intent = "product_lookup";
  else if (usageWords && (products.length || prevProduct)) intent = "usage";
  else if (products.length >= 2 && /совмест|сочета|вместе с|поверх|по верху/.test(q)) intent = "compatibility";
  else if (useCase && (comparisonWords || (products.length >= 2 && !baseOnly && new RegExp(`${B}(или|лучше)${E}`).test(q)) || (reference === "plural" && /лучше|выбрать|какой|сравн/.test(q)))) intent = "comparison";
  else if (useCase && products.length && !baseOnly && (suitWords || (useCaseFrom === "state" && productsFrom === "question" && ELLIPSIS.test(q)))) intent = "suitability";
  else if (useCase && (!products.length || baseOnly) && (selectWords || suitWords || /для |от |есть/.test(q) || useCaseFrom === "question" || (useCaseFrom === "state" && followUp))) intent = "application";
  else if (comparisonWords || (products.length >= 2 && new RegExp(`${B}или${E}`).test(q)) || (reference === "plural" && state.last_intent === "comparison")) intent = "comparison";
  else if (new RegExp(`${B}(источник|откуда|кто (дал|указал|прислал)|документ|подтверд|паспорт[а-я]* качеств)`).test(q)) intent = "source";
  else if (new RegExp(`${B}(расхожд|противореч|спор|конфликт|сверк|нерешен|разн[а-я]* значени)`).test(q)) intent = "conflict";
  else if (specKeys.length) intent = Object.keys(conds).length ? "condition" : "spec_lookup";
  else if (specs.keys.length || new RegExp(`фасовк|упаковк|поддон|паллет|${B}лист(ов|ы|а)?${E}|мешк|gtin|ntin|штрих|артикул|${B}sku`).test(q)) intent = "packaging";
  else if (/подход|подобрат|посовет|для чего|примен|что взять|чем [а-я]*(заделать|выровнять|клеить|зашпаклевать|загрунтовать)|какой [а-я]+ (нужен|лучше)|для (стен|пола|потолк|фасад|ванн|плитк|швов|стык)/.test(q)) intent = "application";
  else if (products.length || /расскажи|что такое|что за|опиши|информац|что с /.test(q)) intent = "product_lookup";
  else if (specsFrom === "state" && products.length) intent = state.last_intent;
  else intent = "unknown";
  if (answering && specsFrom === "state" && state.last_intent) intent = state.last_intent;
  // «Чем отличаются ГКЛ 9,5 и 12,5 мм?» — сравнение фасовок одного товара.
  if (intent === "comparison" && products.length === 1 && (((q.match(/\d+(?:[.,]\d+)?/g) || []).length >= 2 && /\d\s*(мм|кг|л)(?![а-я])/.test(q)) || /фасовк|упаковк|толщин|вариант/.test(q))) intent = "packaging";
  if (intent === "comparison" && products.length < 2 && !needs.includes("products")) needs.push("products");
  if (baseOnly && intent === "application") products = products; // основание: остаётся в маршруте, но не кандидат

  return {
    intent, products, productsFrom, reference,
    ambiguousProducts: found.ambiguous, unknown: found.unknown,
    useCase: useCase ? useCase.id : null, useCaseFrom, baseOnly: !!baseOnly,
    specs: { terms: specs.terms, keys: specs.keys, ambiguous: specs.ambiguous, from: specsFrom, groups: specsFrom === "question" ? specs.groups.map((g) => ({ label: g.label, keys: g.keys })) : [] },
    conditions: conds, needs,
  };
}

// Новое состояние: только то, что следует из вопроса и ответа.
export function nextState(route, prev = {}, { variant = null, awaiting = null, focus = null } = {}) {
  const slugs = route.products.map((p) => p.slug);
  let currentProducts = prev.current_products || [];
  if (route.intent === "comparison" && slugs.length >= 2) currentProducts = slugs;
  else if (slugs.length) currentProducts = [...currentProducts.filter((s) => !slugs.includes(s)), ...slugs].slice(-4);
  let currentProduct = prev.current_product ?? null;
  if (slugs.length === 1) currentProduct = slugs[0];
  else if (slugs.length > 1) currentProduct = null; // после сравнения «у него» — неясно, о каком
  // Подбор: «речь» — о подходящих товарах; первый подтверждённый — текущий.
  if (focus?.products?.length) { currentProducts = focus.products.slice(0, 4); currentProduct = focus.product ?? currentProduct; }
  return stateSchema.parse({
    current_product: currentProduct,
    current_products: currentProducts,
    current_variant: variant ? { product: variant.product, unit: variant.unit } : (slugs.length && prev.current_variant && !slugs.includes(prev.current_variant.product) ? null : prev.current_variant ?? null),
    current_spec: route.specs.keys.length ? (route.specs.terms[0] ?? null) : prev.current_spec ?? null,
    current_specs: route.specs.keys.length ? route.specs.keys.slice(0, 12) : prev.current_specs || [],
    current_condition: Object.keys(route.conditions || {}).length ? route.conditions : (route.specs.from === "question" ? null : prev.current_condition ?? null),
    last_intent: route.intent,
    awaiting,
    current_use_case: route.useCase ?? (["application", "suitability", "comparison"].includes(route.intent) ? prev.current_use_case ?? null : null),
  });
}
