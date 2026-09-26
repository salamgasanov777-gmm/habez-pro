// Habez AI Agent: один ответ на вопрос. Контракт слоёв:
//
//   request     { tenantId, scope, question, history }         ← routes.js
//   → intent    detectIntent(q) → compare|packaging|spec|…      retrieval/intent.js
//   → retrieval detectProducts / unknownNames / callTool(…)      retrieval/entities.js, tools/
//   → evidence  get_product_specs → свойства с наблюдениями      tools/, knowledge/evidence.js
//   → conflicts single | agreed | conflict | unresolved          retrieval/conflicts.js
//   → context   buildContext → текст с [E#] + реестр evidence    runtime/context.js
//   → LLM       provider.stream({ system, messages, … })         provider/
//   → validate  checkAnswer(answer, evidence, { question, forbidden })
//   → stream    onEvent("meta" | "delta" | "done")               routes.js → SSE
//
// Агент ничего не пишет в базу. Состояние беседы держит клиент: сервер
// получает историю с каждым вопросом (не больше 10 реплик и
// historyMaxChars знаков) и не хранит её.
import { all } from "../../../db/index.js";
import { config } from "../../../config.js";
import { detectIntent, specFilter, searchTerms } from "../retrieval/intent.js";
import { detectProducts, unknownNames } from "../retrieval/entities.js";
import { callTool } from "../tools/index.js";
import { buildContext, checkAnswer, publicCitation } from "./context.js";
import { composeSystemPrompt } from "../prompts/system.js";

const MAX_PRODUCTS = 4;
const MAX_HISTORY = 10;
const PACKAGING_KEYS = /thickness|sheet|area|weight|per_pallet|size/;

// Старые реплики: не больше MAX_HISTORY и historyMaxChars знаков, самые
// свежие важнее. Номера [E#] старых ответов относились к старому контексту —
// убираем, чтобы модель не сослалась на них в новом ответе.
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
  if (out.length && out[out.length - 1].role === "user") out.pop(); // текущий вопрос добавится отдельно
  return out;
}

// Подставленное программой (история 40 шт. на поддоне, удалённых сверкой
// 2.2D) — не данные товара: в контекст модели не идёт.
const onlyGenerated = (prop) => prop.values.length > 0 && prop.values.every((v) => !v.hidden && v.evidence.length && v.evidence.every((e) => e.sourceType === "generated_default"));

// Что этой роли показывать нельзя: для проверки ответа (значения на сервере,
// наружу не уходят). Гостю — все наблюдения (он видит только витрину),
// сотруднику — конфиденциальные, администратору — ничего.
function forbiddenFor(tenantId, scope, productIds) {
  if (scope === "admin" || !productIds.length) return [];
  const levels = scope === "public" ? ["public", "internal", "confidential"] : ["confidential"];
  return all(`SELECT original_value AS value, source_reference AS reference FROM ai_spec_observations
     WHERE tenant_id=? AND product_id IN (${productIds.map(() => "?").join(",")}) AND access_level IN (${levels.map(() => "?").join(",")})`,
  tenantId, ...productIds, ...levels);
}

