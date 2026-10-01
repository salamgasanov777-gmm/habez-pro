// Habez AI (Phase 4.1): базовые этапы ответа — вопросы о товарах Habez
// (3.2) и подбор по задаче (3.3). Код перенесён из agent.js без изменений
// логики; порядок этапов задаёт реестр (handlers.js).
//
//   resolution        без модели: товара нет, неясно какой, какие сравнить
//   criteria          «Сравни … по трём характеристикам» — каким? (уточнение)
//   unknownNotes      пометка «товара X в каталоге нет» рядом с найденными
//   plan              инструменты чтения по маршруту: сравнение, карточки,
//                     фасовка, «нет данных», общий поиск
//   applicationSearch подбор «для швов ГКЛ»: товары не того же раздела
//   finalizeMode      режим по умолчанию — после снимка пакета
import { all } from "../../../db/index.js";
import { matchVariant, VARIANT_SPEC_KEYS } from "../retrieval/specs.js";
import { searchTerms } from "../retrieval/intent.js";
import { callTool, comparisonRows } from "../tools/index.js";
import { selectProperties, fetchProduct } from "./plan.js";
import { comparisonSuitability } from "../intel/run.js";
import { applicationSections } from "../intel/profile.js";
import { unsupportedDates } from "../factory/check.js";
import { names } from "./text.js";

// Вопрос только о таких характеристиках — вопрос о применении (Phase 3.3).
export const APPLICATION_KEYS = new Set(["water_per_bag", "water_ratio", "water_mix_ratio", "layer_thickness", "layer_thickness_wall", "layer_thickness_floor",
  "pot_life", "open_time", "adjust_time", "drying_time", "walk_on_time", "consumption", "consumption_per_mm", "consumption_per_10mm", "base_temperature"]);
const MAX_PRODUCTS = 4;

// 1. Без модели: товара нет или неясно, о каком речь.
export const resolutionStage = {
  id: "resolution",
  when: (t) => !t.mode && !t.route.products.length,
  run(t) {
    const { route, state, catalog } = t;
    if (route.unknown.length) {
      t.mode = "NOT_FOUND";
      t.fixed = `Товара ${names(route.unknown)} в каталоге Habez нет, поэтому данных о нём тоже нет. Проверьте название или спросите о задаче — подскажу, что из ассортимента Habez подходит.`
        + (t.competitors.length ? " В справочнике конкурентов такого названия тоже нет." : "");
    } else if (route.ambiguousProducts.length && route.intent !== "application") {
      const opts = route.ambiguousProducts[0].candidates.map((p) => p.short_name || p.name);
      t.mode = "CLARIFICATION"; t.awaiting = "product";
      t.clarification = { question: `Уточните, какой товар: ${names(opts)}?`, options: opts };
    } else if (route.needs.includes("which_product")) {
      const opts = (state.current_products || []).map((s) => catalog.find((p) => p.slug === s)).filter(Boolean).map((p) => p.short_name || p.name);
      t.mode = "CLARIFICATION"; t.awaiting = "product";
      t.clarification = { question: `О каком товаре речь: ${names(opts)}?`, options: opts };
    } else if (route.needs.includes("products")) {
      t.mode = "CLARIFICATION"; t.awaiting = "products";
      t.clarification = { question: "Какие товары сравнить? Назовите два–четыре товара, например «ШОВ и СТАНДАРТ».", options: [] };
    }
    if (t.clarification) t.fixed = t.clarification.question;
  },
};

// «Сравни … по трём характеристикам» — каким, не сказано: спрашиваем.
export const criteriaStage = {
  id: "criteria",
  when: (t) => !t.mode && t.route.intent === "comparison" && t.route.products.length >= 2 && !t.route.specs.keys.length
    && /по (дв|тр|четыр|пят|нескольк|\d)[а-яё]* (основн[а-яё]* )?(характеристик|параметр|показател)/i.test(t.q),
  run(t) {
    const { route } = t;
    const opts = ["прочность", "время схватывания", "расход воды"];
    t.mode = "CLARIFICATION"; t.awaiting = null;
    t.clarification = { question: `По каким характеристикам сравнить ${names(route.products.map((p) => p.short_name || p.name)).replace(" или ", " и ")}? Например: ${opts.join(", ")}.`, options: [`Сравни ${route.products.map((p) => p.short_name || p.name).join(" и ")} по прочности, времени схватывания и расходу воды`] };
    t.fixed = t.clarification.question;
  },
};

