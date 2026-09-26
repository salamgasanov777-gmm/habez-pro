// Habez AI Phase 3.2–3.4: детерминированные случаи (test/fixtures/
// ai-eval-cases-3-2.json — 30, ai-eval-cases-3-3.json — 46,
// ai-eval-cases-3-4.json — заводы и документы). Беседа из нескольких реплик прогоняется по
// порядку: состояние, история и номера [E#] переносятся, как в окне чата.
// Проверяется последняя реплика. Один код — для теста с заглушкой и для
// прогона с настоящей моделью (live: проверки текста ответа).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../runtime/agent.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EVAL32_FILE = resolve(here, "../../../../test/fixtures/ai-eval-cases-3-2.json");
export const loadEval32 = (file = EVAL32_FILE) => JSON.parse(readFileSync(file, "utf8"));
export const EVAL33_FILE = resolve(here, "../../../../test/fixtures/ai-eval-cases-3-3.json");
export const EVAL34_FILE = resolve(here, "../../../../test/fixtures/ai-eval-cases-3-4.json");
export const evalFileForSet = (set) => ({ "3.3": EVAL33_FILE, "3.4": EVAL34_FILE })[set] || EVAL32_FILE;

const WINNER = /(правильн|верн|актуальн|точн)(ое|ым|ая) значени|устаревш|следует (использовать|ориентироваться)|технолог уточнил|ориентируйтесь на|(лучше|прочнее|надёжнее|надежнее) (по|чем)/i;

export async function runConversation(c, { tenantId = 1, provider, scope }) {
  let state = {};
  let refBase = 0;
  const history = [];
  const results = [];
  for (const q of c.turns) {
    const r = await runAgent({ tenantId, scope: scope || c.scope || "staff", question: q, history, state, refBase, provider });
    results.push(r);
    history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
    state = r.state;
    refBase = r.refBase + r.context.evidence.length;
  }
  return { last: results.at(-1), all: results };
}

