// Habez AI Agent: один ответ на вопрос (Phase 3.2 — агент с инструментами).
//
//   вопрос
//   → маршрут (retrieval/router.js): намерение, товары, характеристики,
//     условия, фасовка, отсылки к беседе («у него», «их», «А у Стандарта?»)
//   → решения без модели: товара нет → NOT_FOUND; неясно, какой товар или
//     какая фасовка → CLARIFICATION
//   → план: инструменты чтения по маршруту (get_product, get_product_specs,
//     compare_products, search_products, search_knowledge)
//   → выборка (runtime/plan.js): характеристики, условия, фасовка
//   → режим: FACT | COMPARISON | CONFLICT | NOT_FOUND | CLARIFICATION
//   → пакет доказательств с номерами [E#] (runtime/bundle.js)
//   → модель с инструментами: если данных не хватает, она сама вызывает
//     инструмент (runtime/tool-runner.js), результат дописывается в пакет;
//     лимиты: вызовов, ходов, записей, знаков, общее время; повтор вызова
//     не выполняется; «Стоп» прекращает всё
//   → проверка ответа (runtime/context.js → checkAnswer)
//   → поток: status, meta, delta, reset, done
//
// Агент ничего не пишет в базу. Состояние беседы (о каком товаре речь)
// держит клиент: сервер получает его с вопросом и возвращает новое.
import { all } from "../../../db/index.js";
import { config } from "../../../config.js";
import { routeQuestion, nextState } from "../retrieval/router.js";
import { matchVariant, VARIANT_SPEC_KEYS } from "../retrieval/specs.js";
import { searchTerms } from "../retrieval/intent.js";
import { detectProducts } from "../retrieval/entities.js";
import { callTool, comparisonRows, toolsForScope } from "../tools/index.js";
import { createBundle } from "./bundle.js";
import { selectProperties, fetchProduct, specGroups } from "./plan.js";
import { createToolRunner } from "./tool-runner.js";
import { checkAnswer, publicCitation } from "./context.js";
import { composeSystemPrompt } from "../prompts/system.js";

const MAX_PRODUCTS = 4;
const MAX_HISTORY = 10;

// Старые реплики: не больше MAX_HISTORY и historyMaxChars знаков, самые
// свежие важнее. Номера [E#] старых ответов убираются: модель не должна
// ссылаться на них в новом ответе.
export function cleanHistory(history = [], maxChars = config.ai.agent.historyMaxChars) {
  const out = [];
  for (const m of history.slice(-MAX_HISTORY)) {
    if (!["user", "assistant"].includes(m?.role) || typeof m.content !== "string" || !m.content.trim()) continue;
    const content = m.content.replace(/\[E\d+\]/g, "").slice(0, 4000);
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += `\n${content}`;
    else out.push({ role: m.role, content });
  }
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length && total > maxChars) total -= out.shift().content.length;
  while (out.length && out[0].role !== "user") out.shift();
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

// Что роли показывать нельзя — для проверки ответа (значения остаются на
// сервере). Гостю — все наблюдения, сотруднику — конфиденциальные.
function forbiddenFor(tenantId, scope, productIds) {
  if (scope === "admin" || !productIds.length) return [];
  const levels = scope === "public" ? ["public", "internal", "confidential"] : ["confidential"];
  return all(`SELECT original_value AS value, source_reference AS reference FROM ai_spec_observations
     WHERE tenant_id=? AND product_id IN (${productIds.map(() => "?").join(",")}) AND access_level IN (${levels.map(() => "?").join(",")})`,
  tenantId, ...productIds, ...levels);
}

const names = (list) => list.map((n) => `«${n}»`).join(", ").replace(/, ([^,]*)$/, " или $1");

