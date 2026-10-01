// Habez AI (Phase 4.2): вход проверки ответа — всё, что нужно проверкам,
// в виде, который можно сохранить (JSON) и проверить снова без модели и без
// базы (recheck.js). Ответ — отдельным полем: его можно подменить.
//
//   answer, fixed, emptyAnswer   ответ; fixed — готовый ответ сервера (уточнение,
//                                «нет данных»): его не проверяют
//   question, historyText        вопрос и прошлые ответы беседы
//   evidence, contextText        записи [E#] и текст данных ответа
//   forbidden                    скрытые от роли значения и документы
//                                (выбирает сервер); в файле — только локально
//   catalog, allowedProductIds   товары Habez (id, slug, имя) и разрешённые
//   maskNames                    имена из справочников доменов
//   domains                      данные доменных проверок (их collect)
export const CHECK_INPUT_VERSION = 1;

export function buildCheckInput({ answer, fixed = false, emptyAnswer = false, question = "", historyText = "", scope = null, evidence = [], contextText = "",
  forbidden = [], catalog = null, allowedProductIds = null, maskNames = [], domains = {} } = {}) {
  return {
    version: CHECK_INPUT_VERSION,
    answer: String(answer ?? ""), fixed: !!fixed, emptyAnswer: !!emptyAnswer, question: String(question ?? ""), historyText: String(historyText ?? ""), scope,
    evidence, contextText: String(contextText ?? ""),
    forbidden: (forbidden || []).map((f) => ({ value: f.value ?? null, reference: f.reference ?? null })),
    catalog: catalog ? catalog.map((p) => ({ id: p.id, slug: p.slug ?? null, name: p.name, short_name: p.short_name ?? null })) : null,
    allowedProductIds: allowedProductIds ? [...allowedProductIds] : null,
    maskNames: [...(maskNames || [])],
    domains,
  };
}