export function evaluateCase32(c, r, { slugOf = new Map(), live = false } = {}) {
  const fails = [];
  const warn = [];
  const has = (ok, msg) => { if (!ok) fails.push(msg); };
  const props = r.context?.properties || [];
  const text = r.context?.text || "";
  const e = c.expected_entities || {};
  has(r.intent === c.expected_intent, `намерение ${r.intent}, ожидалось ${c.expected_intent}`);
  if (e.products) has(JSON.stringify(r.route.productSlugs) === JSON.stringify(e.products), `товары ${JSON.stringify(r.route.productSlugs)}, ожидалось ${JSON.stringify(e.products)}`);
  if (e.products_from) has(r.route.productsFrom === e.products_from, `товары из «${r.route.productsFrom}», ожидалось «${e.products_from}»`);
  for (const k of e.specs || []) has(r.route.specKeys.includes(k), `характеристика ${k} не распознана`);
  if (e.ambiguous_spec) has(r.route.ambiguousSpec === e.ambiguous_spec, "неоднозначность «прочность» не отмечена");
  for (const [k, v] of Object.entries(e.conditions || {})) has(String(r.route.conditions?.[k]) === String(v), `условие ${k}=${v} не распознано`);
  if (e.variant !== undefined) has(r.route.variant === e.variant, `фасовка ${r.route.variant}, ожидалась ${e.variant}`);
  if (e.unknown) has(JSON.stringify(r.unknown) === JSON.stringify(e.unknown), `неизвестные ${JSON.stringify(r.unknown)}`);

  const used = new Set(r.toolCalls.map((t) => t.name));
  for (const t of c.expected_tools || []) has(used.has(t), `не вызван ${t}`);

  const ev = c.expected_evidence || {};
  for (const k of ev.keys || []) has(props.some((p) => p.key === k), `нет данных по ${k}`);
  for (const [k, st] of Object.entries(ev.statuses || {})) has(props.some((p) => p.key === k && p.status === st), `у ${k} нет статуса ${st}`);
  for (const v of ev.values || []) has(text.includes(v), `в данных нет «${v}»`);
  if (ev.only_keys) { const extra = props.filter((p) => p.key && !ev.only_keys.includes(p.key)).map((p) => p.key); has(!extra.length, `лишние характеристики ${[...new Set(extra)].join(", ")}`); }
  if (ev.variants) has(JSON.stringify((r.context.variants || []).map((v) => v.unit)) === JSON.stringify(ev.variants), `фасовки ${JSON.stringify((r.context.variants || []).map((v) => v.unit))}`);
  for (const s of ev.found || []) has(r.found.map((id) => slugOf.get(id)).includes(s), `не найден ${s}`);
  for (const ck of ev.condition_keys || []) has(props.some((p) => String(p.conditionKey || "").includes(ck)), `нет свойства с условием ${ck}`);
  for (const row of ev.comparison_rows || []) has((r.context.comparison?.rows || []).some((x) => x.label === row), `в сравнении нет строки «${row}»`);
  if (ev.missing_cells) has((r.context.comparison?.rows || []).some((x) => x.cells.some((cell) => cell.missing)), "в сравнении не отмечено «нет данных»");
  for (const [slug, st] of Object.entries(ev.suitability || {})) {
    const got = (r.suitability || []).find((x) => x.slug === slug);
    has(got && got.status === st, `пригодность ${slug}: ${got?.status ?? "нет в списке"}, ожидалось ${st}`);
  }
  if (ev.profile) {
    has(!!r.profile, "нет паспорта товара");
    if (r.profile && ev.profile.variant !== undefined) has(r.profile.variant === ev.profile.variant, `паспорт фасовки ${r.profile.variant}, ожидалась ${ev.profile.variant}`);
    if (r.profile && ev.profile.min_key_specs) has(r.profile.keySpecs >= ev.profile.min_key_specs, `основных свойств ${r.profile.keySpecs}`);
    if (r.profile && ev.profile.conflicts) for (const c of ev.profile.conflicts) has(r.profile.conflicts.includes(c), `в паспорте нет расхождения «${c}»`);
  }
  for (const k of ev.application_kinds || []) has((r.application?.kinds || []).includes(k), `в применении нет «${k}»`);
  for (const k of ev.application_missing || []) has((r.application?.missing || []).includes(k), `«${k}» не отмечено как отсутствующее`);
  if (ev.compatibility) has(r.compatibility?.status === ev.compatibility, `совместимость ${r.compatibility?.status}, ожидалось ${ev.compatibility}`);
  if (ev.use_case) has(r.useCase === ev.use_case, `задача ${r.useCase}, ожидалась ${ev.use_case}`);
  // Phase 3.4: заводы и документы.
  const pf = (slug) => (r.productFactory || []).find((x) => x.slug === slug);
  for (const [slug, st] of Object.entries(ev.product_factory || {})) has(pf(slug)?.status === st, `связь ${slug} с заводом: ${pf(slug)?.status ?? "нет"}, ожидалось ${st}`);
  for (const [slug, rels] of Object.entries(ev.relations || {})) {
    for (const [name, st] of Object.entries(rels)) has((pf(slug)?.relations || []).some((x) => x.factory.includes(name) && x.status === st), `у ${slug} нет связи «${name}» со статусом ${st}`);
  }
  for (const slug of ev.needs_review || []) has(pf(slug)?.needsReview === true, `у ${slug} не отмечено «нужна сверка»`);
  const docs = r.documents || [];
  for (const t of ev.doc_types || []) has(docs.some((d) => d.type === t), `нет документа вида ${t}`);
  if (ev.only_doc_types) has(docs.every((d) => ev.only_doc_types.includes(d.type)), `лишние виды документов: ${[...new Set(docs.map((d) => d.type))].join(", ")}`);
  if (ev.min_documents) has(docs.length >= ev.min_documents, `документов ${docs.length}, ожидалось не меньше ${ev.min_documents}`);
  for (const t of ev.doc_titles || []) has(docs.some((d) => d.title.includes(t)), `нет документа «${t}»`);
  for (const d of ev.doc_dates || []) has(docs.some((x) => x.date === d), `нет документа с датой ${d}`);
  if (ev.doc_products_min) has(docs.some((d) => d.products.length >= ev.doc_products_min), `нет документа сразу на ${ev.doc_products_min} товара`);
  if (ev.factory_id) has(String(r.factoryId || "").startsWith(ev.factory_id), `завод ${r.factoryId}, ожидался ${ev.factory_id}`);
  for (const [slug, st] of Object.entries(ev.factory_items || {})) {
    const it = (r.factory?.items || []).find((x) => x.slug === slug);
    has(it?.status === st, `товар завода ${slug}: ${it?.status ?? "нет в списке"}, ожидалось ${st}`);
  }
  if (ev.factory_group !== undefined) has(r.factory?.group === ev.factory_group, `группа ${r.factory?.group}, ожидалась ${ev.factory_group}`);
  if (ev.min_factory_items) has((r.factory?.items || []).length >= ev.min_factory_items, `товаров завода ${(r.factory?.items || []).length}`);
  if (ev.profile_factory) has(r.profile?.factory?.status === ev.profile_factory, `в паспорте связь с заводом ${r.profile?.factory?.status}, ожидалось ${ev.profile_factory}`);
  for (const name of ev.citation_products || []) has((r.citations || []).some((c) => String(c.product || "").toUpperCase().includes(name)), `нет ссылки на данные «${name}»`);
  if (ev.only_disputed) has(props.every((p) => ["conflict", "unresolved"].includes(p.status) || p.hiddenDisagreement), "в ответе о расхождениях есть бесспорные свойства");

  const b = c.expected_behavior || {};
  if (b.mode) has(r.mode === b.mode, `режим ${r.mode}, ожидался ${b.mode}`);
  if (b.model !== undefined) has((r.model !== null) === b.model, b.model ? "модель не вызвана" : "модель вызвана, хотя не нужна");
  if (b.model_tools && live) has(r.toolCalls.some((t) => t.source === "model"), "модель не вызвала ни одного инструмента");
  if (b.clarification_options) has(JSON.stringify(r.clarification?.options) === JSON.stringify(b.clarification_options), `варианты уточнения ${JSON.stringify(r.clarification?.options)}`);
  if (b.answer_includes && (live || b.model === false)) for (const s of b.answer_includes) has(r.answer.includes(s), `в ответе нет «${s}»`);

  const f = c.forbidden_behavior || {};
  for (const s of f.context_excludes || []) has(!text.includes(s), `в данных есть запрещённое «${s}»`);
  for (const ck of f.condition_keys || []) has(!props.some((p) => String(p.conditionKey || "").includes(ck)), `использовано условие ${ck}`);
  for (const k of f.keys || []) has(!props.some((p) => p.key === k), `в данных лишнее ${k}`);
  for (const slug of f.suitability_excludes || []) has(!(r.suitability || []).some((x) => x.slug === slug), `в подборе лишний ${slug}`);
  for (const [slug, st] of Object.entries(f.suitability_not || {})) has(!(r.suitability || []).some((x) => x.slug === slug && x.status === st), `у ${slug} запрещённый статус ${st}`);
  for (const [slug, st] of Object.entries(f.product_factory_not || {})) has(pf(slug)?.status !== st, `у ${slug} запрещённый статус связи ${st}`);
  for (const t of f.doc_types || []) has(!docs.some((d) => d.type === t), `лишний документ вида ${t}`);
  for (const slug of f.factory_items_excludes || []) has(!(r.factory?.items || []).some((x) => x.slug === slug), `в товарах завода лишний ${slug}`);
  for (const s of f.found_excludes || []) has(!r.found.map((id) => slugOf.get(id)).includes(s), `в подборе лишний ${s}`);
  if (f.model_call) has(r.model === null, "модель вызвана");

  if (live && r.model) {
    const g = r.grounding;
    has(!g.emptyAnswer && r.answer.trim().length > 0, "модель вернула пустой ответ");
    has(!g.invalidCitations.length, `несуществующие ссылки: ${g.invalidCitations.join(", ")}`);
    has(!g.unsupported.length, `числа не из данных: ${g.unsupported.join(", ")}`);
    has(!g.mismatched.length, `число не из указанного источника: ${g.mismatched.join(", ")}`);
    has(!g.forbidden, "в ответе скрытые данные");
    has(!g.foreignProducts.length, `чужие товары: ${g.foreignProducts.join(", ")}`);
    has(!(g.statusMismatch || []).length, `«подходит» вопреки статусу: ${(g.statusMismatch || []).join(", ")}`);
    has(!(g.factoryMismatch || []).length, `завод назван изготовителем без основания: ${(g.factoryMismatch || []).join(", ")}`);
    has(!(g.inventedDocuments || []).length, `выдуманный документ: ${(g.inventedDocuments || []).join(", ")}`);
    has(!(g.unsupportedDates || []).length, `дата не из данных: ${(g.unsupportedDates || []).join(", ")}`);
    if (g.uncited.length) warn.push(`без ссылки: ${g.uncited.join(", ")}`);
    if (f.winner) has(!WINNER.test(r.answer), `выбран «победитель»: ${r.answer.match(WINNER)?.[0]}`);
  }
  return { id: c.id, group: c.group, question: c.turns.at(-1), turns: c.turns.length, pass: !fails.length, fails, warn };
}
