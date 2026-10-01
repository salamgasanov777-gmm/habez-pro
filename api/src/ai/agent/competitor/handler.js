// Habez AI (Phase 4.1): обработчик Competitor Intelligence (3.5) для
// реестра — вопрос о конкурентах идёт своим путём (раньше заводов 3.4 и
// подбора 3.3), проверка ответа о конкурентах и сводка для заглушки модели.
import { COMPETITOR_INTENTS } from "./route.js";
import { runCompetitor } from "./run.js";
import { verdict, analogyHallucination, priceHallucination, sourceHallucination, entityHallucination, missingAsWorse } from "./check.js";
import { names } from "../runtime/text.js";
import { dctx } from "./tools.js";
import { competitorRegistry } from "../../competitors/index.js";

export const competitorStage = {
  id: "competitor",
  when: (t) => COMPETITOR_INTENTS.has(t.route.intent),
  run(t) {
    const { route, scope } = t;
    const tc = Date.now();
    if (route.unknown.length && !route.competitor.hits.length && scope !== "public") {
      t.mode = "NOT_FOUND";
      t.fixed = `${names(route.unknown)} нет ни в каталоге Habez, ни в справочнике конкурентов. Сведения о конкурентах вносит администратор; я не угадываю и не ищу в интернете.`;
    } else {
      t.comp = runCompetitor({ route, q: t.q, ctx: t.ctx, bundle: t.bundle, calls: t.calls, allowed: t.allowed, state: t.state });
      if (t.comp) { t.mode = t.comp.mode; if (t.comp.fixed) t.fixed = t.comp.fixed; if (t.comp.clarification) t.clarification = t.comp.clarification; }
    }
    if (t.comp) t.comp.ms = Date.now() - tc;
  },
};

// Справочник имён конкурентов (handlers.js → LOOKUPS) — нужен маршруту до
// этапов; только сотрудникам: гость о конкурентах не узнаёт даже по
// названию. Имена маскируются в общей проверке («П-Финиш» — не наш «ФИНИШ»).
export const competitorLookup = {
  id: "competitor",
  load({ tenantId, scope }) {
    let competitors = [];
    if (scope !== "public") { try { competitors = competitorRegistry(dctx({ tenantId, scope })); } catch { competitors = []; } }
    return { data: { competitors }, maskNames: competitors.flatMap((c) => c.names || []) };
  },
};

// Вывод домена (handlers.js → OUTPUTS): карточка конкурента в meta и ответ
// API; время этапа; компания, марка, товар — в состояние беседы.
export const competitorOutput = {
  id: "competitor",
  meta: (t) => ({ competitor: t.comp?.competitor || null }),
  result: (t) => ({ competitor: t.comp?.competitor || null }),
  metrics: (t) => ({ competitor_ms: t.comp?.ms ?? 0 }),
  state: (t) => ({ competitor: t.comp?.focus || null }),
};

// Ответ о конкурентах: выдуманные компании, цены, источники, «полный
// аналог» вопреки статусу, вердикты, «нет данных» как «хуже».
export const competitorCheck = {
  id: "competitor",
  run(t, v) {
    const { comp } = t;
    if (!comp || v.fixed) return;
    const { answer, final } = v;
    const cmpRows = final.comparison?.rows || [];
    const lowName = (n) => String(n).toLowerCase().replace(/ё/g, "е");
    const pairs = [];
    const oursOf = (x) => [x].filter(Boolean).map(lowName);
    for (const a of comp.competitor?.analogs || []) pairs.push({ names: [a.competitorProduct].filter(Boolean).map(lowName), ours: oursOf(a.product || comp.competitor.product), status: a.status, relation: a.relation });
    if (comp.competitor?.analog) pairs.push({ names: [comp.competitor.competitorProduct].filter(Boolean).map(lowName), ours: oursOf(comp.competitor.product), ...comp.competitor.analog });
    for (const pr of pairs) for (const key of ["names", "ours"]) for (const n of [...pr[key]]) { const qn = n.match(/«([^»]+)»/); if (qn) pr[key].push(qn[1]); }
    const prices = priceHallucination(answer, final.evidence.filter((e) => e.kind === "price"));
    v.grounding.competitor = {
      verdict: verdict(answer, t.q),
      analogy: analogyHallucination(answer, pairs),
      inventedPrices: prices.invented, uncitedPrices: prices.uncited,
      inventedSources: sourceHallucination(answer, `${final.text} ${final.evidence.map((e) => `${e.sourceName ?? ""} ${e.value ?? ""}`).join(" ")}`),
      inventedEntities: entityHallucination(answer, { registry: t.competitors, dataText: final.text, corpus: t.catalog.map((p) => `${p.name} ${p.short_name || ""}`).join(" "),
        question: t.q, historyText: v.historyText }),
      missingAsWorse: missingAsWorse(answer, cmpRows.filter((r) => r.cells.some((c) => c.missing)).map((r) => r.label)),
    };
    if (Object.values(v.grounding.competitor).some((x) => x.length)) v.grounding.grounded = false;
  },
};

// Сводка для заглушки модели — записи справочника, цены и связи.
export const competitorDigest = {
  id: "competitor",
  lines(t, ctxResult) {
    if (!t.comp) return [];
    return ctxResult.evidence.filter((e) => ["competitor_record", "price", "analog"].includes(e.kind))
      .map((e) => `${e.kind === "price" ? `${e.productName}, ${e.label}` : e.label}: ${e.value}${e.kind === "price" ? ` на ${e.source_date}` : ""} [${e.id}]`);
  },
};
