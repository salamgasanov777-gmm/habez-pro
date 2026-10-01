// Habez AI (Phase 4.2): контракт проверки ответа.
//
// Проверка — объект:
//   id        имя; ключ своих данных во входе (input.domains[id])
//   layer     common — не зависит от домена (числа, ссылки, даты, товары);
//             domain — правило своего домена (аналоги, заводы, пригодность);
//             policy — что роли видеть нельзя (скрытые значения и документы)
//   codes     { КОД: "error" | "info" } — что проверка может сообщить;
//             error делает ответ непроверенным, info — пометка
//   collect   (t, final) → данные проверки из хода ответа; только то, что
//             не зависит от текста ответа, — так ответ можно подменить при
//             повторной проверке. Нет — проверка читает только общий вход
//   applies   (input) → false — проверка к ответу не относится: ни находок,
//             ни своих полей в grounding. Нет — относится всегда
//   run       (ctx, data) → находки; ctx — разобранный ответ и данные
//             (runner.js), data — то, что вернул collect
//   report    (findings, grounding) — свои поля прежнего grounding (API)
//
// Находка: { code, severity, text, line? } — line: номер строки ответа с 1.
export const LAYERS = ["common", "domain", "policy"];

export const finding = (codes, code, text, line = null) => ({ code, severity: codes[code], text: String(text), ...(line ? { line } : {}) });

// Тексты находок одного кода — так их отдавал прежний grounding.
export const textsOf = (findings, code) => findings.filter((f) => f.code === code).map((f) => f.text);

// Без повторов по коду и тексту — для проверок, которые и раньше собирали
// находки во множество (числа, скрытое).
export function uniqueFindings(list) {
  const seen = new Set();
  return list.filter((f) => { const k = `${f.code}\u0000${f.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
