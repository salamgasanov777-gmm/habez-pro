// Habez AI Agent (Phase 3.2): вызовы инструментов, которые просит модель.
//
// Модель называет товары и характеристики словами; сервер сам находит их
// (resolver, specs) и вызывает те же инструменты только чтения, что и
// план, с правами роли. Результат дописывается в общий пакет
// доказательств со следующими номерами [E#] и возвращается модели текстом.
//
// Ограничения: общий лимит вызовов на ответ, повтор того же вызова не
// выполняется, неизвестный инструмент и запрещённый роли — отказ текстом.
import { callTool, TOOL_SPECS, comparisonRows } from "../tools/index.js";
import { resolveProducts } from "../retrieval/resolver.js";
import { resolveSpecs, parseConditions, matchVariant } from "../retrieval/specs.js";
import { searchTerms } from "../retrieval/intent.js";
import { selectProperties, fetchProduct } from "./plan.js";

export function createToolRunner({ ctx, catalog, bundle, budget, calls, allowed }) {
  const seen = new Set();
  const product = (name) => {
    const hit = resolveProducts(String(name || ""), catalog).products[0];
    return hit ? catalog.find((p) => p.id === hit.id) : null;
  };
  const routeFor = (specs = []) => {
    const r = resolveSpecs((specs || []).join(", "));
    return { specs: { keys: r.keys, terms: r.terms, groups: r.groups.map((g) => ({ label: g.label, keys: g.keys })), ambiguous: r.ambiguous } };
  };

  function addProduct(p, input, route) {
    const variant = matchVariant(`${input.condition || ""} ${input.product || ""}`, p.variants || []);
    const got = fetchProduct(ctx, p.id, route, calls, { variant, source: "model" });
    if (!got) return false;
    const sel = selectProperties(got.sp, got.p, { keys: route.specs.keys, groups: route.specs.groups, conditions: parseConditions(input.condition || ""), variant });
    bundle.product(got.p, got.sp, { missing: sel.missing, otherConditions: sel.otherConditions, strengthAmbiguous: route.specs.ambiguous === "strength", variant });
    allowed.add(p.id);
    return true;
  }

  return function run(name, input = {}) {
    const spec = TOOL_SPECS[name];
    if (!spec) return `Инструмента ${name} нет.`;
    if (name === "get_product_evidence" && ctx.scope === "public") return "Этот инструмент вашему уровню доступа недоступен.";
    const key = `${name}:${JSON.stringify(input)}`;
    if (seen.has(key)) return "Этот вызов уже выполнялся — его результат выше. Отвечай по имеющимся данным.";
    // Лимит — на вызовы модели; план (что сервер нашёл сам) в него не входит.
    if (calls.filter((c) => c.source === "model").length >= budget.maxToolCalls) return "Лимит обращений к данным на этот ответ исчерпан. Отвечай по имеющимся данным и скажи, чего не хватает.";
    seen.add(key);
    const mark = bundle.mark();
    const t0 = Date.now();
    try {
      if (name === "search_products" || name === "search_knowledge") {
        const terms = searchTerms(String(input.query || "")).slice(0, 12);
        const out = callTool(name, { terms, limit: name === "search_products" ? 6 : 10 }, ctx).items;
        calls.push({ name, source: "model", ms: Date.now() - t0, found: out.length });
        for (const it of out) allowed.add(it.id ?? it.productId);
        if (name === "search_products") bundle.searchHits(out); else bundle.knowledge(out);
      } else if (name === "compare_products") {
        const ps = (input.products || []).map(product).filter(Boolean);
        if (ps.length < 2) return "Для сравнения нужны два товара из каталога Habez — один или оба не найдены.";
        const route = routeFor(input.specs);
        const keys = route.specs.keys;
        const cmp = callTool("compare_products", { productIds: ps.map((p) => p.id) }, ctx);
        for (const it of cmp.items) selectProperties(it, { variants: [] }, { keys, groups: route.specs.groups });
        cmp.rows = comparisonRows(cmp.items);
        calls.push({ name, source: "model", ms: Date.now() - t0, found: cmp.items.length });
        for (const it of cmp.items) {
          const p = callTool("get_product", { productId: it.product.id }, ctx);
          if (!p) continue;
          p.sections = [];
          bundle.product(p, it, {});
          allowed.add(p.id);
        }
        bundle.comparison(cmp);
      } else if (name === "get_product_evidence") {
        const p = product(input.product);
        if (!p) return `Товара «${input.product}» в каталоге Habez нет.`;
        const keys = routeFor(input.specs).specs.keys;
        const ev = callTool("get_product_evidence", { productId: p.id }, ctx);
        calls.push({ name, source: "model", ms: Date.now() - t0, found: ev?.properties?.length ?? 0 });
        const items = (ev?.properties || []).filter((g) => !keys.length || keys.includes(g.specKey)).flatMap((g) => g.observations.map((o) => ({
          type: "observation", productId: p.id, slug: p.slug, product: p.name, observationId: o.id, key: g.specKey, label: g.label, value: o.originalValue,
          condition: o.conditionText, sourceType: o.sourceType, reference: o.sourceReference, access: o.accessLevel, verification: o.verificationStatus,
        }))).slice(0, 30);
        allowed.add(p.id);
        bundle.knowledge(items);
      } else {
        const p = product(input.product);
        if (!p) return `Товара «${input.product}» в каталоге Habez нет — данных о нём нет.`;
        const route = name === "get_product" ? { specs: { keys: [], groups: [] } } : routeFor(input.specs);
        if (name === "get_product") {
          const got = callTool("get_product", { productId: p.id }, ctx);
          calls.push({ name, source: "model", ms: Date.now() - t0, found: got ? 1 : 0 });
          if (got) { bundle.product(got, null, {}); allowed.add(p.id); }
        } else if (!addProduct(p, input, route)) return `Товар «${input.product}» недоступен.`;
      }
    } catch (e) {
      return `Не удалось получить данные: ${e.message}`;
    }
    return bundle.since(mark) || "Ничего не найдено.";
  };
}
