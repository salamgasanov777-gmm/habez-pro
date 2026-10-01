// Habez AI Agent: один ответ на вопрос.
//
//   вопрос
//   → справочники доменов по реестру (runtime/handlers.js → LOOKUPS)
//   → маршрут (retrieval/router.js): намерение (домены по приоритету —
//     DOMAIN_ROUTES, затем базовые правила 3.2/3.3), товары,
//     характеристики, условия, фасовка, отсылки к беседе
//   → этапы по реестру (handlers.js → STAGES): каждый домен — свой
//     обработчик; ответы без модели (NOT_FOUND, CLARIFICATION) — там же
//   → снимок пакета [E#] и режим по умолчанию (FACT | COMPARISON | CONFLICT |
//     PRODUCT_APPLICATION)
//   → модель с инструментами: если данных не хватает, она сама вызывает
//     инструмент (runtime/tool-runner.js), результат дописывается в пакет;
//     лимиты: вызовов, ходов, записей, знаков, общее время; повтор вызова
//     не выполняется; «Стоп» прекращает всё
//   → проверка ответа (checks/): вход проверки — ответ, данные [E#],
//     скрытое от роли, данные доменных проверок; затем общие, доменные
//     проверки и политика по реестру → находки и прежний grounding
//   → поток: status, meta, delta, reset, done
//
// Данные доменов в meta, ответе, метриках, ссылках таблиц и состоянии
// беседы собирает реестр (handlers.js → OUTPUTS); agent.js доменов не знает.
//
// Агент ничего не пишет в базу. Состояние беседы (о каком товаре речь)
// держит клиент: сервер получает его с вопросом и возвращает новое.
import { all } from "../../../db/index.js";
import { config } from "../../../config.js";
import { routeQuestion, nextState } from "../retrieval/router.js";
import { detectProducts } from "../retrieval/entities.js";
import { toolsForScope } from "../tools/index.js";
import { createBundle } from "./bundle.js";
import { createToolRunner } from "./tool-runner.js";
import { publicCitation } from "./context.js";
import { buildCheckInput } from "../checks/input.js";
import { runAnswerChecks } from "../checks/runner.js";
import { composeSystemPrompt } from "../prompts/system.js";
import { createTurn, runStages, collectCheckData, digestLines, loadLookups, collectOutput, collectRefs, collectState } from "./handlers.js";
import { finalizeMode } from "./base-handlers.js";

const MAX_HISTORY = 10;

