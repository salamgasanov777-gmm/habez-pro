// Habez AI Agent (Phase 3.2): пакет доказательств (evidence bundle) — единая
// структура между поиском и моделью. Модель получает не строки базы, а
// нормализованные записи с номером [E#]:
//
//   claim, value, raw_value, unit, product, variant, packaging, condition,
//   assertion_type, source, source_type, source_date, verification,
//   access_level, status, conflict_id
//
// Пакет собирается по частям: сначала то, что нашёл план, потом — ответы
// инструментов, которые вызвала модель. Номера сквозные внутри беседы:
// начинаются с refBase + 1 (второе сообщение продолжает, а не повторяет
// номера первого).
import { unitLabel } from "../retrieval/conflicts.js";
import { conditionOfProperty } from "../retrieval/specs.js";

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
  // Phase 3.4
  habez_registry: "реквизиты организации в Habez Pro",
  mentioned: "назван в данных о товаре",
  catalog: "каталог Habez Pro",
  document: "документ",
};
export const sourceLabel = (t) => SOURCE_LABEL[t] || t;

const STATUS_LABEL = {
  single: "одно значение",
  agreed: "источники согласны",
  conflict: "РАСХОЖДЕНИЕ — не выбирать одно значение",
  unresolved: "НЕРЕШЁННЫЙ ВОПРОС СВЕРКИ — не выбирать одно значение",
};
const VERIFICATION = { verified: "подтверждено", unverified: "не проверено", rejected: "отклонено" };
const DATE = (d) => (d ? String(d).slice(0, 10) : null);

