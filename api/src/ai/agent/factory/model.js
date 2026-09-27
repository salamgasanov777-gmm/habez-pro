// Habez AI Phase 3.4: Factory Intelligence — заводы, площадки, ассортимент
// и заводские документы. Производный слой, как Product Intelligence (3.3):
// новых таблиц нет, всё считается из того, что уже есть:
//
//   tenants              реквизиты организации: название, юрлицо, адрес, сайт;
//   products, categories каталог (ассортимент) и товарные группы;
//   ai_spec_observations наблюдения с происхождением: вид источника,
//                        документ, дата, роль передавшего, уровень доступа;
//   ai_sources           зарегистрированные источники.
//
// Сущности:
//   Factory   — завод из реквизитов (home) и заводы, названные в самих
//               наблюдениях «Изготовитель» / «Место производства» (mentioned).
//               Полей, которых нет в источниках (площадь, мощность,
//               численность, производительность), у завода нет.
//   Relation  — завод ↔ товар двух видов:
//               catalog    — товар в каталоге завода (ассортимент, продажа);
//               production — завод производит товар: CONFIRMED (источник прямо
//                            называет изготовителя или площадку), INFERRED
//                            (косвенно: документ, который выпускает
//                            изготовитель), UNKNOWN (данных нет), CONFLICTED
//                            (источники называют разных изготовителей).
//               Вывод не становится подтверждением; отсутствие товара в прайсе
//               не доказывает, что завод его не производит.
//   Document  — documents.js.
//
// Права — как у остальных инструментов агента:
//   public — только витрина: реквизиты, каталог, упоминания документов в
//            карточке; наблюдений нет;
//   staff  — плюс наблюдения public + internal;
//   admin  — плюс конфиденциальные.
// Скрытое, которое влияет на ответ, роль видит только как факт («есть
// внутренние данные, нужна сверка»), без значения и документа.
import { all, get } from "../../../db/index.js";
import { collectDocuments, documentConflicts, DOC_TYPES, CARD_MENTIONS, dateFromTitle, docTypeLabel } from "./documents.js";

export const RELATION_STATUSES = ["CONFIRMED", "INFERRED", "UNKNOWN", "CONFLICTED"];
export const RELATION_LABEL = {
  CONFIRMED: "подтверждено источником",
  INFERRED: "косвенно, прямо не подтверждено",
  UNKNOWN: "нет данных",
  CONFLICTED: "источники противоречат",
};
// Ключи словаря, в которых источник прямо называет изготовителя или место
// производства (spec-dictionary.js).
export const FACTORY_KEYS = ["manufacturer", "production_site"];
// Чего о заводе в данных нет и быть не должно без источника.
export const NOT_IN_DATA = ["площадь", "производственная мощность", "численность работников", "производительность", "год основания"];

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
const levelsFor = (scope) => (scope === "admin" ? ["public", "internal", "confidential"] : scope === "staff" ? ["public", "internal"] : []);
const IN = (list) => list.map(() => "?").join(",");