export const unknownNotesStage = {
  id: "unknown-notes",
  when: () => true,
  run(t) {
    for (const n of t.route.unknown) if (t.route.products.length) t.bundle.note(`ТОВАРА «${n}» В КАТАЛОГЕ HABEZ НЕТ — данных о нём нет, ничего о нём не утверждать.`);
  },
};

// 2. План: инструменты чтения по маршруту.
export const planStage = {
  id: "plan",
  when: (t) => !t.mode && ((t.route.products.length && t.route.intent !== "application") || !t.route.products.length),
  run(t) {
    const { route, q, ctx, bundle, calls, allowed, state, groups, useCase, products, scope } = t;
    if (route.products.length && route.intent !== "application") {
      // Сравнение по задаче: характеристики, важные для неё (Comparison 2.0).
      const keys = route.specs.keys?.length ? route.specs.keys
        : (route.intent === "comparison" && useCase ? [...new Set([...useCase.keySpecs, ...useCase.requires.flat().map((r) => r.key).filter(Boolean), ...(useCase.against || []).map((r) => r.key)])] : []);
      const conditions = route.conditions || {};
      const packaging = route.intent === "packaging";
      const wantsVariantValue = keys.some((k) => VARIANT_SPEC_KEYS.has(k));
      const list = route.products.slice(0, MAX_PRODUCTS);
      if (route.intent === "comparison" && list.length >= 2) {
        const t1 = Date.now();
        const cmp = callTool("compare_products", { productIds: list.map((p) => p.id) }, ctx);
        calls.push({ name: "compare_products", source: "plan", ms: Date.now() - t1, found: cmp.items.length });
        for (const it of cmp.items) {
          const t2 = Date.now();
          const p = callTool("get_product", { productId: it.product.id }, ctx);
          calls.push({ name: "get_product", source: "plan", ms: Date.now() - t2, found: p ? 1 : 0 });
          if (!p) continue;
          p.sections = []; // для сравнения — характеристики, не описания
          const sel = selectProperties(it, p, { keys, groups, conditions });
          products.push({ p, sp: it, sel });
        }
        cmp.rows = comparisonRows(cmp.items);
        for (const x of products) {
          bundle.product(x.p, x.sp, { missing: x.sel.missing, otherConditions: x.sel.otherConditions, strengthAmbiguous: route.specs.ambiguous === "strength", askedConditions: Object.keys(conditions).length ? conditions : null });
          allowed.add(x.p.id);
        }
        bundle.comparison(cmp);
        if (useCase) t.suitability = comparisonSuitability({ products, useCase, ctx, bundle, calls });
      } else {
        for (const rp of list) {
          const got = fetchProduct(ctx, rp.id, route, calls);
          if (!got) continue;
          const { p, sp } = got;
          // Фасовка из прошлого вопроса — только если товар тоже из беседы
          // («а у него?»), а не назван заново.
          const variant = matchVariant(q, p.variants || [])
            || (route.productsFrom === "state" && state.current_variant?.product === p.slug ? (p.variants || []).find((v) => v.unit === state.current_variant.unit) : null);
          // Нужна фасовка, а её не назвали, и значения по фасовкам разные —
          // спрашиваем, а не выбираем.
          if (!variant && (wantsVariantValue || (packaging && /сколько/.test(q.toLowerCase()))) && (p.variants || []).length > 1) {
            const perPallet = new Set(p.variants.map((v) => v.per_pallet));
            if (keys.some((k) => k === "gtin" || k === "ntin") || perPallet.size > 1) {
              const opts = p.variants.map((v) => v.unit);
              t.mode = "CLARIFICATION"; t.awaiting = "variant";
              t.clarification = { question: `Для какой фасовки ${p.short || p.name}: ${names(opts)}?`, options: opts };
              t.fixed = t.clarification.question;
              products.push({ p, sp, sel: { missing: [], otherConditions: [] } });
              break;
            }
          }
          // Сначала отбор (он сверяет строки со ВСЕМИ фасовками), потом из
          // карточки убираются чужие фасовки.
          const sel = selectProperties(sp, p, { keys, groups, conditions, variant, packaging });
          if (variant) { t.chosenVariant = { product: p.slug, unit: variant.unit }; p.variants = p.variants.filter((v) => v.id === variant.id); }
          if (route.intent === "conflict") sp.properties = sp.properties.filter((x) => ["conflict", "unresolved"].includes(x.status) || x.hiddenDisagreement || x.hiddenConfidential);
          // Для вопроса о числе — только разделы карточки со словами вопроса;
          // для вопроса о применении — ещё разделы, где об этом сказано словами
          // («толщина наносимого слоя соответствует…»).
          if (!["product_lookup", "unknown"].includes(route.intent)) {
            const own = new Set(route.products.map((x) => String(x.short_name || "").toLowerCase().replace(/ё/g, "е")));
            const terms = searchTerms(q).filter((w) => ![...own].some((n) => n && (n.startsWith(w) || w.startsWith(n))));
            const appTitles = keys.length && keys.every((k) => APPLICATION_KEYS.has(k)) ? new Set(applicationSections(p, keys)) : new Set();
            p.sections = (p.sections || []).filter((sec) => appTitles.has(sec.title) || terms.some((w) => sec.text.toLowerCase().replace(/ё/g, "е").includes(w)));
          }
          products.push({ p, sp, sel, variant });
        }
        if (!t.mode) {
          for (const x of products) {
            bundle.product(x.p, x.sp, {
              missing: x.sel.missing, otherConditions: x.sel.otherConditions, variant: x.variant,
              strengthAmbiguous: route.specs.ambiguous === "strength",
              provenance: ["source", "conflict"].includes(route.intent) && scope !== "public",
              askedConditions: Object.keys(conditions).length ? conditions : null,
            });
            allowed.add(x.p.id);
          }
        }
      }
      // Спросили характеристику, а её нет ни у одного товара — честное «нет».
      // (Вопрос о применении, на который карточка отвечает словами, — не «нет».)
      const textAnswers = products.length === 1 && route.specs.keys.length && route.specs.keys.every((k) => APPLICATION_KEYS.has(k)) && (products[0].p.sections || []).length > 0;
      if (!t.mode && !textAnswers && groups.length && products.length && products.every((x) => groups.every((g) => x.sel.missing.includes(g.label)))) {
        t.mode = "NOT_FOUND";
        const other = [...new Set(products.flatMap((x) => x.sel.otherConditions))];
        t.fixed = `В данных Habez нет ${groups.map((g) => `«${g.label}»`).join(", ")} для ${products.map((x) => x.p.short || x.p.name).join(" и ")}${Object.keys(route.conditions || {}).length ? " при условии из вопроса" : ""}.`
          + (other.length ? ` Значения есть только для других условий (${other.join("; ")}) — к вашему вопросу они не относятся.` : "");
      }
    } else {
      // Товар не назван: подбор по задаче и общий поиск.
      const t1 = Date.now();
      let found = callTool("search_products", { terms: searchTerms(q).slice(0, 12), limit: 8 }, ctx).items;
      calls.push({ name: "search_products", source: "plan", ms: Date.now() - t1, found: found.length });
      if (/смес/i.test(q)) found = found.filter((h) => !/гипсокартон|плит|профил|подвес|краск|грунт/i.test(h.category || ""));
      found = found.slice(0, 6);
      t.found = found;
      bundle.searchHits(found);
      for (const h of found) allowed.add(h.id);
      if (!found.length) {
        const t2 = Date.now();
        // Сам сервер берёт только строки, где совпало не меньше двух слов
        // (одно слово в глубине описания — случайность).
        const items = callTool("search_knowledge", { terms: searchTerms(q).slice(0, 12), limit: 10, minScore: 2 }, ctx).items;
        calls.push({ name: "search_knowledge", source: "plan", ms: Date.now() - t2, found: items.length });
        if (items.length) { bundle.knowledge(items); for (const it of items) allowed.add(it.productId); } else {
          t.mode = "NOT_FOUND";
          t.fixed = "В данных Habez по этому вопросу ничего не нашлось. Уточните название товара (например, «ШОВ», «СТАНДАРТ», «ГКЛ») или задачу.";
        }
      }
    }
  },
};

