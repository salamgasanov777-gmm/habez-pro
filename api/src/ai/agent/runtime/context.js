// Habez AI Agent: сборка контекста для модели и реестр ссылок [E1], [E2]…
// Каждая строка данных получает номер; модель обязана ссылаться на номера,
// а сервер после ответа проверяет, что ссылки настоящие.
import { unitLabel } from "../retrieval/conflicts.js";

const SOURCE_LABEL = {
  catalog_card: "карточка товара на витрине",
  product_card: "карточка товара",
  factory_technologist: "письмо главного технолога завода",
  quality_passport: "паспорт качества",
  label: "заводская этикетка",
  marking_card: "маркировочная карточка",
  factory_catalog: "заводской каталог",
  factory_site: "сайт завода",
  price_list: "прайс завода",
  manual_entry: "ручной ввод без документа",
  unknown_legacy_origin: "первоисточник не установлен",
  generated_default: "подставлено программой (не заводские данные)",
  ai_inference: "вывод AI (не факт)",
  measurement: "замер",
  technical_document: "технический документ",
  public_source: "внешний источник",
  variant: "фасовка в каталоге",
};
export const sourceLabel = (t) => SOURCE_LABEL[t] || t;

const STATUS_LABEL = {
  single: "одно значение",
  agreed: "источники согласны",
  conflict: "РАСХОЖДЕНИЕ — не выбирать одно значение",
  unresolved: "НЕРЕШЁННЫЙ ВОПРОС СВЕРКИ — не выбирать одно значение",
};

