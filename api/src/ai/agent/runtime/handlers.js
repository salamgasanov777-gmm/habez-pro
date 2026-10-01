// Habez AI (Phase 4.1): реестр обработчиков ответа.
//
// Ответ собирается этапами над общим контекстом t (createTurn). Этап —
// { id, when(t), run(t) }: when решает, нужен ли этап, run кладёт в t
// режим, готовый ответ, уточнение, данные [E#]. Этап, которому режим уже не
// нужен, сам проверяет !t.mode — так записан порядок до 4.1, и он не
// менялся. Новый домен подключается своим handler.js и строкой здесь, а не
// блоком if в agent.js.
//
// Порядок (приоритет) — как до 4.1:
//   competitor         3.5  вопрос о конкурентах (намерение дал router)
//   resolution         3.2  без модели: товара нет / неясно какой / какие сравнить
//   criteria           3.2  «по трём характеристикам» — каким?
//   factory            3.4  заводы, ассортимент, документы
//   intel              3.3  паспорт, подбор, пригодность, применение, совместимость
//   profile-factory    3.4  завод и документы в паспорте товара
//   unknown-notes      3.2  «товара X в каталоге нет» рядом с найденными
//   plan               3.2  инструменты чтения по маршруту, общий поиск
//   application-search 3.3  подбор «для швов ГКЛ»
// затем снимок пакета и режим по умолчанию (finalizeMode), ответ, проверки.
//
// Всё, что домен отдаёт наружу, идёт через реестр, а не через agent.js:
//   LOOKUPS  справочники до маршрута ({ id, load(ctx) → { data, maskNames } })
//   CHECKS   проверки ответа (checks/registry.js), их данные — collect(t, final)
//   OUTPUTS  вывод домена: { id, meta(t), result(t), metrics(t), refs(t),
//            state(t) } — любой метод можно не задавать. meta/result/metrics —
//            поля ответа (блоком, в порядке реестра); refs — номера [E#]
//            таблиц; state — параметры nextState, свои поля состояния —
//            в state(t).fields (поле объявляется в router.js → STATE_FIELDS).
import { competitorStage, competitorDigest, competitorLookup, competitorOutput } from "../competitor/handler.js";
import { factoryStage, productFactoryStage, factoryDigest, factoryOutput } from "../factory/handler.js";
import { intelStage, intelOutput } from "../intel/handler.js";
import { resolutionStage, criteriaStage, unknownNotesStage, planStage, applicationSearchStage } from "./base-handlers.js";
import { CHECKS } from "../checks/registry.js";
import { useCaseById } from "../intel/usecases.js";
import { specGroups } from "./plan.js";

export const STAGES = [competitorStage, resolutionStage, criteriaStage, factoryStage, intelStage, productFactoryStage, unknownNotesStage, planStage, applicationSearchStage];

// Проверки ответа (Phase 4.2) — реестр checks/registry.js: модуль без базы,
// его читает и повторная проверка сохранённого ответа. Здесь — для полноты
// реестра и сбора данных доменных проверок из хода ответа.
export { CHECKS };

// Сводки для заглушки модели (hints.lines) — порядок строк.
export const DIGESTS = [factoryDigest, competitorDigest];

// Вывод доменов — порядок задаёт порядок полей в meta, ответе и метриках.
export const OUTPUTS = [intelOutput, factoryOutput, competitorOutput];

// Справочники доменов, нужные маршруту до этапов.
export const LOOKUPS = [competitorLookup];

// Контекст ответа t. Кто пишет поле:
//   вход (только чтение)  tenantId scope q state catalog route ctx groups
//                         useCase и данные LOOKUPS (competitors)
//   копятся               bundle calls allowed — этапы по очереди дописывают;
//                         products — intel, plan
//   решение               mode fixed — первый решивший этап (остальные
//                         проверяют !t.mode), затем finalizeMode;
//                         clarification awaiting — resolution, criteria,
//                         plan, competitor; chosenVariant — intel, plan;
//                         found — plan, application-search;
//                         suitability — intel, plan (сравнение по задаче)
//   данные доменов        comp — competitor; factory — factory; intel,
//                         intelMs — intel; profileFactory — profile-factory
//                         (он же дописывает завод в паспорт intel.profile)
// Читают данные доменов только их OUTPUTS, CHECKS, DIGESTS — не agent.js.
export function createTurn({ tenantId, scope, q, state, catalog, route, bundle, lookups = {} }) {
  return {
    tenantId, scope, q, state, catalog, ...lookups, route, bundle,
    ctx: { tenantId, scope }, calls: [], allowed: new Set(), groups: specGroups(route),
    useCase: route.useCase ? useCaseById(route.useCase) : null,
    mode: null, fixed: null, clarification: null, awaiting: null, chosenVariant: null,
    products: [], found: [], suitability: null,
    comp: null, factory: null, intel: null, intelMs: 0, profileFactory: null,
  };
}

export function runStages(t, stages = STAGES) {
  for (const s of stages) if (s.when(t)) s.run(t);
  return t;
}

// Данные доменных проверок (collect) из хода ответа — не из текста ответа.
export const collectCheckData = (t, final, checks = CHECKS) => Object.fromEntries(checks.filter((c) => c.collect).map((c) => [c.id, c.collect(t, final)]));

export const digestLines = (t, ctxResult, digests = DIGESTS) => digests.flatMap((d) => d.lines(t, ctxResult));

export function loadLookups(ctx, lookups = LOOKUPS) {
  const out = { data: {}, maskNames: [] };
  for (const l of lookups) { const r = l.load(ctx); Object.assign(out.data, r.data); out.maskNames.push(...(r.maskNames || [])); }
  return out;
}

// Поля доменов для meta, ответа API или метрик (part), в порядке реестра.
export const collectOutput = (t, part, outputs = OUTPUTS) => Object.assign({}, ...outputs.map((o) => o[part]?.(t) ?? {}));
export const collectRefs = (t, outputs = OUTPUTS) => outputs.flatMap((o) => o.refs?.(t) ?? []);
// Параметры nextState от доменов; свои поля состояния (fields) — сливаются.
export function collectState(t, outputs = OUTPUTS) {
  const opts = { fields: {} };
  for (const o of outputs) { const { fields, ...rest } = o.state?.(t) ?? {}; Object.assign(opts, rest); Object.assign(opts.fields, fields); }
  return opts;
}
