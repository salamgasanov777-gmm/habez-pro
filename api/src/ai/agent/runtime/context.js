// Habez AI Agent: контекст для модели и проверка ответа.
//
// Контекст (пакет доказательств с номерами [E#]) собирает runtime/bundle.js;
// buildContext — прежний вход Phase 3.1, теперь поверх него.
// Проверка ответа (checkAnswer) и безопасные для интерфейса ссылки
// (publicCitation) — здесь.
import { createBundle, sourceLabel } from "./bundle.js";
import { detectProducts } from "../retrieval/entities.js";

export { sourceLabel };

export function buildContext({ scope, products, specs, searchHits, unknown = [], missing = [], refBase = 0 }) {
  const b = createBundle({ scope, refBase, maxEvidence: 1000 });
  for (const name of unknown) b.note(`ТОВАРА «${name}» В КАТАЛОГЕ HABEZ НЕТ — данных о нём нет, ничего о нём не утверждать.`);
  b.searchHits(searchHits);
  for (const p of products) b.product(p, specs.get(p.id), { missing: missing.includes(p.id) ? ["из вопроса"] : [] });
  if (!products.length && !searchHits?.length) b.note("\nДАННЫХ ПО ВОПРОСУ НЕ НАЙДЕНО.");
  return b.result();
}

// Проверка ответа (validation). Ловит:
//   invalidCitations — ссылка на номер, которого нет в реестре ЭТОГО ответа
//                      (номера прошлых ответов модель не видит: история
//                      приходит без них);
//   unsupported      — число с единицей, которого нет в данных именно с этой
//                      единицей («5 МПа» при «0,5 МПа» и «5–7 л» — ошибка);
//   mismatched       — число есть в данных, но не в тех строках, на которые
//                      ссылается эта строка ответа, или с другой единицей
//                      (смешаны фасовки, условия, товары);
//   uncited          — число с единицей без ссылки, которое нигде в ответе
//                      не стоит рядом со своей ссылкой;
//   echoed           — число из вопроса, которого нет в данных, повторено без
//                      ссылки или с отрицанием («5 МПа в данных нет») — не
//                      ошибка;
//   forbidden        — значение или документ, которые роли не положены;
//   foreignProducts  — товар, которого нет ни в данных ответа, ни в их тексте;
//   fromHistory      — число из прошлого ответа этой беседы, которого нет в
//                      данных этого ответа: не ошибка, но «не перепроверено»
//                      (историю присылает браузер — доказательством она не
//                      считается).
// Данные — это записи [E#] вместе со строкой свойства (участники спора,
// условие) и пометки контекста (contextText: «другие условия: 7 сут»).
// grounded — нет ошибок, кроме echoed и fromHistory.
const NUM_UNIT = /(\d+(?:[.,]\d+)?)\s*(?:–|-|—|…|\.\.\.)?\s*(\d+(?:[.,]\d+)?)?\s*(мпа|мм|см|кг\/м³|кг\/м3|кг\/м²|кг\/м2|г\/м²|г\/м2|мл\/м²|мл\/м2|л\/кг|кг|г|мл|л(?:итр(?:а|ов)?)?|мин(?:ут[аы]?)?|ч(?:ас(?:а|ов)?)?|сут(?:ок|ки)?|месяц(?:а|ев)?|мес|м²|м2|м|%|шт|циклов|°c|°)(?![а-яa-z])/giu;
const NUM = /\d+(?:[.,]\d+)?/g;
const DENIAL = /(^|[^а-яё])(нет|не)([^а-яё]|$)|отсутству|не подтвержд/i;
const canon = (s) => String(s).replace(",", ".").replace(/\.0+$/, "");
const FAMILY = [
  [/^мпа$/, "mpa"], [/^мм$/, "mm"], [/^см$/, "cm"], [/^м[²2]$/, "m2"], [/^м$/, "m"],
  [/^кг\/м[³3]$/, "kg_m3"], [/^кг\/м[²2]$/, "kg_m2"], [/^г\/м[²2]$/, "g_m2"], [/^мл\/м[²2]$/, "ml_m2"], [/^л\/кг$/, "l_kg"],
  [/^кг$/, "kg"], [/^г$/, "g"], [/^мл$/, "ml"], [/^л/, "l"], [/^мин/, "min"], [/^ч/, "h"], [/^сут/, "day"], [/^мес/, "month"],
  [/^%$/, "pct"], [/^шт$/, "pcs"], [/^циклов$/, "cycles"], [/^°/, "deg"],
];
const family = (u) => (FAMILY.find(([re]) => re.test(String(u).toLowerCase())) || [null, String(u).toLowerCase()])[1];
// Пары «число|единица» и числа без единицы в тексте.
function facts(text) {
  const s = String(text ?? "");
  const pairs = new Set();
  const withUnit = new Set();
  for (const m of s.matchAll(NUM_UNIT)) {
    for (const n of [m[1], m[2]].filter(Boolean).map(canon)) { pairs.add(`${n}|${family(m[3])}`); withUnit.add(n); }
  }
  const all = new Set((s.match(NUM) || []).map(canon));
  const bare = new Set([...all].filter((n) => !withUnit.has(n)));
  return { pairs, bare, all };
}
const supports = (f, n, fam) => f.pairs.has(`${n}|${fam}`) || f.bare.has(n);
const evidenceText = (e) => `${e.value ?? ""} ${e.label ?? ""} ${e.perPallet ? `${e.perPallet} шт` : ""} ${e.variant ?? ""} ${e.productName ?? ""} ${e.condition ?? ""} ${e.property ?? ""} ${e.line ?? ""}`;