// Название организации без формы собственности и кавычек: «ОАО «Хабезский
// гипсовый завод»» и «Хабезский гипсовый завод» — одно имя.
export const normName = (s) => low(s).replace(/[«»"“”„']/g, " ").replace(/(^|\s)(оао|ооо|зао|пао|ао|ип|ooo|llc)(?=\s|$)/g, " ")
  .replace(/[^a-zа-я0-9]+/g, " ").trim();

// Марка в названиях и карточках: HABEZ, ХАБЕЗ, ТМ «Habez-Gips». Марка —
// не завод и не производитель.
const BRAND_RE = /(?:ТМ\s*)?[«"]?(HABEZ[- ]?GIPS|Habez[- ]?Gips|HabezGips|HABEZ|ХАБЕЗ)[»"]?/g;
function brandsOf(p) {
  const out = new Set();
  for (const m of String(p.name || "").matchAll(BRAND_RE)) out.add(m[1].toUpperCase().replace(/[- ]?GIPS/, "-GIPS"));
  for (const s of json(p.sections, [])) for (const m of String(s.text || "").matchAll(/ТМ\s*«([^»]+)»/g)) out.add(`ТМ «${m[1]}»`);
  return [...out];
}

function homeFactory(tenant, scope) {
  const s = json(tenant.settings, {});
  const site = s.site || null;
  const aliases = [...new Set([tenant.name, tenant.legal_name, tenant.slug, s.orderPrefix, site ? site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : null].filter(Boolean))];
  return {
    id: "home", name: tenant.name, legalName: tenant.legal_name || null, aliases, site,
    // Адрес из реквизитов — адрес организации. Что это адрес именно
    // производственной площадки, в данных не сказано.
    location: tenant.address ? { text: tenant.address, kind: "organization_address", label: "адрес в реквизитах организации" } : null,
    // ИНН и ОГРН на витрине не опубликованы — только сотрудникам.
    requisites: scope === "public" ? null : { inn: tenant.inn || null, ogrn: s.ogrn || null },
    status: "REGISTERED", basis: "реквизиты организации в Habez Pro",
  };
}

// Всё, что нужно слою, — одним чтением. Видимость — по роли.
export function loadFactoryData(ctx) {
  const tenant = get("SELECT * FROM tenants WHERE id=?", ctx.tenantId);
  const products = all(`SELECT p.id, p.slug, p.name, p.short_name, p.status, p.sections, p.gost, c.name AS category, c.id AS category_id
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=?${ctx.scope === "public" ? " AND p.status='published'" : ""}
     ORDER BY c.position, c.id, p.position, p.id`, ctx.tenantId);
  const productsById = new Map(products.map((p) => [p.id, p]));
  const levels = levelsFor(ctx.scope);
  const observations = levels.length ? all(`SELECT o.id, o.product_id, o.variant_id, o.spec_key, o.label, o.original_value, o.condition_key, o.condition_text,
        o.statement_type, o.source_type, o.source_id, s.name AS linked_source_name, o.source_name, o.source_reference, o.provided_by, o.provided_at,
        o.captured_at, o.access_level, o.verification_status, o.capture_channel, o.upstream_ref, o.upstream_recorded_at
      FROM ai_spec_observations o LEFT JOIN ai_sources s ON s.id=o.source_id
     WHERE o.tenant_id=? AND o.lifecycle_status='active' AND o.access_level IN (${IN(levels)}) ORDER BY o.id`, ctx.tenantId, ...levels).filter((o) => productsById.has(o.product_id)) : [];
  // Скрытые роли сведения об изготовителе: значения остаются здесь, наружу —
  // только «есть и расходится».
  const hiddenLevels = ["public", "internal", "confidential"].filter((l) => !levels.includes(l));
  const hiddenFactoryObs = hiddenLevels.length ? all(`SELECT product_id, spec_key, original_value, access_level FROM ai_spec_observations
     WHERE tenant_id=? AND lifecycle_status='active' AND spec_key IN (${IN(FACTORY_KEYS)}) AND access_level IN (${IN(hiddenLevels)})`, ctx.tenantId, ...FACTORY_KEYS, ...hiddenLevels) : [];
  // Гостю можно назвать число внутренних документов по товару (как число
  // открытых вопросов сверки в 3.2), но не их содержание; конфиденциальные
  // не считаются.
  const internalDocs = ctx.scope === "public" ? all(`SELECT product_id, COUNT(DISTINCT source_type || '|' || COALESCE(source_reference,'') || '|' || COALESCE(source_name,'')) AS n
      FROM ai_spec_observations WHERE tenant_id=? AND lifecycle_status='active' AND access_level IN ('public','internal')
       AND source_type NOT IN ('generated_default','ai_inference','unknown_legacy_origin','manual_entry') GROUP BY product_id`, ctx.tenantId) : [];
  const sources = ctx.scope === "public" ? [] : all("SELECT id, source_type, name, url, publisher, created_at FROM ai_sources WHERE tenant_id=? AND status='active' ORDER BY id", ctx.tenantId);
  const home = homeFactory(tenant, ctx.scope);
  const data = { ctx, tenant, home, products, productsById, observations, hiddenFactoryObs, sources,
    internalDocsByProduct: new Map(internalDocs.map((r) => [r.product_id, r.n])) };
  data.obsByProduct = new Map();
  for (const o of observations) {
    if (!data.obsByProduct.has(o.product_id)) data.obsByProduct.set(o.product_id, []);
    data.obsByProduct.get(o.product_id).push(o);
  }
  data.factories = factoriesOf(data);
  data.documents = collectDocuments(observations, { productsById, homeId: home.id });
  data.docConflicts = documentConflicts(data.documents, observations);
  return data;
}

// Завод, названный в наблюдении: свой (home) или другой (mentioned).
function matchFactory(data, value) {
  const n = normName(value);
  if (!n) return null;
  const home = data.home;
  const homeNames = [home.name, home.legalName].filter(Boolean).map(normName);
  if (homeNames.some((h) => h && (n.includes(h) || h.includes(n)))) return home;
  return { id: `m-${n.replace(/\s+/g, "-").slice(0, 48)}`, name: String(value).trim(), legalName: null, aliases: [String(value).trim()], site: null, location: null,
    requisites: null, status: "MENTIONED", basis: "назван в данных о товаре как изготовитель или место производства" };
}

function factoriesOf(data) {
  const out = new Map([[data.home.id, data.home]]);
  for (const o of data.observations.filter((x) => FACTORY_KEYS.includes(x.spec_key))) {
    const f = matchFactory(data, o.original_value);
    if (f && !out.has(f.id)) out.set(f.id, f);
  }
  return out;
}

// Карточка на витрине: упоминания документов и изготовителя без названия
// («Изготовитель гарантирует…»), прямое имя изготовителя.
function cardMentions(p, home) {
  const docs = [];
  const unnamed = [];
  const explicit = [];
  const homeNames = [home.name, home.legalName].filter(Boolean).map(normName);
  for (const s of json(p.sections, [])) {
    const text = String(s.text || "");
    const lt = low(text);
    for (const m of CARD_MENTIONS) {
      if (m.re.test(lt)) docs.push({ type: m.type, typeLabel: m.label || `${docTypeLabel(m.type)} (упомянут в карточке)`, section: s.title, text: text.slice(0, 240), ofFactory: /завод/.test(lt) });
    }
    for (const sn of text.split(/(?<=[.!?])\s+/)) {
      if (!/изготовител|производител/i.test(sn)) continue;
      if (homeNames.some((h) => h && normName(sn).includes(h))) explicit.push({ section: s.title, text: sn.slice(0, 240) });
      else unnamed.push({ section: s.title, text: sn.slice(0, 240) });
    }
  }
  return { docs, unnamed, explicit };
}

const docOf = (data, o) => data.documents.find((d) => d.observations.some((x) => x.id === o.id));

// Связи одного товара с заводами.
export function productFactory(data, p) {
  const home = data.home;
  const obs = data.obsByProduct.get(p.id) || [];
  const card = cardMentions(p, home);
  const production = [];
  // 1. Прямые утверждения: «Изготовитель», «Место производства», имя
  //    изготовителя в карточке.
  const stated = obs.filter((o) => FACTORY_KEYS.includes(o.spec_key)).map((o) => ({ o, f: matchFactory(data, o.original_value) })).filter((x) => x.f);
  const makers = new Map();
  for (const x of stated.filter((s) => s.o.spec_key === "manufacturer")) {
    if (!makers.has(x.f.id)) makers.set(x.f.id, { f: x.f, obs: [] });
    makers.get(x.f.id).obs.push(x.o);
  }
  if (card.explicit.length && !makers.has(home.id)) makers.set(home.id, { f: home, obs: [], card: card.explicit });
  const sites = new Map();
  for (const x of stated.filter((s) => s.o.spec_key === "production_site")) {
    if (!sites.has(x.f.id)) sites.set(x.f.id, { f: x.f, obs: [] });
    sites.get(x.f.id).obs.push(x.o);
  }
  const basisOf = (list, extra = []) => [
    ...list.map((o) => { const d = docOf(data, o); return { kind: "statement", text: `${o.spec_key === "manufacturer" ? "изготовитель" : "место производства"}: «${o.original_value}»`, observationId: o.id, docId: d?.id ?? null, docTitle: d?.title ?? null, docType: o.source_type }; }),
    ...extra.map((c) => ({ kind: "card", text: `карточка, раздел «${c.section}»: «${c.text}»`, section: c.section })),
  ];
  // Изготовитель — одно юрлицо: два разных — противоречие. Площадок может
  // быть несколько, и это не противоречие.
  for (const m of makers.values()) {
    production.push({ factoryId: m.f.id, factory: m.f.name, role: "manufacturer", status: makers.size > 1 ? "CONFLICTED" : "CONFIRMED", basis: basisOf(m.obs, m.card || []) });
  }
  for (const s of sites.values()) {
    const cur = production.find((r) => r.factoryId === s.f.id);
    if (cur) cur.basis.push(...basisOf(s.obs));
    else production.push({ factoryId: s.f.id, factory: s.f.name, role: "production_site", status: "CONFIRMED", basis: basisOf(s.obs) });
  }
  // 2. Косвенно — только для завода из реквизитов и только если прямых
  //    утверждений о нём нет.
  if (!production.some((r) => r.factoryId === home.id)) {
    const basis = [];
    const seen = new Set();
    for (const o of obs) {
      const meta = DOC_TYPES[o.source_type];
      if (!meta?.production) continue;
      const d = docOf(data, o);
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      basis.push({ kind: "document", text: `${d.typeLabel}${d.date?.value ? ` от ${d.date.value}` : ""} содержит характеристики товара`, docId: d.id, docTitle: d.title, docType: d.type });
    }
    for (const c of card.docs.filter((x) => x.ofFactory && ["quality_passport", "label"].includes(x.type))) {
      basis.push({ kind: "card", text: `карточка ссылается на документ завода (раздел «${c.section}»)`, section: c.section });
    }
    production.push({ factoryId: home.id, factory: home.name, role: "producer", status: basis.length ? "INFERRED" : "UNKNOWN", basis });
  }
  // Ассортимент: где товар есть как предложение, не как производство.
  const assortment = [{ kind: "catalog", text: `в каталоге «${home.name}» (раздел «${p.category || "—"}»)` }];
  for (const d of data.documents.filter((x) => x.assortment && x.products.some((y) => y.id === p.id))) {
    assortment.push({ kind: d.type, text: `${d.typeLabel}${d.titleKnown ? ` «${d.title}»` : ""}`, docId: d.id });
  }
  // Скрытое, что меняло бы ответ: есть сведения об изготовителе, которых
  // роль не видит, и они расходятся с видимыми (или видимых нет).
  const hidden = data.hiddenFactoryObs.filter((h) => h.product_id === p.id);
  const visibleIds = new Set(production.filter((r) => r.status === "CONFIRMED" || r.status === "CONFLICTED").map((r) => r.factoryId));
  const needsReview = hidden.length > 0 && (!visibleIds.size || hidden.some((h) => !visibleIds.has(matchFactory(data, h.original_value)?.id)));
  const main = production.find((r) => r.role === "manufacturer") || production.find((r) => r.factoryId === home.id) || production[0];
  return {
    product: { id: p.id, slug: p.slug, name: p.name, short: p.short_name || p.name, category: p.category },
    catalog: { factoryId: home.id, factory: home.name, status: "CONFIRMED" },
    production, status: main.status, assortment,
    brands: brandsOf(p), norm: p.gost || null,
    cardDocuments: card.docs, unnamedManufacturer: card.unnamed,
    documents: data.documents.filter((d) => d.products.some((x) => x.id === p.id)).map((d) => d.id),
    internalDocuments: data.internalDocsByProduct.get(p.id) || 0,
    needsReview,
  };
}

// Товарные группы по словам вопроса (разделы каталога).
export const GROUPS = [
  { re: /сух[а-я]*\s+(строительн[а-я]*\s+)?смес/, label: "сухие смеси", cat: /^(гипсовая штукатурка|цементн|шпаклевк|клеи|полы|монтажн)/, name: /смес/, nameCat: /гидроизол/ },
  { re: /краск/, label: "краски", cat: /краск/ },
  { re: /гипсокартон|(?:^|[^а-я])гкл/, label: "гипсокартон", cat: /гипсокартон/ },
  { re: /пазогреб|(?:^|[^а-я])пгп/, label: "пазогребневые плиты", cat: /пазогреб/ },
  { re: /грунт/, label: "грунтовки", cat: /грунт/ },
  { re: /(?:^|[^а-я])кле[йия]/, label: "клеи", cat: /клеи/ },
  { re: /шпакл/, label: "шпаклёвки", cat: /шпакл/ },
  { re: /штукатур/, label: "штукатурки", cat: /штукатур/ },
  { re: /наливн|(?:^|[^а-я])пол(ы|ов)?(?![а-я])|стяжк/, label: "полы", cat: /^полы/ },
  { re: /гидроизол/, label: "гидроизоляция", cat: /гидроизол/ },
  { re: /профил|подвес/, label: "профили и подвесы", cat: /профил/ },
  { re: /монтажн/, label: "монтажные смеси", cat: /монтажн/ },
  { re: /(?:^|[^а-я])(гипс|алебастр)(?![а-я])/, label: "гипс", cat: /^гипс$/ },
];
export function groupFromQuestion(q) {
  const t = low(q);
  return GROUPS.find((g) => g.re.test(t)) || null;
}
const inGroup = (g, p) => g.cat.test(low(p.category)) || (g.name && g.nameCat?.test(low(p.category)) && g.name.test(low(p.name)));

// Товары завода. Для своего завода — весь каталог (ассортимент), у каждого
// товара — статус производства. Для завода, названного в данных, — только
// товары, где он назван.
export function factoryProducts(data, factoryId, { group = null, productIds = null } = {}) {
  let list = data.products;
  if (group) list = list.filter((p) => inGroup(group, p));
  if (productIds) list = list.filter((p) => productIds.includes(p.id));
  const rel = list.map((p) => productFactory(data, p));
  const items = factoryId === data.home.id ? rel : rel.filter((r) => r.production.some((x) => x.factoryId === factoryId));
  const count = (st) => items.filter((r) => (r.production.find((x) => x.factoryId === factoryId)?.status ?? "UNKNOWN") === st).length;
  return {
    factoryId, group: group?.label ?? null, items,
    byStatus: Object.fromEntries(RELATION_STATUSES.map((s) => [s, count(s)])),
    groups: productGroups(data, items, factoryId),
  };
}

function productGroups(data, items, factoryId) {
  const out = new Map();
  for (const r of items) {
    const name = r.product.category || "без раздела";
    if (!out.has(name)) out.set(name, { name, count: 0, CONFIRMED: 0, INFERRED: 0, UNKNOWN: 0, CONFLICTED: 0 });
    const g = out.get(name);
    g.count += 1;
    g[r.production.find((x) => x.factoryId === factoryId)?.status ?? "UNKNOWN"] += 1;
  }
  return [...out.values()];
}

// Документы по товарам, виду, характеристике, заводу.
export function factoryDocuments(data, { factoryId = null, productIds = null, types = null, specKeys = null } = {}) {
  let docs = data.documents;
  if (factoryId) docs = docs.filter((d) => d.issuer?.factoryId === factoryId || d.observations.some((o) => FACTORY_KEYS.includes(o.key) && matchFactory(data, o.value)?.id === factoryId));
  if (productIds?.length) docs = docs.filter((d) => d.products.some((p) => productIds.includes(p.id)));
  if (types?.length) docs = docs.filter((d) => types.includes(d.type));
  if (specKeys?.length) docs = docs.filter((d) => d.observations.some((o) => specKeys.includes(o.key)));
  // Внутри документа — только наблюдения о нужных товарах и характеристиках.
  docs = docs.map((d) => ({ ...d, observations: d.observations.filter((o) => (!productIds?.length || productIds.includes(o.productId)) && (!specKeys?.length || specKeys.includes(o.key))) }));
  const ids = new Set(docs.map((d) => d.id));
  return {
    documents: docs,
    conflicts: { value: data.docConflicts.value.filter((c) => ids.has(c.docId)), dates: data.docConflicts.dates.filter((c) => c.docs.some((d) => ids.has(d.id))) },
  };
}

// Виды источников: сколько наблюдений и документов каждого вида видит роль.
export function sourceTypes(data) {
  const out = new Map();
  for (const o of data.observations) {
    if (!out.has(o.source_type)) out.set(o.source_type, { type: o.source_type, observations: 0, documents: new Set(), products: new Set() });
    const s = out.get(o.source_type);
    s.observations += 1; s.products.add(o.product_id);
  }
  for (const d of data.documents) out.get(d.type)?.documents.add(d.id);
  return [...out.values()].map((s) => ({ type: s.type, observations: s.observations, documents: s.documents.size, products: s.products.size })).sort((a, b) => b.observations - a.observations);
}

// Профиль завода.
export function factoryProfile(data, factoryId = "home") {
  const f = data.factories.get(factoryId) || data.home;
  const prods = factoryProducts(data, f.id);
  const docs = factoryDocuments(data, { factoryId: f.id });
  const brands = [...new Set(data.products.flatMap((p) => brandsOf(p)))];
  const registered = f.id === data.home.id
    ? data.sources.map((s) => ({ id: s.id, type: s.source_type, name: s.name, date: dateFromTitle(s.name), url: s.url || null, publisher: s.publisher || null }))
    : [];
  const unresolved = [];
  if (f.location?.kind === "organization_address") unresolved.push("адрес производственной площадки отдельно не указан — известен только адрес организации из реквизитов");
  if (!f.location) unresolved.push("местоположение не указано");
  if (!prods.byStatus.CONFIRMED) unresolved.push("ни для одного товара источник прямо не называет изготовителя");
  if (prods.byStatus.UNKNOWN) unresolved.push(`по ${prods.byStatus.UNKNOWN} товарам данных о производстве нет`);
  if (prods.byStatus.CONFLICTED) unresolved.push(`по ${prods.byStatus.CONFLICTED} товарам источники называют разных изготовителей`);
  if (docs.conflicts.dates.length) unresolved.push(`${docs.conflicts.dates.length} случаев, когда у товара несколько документов одного вида с разными датами`);
  if (prods.items.some((r) => r.needsReview)) unresolved.push("есть внутренние данные об изготовителе, которые требуют дополнительной сверки");
  return {
    factory: f, location: f.location, manufacturer: f.legalName, brands,
    productGroups: prods.groups, products: prods, documents: docs.documents, documentConflicts: docs.conflicts,
    sourceTypes: sourceTypes(data), registeredSources: registered,
    notInData: NOT_IN_DATA, unresolved,
  };
}

// Поиск заводов по словам: имя, юрлицо, адрес сайта, префикс заказов.
// Общие слова в названиях заводов («завод», «смесей», «гипсовый») завод не
// различают: по ним ищется только завод из реквизитов.
const GENERIC_WORD = /^(завод|фабрик|производ|изготов|площадк|смес|гипс|строит|компан|предприят|ооо|оао|зао|пао)/;
export function searchFactories(data, terms = []) {
  const ts = terms.map(low).filter((t) => t.length >= 3 && !GENERIC_WORD.test(t));
  const generic = terms.map(low).some((t) => /^(завод|фабрик|производ|изготов|площадк)/.test(t));
  const out = [];
  for (const f of data.factories.values()) {
    const words = normName([f.name, f.legalName, ...(f.aliases || [])].join(" ")).split(" ").filter(Boolean);
    const hits = ts.filter((t) => words.some((w) => w.startsWith(t) || (t.length >= 5 && t.startsWith(w.slice(0, 5)))));
    if (hits.length || (!ts.length && !generic) || (f.id === data.home.id && generic)) {
      out.push({ id: f.id, name: f.name, legalName: f.legalName, status: f.status, basis: f.basis, matched: hits });
    }
  }
  return out;
}
