// Habez AI Phase 3.4: пути Factory Intelligence в конвейере ответа.
//
//   FACTORY_PROFILE    «Расскажи про завод» — профиль из реквизитов, каталога,
//                      документов; чего нет — названо
//   FACTORY_LOOKUP     «Где находится завод?», «Какая мощность?» — одно
//                      сведение; нет в данных — ответ без модели
//   FACTORY_PRODUCTS   «Что производит Habez?», «Какие краски выпускает
//                      завод?» — ассортимент и статус «производит» у товара
//   PRODUCT_FACTORY    «Где производится ШОВ?» — связи товара с заводами;
//                      данных нет — ответ без модели
//   FACTORY_DOCUMENTS  «Какие документы есть у ШОВ?», «Какой документ
//                      подтверждает прочность?», «Какие источники используются?»
//
// Всё считается здесь (factory/model.js через инструменты только чтения),
// модель получает готовые статусы и уровни сведений и только объясняет их:
//   ФАКТ ЗАВОДА — реквизиты, каталог;
//   ФАКТ ДОКУМЕНТА — документ такого вида и даты есть;
//   НАБЛЮДЕНИЕ — «в документе указано …»;
//   ВЫВОД — косвенная связь, прямо не подтверждена.
import { callTool } from "../tools/index.js";
import { RELATION_LABEL, NOT_IN_DATA } from "./model.js";
import { docTypeLabel } from "./documents.js";
import { sourceLabel } from "../runtime/bundle.js";
import { specLabel, resolveSpecs } from "../retrieval/specs.js";

const brackets = (ids) => { const u = [...new Set((ids || []).filter(Boolean))]; return u.length ? ` [${u.join("][")}]` : ""; };
const nameOf = (p) => p.short || p.short_name || p.name;
const list = (xs) => xs.join(", ").replace(/, ([^,]*)$/, " и $1");
const REL_UPPER = { CONFIRMED: "ПОДТВЕРЖДЕНО", INFERRED: "КОСВЕННО (вывод, прямо не подтверждено)", UNKNOWN: "НЕТ ДАННЫХ", CONFLICTED: "ИСТОЧНИКИ ПРОТИВОРЕЧАТ" };
const ROLE = { manufacturer: "изготовитель", production_site: "место производства", producer: "производит" };

function timed(calls, name, fn, found = (x) => (x ? 1 : 0)) {
  const t = Date.now();
  const out = fn();
  calls.push({ name, source: "plan", ms: Date.now() - t, found: found(out) });
  return out;
}