export function createBundle({ scope, refBase = 0, maxEvidence = 160 }) {
  const evidence = [];
  const properties = [];
  const variants = [];
  const found = [];
  const lines = [];
  const productsSeen = new Map();
  let comparison = null;
  let truncated = false;

  const add = (e) => {
    if (evidence.length >= maxEvidence) { truncated = true; return null; }
    const id = `E${refBase + evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  // Нормализованная запись. Старые поля (label, property, value, perPallet,
  // variant, productName, condition) оставлены: по ним работает проверка.
  const norm = (e, extra = {}) => ({
    claim: extra.claim ?? e.property ?? e.label ?? null,
    value: e.value ?? null,
    raw_value: e.value ?? null,
    unit: e.unit ?? null,
    product: e.product ?? null,
    variant: e.variant ?? null,
    packaging: !!extra.packaging,
    condition: e.condition ?? extra.condition ?? null,
    assertion_type: e.statementType ?? (e.kind === "observation" ? "unknown" : "card"),
    source: sourceLabel(e.sourceType || e.kind),
    source_type: e.sourceType || e.kind,
    source_date: DATE(e.sourceDate),
    verification: e.verification ?? null,
    access_level: e.access ?? "public",
    status: extra.status ?? e.status ?? null,
    conflict_id: extra.conflictId ?? null,
    ...e,
  });

  lines.push(`Уровень доступа пользователя: ${scope === "public" ? "покупатель / гость — только данные витрины" : scope === "staff" ? "сотрудник — витрина и внутренние наблюдения" : "администратор — всё, включая конфиденциальное"}.`);

  const api = {
    note(text) { lines.push(text); },

    searchHits(hits) {
      if (!hits?.length) return;
      lines.push("\nНАЙДЕННЫЕ ТОВАРЫ (по словам вопроса):");
      for (const h of hits) {
        productsSeen.set(h.id, h.name);
        const id = add(norm({ kind: "catalog_card", product: h.slug, productName: h.name, label: "описание", value: h.summary || h.name, where: "карточка товара" }));
        if (!id) break;
        lines.push(`[${id}] ${h.name} (раздел «${h.category || "—"}»): ${h.summary || "—"}`);
        found.push({ name: h.name, short: h.short, ref: id });
        for (const a of h.application || []) {
          const aid = add(norm({ kind: "catalog_card", product: h.slug, productName: h.name, label: a.label, value: a.value, where: `таблица «${a.table}»` }));
          if (aid) lines.push(`  [${aid}] ${a.table}: ${a.label} — ${a.value}`);
        }
      }
    },

    // Товар: описание, разделы, фасовки, свойства. opts: { missing: [термины],
    // askedConditions, variant, provenance, strengthAmbiguous }.
    // Возвращает номера описания, разделов и фасовок — для объяснений
    // (пригодность, паспорт, инструкция).
    product(p, sp, opts = {}) {
      const refs = { summary: null, sections: new Map(), variants: [] };
      productsSeen.set(p.id, p.name);
      lines.push(`\nТОВАР: ${p.name} (короткое имя «${p.short || p.name}», раздел «${p.category || "—"}»${p.gost ? `, ${p.gost}` : ""})`);
      if (p.summary) {
        const id = add(norm({ kind: "catalog_card", product: p.slug, productName: p.name, label: "описание", value: p.summary, where: "карточка товара" }));
        if (id) { lines.push(`[${id}] Описание: ${p.summary}`); refs.summary = id; }
      }
      for (const sec of p.sections || []) {
        const id = add(norm({ kind: "catalog_card", product: p.slug, productName: p.name, label: sec.title, value: sec.text, where: `раздел «${sec.title}»` }));
        if (id) { lines.push(`[${id}] ${sec.title}: ${sec.text}`); refs.sections.set(sec.title, id); }
      }
      if (p.variants?.length) {
        lines.push(opts.variant ? `Фасовка из вопроса: ${opts.variant.unit} (другие фасовки к ответу не относятся):` : "Фасовки (каждая — отдельно, не смешивать):");
        for (const v of p.variants) {
          const id = add(norm({ kind: "variant", product: p.slug, productName: p.name, label: "фасовка", value: v.unit, variant: v.unit, sourceType: "variant", perPallet: v.per_pallet, sku: v.sku }, { packaging: true, claim: "фасовка" }));
          if (!id) break;
          lines.push(`  [${id}] ${v.unit}${v.sku ? ` (артикул ${v.sku})` : ""}${v.per_pallet ? `; на поддоне: ${v.per_pallet} шт` : "; количество на поддоне: нет данных"}`);
          variants.push({ product: p.short || p.name, unit: v.unit, perPallet: v.per_pallet, ref: id });
          refs.variants.push(id);
        }
      }
      if (!sp) return refs;
      lines.push(`Характеристики (${sp.channel === "catalog_card" ? "из карточки на витрине" : "из наблюдений слоя знаний и строк карточки"}):`);
      if (opts.strengthAmbiguous) lines.push("- В вопросе «прочность» без уточнения: показать КАЖДЫЙ вид прочности отдельно (сцепление, сжатие, изгиб), не выбирать один.");
      for (const term of opts.missing || []) lines.push(`- По характеристике «${term}» у этого товара данных нет${opts.askedConditions ? " для условия из вопроса" : ""}.`);
      if (opts.otherConditions?.length) lines.push(`- Для других условий данные есть (${opts.otherConditions.join("; ")}) — их к вопросу не применять.`);
      for (const prop of sp.properties) {
        const cond = conditionOfProperty(prop);
        const scopeText = [prop.conditionText ? `условие: «${prop.conditionText}»` : cond.age_days && !prop.conditionText ? `условие: ${cond.age_days} сут` : null,
          prop.variant ? `фасовка: ${prop.variant.unit}` : null].filter(Boolean).join("; ");
        const conflictId = prop.items?.length ? prop.items.map((i) => i.decision).join(",") : prop.status === "conflict" ? `C:${p.slug}:${prop.key || prop.label}:${prop.conditionKey || ""}` : null;
        const summary = { product: p.short || p.name, productId: p.id, key: prop.key, label: prop.label, conditionKey: prop.conditionKey ?? "", conditionText: prop.conditionText,
          variant: prop.variant?.unit ?? null, status: prop.status, reason: prop.reason, items: (prop.items || []).map((i) => i.decision), values: [],
          hiddenDisagreement: !!prop.hiddenDisagreement, conflictId };
        prop._refs = [];
        const vals = prop.values.map((v) => {
          if (v.hidden) { summary.values.push({ hidden: true, refs: [] }); return "(скрытое значение — есть конфиденциальные данные, раскрывать нельзя)"; }
          const ids = v.evidence.map((e) => add(norm({ ...e, productName: p.name, property: prop.label, status: prop.status, condition: e.condition ?? prop.conditionText ?? null },
            { status: prop.status, conflictId, packaging: !!prop.packaging || !!prop.variant }))).filter(Boolean);
          prop._refs.push(...ids);
          summary.values.push({ display: v.display, unit: v.unit, refs: ids });
          const weak = v.evidence.length && v.evidence.every((e) => ["generated_default", "ai_inference"].includes(e.sourceType));
          const prov = opts.provenance && v.evidence[0]?.kind === "observation"
            ? ` (${[sourceLabel(v.evidence[0].sourceType), DATE(v.evidence[0].sourceDate), VERIFICATION[v.evidence[0].verification] || v.evidence[0].verification].filter(Boolean).join(", ")})`
            : weak ? ` (источник: ${sourceLabel(v.evidence[0].sourceType)})` : "";
          return `${v.display}${v.unit && !/[а-я%°]/i.test(v.display) ? ` ${unitLabel(v.unit)}` : ""}${ids.length ? ` [${ids.join("][")}]` : ""}${prov}`;
        });
        properties.push(summary);
        const firstRef = evidence.length - prop._refs.length;
        let line = `- ${prop.label}${scopeText ? ` (${scopeText})` : ""}: ${vals.join(" | ") || "нет значения"} — ${STATUS_LABEL[prop.status] || prop.status}`;
        if (new Set(prop.values.map((v) => v.unit).filter(Boolean)).size > 1) line += "; единицы разные, НЕ пересчитывать";
        if (prop.items?.length) line += `; вопрос сверки: ${prop.items.map((i) => `${i.decision} (${i.kind === "candidate_replacement" ? "замена НЕ подтверждена" : i.kind === "semantic_mapping_candidate" ? "одно ли это свойство — не решено" : "спор значений"}; участники: ${i.values.join(" / ")})`).join("; ")}`;
        if (prop.hiddenConfidential) line += `; есть ещё ${prop.hiddenConfidential} конфиденциальн. наблюд. — значения не раскрывать`;
        if (prop.hiddenDisagreement) line += "; в системе есть дополнительные внутренние данные, поэтому окончательное значение не опубликовано — значения не называть";
        if (opts.askedConditions && !Object.keys(opts.askedConditions).every((k) => cond[k] !== undefined)) line += "; условие в источнике не указано";
        lines.push(line);
        // Строка свойства целиком (со всеми значениями и участниками спора) —
        // для проверки: число из этой строки рядом со ссылкой на неё — из данных.
        for (let i = Math.max(0, firstRef); i < evidence.length; i += 1) evidence[i].line = line;
      }
      if (sp.channel === "catalog_card" && sp.internalOpenItems) {
        lines.push(`Внутренняя сверка: по этому товару у завода есть ${sp.internalOpenItems} нерешённ. вопрос(ов) о данных; подробности пользователю этого уровня недоступны.`);
      }
      return refs;
    },

    // Сравнение: после товаров (ссылки уже присвоены).
    comparison(cmp) {
      if (!cmp?.rows?.length) return;
      const names = new Map(cmp.products.map((p) => [p.id, p.short || p.name]));
      lines.push("\nСРАВНЕНИЕ (строка — характеристика с одним условием; у каждого товара свои значения; победителя нет; «нет данных» — так и сказать):");
      comparison = { products: cmp.products.map((p) => p.short || p.name), rows: [] };
      for (const r of cmp.rows.slice(0, 30)) {
        const cells = cmp.products.map((p) => {
          const prop = r.cells[p.id];
          if (!prop) return { product: names.get(p.id), missing: true, values: [], status: null, refs: [] };
          const vals = prop.values.map((v) => (v.hidden ? "скрытое значение" : v.display));
          return { product: names.get(p.id), missing: false, values: vals, status: prop.status, refs: prop._refs || [], decisions: (prop.items || []).map((i) => i.decision) };
        });
        comparison.rows.push({ label: r.label, condition: r.conditionText, common: r.common, cells });
        lines.push(`- ${r.label}${r.conditionText ? ` (${r.conditionText})` : ""}: ${cells.map((c) => `${c.product} — ${c.missing ? "нет данных" : `${c.values.join(" | ")}${c.refs.length ? ` [${c.refs.join("][")}]` : ""}${["conflict", "unresolved"].includes(c.status) ? ` (спор${c.decisions?.length ? ` ${c.decisions.join(",")}` : ""})` : ""}`}`).join("; ")}`);
      }
    },

    // Phase 3.4: сведения о заводе из реквизитов (или о заводе, названном
    // в данных). Возвращает номера записей.
    factoryRecord(f) {
      const refs = {};
      lines.push(`\nЗАВОД: ${f.name} — ${f.status === "REGISTERED" ? "из реквизитов организации в Habez Pro" : "назван в данных о товаре (реквизитов этого завода в системе нет)"}`);
      const rec = (key, label, value, where = null) => {
        if (!value) return;
        const id = add(norm({ kind: "factory_record", label, value, where, factoryId: f.id, sourceType: f.status === "REGISTERED" ? "habez_registry" : "mentioned" }));
        if (id) { refs[key] = id; lines.push(`[${id}] ${label}: ${value}${where ? ` — ${where}` : ""}`); }
      };
      rec("name", "Название", f.name);
      rec("legal", "Юридическое лицо (организация)", f.legalName);
      rec("location", f.location?.label || "Адрес", f.location?.text, f.location?.kind === "organization_address" ? "адрес организации; что это адрес производственной площадки, в данных не сказано" : null);
      rec("site", "Сайт", f.site);
      rec("inn", "ИНН", f.requisites?.inn);
      rec("ogrn", "ОГРН", f.requisites?.ogrn);
      return refs;
    },

    // Отдельная запись о заводе (группа каталога, зарегистрированный источник).
    record({ label, value, where = null, sourceType = "habez_registry", text = null }) {
      const id = add(norm({ kind: "factory_record", label, value, where, sourceType }));
      if (id) lines.push(`[${id}] ${text || `${label}: ${value}${where ? ` — ${where}` : ""}`}`);
      return id;
    },

    // Товар в каталоге завода (ассортимент, не производство).
    catalogEntry(p, factoryName) {
      productsSeen.set(p.id, p.name);
      const id = add(norm({ kind: "catalog", product: p.slug, productName: p.name, label: "в каталоге завода", value: p.category || "—", where: `каталог «${factoryName}»` }));
      return id;
    },

    // Раздел карточки товара (упоминание документа, изготовителя).
    cardSection(p, title, text) {
      productsSeen.set(p.id, p.name);
      const id = add(norm({ kind: "catalog_card", product: p.slug, productName: p.name, label: title, value: text, where: `раздел «${title}»` }));
      if (id) lines.push(`[${id}] ${p.short || p.name} · раздел «${title}»: ${text}`);
      return id;
    },

    // Документ (группа наблюдений с одним источником) и что в нём указано.
    document(d, { maxObs = 12 } = {}) {
      const access = d.access.includes("confidential") ? "confidential" : d.access.includes("internal") ? "internal" : "public";
      const id = add(norm({ kind: "document", label: d.typeLabel, value: d.title, docId: d.id, sourceType: d.type, sourceDate: d.date?.value ?? null,
        sourceReference: d.reference, access, product: d.products[0]?.slug ?? null, productName: d.products.map((x) => x.name).join(", "), where: d.kindLabel }));
      if (!id) return { ref: null, obs: new Map() };
      const date = d.date?.value ? `дата документа: ${d.date.value}${d.date.basis === "title" ? " (из названия)" : ""}`
        : d.date?.values ? `в записях разные даты документа: ${d.date.values.join(", ")} — не выбирать одну` : "дата документа не указана";
      lines.push(`[${id}] ДОКУМЕНТ: ${d.typeLabel} — «${d.title}» (${d.kindLabel}); ${date}${d.revision ? `; редакция ${d.revision}` : ""}`
        + `${d.recordedInApp1 ? `; записан в приложение №1 ${d.recordedInApp1} — это НЕ дата документа` : ""}${d.capturedAt ? `; внесён в Habez Pro ${d.capturedAt}` : ""}`
        + `; товары: ${d.products.map((x) => x.short).join(", ")}${d.providedBy.length ? `; передал: ${d.providedBy.map((r) => (r === "factory_technologist" ? "технолог завода (роль)" : r)).join(", ")}` : ""}`
        + `; доступ: ${access}${d.dateConflict ? "; дата в названии и дата в записи расходятся" : ""}`);
      const obs = new Map();
      for (const o of d.observations.slice(0, maxObs)) {
        productsSeen.set(o.productId, o.productName);
        const oid = add(norm({ kind: "observation", product: o.slug, productName: o.productName, label: o.label, property: o.label, value: o.value, condition: o.condition,
          observationId: o.id, sourceType: d.type, sourceReference: d.reference, sourceDate: d.date?.value ?? null, access: o.access, verification: o.verification,
          statementType: o.statement, docId: d.id }, { status: o.disputed ? "conflict" : null }));
        if (!oid) break;
        obs.set(o.id, oid);
        lines.push(`  [${oid}] в документе указано: ${o.product} · ${o.label}: ${o.value}${o.condition ? ` (условие: ${o.condition})` : ""}${o.disputed ? " — у этого свойства в данных есть и другие значения; победителя нет" : ""}`);
      }
      if (d.observations.length > maxObs) lines.push(`  …ещё ${d.observations.length - maxObs} значений в этом документе`);
      return { ref: id, obs };
    },

    // Ответ общего поиска (search_knowledge).
    knowledge(items) {
      if (!items?.length) { lines.push("(поиск по данным Habez ничего не нашёл)"); return; }
      for (const it of items) {
        productsSeen.set(it.productId, it.product);
        const e = it.type === "observation"
          ? { kind: "observation", product: it.slug, productName: it.product, label: it.label, property: it.label, value: it.value, condition: it.condition, observationId: it.observationId,
            sourceType: it.sourceType, sourceReference: it.reference, access: it.access, verification: it.verification }
          : it.type === "variant"
            ? { kind: "variant", product: it.slug, productName: it.product, label: "фасовка", value: it.value, variant: it.variant, perPallet: it.perPallet, sourceType: "variant" }
            : { kind: "catalog_card", product: it.slug, productName: it.product, label: it.label, value: it.value, where: it.type === "section" ? `раздел «${it.label}»` : "карточка товара" };
        const id = add(norm(e, { conflictId: it.decision || null }));
        if (!id) break;
        lines.push(`[${id}] ${it.product} · ${it.label}: ${String(it.value ?? "").slice(0, 300)}${it.condition ? ` (условие: ${it.condition})` : ""}${it.type === "question" ? " — открытый вопрос сверки" : ""}`);
      }
    },

    // Сколько знаков и записей: для бюджета контекста.
    size() { return { chars: lines.reduce((n, l) => n + l.length + 1, 0), evidence: evidence.length, truncated }; },
    // Текст, добавленный после отметки (для ответа инструмента).
    mark() { return lines.length; },
    since(m) { return lines.slice(m).join("\n"); },
    productNames() { return [...productsSeen.values()]; },
    result() { return { text: lines.join("\n"), evidence, properties, found, variants, comparison, truncated }; },
  };
  return api;
}
