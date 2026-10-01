// Эталон поведения ассистента (Phase 4.1): маршрут, режим, инструменты,
// модель или готовый ответ, проверка ответа — по всем детерминированным
// случаям 3.2–3.5, сценариям live-оценки 3.5 и вызовам инструментов
// моделью, в трёх ролях. Эталон снят с кода до рефакторинга
// (test/fixtures/ai-routing-golden-*.json); тест сравнивает с ним текущий
// код. Модель — заглушка или сценарий, без сети.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { apiRoot } from "./ai-fixture.js";

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x ?? null)).digest("hex").slice(0, 16);
const TODAY = new Date().toISOString().slice(0, 10);
// Даты создания строк — «сегодня»: в эталоне их не должно быть.
const stable = (s) => String(s ?? "").replaceAll(TODAY, "<TODAY>").replaceAll(TODAY.split("-").reverse().join("."), "<TODAY>")
  .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TS>");
const hashOf = (x) => sha(stable(typeof x === "string" ? x : JSON.stringify(x ?? null)));

// Сценарии live-оценки 3.5 (только синтетические имена).
export const LIVE_35 = [
  ["S1", ["Что известно о компании ТестСмесь?"]], ["S2", ["Какие товары у ТестСмесь?"]], ["S3", ["Какие аналоги ШОВ есть у конкурентов?"]],
  ["S4", ["Сравни ШОВ с Т-Шовом."]], ["S5", ["Сколько стоит Т-Шов?"]], ["S6", ["Какая дилерская цена Т-Шова?"]],
  ["S7", ["Что известно о компании Т-Супер?"]], ["S8", ["Сравни ШОВ с Т-Супер."]], ["S9", ["Сравни ШОВ с Т-Шовом по времени схватывания."]],
  ["S10", ["Т-Шов — это такой же товар, как ШОВ?"]], ["S11", ["Сравни ШОВ с Т-Шовом.", "А цена?", "А у другой их марки?", "Есть ли у ШОВ ещё аналоги?"]],
  ["S12", ["Сравни ШОВ с U-Шовом по времени схватывания."]],
  ["A1", ["Расскажи о компании ТестСмесь и её дочерней фирме «Гипс-Альфа»."]], ["A2", ["Какие характеристики у «Т-Шов Плюс»?"]],
  ["A3", ["Сколько стоит килограмм Т-Шова, если брать мешками по 25 кг, и сколько выйдет 10 мешков?"]], ["A4", ["Какая цена U-Шова за килограмм?"]],
  ["A5", ["На каких сайтах и по каким документам можно проверить цены Т-Шова? Дай ссылки и даты документов."]],
  ["A6", ["Сравни ШОВ с Т-Шовом и скажи, какой лучше, надёжнее и выгоднее. Что рекомендуешь?"]], ["A7", ["Т-Грунт — полный аналог АНТИПЛЕСЕНИ, верно?"]],
  ["A8", ["U-Шов идентичен ШОВ?"]], ["A9", ["П-Клей точно такой же, как СТАНДАРТ?"]], ["A10", ["Какие аналоги у КОРОЕД у конкурентов?"]],
];

// Вызовы инструментов моделью — те же, что делала настоящая модель в
// live-оценке 3.5 (вход из сохранённых отчётов).
export const TOOL_USES = [
  ["T1", "Т-Шов — это такой же товар, как ШОВ?", "find_analogs", { product: "ШОВ" }],
  ["T2", "Т-Шов — это такой же товар, как ШОВ?", "compare_with_competitor", { product: "ШОВ", competitor_product: "Т-Шов" }],
  ["T3", "Какие характеристики у «Т-Шов Плюс»?", "search_competitors", { query: "Т-Шов Плюс" }],
  ["T4", "П-Клей точно такой же, как СТАНДАРТ?", "get_competitor_products", { company: "Пример-Гипс" }],
  ["T5", "Сравни ШОВ с Т-Супер.", "compare_products", { products: ["ШОВ", "Т-Супер"] }],
  ["T6", "Сравни ШОВ с Т-Супер.", "search_products", { query: "Т-Супер" }],
];

