// Habez AI (Phase 4.2): проверки политики доступа — что роли видеть нельзя.
//
//   forbidden  FORBIDDEN_DATA — число из наблюдения, недоступного роли
//              (и которого нет в доступных данных), или ссылка на документ
//              такого наблюдения. Сами скрытые значения (input.forbidden)
//              выбирает сервер по роли (agent.js → forbiddenFor); проверка
//              только ищет их в ответе. Код перенесён из checkAnswer.
import { NUM_UNIT, numbersOf, family, supports } from "./text.js";
import { finding, uniqueFindings } from "./contract.js";

const FORBIDDEN = { FORBIDDEN_DATA: "error" };
export const forbiddenCheck = {
  id: "forbidden", layer: "policy", codes: FORBIDDEN,
  run({ a, data, input }) {
    const out = [];
    for (const fb of input.forbidden || []) {
      if (fb.reference && fb.reference.length >= 6 && a.lower.includes(String(fb.reference).toLowerCase())) out.push(finding(FORBIDDEN, "FORBIDDEN_DATA", fb.reference));
      for (const m of String(fb.value ?? "").matchAll(NUM_UNIT)) {
        const fam = family(m[3]);
        const secret = numbersOf(m).filter((n) => !supports(data, n, fam));
        if (!secret.length) continue;
        for (const x of a.whole) if (x.fam === fam && x.values.some((n) => secret.includes(n))) out.push(finding(FORBIDDEN, "FORBIDDEN_DATA", x.claim));
      }
    }
    return uniqueFindings(out);
  },
  // Наружу — только число совпадений, не сами значения.
  report(findings, g) { g.forbidden = findings.length; },
};