// Подбор «для швов ГКЛ»: товары того же раздела, что и основание, — не ответ.
export const applicationSearchStage = {
  id: "application-search",
  when: (t) => !t.mode && t.route.intent === "application" && t.route.products.length,
  run(t) {
    const { route, q, ctx, bundle, calls, allowed, tenantId } = t;
    const t1 = Date.now();
    let hits = callTool("search_products", { terms: searchTerms(q).slice(0, 12), limit: 8 }, ctx).items;
    calls.push({ name: "search_products", source: "plan", ms: Date.now() - t1, found: hits.length });
    const base = new Set(all(`SELECT DISTINCT category_id AS c FROM products WHERE id IN (${route.products.map(() => "?").join(",")})`, ...route.products.map((p) => p.id)).map((r) => r.c));
    const catOf = new Map(all("SELECT id, category_id FROM products WHERE tenant_id=?", tenantId).map((r) => [r.id, r.category_id]));
    hits = hits.filter((h) => !base.has(catOf.get(h.id)));
    if (/смес/i.test(q)) hits = hits.filter((h) => !/гипсокартон|плит|профил|подвес|краск|грунт/i.test(h.category || ""));
    t.found = hits.slice(0, 6);
    bundle.searchHits(t.found);
    for (const h of t.found) allowed.add(h.id);
  },
};