export async function runAgent({ tenantId, scope, question, history = [], provider, onEvent = () => {}, signal }) {
  const t0 = Date.now();
  const q = String(question || "").trim().slice(0, 2000);
  const intent = detectIntent(q);
  const ctx = { tenantId, scope };

  const catalog = all(`SELECT id, slug, name, short_name, summary, sections FROM products WHERE tenant_id=?${scope === "public" ? " AND status='published'" : ""}`, tenantId);
  let detected = detectProducts(q, catalog);
  // Уточняющий вопрос («а прочность?») — товар из прошлой реплики.
  if (!detected.length && history.length) {
    for (const m of [...history].reverse()) {
      if (m?.role !== "user") continue;
      detected = detectProducts(m.content || "", catalog);
      if (detected.length) break;
    }
  }
  detected = detected.slice(0, MAX_PRODUCTS);
  const unknown = unknownNames(q, catalog.map((p) => `${p.name} ${p.short_name || ""} ${p.slug} ${p.summary || ""} ${p.sections || ""}`).join(" "));

  const keyFilter = intent === "spec" || intent === "compare" ? specFilter(q) : null;
  let products = [];
  let searchHits = [];
  const missing = [];
  // Названный товар неизвестен, а известных нет — искать «похожее» по
  // словам не нужно: честный ответ — «такого товара нет».
  if (unknown.length && !detected.length) {
    // ничего не ищем
  } else if (intent === "recommend" || !detected.length) {
    // «Что подходит для…» — ищем по каталогу, а названный в вопросе товар —
    // это, как правило, то, к чему подбираем (ГКЛ для «швов ГКЛ»).
    searchHits = callTool("search_products", { terms: searchTerms(q), limit: 8 }, ctx).items;
    // В «что подходит для швов ГКЛ» ГКЛ — основание, а не ответ: товары его
    // раздела из подбора убираем.
    if (intent === "recommend" && detected.length) {
      const targetCats = new Set(all(`SELECT DISTINCT category_id AS c FROM products WHERE id IN (${detected.map(() => "?").join(",")})`, ...detected.map((d) => d.id)).map((r) => r.c));
      const catOf = new Map(all("SELECT id, category_id FROM products WHERE tenant_id=?", tenantId).map((r) => [r.id, r.category_id]));
      searchHits = searchHits.filter((h) => !targetCats.has(catOf.get(h.id)));
    }
    // «Сухие смеси» — это не листы, плиты, профили, краски и грунтовки.
    if (/смес/i.test(q)) searchHits = searchHits.filter((h) => !/гипсокартон|плит|профил|подвес|краск|грунт/i.test(h.category || ""));
    searchHits = searchHits.slice(0, 6);
  }
  if (intent !== "recommend") {
    products = detected.map((p) => callTool("get_product", { productId: p.id }, ctx)).filter(Boolean);
  }
  // Характеристики: для сравнения — одним вызовом compare_products (те же
  // права и тот же слой споров), иначе — get_product_specs по товару.
  const specList = intent === "compare" && products.length >= 2
    ? callTool("compare_products", { productIds: products.map((p) => p.id), keyFilter }, ctx).items
    : products.map((p) => callTool("get_product_specs", { productId: p.id, keyFilter }, ctx)).filter(Boolean);
  const specs = new Map();
  for (const s of specList) {
    const p = products.find((x) => x.id === s.product.id);
    s.properties = s.properties.filter((x) => !onlyGenerated(x));
    if (intent === "packaging") s.properties = s.properties.filter((x) => x.packaging || (x.key && PACKAGING_KEYS.test(x.key)) || x.variant);
    s.properties = s.properties.slice(0, 60);
    if (keyFilter && !s.properties.length) missing.push(p.id);
    specs.set(p.id, s);
    // Описания нужны для рассказа о товаре; для вопроса о числе — только
    // разделы со словами вопроса («5–7 литров воды на 1 мешок»).
    if (!["overview", "search"].includes(intent)) {
      // Имя товара в вопросе («шов») — не повод брать все его разделы.
      const names = new Set(detected.map((d) => String(d.short_name || "").toLowerCase().replace(/ё/g, "е")));
      const terms = searchTerms(q).filter((t) => ![...names].some((n) => n && (n.startsWith(t) || t.startsWith(n))));
      p.sections = (p.sections || []).filter((sec) => terms.some((t) => sec.text.toLowerCase().replace(/ё/g, "е").includes(t)));
    }
  }
  const tRetrieval = Date.now();

  const context = buildContext({ scope, products, specs, searchHits, unknown, missing });
  const forbidden = forbiddenFor(tenantId, scope, products.map((p) => p.id));
  const conflicts = context.properties.filter((p) => p.status === "conflict" || p.status === "unresolved");
  const tContext = Date.now();
  onEvent("meta", {
    intent, scope,
    products: products.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    found: searchHits.map((h) => ({ id: h.id, name: h.name, slug: h.slug })),
    unknown,
    conflicts: conflicts.map((c) => ({ product: c.product, label: c.label, condition: c.conditionText, variant: c.variant, status: c.status,
      decisions: c.items, values: c.values.map((v) => (v.hidden ? { hidden: true } : { display: v.display, refs: v.refs })) })),
    evidenceCount: context.evidence.length,
  });

  let answer = "";
  let stopReason = null;
  let usage = {};
  let firstTokenAt = null;
  let llm = false;
  if (!products.length && !searchHits.length) {
    // Без данных модель не спрашиваем: отвечать ей не на чем, а выдумывать нельзя.
    answer = unknown.length
      ? `Товара ${unknown.map((n) => `«${n}»`).join(", ")} в каталоге Habez нет, поэтому данных о нём тоже нет. Проверьте название или спросите о задаче — подскажу, что из ассортимента Habez подходит.`
      : "В данных Habez по этому вопросу ничего не нашлось. Уточните название товара (например, «ШОВ», «СТАНДАРТ», «ГКЛ») или задачу.";
    onEvent("delta", { text: answer });
  } else {
    llm = true;
    const messages = [...cleanHistory(history), { role: "user", content: `ДАННЫЕ HABEZ:\n${context.text}\n\nВОПРОС: ${q}` }];
    const hints = { properties: context.properties, found: context.found, variants: context.variants, unknown };
    for await (const ev of provider.stream({ system: composeSystemPrompt(), messages, maxTokens: provider.capabilities.maxOutputTokens, signal, hints })) {
      if (ev.type === "text") {
        firstTokenAt ??= Date.now();
        answer += ev.text;
        onEvent("delta", { text: ev.text });
      } else if (ev.type === "done") { stopReason = ev.stopReason; usage = ev.usage || {}; }
    }
  }
  const tLlm = Date.now();

  const check = checkAnswer(answer, context.evidence, { question: q, forbidden });
  const t1 = Date.now();
  const timings = {
    retrievalMs: tRetrieval - t0, contextMs: tContext - tRetrieval,
    llmFirstTokenMs: llm && firstTokenAt ? firstTokenAt - tContext : null, llmMs: llm ? tLlm - tContext : 0,
    validateMs: t1 - tLlm, totalMs: t1 - t0,
  };
  const grounding = {
    grounded: check.grounded, unsupported: check.unsupported, mismatched: check.mismatched, uncited: check.uncited,
    echoed: check.echoed, invalidCitations: check.invalidCitations, forbidden: check.forbidden.length,
  };
  const result = {
    answer, intent, scope, stopReason, usage,
    citations: check.citations.map((e) => publicCitation(e, scope)),
    grounding,
    // Ответ с недоступными роли данными не показывается: интерфейс заменит
    // его текст предупреждением (поток уже ушёл, но на экране не останется).
    withheld: check.forbidden.length > 0,
    model: llm ? provider.model : null, latencyMs: timings.totalMs, timings,
    sources: context.evidence.length, conflicts: conflicts.length,
    products: products.map((p) => p.id), found: searchHits.map((h) => h.id), unknown,
    context, // для тестов и журнала без содержимого; наружу не отдаётся
  };
  onEvent("done", {
    citations: result.withheld ? [] : result.citations, grounding, withheld: result.withheld,
    model: result.model, latencyMs: result.latencyMs, timings, stopReason, truncated: stopReason === "max_tokens",
  });
  return result;
}
