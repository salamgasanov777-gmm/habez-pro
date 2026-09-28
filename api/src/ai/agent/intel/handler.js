// Habez AI (Phase 4.1): обработчик Product Intelligence (3.3) для реестра —
// паспорт, подбор, пригодность, применение, совместимость (правилами, до
// модели) и проверка ответа «подходит» вопреки статусу системы.
import { runIntel } from "./run.js";
import { suitabilityMismatch } from "./suitability.js";

export const intelStage = {
  id: "intel",
  when: (t) => !t.mode,
  run(t) {
    const ti = Date.now();
    const intel = runIntel({ route: t.route, q: t.q, ctx: t.ctx, catalog: t.catalog, bundle: t.bundle, calls: t.calls, allowed: t.allowed });
    t.intelMs = Date.now() - ti;
    t.intel = intel;
    if (intel) {
      t.mode = intel.mode; if (intel.fixed) t.fixed = intel.fixed;
      t.products.push(...intel.products.filter((x) => x.sp !== undefined && x.p));
      if (intel.variant) t.chosenVariant = intel.variant;
      t.suitability = intel.suitability || null;
    }
  },
};

// Модель назвала «подходит» то, что система так не оценила.
export const intelCheck = {
  id: "suitability-status",
  run(t, v) {
    v.grounding.statusMismatch = v.fixed || !t.suitability ? [] : suitabilityMismatch(v.answer, t.suitability);
    if (v.grounding.statusMismatch.length) v.grounding.grounded = false;
  },
};