export function buildContext({ scope, products, specs, searchHits, unknown = [], missing = [] }) {
  const evidence = [];
  const properties = []; // сводка свойств: для интерфейса (споры) и тестового провайдера
  const found = [];      // найденные по словам товары — тоже для сводки
  const variants = [];
  const add = (e) => {
    const id = `E${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  const lines = [];
  lines.push(`Уровень доступа пользователя: ${scope === "public" ? "покупатель / гость — только данные витрины" : scope === "staff" ? "сотрудник — витрина и внутренние наблюдения" : "администратор — всё, включая конфиденциальное"}.`);
  for (const name of unknown) lines.push(`ТОВАРА «${name}» В КАТАЛОГЕ HABEZ НЕТ — данных о нём нет, ничего о нём не утверждать.`);

  if (searchHits?.length) {
    lines.push("\nНАЙДЕННЫЕ ТОВАРЫ (по словам вопроса):");
    for (const h of searchHits) {
      const id = add({ kind: "catalog_card", product: h.slug, productName: h.name, label: "описание", value: h.summary || h.name, where: "карточка товара" });
      lines.push(`[${id}] ${h.name} (раздел «${h.category || "—"}»): ${h.summary || "—"}`);
      found.push({ name: h.name, short: h.short, ref: id });
      for (const a of h.application || []) {
        const aid = add({ kind: "catalog_card", product: h.slug, productName: h.name, label: a.label, value: a.value, where: `таблица «${a.table}»` });
        lines.push(`  [${aid}] ${a.table}: ${a.label} — ${a.value}`);
      }
    }
  }

  for (const p of products) {
    lines.push(`\nТОВАР: ${p.name} (короткое имя «${p.short || p.name}», раздел «${p.category || "—"}»${p.gost ? `, ${p.gost}` : ""})`);
    if (p.summary) {
      const id = add({ kind: "catalog_card", product: p.slug, productName: p.name, label: "описание", value: p.summary, where: "карточка товара" });
      lines.push(`[${id}] Описание: ${p.summary}`);
    }
    for (const sec of p.sections || []) {
      const id = add({ kind: "catalog_card", product: p.slug, productName: p.name, label: sec.title, value: sec.text, where: `раздел «${sec.title}»` });
      lines.push(`[${id}] ${sec.title}: ${sec.text}`);
    }
    if (p.variants?.length) {
      lines.push("Фасовки (каждая — отдельно, не смешивать):");
      for (const v of p.variants) {
        const id = add({ kind: "variant", product: p.slug, productName: p.name, label: "фасовка", value: v.unit,
          variant: v.unit, sourceType: "variant", perPallet: v.per_pallet, sku: v.sku });
        lines.push(`  [${id}] ${v.unit}${v.sku ? ` (артикул ${v.sku})` : ""}${v.per_pallet ? `; на поддоне: ${v.per_pallet} шт` : "; количество на поддоне: нет данных"}`);
        variants.push({ product: p.short || p.name, unit: v.unit, perPallet: v.per_pallet, ref: id });
      }
    }
    const sp = specs.get(p.id);
    if (sp) {
      lines.push(`Характеристики (${sp.channel === "catalog_card" ? "из карточки на витрине" : "из наблюдений слоя знаний и строк карточки"}):`);
      if (missing.includes(p.id)) lines.push("- По характеристике из вопроса у этого товара данных нет.");
      for (const prop of sp.properties) {
        const scopeText = [prop.conditionText ? `условие: «${prop.conditionText}»` : null, prop.variant ? `фасовка: ${prop.variant.unit}` : null].filter(Boolean).join("; ");
        const summary = { product: p.short || p.name, productId: p.id, key: prop.key, label: prop.label, conditionKey: prop.conditionKey ?? "", conditionText: prop.conditionText,
          variant: prop.variant?.unit ?? null, status: prop.status, reason: prop.reason, items: (prop.items || []).map((i) => i.decision), values: [] };
        const vals = prop.values.map((v) => {
          if (v.hidden) { summary.values.push({ hidden: true, refs: [] }); return "(скрытое значение — есть конфиденциальные данные, раскрывать нельзя)"; }
          const ids = v.evidence.map((e) => add({ ...e, productName: p.name, property: prop.label, status: prop.status }));
          summary.values.push({ display: v.display, unit: v.unit, refs: ids });
          // Не заводские данные помечаются прямо в строке, чтобы модель не
          // подала их как характеристику.
          // (Подставленное программой — история удалённых значений — сюда не
          // доходит: его отбрасывает runtime/agent.js.)
          const weak = v.evidence.length && v.evidence.every((e) => ["generated_default", "ai_inference"].includes(e.sourceType));
          return `${v.display}${v.unit && !/[а-я%°]/i.test(v.display) ? ` ${unitLabel(v.unit)}` : ""} [${ids.join("][")}]${weak ? ` (источник: ${sourceLabel(v.evidence[0].sourceType)})` : ""}`;
        });
        properties.push(summary);
        let line = `- ${prop.label}${scopeText ? ` (${scopeText})` : ""}: ${vals.join(" | ") || "нет значения"} — ${STATUS_LABEL[prop.status] || prop.status}`;
        // Разные единицы — и при споре, и при открытом вопросе сверки (D5).
        if (new Set(prop.values.map((v) => v.unit).filter(Boolean)).size > 1) line += "; единицы разные, НЕ пересчитывать";
        if (prop.items?.length) line += `; вопрос сверки: ${prop.items.map((i) => `${i.decision} (${i.kind === "candidate_replacement" ? "замена НЕ подтверждена" : i.kind === "semantic_mapping_candidate" ? "одно ли это свойство — не решено" : "спор значений"}; участники: ${i.values.join(" / ")})`).join("; ")}`;
        if (prop.hiddenConfidential) line += `; есть ещё ${prop.hiddenConfidential} конфиденциальн. наблюд. — значения не раскрывать`;
        lines.push(line);
      }
      if (sp.channel === "catalog_card" && sp.internalOpenItems) {
        lines.push(`Внутренняя сверка: по этому товару у завода есть ${sp.internalOpenItems} нерешённ. вопрос(ов) о данных; подробности пользователю этого уровня недоступны.`);
      }
    }
  }
  if (!products.length && !searchHits?.length) lines.push("\nДАННЫХ ПО ВОПРОСУ НЕ НАЙДЕНО.");
  return { text: lines.join("\n"), evidence, properties, found, variants };
}

// Проверка ответа (validation). Ловит:
//   invalidCitations — ссылка на номер, которого в этом ответе нет (в том
//                      числе номер из прошлого ответа: реестр [E#] у каждого
//                      запроса свой, история приходит без номеров);
//   unsupported      — число с единицей, которого нет ни в одной строке данных;
//   mismatched       — число есть в данных, но не в тех строках, на которые
//                      ссылается эта же строка ответа (смешаны фасовки,
//                      условия, товары);
//   uncited          — число с единицей без ссылки, и нигде в ответе оно
//                      не стоит рядом со своей ссылкой (утверждение без
//                      опоры; повтор уже процитированного — не ошибка);
//   echoed           — число из вопроса, которого нет в данных, повторено
//                      без ссылки или с отрицанием («5 МПа в данных нет»);
//                      не ошибка, но в журнал идёт;
//   forbidden        — значение или ссылка на документ, которые этой роли
//                      не положены (конфиденциальные, внутренние для гостя).
// grounded — нет ни одной ошибки из первых четырёх и из forbidden.
const NUM_UNIT = /(\d+(?:[.,]\d+)?)\s*(?:–|-|—|…|\.\.\.)?\s*(\d+(?:[.,]\d+)?)?\s*(мпа|мм|см|кг\/м³|кг\/м²|кг\/м2|г\/м²|мл\/м²|л\/кг|кг|г|мл|л(?:итр(?:а|ов)?)?|мин(?:ут[аы]?)?|ч(?:ас(?:а|ов)?)?|сут(?:ок|ки)?|месяц(?:а|ев)?|мес|м²|м2|м|%|шт|циклов|°c|°)(?![а-яa-z])/giu;
const NUM = /\d+(?:[.,]\d+)?/g;
const DENIAL = /(^|[^а-яё])(нет|не)([^а-яё]|$)|отсутству|не подтвержд/i;
const canon = (s) => String(s).replace(",", ".").replace(/\.0+$/, "");
const numbersOf = (text) => new Set((String(text ?? "").match(NUM) || []).map(canon));
const evidenceText = (e) => `${e.value ?? ""} ${e.label ?? ""} ${e.perPallet ?? ""} ${e.variant ?? ""} ${e.productName ?? ""} ${e.condition ?? ""} ${e.property ?? ""}`;

export function checkAnswer(answer, evidence, { question = "", forbidden = [] } = {}) {
  const text = String(answer || "");
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const cited = [...new Set([...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))];
  const invalid = cited.filter((id) => !byId.has(id));
  const numbersInData = numbersOf(evidence.map(evidenceText).join(" "));
  const numbersInQuestion = numbersOf(question);
  const unsupported = new Set();
  const mismatched = new Set();
  const uncited = new Set();
  const echoed = new Set();
  const lines = text.split(/\n+/);
  // Числа, которые где-то в ответе стоят рядом со своей ссылкой: итоговая
  // строка «участники: 0,5 / 0,3» без ссылок их лишь повторяет.
  const citedNumbers = new Set();
  for (const line of lines) {
    const refs = [...line.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]).filter((id) => byId.has(id));
    if (!refs.length) continue;
    const lineData = numbersOf(refs.map((id) => evidenceText(byId.get(id))).join(" "));
    for (const n of numbersOf(line)) if (lineData.has(n)) citedNumbers.add(n);
  }

  for (const line of lines) {
    const refs = [...line.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]).filter((id) => byId.has(id));
    const lineData = refs.length ? numbersOf(refs.map((id) => evidenceText(byId.get(id))).join(" ")) : null;
    for (const m of line.matchAll(NUM_UNIT)) {
      const claim = m[0].trim();
      for (const n of [m[1], m[2]].filter(Boolean).map(canon)) {
        if (!numbersInData.has(n)) {
          // Число из вопроса повторено, чтобы его опровергнуть («5 МПа в
          // данных нет»), — не ошибка. Со ссылкой и без отрицания — подано
          // как данные.
          if (numbersInQuestion.has(n) && (!refs.length || DENIAL.test(line.replace(/не (менее|более|ранее|позднее|выше|ниже)/gi, "")))) echoed.add(claim);
          else unsupported.add(claim);
        } else if (lineData && !lineData.has(n)) {
          // Число из вопроса («7 и 28 суток»), подтверждённое ссылкой в другой
          // строке ответа, здесь лишь упомянуто — не смешение источников.
          if (!(numbersInQuestion.has(n) && citedNumbers.has(n))) mismatched.add(claim);
        }
        else if (!lineData && !citedNumbers.has(n)) uncited.add(claim);
      }
    }
  }

  // Скрытое: числа из недоступных роли наблюдений, которых нет в
  // доступных данных, и ссылки на их документы.
  const forbiddenHits = new Set();
  const lower = text.toLowerCase();
  for (const f of forbidden) {
    if (f.reference && f.reference.length >= 6 && lower.includes(String(f.reference).toLowerCase())) forbiddenHits.add(f.reference);
    for (const m of String(f.value ?? "").matchAll(NUM_UNIT)) {
      const secret = [m[1], m[2]].filter(Boolean).map(canon).filter((n) => !numbersInData.has(n));
      if (!secret.length) continue;
      for (const a of text.matchAll(NUM_UNIT)) {
        if ([a[1], a[2]].filter(Boolean).map(canon).some((n) => secret.includes(n))) forbiddenHits.add(a[0].trim());
      }
    }
  }

  const out = {
    citations: cited.filter((id) => byId.has(id)).map((id) => byId.get(id)),
    invalidCitations: invalid,
    unsupported: [...unsupported],
    mismatched: [...mismatched],
    uncited: [...uncited],
    echoed: [...echoed],
    forbidden: [...forbiddenHits],
  };
  out.grounded = !invalid.length && !unsupported.size && !mismatched.size && !uncited.size && !forbiddenHits.size;
  return out;
}

// Отдаём в интерфейс только безопасные поля ссылки.
export function publicCitation(e, scope) {
  const base = { id: e.id, product: e.productName || e.product, label: e.label, value: e.value, where: e.where ?? null, property: e.property ?? null, status: e.status ?? null };
  if (e.kind === "variant") return { ...base, kind: "variant", source: sourceLabel("variant"), perPallet: e.perPallet ?? null };
  if (e.kind === "catalog_card") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card") };
  // Наблюдение видно только сотрудникам: сюда оно и не попадает иначе.
  if (scope === "public") return { ...base, kind: "catalog_card", source: sourceLabel("catalog_card") };
  return {
    ...base, kind: "observation", observationId: e.observationId, source: sourceLabel(e.sourceType), sourceType: e.sourceType,
    reference: e.sourceReference, upstream: e.upstream, condition: e.condition, variant: e.variant,
    verification: e.verification, access: e.access, statement: e.statementType ?? null,
  };
}
