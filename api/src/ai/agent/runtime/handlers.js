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
import { competitorStage, competitorCheck, competitorDigest } from "../competitor/handler.js";
import { factoryStage, productFactoryStage, factoryCheck, factoryDigest } from "../factory/handler.js";
import { intelStage, intelCheck } from "../intel/handler.js";
import { resolutionStage, criteriaStage, unknownNotesStage, planStage, applicationSearchStage, emptyAnswerCheck, datesCheck } from "./base-handlers.js";
import { useCaseById } from "../intel/usecases.js";
import { specGroups } from "./plan.js";

export const STAGES = [competitorStage, resolutionStage, criteriaStage, factoryStage, intelStage, productFactoryStage, unknownNotesStage, planStage, applicationSearchStage];

// Проверки ответа после общей (checkAnswer) — порядок задаёт порядок полей
// grounding в ответе API.
export const CHECKS = [intelCheck, emptyAnswerCheck, factoryCheck, datesCheck, competitorCheck];

// Сводки для заглушки модели (hints.lines) — порядок строк.
export const DIGESTS = [factoryDigest, competitorDigest];

export function createTurn({ tenantId, scope, q, state, catalog, competitors, route, bundle }) {
  return {
    tenantId, scope, q, state, catalog, competitors, route, bundle,
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

export function runChecks(t, v, checks = CHECKS) {
  for (const c of checks) c.run(t, v);
  return v.grounding;
}

export const digestLines = (t, ctxResult, digests = DIGESTS) => digests.flatMap((d) => d.lines(t, ctxResult));