export function checkAnswer(answer, evidence, { question = "", forbidden = [], catalog = null, allowedProductIds = null, contextText = "", historyText = "" } = {}) {
  const text = String(answer || "");
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const cited = [...new Set([...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))];
  const invalid = cited.filter((id) => !byId.has(id));
  const data = facts(`${evidence.map(evidenceText).join(" \n ")} \n ${contextText}`);
  const asked = facts(question);
  const past = facts(historyText);
  const fromHistory = new Set();
  const unsupported = new Set();
  const mismatched = new Set();
  const uncited = new Set();
  const echoed = new Set();
  const lines = text.split(/\n+/);
  const lineFacts = (line) => {
    const refs = [...line.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]).filter((id) => byId.has(id));
    return { refs, f: refs.length ? facts(refs.map((id) => evidenceText(byId.get(id))).join(" \n ")) : null };
  };
  // Числа, которые где-то в ответе стоят рядом со своей ссылкой: итоговая
  // строка «участники: 0,5 / 0,3» без ссылок их лишь повторяет.
  const citedPairs = new Set();
  for (const line of lines) {
    const { f } = lineFacts(line);
    if (!f) continue;
    for (const m of line.matchAll(NUM_UNIT)) for (const n of [m[1], m[2]].filter(Boolean).map(canon)) if (supports(f, n, family(m[3]))) citedPairs.add(`${n}|${family(m[3])}`);
  }

  for (const line of lines) {
    const { refs, f } = lineFacts(line);
    for (const m of line.matchAll(NUM_UNIT)) {
      const claim = m[0].trim();
      // «на 1 кг», «на 1 м²», «на 1 мешок» — единица расчёта, не значение.
      if (/на\s*$/i.test(line.slice(Math.max(0, m.index - 4), m.index)) && canon(m[1]) === "1" && !m[2]) continue;
      const fam = family(m[3]);
      for (const n of [m[1], m[2]].filter(Boolean).map(canon)) {
        const inQuestion = asked.all.has(n);
        if (!supports(data, n, fam)) {
          // Число из вопроса повторено, чтобы его опровергнуть, — не ошибка.
          // Со ссылкой и без отрицания — подано как данные.
          if (inQuestion && (!refs.length || DENIAL.test(line.replace(/не (менее|более|ранее|позднее|выше|ниже)/gi, "")))) echoed.add(claim);
          else if (!refs.length && supports(past, n, fam)) fromHistory.add(claim);
          else unsupported.add(claim);
        } else if (f && !supports(f, n, fam)) {
          // Число из вопроса («7 и 28 суток»), подтверждённое ссылкой в другой
          // строке ответа, здесь лишь упомянуто — не смешение источников.
          if (!(inQuestion && citedPairs.has(`${n}|${fam}`))) mismatched.add(claim);
        } else if (!f && !citedPairs.has(`${n}|${fam}`)) uncited.add(claim);
      }
    }
  }

  // Скрытое: числа из недоступных роли наблюдений, которых нет в доступных
  // данных, и ссылки на их документы.
  const forbiddenHits = new Set();
  const lower = text.toLowerCase();
  for (const fb of forbidden) {
    if (fb.reference && fb.reference.length >= 6 && lower.includes(String(fb.reference).toLowerCase())) forbiddenHits.add(fb.reference);
    for (const m of String(fb.value ?? "").matchAll(NUM_UNIT)) {
      const fam = family(m[3]);
      const secret = [m[1], m[2]].filter(Boolean).map(canon).filter((n) => !supports(data, n, fam));
      if (!secret.length) continue;
      for (const a of text.matchAll(NUM_UNIT)) {
        if (family(a[3]) === fam && [a[1], a[2]].filter(Boolean).map(canon).some((n) => secret.includes(n))) forbiddenHits.add(a[0].trim());
      }
    }
  }

  // Товары в ответе: только те, что есть в данных этого ответа.
  const foreign = catalog && allowedProductIds
    ? detectProducts(text, catalog).filter((p) => !allowedProductIds.has(p.id)).map((p) => p.short_name || p.name)
    : [];

  const out = {
    citations: cited.filter((id) => byId.has(id)).map((id) => byId.get(id)),
    invalidCitations: invalid,
    unsupported: [...unsupported],
    mismatched: [...mismatched],
    uncited: [...uncited],
    echoed: [...echoed],
    forbidden: [...forbiddenHits],
    foreignProducts: foreign,
    fromHistory: [...fromHistory],
  };
  out.grounded = !invalid.length && !unsupported.size && !mismatched.size && !uncited.size && !forbiddenHits.size && !foreign.length;
  return out;
}

// Отдаём в интерфейс только безопасные поля ссылки.
export function publicCitation(e, scope) {
  const base = { id: e.id, product: e.productName || e.product, label: e.label, value: e.value, where: e.where ?? null, property: e.property ?? null,
    status: e.status ?? null, conflictId: e.conflict_id ?? null };
  if (e.kind === "variant") return { ...base, kind: "variant", source: sourceLabel("variant"), variant: e.variant ?? null, perPallet: e.perPallet ?? null };
  if (e.kind === "catalog_card") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card"), condition: e.condition ?? null };
  // Наблюдение видно только сотрудникам: сюда оно и не попадает иначе.
  if (scope === "public") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card") };
  return {
    ...base, kind: "observation", observationId: e.observationId, source: sourceLabel(e.sourceType), sourceType: e.sourceType,
    reference: e.sourceReference, upstream: e.upstream, condition: e.condition, variant: e.variant, sourceDate: e.source_date ?? null,
    verification: e.verification, access: e.access, statement: e.statementType ?? null,
  };
}