// Какой завод имеется в виду: названный в вопросе, из беседы или завод из
// реквизитов. Названный, но неизвестный («завод Кнауф») — null.
function resolveFactory({ q, route, ctx, calls, state }) {
  const words = q.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9-]{3,}/g) || [];
  const hits = timed(calls, "search_factories", () => callTool("search_factories", { terms: words.slice(0, 12) }, ctx).items, (x) => x.length);
  const named = hits.find((f) => f.id !== "home" && f.matched.length);
  if (named) return { id: named.id, from: "question" };
  const m = q.match(/завод[а-я]*\s+[«"]?([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё0-9-]{2,})/);
  if (m && !/^(habez|хабез)/i.test(m[1]) && !hits.some((f) => f.matched.length)) return { id: null, unknownName: m[1] };
  if (route.factory?.from === "state" && state.current_factory) return { id: state.current_factory, from: "state" };
  return { id: "home", from: route.factory?.from || "default" };
}

// Документ и его наблюдения в пакет — один раз на ответ.
function docAdder(bundle, allowed) {
  const seen = new Map();
  return (d, opts) => {
    // Товары документа — в данных ответа: их можно называть.
    for (const p of d.products || []) allowed?.add(p.id);
    if (!seen.has(d.id)) seen.set(d.id, bundle.document(d, opts));
    return seen.get(d.id);
  };
}

// Основания связи товара с заводом — строкой со ссылками.
function basisText(rel, docRefs, sectionRefs) {
  return rel.basis.map((b) => `${b.text}${brackets([b.docId ? docRefs.get(b.docId) : null, b.section ? sectionRefs.get(b.section) : null])}`).join("; ");
}

// Связи товаров (product_factory и паспорт товара): в пакет и сводку.
export function renderProductFactory({ items, docs, bundle, allowed, scope, levels = false }) {
  const addDoc = docAdder(bundle, allowed);
  const out = [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const r of items) {
    allowed.add(r.product.id);
    const catRef = bundle.catalogEntry({ ...r.product, category: r.product.category }, r.catalog.factory);
    const docRefs = new Map();
    for (const rel of r.production) for (const b of rel.basis) if (b.docId && docById.has(b.docId)) docRefs.set(b.docId, addDoc(docById.get(b.docId), { maxObs: 4 }).ref);
    const sectionRefs = new Map();
    for (const c of [...r.cardDocuments, ...r.unnamedManufacturer]) if (!sectionRefs.has(c.section)) sectionRefs.set(c.section, bundle.cardSection(r.product, c.section, c.text));
    bundle.note(`\nСВЯЗЬ ТОВАРА С ЗАВОДОМ: ${r.product.name}`);
    bundle.note(`- ФАКТ ЗАВОДА: товар есть в каталоге «${r.catalog.factory}», раздел «${r.product.category || "—"}»${brackets([catRef])} — это ассортимент, а не подтверждение производства`);
    for (const rel of r.production) {
      bundle.note(`- ${ROLE[rel.role] || rel.role}: ${rel.factory} — ${REL_UPPER[rel.status]}${rel.basis.length ? `; основания: ${basisText(rel, docRefs, sectionRefs)}` : "; оснований нет"}`);
    }
    if (r.brands.length) bundle.note(`- марка в названии или карточке: ${r.brands.join(", ")} — это марка, не завод и не изготовитель`);
    if (r.norm) bundle.note(`- нормативный документ в карточке: ${r.norm} — нормативный документ, которому соответствует товар (не документ завода); кто его держатель и где товар производится, из него не следует`);
    if (r.unnamedManufacturer.length) bundle.note(`- карточка упоминает изготовителя, но не называет его${brackets(r.unnamedManufacturer.map((c) => sectionRefs.get(c.section)))}`);
    for (const a of r.assortment.filter((x) => x.kind !== "catalog")) bundle.note(`- есть в документе ассортимента: ${a.text}${brackets([docById.has(a.docId) ? addDoc(docById.get(a.docId), { maxObs: 0 }).ref : null])} — это продажа, не производство`);
    if (scope === "public" && r.internalDocuments) bundle.note(`- у завода есть внутренние документы по этому товару (${r.internalDocuments}); их содержание доступно сотрудникам`);
    if (r.needsReview) bundle.note("- в системе есть внутренние данные об изготовителе, из-за которых сведения требуют дополнительной сверки — значения не раскрывать");
    const main = r.production.find((x) => x.role === "manufacturer") || r.production.find((x) => x.factoryId === "home") || r.production[0];
    out.push({
      product: r.product.name, short: r.product.short, slug: r.product.slug, status: r.status, label: RELATION_LABEL[r.status],
      relations: r.production.map((x) => ({ factory: x.factory, factoryId: x.factoryId, role: x.role, status: x.status, label: RELATION_LABEL[x.status],
        basis: x.basis.map((b) => ({ kind: b.kind, text: b.text, refs: [b.docId ? docRefs.get(b.docId) : null, b.section ? sectionRefs.get(b.section) : null].filter(Boolean) })) })),
      catalog: { factory: r.catalog.factory, ref: catRef }, brands: r.brands, norm: r.norm, needsReview: r.needsReview,
      refs: [catRef, ...docRefs.values(), ...sectionRefs.values()].filter(Boolean), mainFactoryId: main.factoryId,
      documents: r.documents.length,
    });
  }
  if (levels) {
    bundle.note("\nУРОВНИ СВЕДЕНИЙ (объясни пользователю по этим данным): ФАКТ ЗАВОДА — реквизиты и каталог; ФАКТ ДОКУМЕНТА — документ такого вида и даты есть; НАБЛЮДЕНИЕ — «в документе указано…»; ВЫВОД — связь предполагается по косвенным признакам (документ завода описывает товар), прямо источник этого не говорит. Прямое доказательство производства — только запись «Изготовитель» или «Место производства» в источнике.");
  }
  return out;
}

export function runFactory({ route, q, ctx, bundle, calls, allowed, state = {} }) {
  const f = route.factory || {};
  const t0 = Date.now();
  const target = resolveFactory({ q, route, ctx, calls, state });
  if (!target.id) {
    return { mode: "NOT_FOUND", products: [], factoryId: null, timings: { factoryMs: Date.now() - t0 },
      fixed: `Завода «${target.unknownName}» в данных Habez нет. Известен завод из реквизитов организации; другие заводы в данных не названы.` };
  }
  const timings = { factoryMs: 0, documentsMs: 0, graphMs: 0 };

  // Профиль и одно сведение о заводе.
  if (route.intent === "factory_profile" || route.intent === "factory_lookup") {
    const prof = timed(calls, "get_factory", () => callTool("get_factory", { factoryId: target.id }, ctx));
    timings.factoryMs = Date.now() - t0;
    if (!prof) return { mode: "NOT_FOUND", products: [], factoryId: null, fixed: "Сведений об этом заводе в данных Habez нет.", timings };
    const fac = prof.factory;
    // «Какая мощность завода?» — этого в данных нет: без модели.
    if (route.intent === "factory_lookup" && f.asked && f.asked !== "location") {
      return { mode: "FACTORY_LOOKUP", products: [], factoryId: fac.id, timings, factory: summaryOf(prof),
        fixed: `В данных Habez нет сведений о том, какая у завода «${fac.name}» ${f.asked}. О заводе известны только реквизиты организации (название, юридическое лицо, адрес организации${fac.site ? ", сайт" : ""}) и каталог товаров. Площадь, мощность, численность работников и производительность ни в одном источнике не указаны.` };
    }
    const t1 = Date.now();
    const refs = bundle.factoryRecord(fac);
    const groupRefs = [];
    if (route.intent === "factory_profile") {
      bundle.note(`\nТОВАРНЫЕ ГРУППЫ (каталог завода; статус «производит» посчитала система):`);
      for (const g of prof.productGroups) {
        const id = bundle.record({ label: `Раздел каталога «${g.name}»`, value: `${g.count} товаров`, sourceType: "catalog",
          text: `Раздел каталога «${g.name}»: ${g.count} товаров; производство: подтверждено ${g.CONFIRMED}, косвенно ${g.INFERRED}, нет данных ${g.UNKNOWN}${g.CONFLICTED ? `, противоречие ${g.CONFLICTED}` : ""}` });
        groupRefs.push(id);
      }
      const addDoc = docAdder(bundle, allowed);
      const factoryDocs = prof.documents.filter((d) => d.kind !== "card").slice(0, 12);
      if (factoryDocs.length) {
        bundle.note("\nДОКУМЕНТЫ ЗАВОДА В ДАННЫХ (виды и даты — как записаны):");
        for (const d of factoryDocs) addDoc(d, { maxObs: 0 });
        if (prof.documents.length > 12) bundle.note(`…ещё ${prof.documents.length - 12} документов`);
      } else if (ctx.scope === "public") bundle.note("\nДокументы из внутренней базы завода доступны сотрудникам; на витрине их нет.");
      for (const s of prof.registeredSources) bundle.record({ label: "Зарегистрированный источник", value: s.name, where: `${docTypeLabel(s.type)}${s.date ? `, дата из названия ${s.date}` : ""}`, sourceType: "habez_registry" });
      if (prof.sourceTypes.length) bundle.note(`\nВИДЫ ИСТОЧНИКОВ (наблюдений): ${prof.sourceTypes.map((s) => `${docTypeLabel(s.type)} — ${s.observations}`).join("; ")}`);
      if (prof.brands.length) bundle.note(`\nМАРКИ в названиях и карточках: ${prof.brands.join(", ")} — марка не равна заводу.`);
    }
    bundle.note(`\nНЕ УСТАНОВЛЕНО: ${prof.unresolved.join("; ") || "—"}`);
    bundle.note(`В ДАННЫХ НЕТ (не выдумывать): ${NOT_IN_DATA.join(", ")}.`);
    if (f.levels) bundle.note("\nУРОВНИ СВЕДЕНИЙ: ФАКТ ЗАВОДА — реквизиты и каталог; ФАКТ ДОКУМЕНТА — документ есть; НАБЛЮДЕНИЕ — в документе указано значение; ВЫВОД — косвенная связь «завод производит товар» (документ завода описывает товар), прямо источник этого не говорит. Прямое доказательство — только запись «Изготовитель» / «Место производства».");
    timings.graphMs = Date.now() - t1;
    return { mode: route.intent === "factory_profile" ? "FACTORY_PROFILE" : "FACTORY_LOOKUP", products: [], factoryId: fac.id, timings,
      factory: { ...summaryOf(prof), refs: { ...refs, groups: groupRefs.filter(Boolean) } } };
  }

  // Товары завода.
  if (route.intent === "factory_products") {
    const res = timed(calls, "get_factory_products", () => callTool("get_factory_products", { factoryId: target.id, group: f.group }, ctx), (x) => x?.items.length ?? 0);
    timings.factoryMs = Date.now() - t0;
    if (!res) return { mode: "NOT_FOUND", products: [], factoryId: null, fixed: "Сведений об этом заводе в данных Habez нет.", timings };
    const prof = callTool("get_factory", { factoryId: target.id }, ctx);
    const exclude = f.more && state.current_product ? state.current_product : null;
    const items = res.items.filter((r) => r.product.slug !== exclude);
    if (!items.length) {
      return { mode: "NOT_FOUND", products: [], factoryId: target.id, timings,
        fixed: f.group ? `В каталоге завода «${prof.factory.name}» нет товаров группы «${f.group}».` : `В данных Habez нет товаров, связанных с заводом «${prof.factory.name}».` };
    }
    const t1 = Date.now();
    bundle.factoryRecord(prof.factory);
    const docById = new Map(prof.documents.map((d) => [d.id, d]));
    const addDoc = docAdder(bundle, allowed);
    const count = (st) => items.filter((r) => (r.production.find((x) => x.factoryId === target.id)?.status ?? "UNKNOWN") === st).length;
    bundle.note(`\nТОВАРЫ ЗАВОДА${f.group ? ` — группа «${f.group}»` : ""}${exclude ? " (кроме товара, о котором уже шла речь)" : ""}: ${items.length}. Статус «производит» посчитала система: подтверждено ${count("CONFIRMED")}, косвенно ${count("INFERRED")}, нет данных ${count("UNKNOWN")}${count("CONFLICTED") ? `, противоречие ${count("CONFLICTED")}` : ""}.`);
    bundle.note("Все товары ниже — в каталоге завода (ассортимент). «Нет данных» о производстве — не «не производит»; отсутствие товара в прайсе или на сайте ничего не доказывает.");
    const summary = [];
    for (const r of items.slice(0, 60)) {
      allowed.add(r.product.id);
      const ref = bundle.catalogEntry(r.product, prof.factory.name);
      const rel = r.production.find((x) => x.factoryId === target.id) || { status: "UNKNOWN", basis: [] };
      const docRefs = rel.basis.filter((b) => b.docId && docById.has(b.docId)).map((b) => addDoc(docById.get(b.docId), { maxObs: 0 }).ref);
      bundle.note(`[${ref}] ${r.product.name} — раздел «${r.product.category || "—"}»; производство: ${REL_UPPER[rel.status]}${docRefs.length ? `; основания: ${rel.basis.filter((b) => b.docId).map((b) => b.text).join("; ")}${brackets(docRefs)}` : ""}`);
      summary.push({ product: r.product.name, short: r.product.short, slug: r.product.slug, category: r.product.category, status: rel.status, label: RELATION_LABEL[rel.status], refs: [ref, ...docRefs].filter(Boolean) });
    }
    timings.graphMs = Date.now() - t1;
    return { mode: "FACTORY_PRODUCTS", products: [], factoryId: target.id, timings,
      factory: { ...summaryOf(prof), group: f.group, items: summary, byStatus: { CONFIRMED: count("CONFIRMED"), INFERRED: count("INFERRED"), UNKNOWN: count("UNKNOWN"), CONFLICTED: count("CONFLICTED") } } };
  }

  // Документы и связи товаров.
  const productIds = route.products.map((p) => p.id);
  const fromFactory = !productIds.length && (route.factory?.from === "state" || route.intent === "factory_documents");
  const factoryProductIds = fromFactory && route.factory?.from === "state"
    ? (callTool("get_factory_products", { factoryId: target.id }, ctx)?.items || []).map((r) => r.product.id) : null;
  // Характеристика — из вопроса без имён товаров: «краска ФАСАД» — товар,
  // а не «наружные работы».
  let named = q;
  for (const p of route.products) for (const n of [p.short_name, ...[...String(p.name || "").matchAll(/«([^»]+)»/g)].map((m) => m[1])].filter(Boolean)) {
    named = named.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  }
  const specKeys = route.intent === "factory_documents" && route.specs.keys.length ? resolveSpecs(named).keys.filter((k) => k !== "per_pallet") : [];
  const td = Date.now();
  const res = timed(calls, "get_factory_documents", () => callTool("get_factory_documents", {
    factoryId: fromFactory && !factoryProductIds ? target.id : null, productIds: productIds.length ? productIds : factoryProductIds?.slice(0, 60) || undefined,
    types: f.docTypes?.length ? f.docTypes : undefined, specKeys: specKeys.length ? specKeys : undefined,
  }, ctx), (x) => x.documents.length);
  timings.documentsMs = Date.now() - td;
  timings.factoryMs = Date.now() - t0 - timings.documentsMs;
  const names = route.products.map(nameOf);

  if (route.intent === "product_factory") {
    const t1 = Date.now();
    const unknownAll = res.products.every((r) => r.status === "UNKNOWN" && !r.needsReview && !r.cardDocuments.length);
    const items = renderProductFactory({ items: res.products, docs: res.documents, bundle, allowed, scope: ctx.scope, levels: f.levels });
    timings.graphMs = Date.now() - t1;
    const mainFactory = items.find((x) => x.status === "CONFIRMED")?.mainFactoryId || "home";
    if (unknownAll && !f.levels) {
      const r0 = res.products[0];
      return { mode: "PRODUCT_FACTORY", products: [], productFactory: items, factoryId: mainFactory, timings,
        fixed: `В доступных данных завод-изготовитель ${list(names)} не указан. ${names.length > 1 ? "Товары есть" : "Товар есть"} в каталоге «${r0.catalog.factory}» — это ассортимент завода, а не подтверждение, что ${names.length > 1 ? "они производятся" : "товар производится"} именно там.`
          + (res.products.some((r) => r.unnamedManufacturer.length) ? " Карточка упоминает изготовителя, но не называет его." : "")
          + (res.products.some((r) => r.brands.length) ? ` Марка в названии (${[...new Set(res.products.flatMap((r) => r.brands))].join(", ")}) — это марка, а не завод.` : "")
          + (ctx.scope === "public" && res.products.some((r) => r.internalDocuments) ? " Внутренние документы завода по товару доступны сотрудникам." : "") };
    }
    return { mode: "PRODUCT_FACTORY", products: [], productFactory: items, factoryId: mainFactory, timings };
  }

  // factory_documents
  const t1 = Date.now();
  const docs = res.documents;
  const cardMentions = res.products.flatMap((r) => r.cardDocuments.map((c) => ({ ...c, product: r.product })));
  const norms = res.products.filter((r) => r.norm).map((r) => ({ product: r.product, norm: r.norm }));
  if (!docs.length && !cardMentions.length) {
    const what = f.docTypes?.length ? `«${f.docTypes.map(docTypeLabel).join("», «")}»` : "документов";
    const about = names.length ? ` по ${list(names)}` : "";
    const spec = specKeys.length ? `, которые содержат «${[...new Set(specKeys.map(specLabel))].slice(0, 3).join("», «")}»` : "";
    const internal = ctx.scope === "public" && res.products.some((r) => r.internalDocuments);
    return { mode: "FACTORY_DOCUMENTS", products: [], documents: [], factoryId: target.id, timings,
      fixed: `В доступных данных ${what}${about}${spec} нет.`
        + (norms.length ? ` В карточке указан нормативный документ: ${norms.map((n) => `${nameOf(n.product)} — ${n.norm}`).join("; ")} (нормативный документ, а не документ завода).` : "")
        + (internal ? " Внутренние документы завода по этому товару доступны сотрудникам." : "")
        + " Документ, которого нет в данных, я не называю." };
  }
  const addDoc = docAdder(bundle, allowed);
  bundle.note(`\nДОКУМЕНТЫ${names.length ? ` по ${list(names)}` : ""}${f.docTypes?.length ? ` (вид: ${f.docTypes.map(docTypeLabel).join(", ")})` : ""}${specKeys.length ? ` с характеристикой «${[...new Set(specKeys.map(specLabel))].slice(0, 3).join("», «")}»` : ""}. Один документ может относиться к нескольким товарам. Дата документа, дата записи в приложение №1 и дата внесения в Habez Pro — разные даты.`);
  const summary = [];
  for (const d of docs.slice(0, 14)) {
    const { ref, obs } = addDoc(d, { maxObs: specKeys.length ? 12 : f.overview ? 0 : docs.length > 4 ? 6 : 12 });
    for (const p of d.products) allowed.add(p.id);
    summary.push({ id: d.id, type: d.type, typeLabel: d.typeLabel, kind: d.kind, kindLabel: d.kindLabel, title: d.title, titleKnown: d.titleKnown,
      date: d.date?.value ?? null, dateBasis: d.date?.basis ?? null, recordedInApp1: d.recordedInApp1, capturedAt: d.capturedAt,
      products: d.products.map((p) => p.short), observations: d.observations.length, access: d.access, ref, refs: [ref, ...obs.values()].filter(Boolean) });
  }
  if (docs.length > 14) bundle.note(`…ещё ${docs.length - 14} документов`);
  for (const c of cardMentions) {
    const id = bundle.cardSection(c.product, c.section, c.text);
    allowed.add(c.product.id);
    summary.push({ id: `card-${c.product.slug}-${c.type}`, type: c.type, typeLabel: c.typeLabel, kind: "mention", kindLabel: "упомянут в карточке, сам документ в системе не хранится", title: c.section,
      date: null, products: [nameOf(c.product)], observations: 0, access: ["public"], ref: id, refs: [id].filter(Boolean) });
  }
  for (const n of norms) bundle.note(`- ${nameOf(n.product)}: в карточке указан нормативный документ ${n.norm} — не документ завода`);
  if (ctx.scope === "public" && res.products.some((r) => r.internalDocuments)) bundle.note("- у завода есть внутренние документы по этим товарам; их содержание доступно сотрудникам");
  if (res.conflicts.value.length) bundle.note(`\nРАСХОЖДЕНИЯ: у ${[...new Set(res.conflicts.value.map((c) => `${c.product} · ${c.label}`))].slice(0, 8).join("; ")} в данных несколько разных значений — назвать все, победителя не выбирать.`);
  for (const c of res.conflicts.dates) bundle.note(`- ${c.product}: несколько документов вида «${c.typeLabel}» с разными датами (${c.docs.map((d) => d.date || "без даты").join(", ")}) — более поздняя дата не делает документ правильнее.`);
  if (f.conflictPolicy) bundle.note("\nПРАВИЛО ПРИ РАСХОЖДЕНИИ ДОКУМЕНТОВ: система не выбирает победителя ни по дате, ни по виду документа (порядок доверия к видам источников владелец не утверждал). Показываются все значения с их документами; решение принимает человек в панели («Вопросы сверки»), помощник его не принимает.");
  if (f.overview) bundle.note(`\nВИДЫ ИСТОЧНИКОВ: ${callTool("get_factory", { factoryId: "home" }, ctx).sourceTypes.map((s) => `${sourceLabel(s.type)} — ${s.observations} наблюд.`).join("; ") || "наблюдения этой роли недоступны"}. «Первоисточник не установлен» и «подставлено программой» — не документы. Называй виды словами, как здесь, без служебных кодов.`);
  timings.graphMs = Date.now() - t1;
  return { mode: "FACTORY_DOCUMENTS", products: [], documents: summary, factoryId: target.id, timings,
    documentConflicts: { value: res.conflicts.value.length, dates: res.conflicts.dates.length } };
}

// Короткая сводка завода для интерфейса.
function summaryOf(prof) {
  const f = prof.factory;
  return {
    id: f.id, name: f.name, legalName: f.legalName, status: f.status, site: f.site,
    location: f.location ? { text: f.location.text, label: f.location.label, kind: f.location.kind } : null,
    groups: prof.productGroups.map((g) => ({ name: g.name, count: g.count, CONFIRMED: g.CONFIRMED, INFERRED: g.INFERRED, UNKNOWN: g.UNKNOWN, CONFLICTED: g.CONFLICTED })),
    products: prof.products.items.length, byStatus: prof.products.byStatus,
    documents: prof.documents.filter((d) => d.kind !== "card").slice(0, 12).map((d) => ({ id: d.id, typeLabel: d.typeLabel, title: d.title, date: d.date?.value ?? null, products: d.products.map((p) => p.short) })),
    documentCount: prof.documents.length, brands: prof.brands, unresolved: prof.unresolved, notInData: prof.notInData,
  };
}