export async function runAgent({ tenantId, scope, question, history = [], state = {}, refBase = 0, provider, onEvent = () => {}, signal, budget: overrides = {} }) {
  const cfg = config.ai.agent;
  const budget = { maxToolCalls: cfg.maxToolCalls, maxTurns: cfg.maxTurns, maxEvidence: cfg.maxEvidence, maxContextChars: cfg.maxContextChars, totalTimeoutMs: cfg.totalTimeoutMs, ...overrides };
  const t0 = Date.now();
  const q = String(question || "").trim().slice(0, 2000);
  const ctx = { tenantId, scope };
  const calls = [];
  onEvent("status", { phase: "search", text: "Ищу данные…" });

  const catalog = all(`SELECT id, slug, name, short_name, summary, sections, spec_tables FROM products WHERE tenant_id=?${scope === "public" ? " AND status='published'" : ""}`, tenantId);
  const route = routeQuestion(q, { catalog, state });
  const bundle = createBundle({ scope, refBase, maxEvidence: budget.maxEvidence });
  const allowed = new Set();
  const groups = specGroups(route);
  let mode = null;
  let fixed = null;
  let clarification = null;
  let awaiting = null;
  let chosenVariant = null;
  const products = [];
  let found = [];

  // 1. Без модели: товара нет или неясно, о каком речь.
  if (!route.products.length) {
    if (route.unknown.length) {
      mode = "NOT_FOUND";
      fixed = `Товара ${names(route.unknown)} в каталоге Habez нет, поэтому данных о нём тоже нет. Проверьте название или спросите о задаче — подскажу, что из ассортимента Habez подходит.`;
    } else if (route.ambiguousProducts.length && route.intent !== "application") {
      const opts = route.ambiguousProducts[0].candidates.map((p) => p.short_name || p.name);
      mode = "CLARIFICATION"; awaiting = "product";
      clarification = { question: `Уточните, какой товар: ${names(opts)}?`, options: opts };
    } else if (route.needs.includes("which_product")) {
      const opts = (state.current_products || []).map((s) => catalog.find((p) => p.slug === s)).filter(Boolean).map((p) => p.short_name || p.name);
      mode = "CLARIFICATION"; awaiting = "product";
      clarification = { question: `О каком товаре речь: ${names(opts)}?`, options: opts };
    } else if (route.needs.includes("products")) {
      mode = "CLARIFICATION"; awaiting = "products";
      clarification = { question: "Какие товары сравнить? Назовите два–четыре товара, например «ШОВ и СТАНДАРТ».", options: [] };
    }
    if (clarification) fixed = clarification.question;
  }
  // «Сравни … по трём характеристикам» — каким, не сказано: спрашиваем.
  if (!mode && route.intent === "comparison" && route.products.length >= 2 && !route.specs.keys.length
    && /по (дв|тр|четыр|пят|нескольк|\d)[а-яё]* (основн[а-яё]* )?(характеристик|параметр|показател)/i.test(q)) {
    const opts = ["прочность", "время схватывания", "расход воды"];
    mode = "CLARIFICATION"; awaiting = null;
    clarification = { question: `По каким характеристикам сравнить ${names(route.products.map((p) => p.short_name || p.name)).replace(" или ", " и ")}? Например: ${opts.join(", ")}.`, options: [`Сравни ${route.products.map((p) => p.short_name || p.name).join(" и ")} по прочности, времени схватывания и расходу воды`] };
    fixed = clarification.question;
  }
  for (const n of route.unknown) if (route.products.length) bundle.note(`ТОВАРА «${n}» В КАТАЛОГЕ HABEZ НЕТ — данных о нём нет, ничего о нём не утверждать.`);

  // 2. План: инструменты чтения по маршруту.
  if (!mode && route.products.length && route.intent !== "application") {
    const keys = route.specs.keys || [];
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
            mode = "CLARIFICATION"; awaiting = "variant";
            clarification = { question: `Для какой фасовки ${p.short || p.name}: ${names(opts)}?`, options: opts };
            fixed = clarification.question;
            products.push({ p, sp, sel: { missing: [], otherConditions: [] } });
            break;
          }
        }
        // Сначала отбор (он сверяет строки со ВСЕМИ фасовками), потом из
        // карточки убираются чужие фасовки.
        const sel = selectProperties(sp, p, { keys, groups, conditions, variant, packaging });
        if (variant) { chosenVariant = { product: p.slug, unit: variant.unit }; p.variants = p.variants.filter((v) => v.id === variant.id); }
        if (route.intent === "conflict") sp.properties = sp.properties.filter((x) => ["conflict", "unresolved"].includes(x.status) || x.hiddenDisagreement || x.hiddenConfidential);
        // Для вопроса о числе — только разделы карточки со словами вопроса.
        if (!["product_lookup", "unknown"].includes(route.intent)) {
          const own = new Set(route.products.map((x) => String(x.short_name || "").toLowerCase().replace(/ё/g, "е")));
          const terms = searchTerms(q).filter((t) => ![...own].some((n) => n && (n.startsWith(t) || t.startsWith(n))));
          p.sections = (p.sections || []).filter((sec) => terms.some((t) => sec.text.toLowerCase().replace(/ё/g, "е").includes(t)));
        }
        products.push({ p, sp, sel, variant });
      }
      if (!mode) {
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
    if (!mode && groups.length && products.length && products.every((x) => groups.every((g) => x.sel.missing.includes(g.label)))) {
      mode = "NOT_FOUND";
      const other = [...new Set(products.flatMap((x) => x.sel.otherConditions))];
      fixed = `В данных Habez нет ${groups.map((g) => `«${g.label}»`).join(", ")} для ${products.map((x) => x.p.short || x.p.name).join(" и ")}${Object.keys(route.conditions || {}).length ? " при условии из вопроса" : ""}.`
        + (other.length ? ` Значения есть только для других условий (${other.join("; ")}) — к вашему вопросу они не относятся.` : "");
    }
  } else if (!mode && !route.products.length) {
    // Товар не назван: подбор по задаче и общий поиск.
    const t1 = Date.now();
    found = callTool("search_products", { terms: searchTerms(q).slice(0, 12), limit: 8 }, ctx).items;
    calls.push({ name: "search_products", source: "plan", ms: Date.now() - t1, found: found.length });
    if (/смес/i.test(q)) found = found.filter((h) => !/гипсокартон|плит|профил|подвес|краск|грунт/i.test(h.category || ""));
    found = found.slice(0, 6);
    bundle.searchHits(found);
    for (const h of found) allowed.add(h.id);
    if (!found.length) {
      const t2 = Date.now();
      // Сам сервер берёт только строки, где совпало не меньше двух слов
      // (одно слово в глубине описания — случайность).
      const items = callTool("search_knowledge", { terms: searchTerms(q).slice(0, 12), limit: 10, minScore: 2 }, ctx).items;
      calls.push({ name: "search_knowledge", source: "plan", ms: Date.now() - t2, found: items.length });
      if (items.length) { bundle.knowledge(items); for (const it of items) allowed.add(it.productId); } else {
        mode = "NOT_FOUND";
        fixed = "В данных Habez по этому вопросу ничего не нашлось. Уточните название товара (например, «ШОВ», «СТАНДАРТ», «ГКЛ») или задачу.";
      }
    }
  }
  // Подбор «для швов ГКЛ»: товары того же раздела, что и основание, — не ответ.
  if (!mode && route.intent === "application" && route.products.length) {
    const t1 = Date.now();
    let hits = callTool("search_products", { terms: searchTerms(q).slice(0, 12), limit: 8 }, ctx).items;
    calls.push({ name: "search_products", source: "plan", ms: Date.now() - t1, found: hits.length });
    const base = new Set(all(`SELECT DISTINCT category_id AS c FROM products WHERE id IN (${route.products.map(() => "?").join(",")})`, ...route.products.map((p) => p.id)).map((r) => r.c));
    const catOf = new Map(all("SELECT id, category_id FROM products WHERE tenant_id=?", tenantId).map((r) => [r.id, r.category_id]));
    hits = hits.filter((h) => !base.has(catOf.get(h.id)));
    if (/смес/i.test(q)) hits = hits.filter((h) => !/гипсокартон|плит|профил|подвес|краск|грунт/i.test(h.category || ""));
    found = hits.slice(0, 6);
    bundle.searchHits(found);
    for (const h of found) allowed.add(h.id);
  }

  const ctxResult = bundle.result();
  if (!mode) {
    const disputed = ctxResult.properties.some((p) => ["conflict", "unresolved"].includes(p.status) || p.hiddenDisagreement);
    mode = route.intent === "comparison" && products.length >= 2 ? "COMPARISON" : disputed ? "CONFLICT" : "FACT";
  }
  const tRetrieval = Date.now();
  const conflicts = ctxResult.properties.filter((p) => p.status === "conflict" || p.status === "unresolved");
  const next = nextState(route, state, { variant: chosenVariant, awaiting });
  const safeRoute = {
    intent: route.intent, products: route.products.map((p) => p.short_name || p.name), productSlugs: route.products.map((p) => p.slug), productsFrom: route.productsFrom,
    specs: route.specs.terms, specKeys: route.specs.keys, ambiguousSpec: route.specs.ambiguous, conditions: route.conditions,
    variant: chosenVariant?.unit ?? null, unknown: route.unknown,
  };
  onEvent("meta", {
    intent: route.intent, scope, mode, route: safeRoute,
    products: products.map((x) => ({ id: x.p.id, name: x.p.name, slug: x.p.slug })),
    found: found.map((h) => ({ id: h.id, name: h.name, slug: h.slug })),
    unknown: route.unknown,
    conflicts: conflicts.map((c) => ({ product: c.product, label: c.label, condition: c.conditionText, variant: c.variant, status: c.status,
      decisions: c.items, values: c.values.map((v) => (v.hidden ? { hidden: true } : { display: v.display, refs: v.refs })) })),
    withheldProperties: ctxResult.properties.filter((p) => p.hiddenDisagreement).map((p) => ({ product: p.product, label: p.label })),
    comparison: ctxResult.comparison,
    clarification,
    evidenceCount: ctxResult.evidence.length, refBase,
  });

  // 3. Ответ: готовый (без модели) или модель с инструментами.
  let answer = "";
  let stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let firstTokenAt = null;
  let turns = 0;
  let llm = false;
  const tContext = Date.now();
  if (fixed) {
    answer = fixed;
    onEvent("delta", { text: answer });
  } else {
    llm = true;
    onEvent("status", { phase: "write", text: "Проверяю источники…" });
    const tools = provider.capabilities?.tools && budget.maxToolCalls > 0 && budget.maxTurns > 1 ? toolsForScope(scope) : null;
    const runner = createToolRunner({ ctx, catalog, bundle, budget, calls, allowed });
    const system = composeSystemPrompt({ mode, tools: !!tools });
    const size = bundle.size();
    const text = size.chars > budget.maxContextChars ? `${ctxResult.text.slice(0, budget.maxContextChars)}\n(данные обрезаны по лимиту контекста)` : ctxResult.text;
    let messages = [...cleanHistory(history), { role: "user", content: `ДАННЫЕ HABEZ:\n${text}\n\nВОПРОС: ${q}` }];
    const timeout = AbortSignal.timeout(budget.totalTimeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const hints = { properties: ctxResult.properties, found: ctxResult.found, variants: ctxResult.variants, unknown: route.unknown, comparison: ctxResult.comparison, mode };
    for (let turn = 1; turn <= budget.maxTurns; turn += 1) {
      turns = turn;
      // Последний ход — без вызовов: модель отвечает по тому, что есть.
      const last = turn === budget.maxTurns;
      let turnText = "";
      const uses = [];
      let content = [];
      for await (const ev of provider.stream({ system, messages, maxTokens: provider.capabilities.maxOutputTokens, signal: sig, hints,
        tools: tools || undefined, toolChoice: tools && last ? "none" : undefined })) {
        if (ev.type === "text") {
          firstTokenAt ??= Date.now();
          turnText += ev.text;
          onEvent("delta", { text: ev.text });
        } else if (ev.type === "tool_use") uses.push(ev);
        else if (ev.type === "done") {
          stopReason = ev.stopReason;
          usage.input_tokens += ev.usage?.input_tokens || 0;
          usage.output_tokens += ev.usage?.output_tokens || 0;
          content = ev.content || [];
        }
      }
      if (!uses.length || last) { answer = turnText; break; }
      // Модель попросила данные: текст этого хода не ответ — убираем с экрана.
      if (turnText) onEvent("reset", {});
      onEvent("status", { phase: "check", text: "Ищу дополнительные данные…" });
      const results = uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: runner(u.name, u.input) }));
      const exhausted = calls.filter((c) => c.source === "model").length >= budget.maxToolCalls || turn + 1 === budget.maxTurns;
      messages = [...messages,
        { role: "assistant", content: content.length ? content : uses.map((u) => ({ type: "tool_use", id: u.id, name: u.name, input: u.input })) },
        { role: "user", content: [...results, ...(exhausted ? [{ type: "text", text: "Лимит обращений к данным исчерпан: ответь по имеющимся данным, чего нет — так и скажи." }] : [])] }];
      onEvent("status", { phase: "write", text: "Проверяю источники…" });
    }
  }
  const tLlm = Date.now();

  // 4. Проверка по ВСЕМ данным ответа (план + инструменты модели).
  const final = bundle.result();
  // Товары, упомянутые в самих данных (подписи «Основание: ГКЛ и ГВЛ»,
  // «грунтовкой «Эконом»» в разделе), — тоже разрешены.
  const evidenceProducts = detectProducts(final.evidence.map((e) => `${e.value ?? ""} ${e.productName ?? ""} ${e.label ?? ""} ${e.property ?? ""}`).join(" \n "), catalog).map((p) => p.id);
  const allowedIds = new Set([...allowed, ...evidenceProducts]);
  const forbidden = forbiddenFor(tenantId, scope, [...allowedIds]);
  // Готовый ответ (уточнение, «нет данных») собран сервером из базы, а не
  // моделью: проверять в нём нечего.
  const check = fixed
    ? { citations: [], invalidCitations: [], unsupported: [], mismatched: [], uncited: [], echoed: [], forbidden: [], foreignProducts: [], grounded: true }
    : checkAnswer(answer, final.evidence, { question: q, forbidden, catalog, allowedProductIds: allowedIds,
      contextText: final.text, historyText: history.filter((m) => m?.role === "assistant").map((m) => m.content).join("\n") });
  const t1 = Date.now();
  const timings = {
    retrievalMs: tRetrieval - t0, contextMs: tContext - tRetrieval,
    llmFirstTokenMs: llm && firstTokenAt ? firstTokenAt - tContext : null, llmMs: llm ? tLlm - tContext : 0,
    validateMs: t1 - tLlm, totalMs: t1 - t0,
  };
  const grounding = {
    grounded: check.grounded, unsupported: check.unsupported, mismatched: check.mismatched, uncited: check.uncited,
    echoed: check.echoed, invalidCitations: check.invalidCitations, forbidden: check.forbidden.length, foreignProducts: check.foreignProducts,
    fromHistory: check.fromHistory || [],
  };
  const metrics = {
    tool_calls: calls.length, tool_calls_plan: calls.filter((c) => c.source === "plan").length, tool_calls_model: calls.filter((c) => c.source === "model").length,
    turns, evidence: final.evidence.length, context_chars: bundle.size().chars,
    retrieval_ms: timings.retrievalMs, context_ms: timings.contextMs, model_ms: timings.llmMs, total_ms: timings.totalMs,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
  };
  // Источники: на что сослался ответ + ячейки таблицы сравнения (на них
  // можно нажать, даже если в тексте ссылки нет).
  const tableRefs = new Set((final.comparison?.rows || []).flatMap((r) => r.cells.flatMap((c) => c.refs || [])));
  const cited = [...check.citations, ...final.evidence.filter((e) => tableRefs.has(e.id) && !check.citations.includes(e))];
  const result = {
    answer, intent: route.intent, mode, route: safeRoute, scope, stopReason, usage,
    citations: cited.map((e) => publicCitation(e, scope)),
    grounding,
    withheld: check.forbidden.length > 0,
    model: llm ? provider.model : null, latencyMs: timings.totalMs, timings, metrics,
    toolCalls: calls.map((c) => ({ name: c.name, source: c.source, found: c.found })),
    sources: final.evidence.length, conflicts: conflicts.length,
    products: products.map((x) => x.p.id), found: found.map((h) => h.id), unknown: route.unknown,
    clarification, state: next, refBase,
    context: final, // для тестов и журнала без содержимого; наружу не отдаётся
  };
  onEvent("done", {
    citations: result.withheld ? [] : result.citations, grounding, withheld: result.withheld, mode, clarification,
    state: next, refNext: refBase + final.evidence.length,
    model: result.model, latencyMs: result.latencyMs, timings, metrics, stopReason, truncated: stopReason === "max_tokens",
  });
  return result;
}
