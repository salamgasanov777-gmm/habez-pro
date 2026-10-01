// Habez AI (Phase 4.1): обработчик Product Intelligence (3.3) для реестра —
// паспорт, подбор, пригодность, применение, совместимость (правилами, до
// модели). Проверка ответа «подходит» вопреки статусу системы —
// suitability.js (suitabilityAnswerCheck, реестр checks/registry.js).
import { runIntel } from "./run.js";

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

// Вывод домена (handlers.js → OUTPUTS): задача, пригодность, паспорт,
// применение, совместимость — в meta и ответ API; время подбора; ссылки
// карточек пригодности; товары подбора — в состояние беседы.
export const intelOutput = {
  id: "intel",
  meta: (t) => ({
    useCase: t.useCase ? { id: t.useCase.id, label: t.useCase.label } : null,
    suitability: t.suitability, profile: t.intel?.profile || null, application: t.intel?.application || null, compatibility: t.intel?.compatibility || null,
  }),
  result: (t) => ({
    suitability: t.suitability, useCase: t.useCase?.id ?? null,
    profile: t.intel?.profile || null, application: t.intel?.application || null, compatibility: t.intel?.compatibility || null,
  }),
  metrics: (t) => ({ intel_ms: t.intelMs }),
  refs: (t) => (t.suitability || []).flatMap((s) => s.refs || []),
  state: (t) => ({ focus: t.intel?.focus || null }),
};