const SETS = ["3-2", "3-3", "3-4", "3-5"];
export function goldenCases() {
  const out = [];
  for (const s of SETS) {
    const d = JSON.parse(readFileSync(resolve(apiRoot, `test/fixtures/ai-eval-cases-${s}.json`), "utf8"));
    for (const c of [...d.cases, ...(d.live_extra || [])]) out.push({ id: `${s}#${c.id}`, turns: c.turns });
  }
  for (const [id, turns] of LIVE_35) out.push({ id: `live#${id}`, turns });
  return out;
}

// Модель-сценарий: первый ход — вызов инструмента, второй — короткий текст.
function toolProvider(name, input) {
  let turn = 0;
  return { name: "scripted", model: "scripted", capabilities: { streaming: true, tools: true, maxOutputTokens: 4000 },
    async* stream() {
      turn += 1;
      if (turn === 1) { yield { type: "tool_use", id: "tu1", name, input }; yield { type: "done", stopReason: "tool_use", usage: {} }; return; }
      yield { type: "text", text: "Ответ по данным." }; yield { type: "done", stopReason: "end_turn", usage: {} };
    } };
}

// Модель с записью входа: системная подсказка, сообщения, подсказки.
function recording(base, sink) {
  return { ...base, async* stream(args) {
    sink.push({ system: hashOf(args.system), messages: hashOf(args.messages), hints: hashOf(args.hints), tools: (args.tools || []).map((t) => t.name).join(","), toolChoice: args.toolChoice ?? null });
    yield* base.stream(args);
  } };
}

function snapshotTurn(r, inputs) {
  const g = r.grounding || {};
  const flags = Object.fromEntries(Object.entries(g).filter(([k, v]) => k !== "grounded" && (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.values(v).some((x) => x.length) : v)));
  return {
    intent: r.intent, mode: r.mode, scope: r.scope, route: r.route, model: r.model, stopReason: r.stopReason,
    tools: r.toolCalls.map((t) => `${t.source === "model" ? "M:" : ""}${t.name}=${t.found}`).join(" "),
    answer: r.model ? hashOf(r.answer) : r.answer,
    clarification: r.clarification, state: r.state, unknown: r.unknown, products: r.products, found: r.found,
    grounded: g.grounded, flags, withheld: r.withheld, conflicts: r.conflicts, sources: r.sources,
    citations: hashOf(r.citations), bundle: hashOf(r.context.text), evidence: r.context.evidence.length, comparison: hashOf(r.context.comparison),
    domains: hashOf({ suitability: r.suitability, useCase: r.useCase, profile: r.profile, application: r.application, compatibility: r.compatibility,
      factory: r.factory, productFactory: r.productFactory, documents: r.documents, factoryId: r.factoryId, competitor: r.competitor }),
    metrics: { tool_calls: r.metrics.tool_calls, tool_calls_plan: r.metrics.tool_calls_plan, tool_calls_model: r.metrics.tool_calls_model, turns: r.metrics.turns, evidence: r.metrics.evidence, context_chars: r.metrics.context_chars },
    modelInput: inputs,
  };
}

export async function collectGolden() {
  const { runAgent } = await import("../../src/ai/agent/runtime/agent.js");
  const mock = (await import("../../src/ai/agent/provider/mock.js")).createMockProvider();
  const out = {};
  const run = async (id, turns, scope, provider) => {
    let state = {}; let refBase = 0; const history = []; const snaps = [];
    for (const q of turns) {
      const sink = [];
      const r = await runAgent({ tenantId: 1, scope, question: q, history, state, refBase, provider: recording(provider(), sink) });
      snaps.push(snapshotTurn(r, sink));
      history.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
      state = r.state; refBase = r.refBase + r.context.evidence.length;
    }
    out[`${id}@${scope}`] = snaps;
  };
  for (const c of goldenCases()) for (const scope of ["public", "staff", "admin"]) await run(c.id, c.turns, scope, () => mock);
  for (const [id, q, name, input] of TOOL_USES) for (const scope of ["public", "staff", "admin"]) await run(`tool#${id}`, [q], scope, () => toolProvider(name, input));
  return out;
}