// Режим по умолчанию. Вызывается после снимка пакета (ctxResult): пометка
// PRODUCT_APPLICATION попадает в итоговый пакет, но не в снимок, по
// которому строится текст для модели, — так было до 4.1 и так остаётся.
export function finalizeMode(t, ctxResult) {
  if (t.mode) return;
  const { route, products, bundle } = t;
  const disputed = ctxResult.properties.some((p) => ["conflict", "unresolved"].includes(p.status) || p.hiddenDisagreement);
  t.mode = route.intent === "comparison" && products.length >= 2 ? "COMPARISON" : disputed ? "CONFLICT" : "FACT";
  // Вопрос о воде, слое, расходе, времени работы — вопрос о применении.
  if (["spec_lookup", "condition"].includes(route.intent) && products.length === 1 && route.specs.keys.length && route.specs.keys.every((k) => APPLICATION_KEYS.has(k))) {
    t.mode = "PRODUCT_APPLICATION";
    bundle.note("\nПРИМЕНЕНИЕ: значения выше — структурированные; текст разделов карточки — со своими номерами. Раздели «указано в разделе» и «структурированное значение»; расхождения — все значения; «на мешок» не пересчитывать в «на кг»; общие знания не добавлять.");
  }
}

// Проверки ответа, общие для всех доменов (порядок — в handlers.js).
export const emptyAnswerCheck = {
  id: "empty-answer",
  run(t, v) { v.grounding.emptyAnswer = v.emptyAnswer; if (v.emptyAnswer) v.grounding.grounded = false; },
};
// Дата, которой нет в данных (правило 3.4, действует для любого ответа).
export const datesCheck = {
  id: "dates",
  run(t, v) {
    v.grounding.unsupportedDates = v.fixed ? [] : unsupportedDates(v.answer, v.final.text, t.q);
    if (v.grounding.unsupportedDates.length) v.grounding.grounded = false;
  },
};
