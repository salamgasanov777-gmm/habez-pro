// Habez AI Agent: контекст для модели и проверка ответа.
//
// Контекст (пакет доказательств с номерами [E#]) собирает runtime/bundle.js;
// buildContext — прежний вход Phase 3.1, теперь поверх него.
// Проверка ответа (checkAnswer — прежний вход в checks/) и безопасные для
// интерфейса ссылки (publicCitation) — здесь.
import { createBundle, sourceLabel } from "./bundle.js";
import { numbersCheck, citationsCheck, productsCheck } from "../checks/common.js";
import { forbiddenCheck } from "../checks/policy.js";
import { runAnswerChecks } from "../checks/runner.js";
import { buildCheckInput } from "../checks/input.js";
import { textsOf } from "../checks/contract.js";

export { sourceLabel };

export function buildContext({ scope, products, specs, searchHits, unknown = [], missing = [], refBase = 0 }) {
  const b = createBundle({ scope, refBase, maxEvidence: 1000 });
  for (const name of unknown) b.note(`ТОВАРА «${name}» В КАТАЛОГЕ HABEZ НЕТ — данных о нём нет, ничего о нём не утверждать.`);
  b.searchHits(searchHits);
  for (const p of products) b.product(p, specs.get(p.id), { missing: missing.includes(p.id) ? ["из вопроса"] : [] });
  if (!products.length && !searchHits?.length) b.note("\nДАННЫХ ПО ВОПРОСУ НЕ НАЙДЕНО.");
  return b.result();
}

// Проверка ответа — Phase 4.2: checks/ (контракт, общие проверки,
// политика, запуск). checkAnswer — прежний вход: общие проверки и политика
// без доменных; поля результата — как до 4.2 (forbidden — списком).
const CORE_CHECKS = [numbersCheck, citationsCheck, forbiddenCheck, productsCheck];
export function checkAnswer(answer, evidence, { question = "", forbidden = [], catalog = null, allowedProductIds = null, contextText = "", historyText = "", maskNames = [] } = {}) {
  const r = runAnswerChecks(buildCheckInput({ answer, question, historyText, evidence, contextText, forbidden, catalog, allowedProductIds, maskNames }), CORE_CHECKS);
  const g = r.grounding;
  return {
    citations: r.citations, invalidCitations: g.invalidCitations, unsupported: g.unsupported, mismatched: g.mismatched, uncited: g.uncited, echoed: g.echoed,
    forbidden: textsOf(r.findings, "FORBIDDEN_DATA"), foreignProducts: g.foreignProducts, fromHistory: g.fromHistory, grounded: g.grounded,
  };
}

// Отдаём в интерфейс только безопасные поля ссылки.
export function publicCitation(e, scope) {
  const base = { id: e.id, product: e.productName || e.product, label: e.label, value: e.value, where: e.where ?? null, property: e.property ?? null,
    status: e.status ?? null, conflictId: e.conflict_id ?? null };
  if (e.kind === "variant") return { ...base, kind: "variant", source: sourceLabel("variant"), variant: e.variant ?? null, perPallet: e.perPallet ?? null };
  if (e.kind === "catalog_card") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card"), condition: e.condition ?? null };
  // Phase 3.4: реквизиты и каталог завода видны всем ролям.
  if (e.kind === "factory_record") return { ...base, kind: "factory_record", product: e.label, label: null, source: sourceLabel(e.sourceType) };
  if (e.kind === "catalog") return { ...base, kind: "catalog", source: sourceLabel("catalog") };
  // 3.5: сведения о конкурентах — только сотрудникам (гостю их не выдаёт
  // сам слой); здесь — безопасные поля ссылки.
  if (e.kind === "competitor_record") return { ...base, kind: "competitor_record", source: sourceLabel("competitor_registry") };
  if (e.kind === "price") return scope === "public" ? { id: e.id } : { ...base, kind: "price", source: e.sourceName || sourceLabel("price"), sourceDate: e.source_date ?? null,
    region: e.region ?? null, seller: e.seller ?? null, reference: e.sourceReference ?? null, access: e.access };
  if (e.kind === "analog") return scope === "public" ? { id: e.id } : { ...base, kind: "analog", source: e.sourceName || sourceLabel("analog"), status: e.status ?? null };
  if (e.kind === "document") {
    if (scope === "public") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card") };
    return { ...base, kind: "document", docId: e.docId, source: e.label, sourceType: e.sourceType, reference: e.sourceReference, sourceDate: e.source_date ?? null, access: e.access };
  }
  // Наблюдение видно только сотрудникам: сюда оно и не попадает иначе.
  if (scope === "public") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card") };
  return {
    ...base, kind: "observation", observationId: e.observationId, source: sourceLabel(e.sourceType), sourceType: e.sourceType,
    reference: e.sourceReference, upstream: e.upstream, condition: e.condition, variant: e.variant, sourceDate: e.source_date ?? null,
    verification: e.verification, access: e.access, statement: e.statementType ?? null,
  };
}
