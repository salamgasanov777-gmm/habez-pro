// Habez AI (Phase 4.1): обработчик Competitor Intelligence (3.5) для
// реестра — вопрос о конкурентах идёт своим путём (раньше заводов 3.4 и
// подбора 3.3) и сводка для заглушки модели. Проверка ответа о конкурентах —
// check.js (competitorAnswerCheck, реестр checks/registry.js).
import { COMPETITOR_INTENTS } from "./route.js";
import { runCompetitor } from "./run.js";
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

// Сводка для заглушки модели — записи справочника, цены и связи.
export const competitorDigest = {
  id: "competitor",
  lines(t, ctxResult) {
    if (!t.comp) return [];
    return ctxResult.evidence.filter((e) => ["competitor_record", "price", "analog"].includes(e.kind))
      .map((e) => `${e.kind === "price" ? `${e.productName}, ${e.label}` : e.label}: ${e.value}${e.kind === "price" ? ` на ${e.source_date}` : ""} [${e.id}]`);
  },
};