// Старые реплики: не больше MAX_HISTORY и historyMaxChars знаков, самые
// свежие важнее. Номера [E#] старых ответов убираются: модель не должна
// ссылаться на них в новом ответе.
export function cleanHistory(history = [], maxChars = config.ai.agent.historyMaxChars) {
  const out = [];
  for (const m of history.slice(-MAX_HISTORY)) {
    if (!["user", "assistant"].includes(m?.role) || typeof m.content !== "string" || !m.content.trim()) continue;
    const content = m.content.replace(/[ \t]*\[E\d+\]/g, "").slice(0, 4000);
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

export async function runAgent({ tenantId, scope, question, history = [], state = {}, refBase = 0, provider, onEvent = () => {}, signal, budget: overrides = {} }) {
  const cfg = config.ai.agent;
  const budget = { maxToolCalls: cfg.maxToolCalls, maxTurns: cfg.maxTurns, maxEvidence: cfg.maxEvidence, maxContextChars: cfg.maxContextChars, totalTimeoutMs: cfg.totalTimeoutMs, ...overrides };
  const t0 = Date.now();
  const q = String(question || "").trim().slice(0, 2000);
  onEvent("status", { phase: "search", text: "Ищу данные…" });

  const catalog = all(`SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.sections, p.spec_tables, c.name AS category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=?${scope === "public" ? " AND p.status='published'" : ""}`, tenantId);
  // Справочники доменов — до маршрута (права на них проверяет домен).
  const lookups = loadLookups({ tenantId, scope });
  const route = routeQuestion(q, { catalog, state, scope, ...lookups.data });
  const bundle = createBundle({ scope, refBase, maxEvidence: budget.maxEvidence });

  // 1–2. Этапы по реестру: домены, ответы без модели, план инструментов.
  const t = runStages(createTurn({ tenantId, scope, q, state, catalog, route, bundle, lookups: lookups.data }));
  const ctxResult = bundle.result();
  finalizeMode(t, ctxResult);
  const { mode, fixed, clarification, awaiting, chosenVariant, products, found, calls, allowed, ctx } = t;
  const tRetrieval = Date.now();
  const conflicts = ctxResult.properties.filter((p) => p.status === "conflict" || p.status === "unresolved");
  const next = nextState(route, state, { variant: chosenVariant, awaiting, ...collectState(t) });
  const safeRoute = {
    intent: route.intent, products: route.products.map((p) => p.short_name || p.name), productSlugs: route.products.map((p) => p.slug), productsFrom: route.productsFrom,
    specs: route.specs.terms, specKeys: route.specs.keys, ambiguousSpec: route.specs.ambiguous, conditions: route.conditions,
    variant: chosenVariant?.unit ?? null, unknown: route.unknown, useCase: route.useCase, useCaseFrom: route.useCaseFrom,
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
    ...collectOutput(t, "meta"),
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
    const hints = { properties: ctxResult.properties, found: ctxResult.found, variants: ctxResult.variants, unknown: route.unknown, comparison: ctxResult.comparison, mode,
      lines: digestLines(t, ctxResult) };
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
  // Модель не вернула ни слова (редкий сбой провайдера): пустой ответ не
  // выдаётся за готовый — пользователь видит, что нужно повторить вопрос.
  const emptyAnswer = llm && !answer.trim();
  if (emptyAnswer) {
    answer = "Модель не вернула ответ. Данные по вопросу найдены — повторите вопрос, пожалуйста.";
    onEvent("delta", { text: answer });
  }

  // 4. Проверка по ВСЕМ данным ответа (план + инструменты модели).
  const final = bundle.result();
  // Товары, упомянутые в самих данных (подписи «Основание: ГКЛ и ГВЛ»,
  // «грунтовкой «Эконом»» в разделе), — тоже разрешены.
  const evidenceProducts = detectProducts(final.evidence.map((e) => `${e.value ?? ""} ${e.productName ?? ""} ${e.label ?? ""} ${e.property ?? ""}`).join(" \n "), catalog).map((p) => p.id);
  const allowedIds = new Set([...allowed, ...evidenceProducts]);
  const forbidden = forbiddenFor(tenantId, scope, [...allowedIds]);
  // Проверка ответа (checks/). Готовый ответ (уточнение, «нет данных»)
  // собран сервером из базы, а не моделью: проверять в нём нечего (fixed).
  const historyText = history.filter((m) => m?.role === "assistant").map((m) => m.content).join("\n");
  const checkInput = buildCheckInput({ answer, fixed: !!fixed, emptyAnswer, question: q, historyText, scope, evidence: final.evidence, contextText: final.text,
    forbidden, catalog, allowedProductIds: allowedIds, maskNames: lookups.maskNames, domains: collectCheckData(t, final) });
  const checked = runAnswerChecks(checkInput);
  const { grounding } = checked;
  const t1 = Date.now();
  const timings = {
    retrievalMs: tRetrieval - t0, contextMs: tContext - tRetrieval,
    llmFirstTokenMs: llm && firstTokenAt ? firstTokenAt - tContext : null, llmMs: llm ? tLlm - tContext : 0,
    validateMs: t1 - tLlm, totalMs: t1 - t0,
  };
  const metrics = {
    tool_calls: calls.length, tool_calls_plan: calls.filter((c) => c.source === "plan").length, tool_calls_model: calls.filter((c) => c.source === "model").length,
    turns, evidence: final.evidence.length, context_chars: bundle.size().chars,
    // Время этапов доменов.
    ...collectOutput(t, "metrics"),
    retrieval_ms: timings.retrievalMs, context_ms: timings.contextMs, model_ms: timings.llmMs, total_ms: timings.totalMs,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
  };
  // Источники: на что сослался ответ + ячейки таблицы сравнения (на них
  // можно нажать, даже если в тексте ссылки нет).
  const tableRefs = new Set([...(final.comparison?.rows || []).flatMap((r) => r.cells.flatMap((c) => c.refs || [])), ...collectRefs(t)]);
  const cited = [...checked.citations, ...final.evidence.filter((e) => tableRefs.has(e.id) && !checked.citations.includes(e))];
  const result = {
    answer, intent: route.intent, mode, route: safeRoute, scope, stopReason, usage,
    ...collectOutput(t, "result"),
    citations: cited.map((e) => publicCitation(e, scope)),
    grounding,
    withheld: grounding.forbidden > 0,
    model: llm ? provider.model : null, latencyMs: timings.totalMs, timings, metrics,
    toolCalls: calls.map((c) => ({ name: c.name, source: c.source, found: c.found })),
    sources: final.evidence.length, conflicts: conflicts.length,
    products: products.map((x) => x.p.id), found: found.map((h) => h.id), unknown: route.unknown,
    clarification, state: next, refBase,
    context: final, // для тестов и журнала без содержимого; наружу не отдаётся
    // Итог проверки по находкам и её вход — для повторной проверки без
    // модели (checks/recheck.js); наружу не отдаются (во входе — скрытое).
    verdict: { passed: checked.passed, findings: checked.findings },
    checkInput,
  };
  onEvent("done", {
    citations: result.withheld ? [] : result.citations, grounding, withheld: result.withheld, mode, clarification,
    state: next, refNext: refBase + final.evidence.length,
    model: result.model, latencyMs: result.latencyMs, timings, metrics, stopReason, truncated: stopReason === "max_tokens",
  });
  return result;
}
