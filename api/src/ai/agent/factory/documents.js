// Habez AI Phase 3.4: заводские документы — производная запись над
// наблюдениями. Отдельной таблицы документов нет: документ — это группа
// наблюдений с одним видом источника и одной ссылкой на него
// (source_type + source_reference + source_name). Один документ может
// описывать несколько товаров: products[] без копий самого документа.
//
//   документ → товары[] → наблюдения (модель наблюдений 2.2B как есть)
//
// Что не документ: подставленное программой (generated_default), вывод
// модели (ai_inference), запись без доказанного первоисточника
// (unknown_legacy_origin), ручной ввод без документа (manual_entry).
//
// Даты не смешиваются:
//   date          — дата самого документа: provided_at, иначе дата из
//                   названия («Письмо … от 05.09.2026»); иначе неизвестна;
//   recordedInApp1 — когда значение записали в приложение №1 (коммит);
//   capturedAt    — когда оно попало в Habez Pro.
import { createHash } from "node:crypto";
import { evidenceKeyMeta } from "../../knowledge/evidence-model.js";

// Виды документов. production — документ, который выпускает изготовитель
// о своём товаре (паспорт партии, этикетка, маркировочная карточка, письмо
// технолога о составе и свойствах): косвенный признак производства.
// assortment — документ об ассортименте и продаже (сайт, каталог, прайс):
// говорит «завод продаёт», а не «завод производит».
export const DOC_TYPES = {
  quality_passport: { label: "паспорт качества", kind: "document", production: true, issuer: "factory" },
  label: { label: "заводская этикетка", kind: "document", production: true, issuer: "factory" },
  marking_card: { label: "маркировочная карточка", kind: "document", production: true, issuer: "factory" },
  factory_technologist: { label: "письмо главного технолога завода", kind: "letter", production: true, issuer: "factory" },
  technical_document: { label: "технический документ", kind: "document", production: false, issuer: null },
  factory_catalog: { label: "заводской каталог", kind: "document", assortment: true, issuer: "factory" },
  factory_site: { label: "сайт завода", kind: "publication", assortment: true, issuer: "factory" },
  price_list: { label: "прайс завода", kind: "commercial", assortment: true, issuer: "factory" },
  product_card: { label: "карточка товара Habez Pro", kind: "card", issuer: "habez_pro" },
  measurement: { label: "замер", kind: "measurement", issuer: null },
  public_source: { label: "внешний источник", kind: "external", issuer: null },
};
export const NOT_DOCUMENTS = new Set(["generated_default", "ai_inference", "unknown_legacy_origin", "manual_entry"]);
export const KIND_LABEL = {
  document: "документ", letter: "письмо", publication: "публикация, не документ", commercial: "коммерческий документ",
  card: "карточка товара", measurement: "замер", external: "внешний источник",
};
export const docTypeLabel = (t) => DOC_TYPES[t]?.label || t;

// Упоминания документов в тексте карточки (витрина): сам документ в системе
// не хранится, но карточка на него ссылается.
export const CARD_MENTIONS = [
  { type: "quality_passport", re: /паспорт[а-я]* качества/ },
  { type: "label", re: /этикетк/ },
  { type: "certificate", re: /сертифицирован|сертификат/, label: "сертификат (упомянут в карточке)" },
];

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const pad = (n) => String(n).padStart(2, "0");
// Дата из названия документа: «от 05.09.2026», «от 6 сентября 2026».
export function dateFromTitle(title) {
  const s = String(title || "").toLowerCase().replace(/ё/g, "е");
  let m = s.match(/от\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/от\s+(\d{1,2})\s+([а-я]+)\s+(\d{4})/);
  if (m) {
    const i = MONTHS.findIndex((x) => (x === "ма" ? /^ма[яй]$/.test(m[2]) : m[2].startsWith(x)));
    if (i >= 0) return `${m[3]}-${pad(i + 1)}-${pad(m[1])}`;
  }
  return null;
}
// Редакция — только если она прямо написана в названии.
export const revisionFromTitle = (title) => String(title || "").match(/(?:редакция|ред\.|версия|rev\.?)\s*([\w.-]+)/i)?.[1] ?? null;

const DAY = (d) => (d ? String(d).slice(0, 10) : null);
const low = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
export const docKey = (o) => `${o.source_type}|${o.source_reference || ""}|${o.source_name || o.linked_source_name || ""}`;
export const docId = (key) => `D${createHash("sha1").update(key).digest("hex").slice(0, 6)}`;

// Название, которое можно показать: записанное в источнике, иначе — вид
// документа и честная пометка, что названия нет.
function titleOf(o) {
  const named = o.source_name || o.linked_source_name;
  if (named) return { title: named, known: true };
  const t = docTypeLabel(o.source_type);
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return { title: `${cap} (название документа не записано)`, known: false };
}

// Документы из видимых роли наблюдений. productsById — товары, видимые
// роли (по ним подписи). homeId — завод из реквизитов: документы видов
// «завода» приписываются ему по виду источника.
export function collectDocuments(observations, { productsById, homeId }) {
  const docs = new Map();
  for (const o of observations) {
    if (NOT_DOCUMENTS.has(o.source_type) || !productsById.has(o.product_id)) continue;
    const key = docKey(o);
    if (!docs.has(key)) {
      const meta = DOC_TYPES[o.source_type] || { label: o.source_type, kind: "other", issuer: null };
      const { title, known } = titleOf(o);
      docs.set(key, {
        id: docId(key), key, type: o.source_type, typeLabel: meta.label, kind: meta.kind, kindLabel: KIND_LABEL[meta.kind] || "другой источник",
        production: !!meta.production, assortment: !!meta.assortment,
        title, titleKnown: known, reference: o.source_reference || null,
        issuer: meta.issuer === "factory" ? { factoryId: homeId, basis: "вид источника: документ завода" } : meta.issuer === "habez_pro" ? { factoryId: null, name: "Habez Pro", basis: "карточка в этой системе" } : null,
        dates: new Set(), recorded: new Set(), captured: [], providedBy: new Set(), access: new Set(), channels: new Set(),
        products: new Map(), observations: [],
      });
    }
    const d = docs.get(key);
    if (o.provided_at) d.dates.add(DAY(o.provided_at));
    if (o.upstream_recorded_at) d.recorded.add(DAY(o.upstream_recorded_at));
    if (o.captured_at) d.captured.push(DAY(o.captured_at));
    if (o.provided_by) d.providedBy.add(o.provided_by);
    d.access.add(o.access_level);
    if (o.capture_channel) d.channels.add(o.capture_channel);
    const p = productsById.get(o.product_id);
    if (!d.products.has(p.id)) d.products.set(p.id, { id: p.id, slug: p.slug, name: p.name, short: p.short_name || p.name, keys: new Set(), count: 0 });
    const dp = d.products.get(p.id);
    dp.count += 1; dp.keys.add(o.spec_key);
    d.observations.push({
      id: o.id, productId: p.id, product: p.short_name || p.name, productName: p.name, slug: p.slug, key: o.spec_key,
      label: evidenceKeyMeta(o.spec_key)?.label || o.label || o.spec_key, value: o.original_value, condition: o.condition_text || null,
      conditionKey: o.condition_key || "", variantId: o.variant_id ?? null, statement: o.statement_type, verification: o.verification_status, access: o.access_level,
    });
  }
  return [...docs.values()].map(finish);
}

function finish(d) {
  const dates = [...d.dates].sort();
  const titleDate = dateFromTitle(d.title);
  // Дата документа: из самого наблюдения (provided_at) или из названия.
  // Если их несколько или они расходятся — все, без выбора.
  const date = dates.length === 1 ? { value: dates[0], basis: "document" } : dates.length > 1 ? { value: null, values: dates, basis: "several" }
    : titleDate ? { value: titleDate, basis: "title" } : null;
  const dateConflict = dates.length > 1 || (dates.length === 1 && titleDate && titleDate !== dates[0]);
  return {
    ...d,
    date, dateConflict,
    revision: revisionFromTitle(d.title),
    recordedInApp1: [...d.recorded].sort()[0] ?? null,
    capturedAt: d.captured.sort()[0] ?? null,
    providedBy: [...d.providedBy],
    access: [...d.access],
    channels: [...d.channels],
    products: [...d.products.values()].map((p) => ({ ...p, keys: [...p.keys] })),
    dates: undefined, recorded: undefined, captured: undefined,
  };
}

// Расхождения внутри видимых данных:
//   value    — у одного свойства (товар × фасовка × ключ × условие) разные
//              значения в разных строках или документах;
//   dates    — у одного товара несколько документов одного вида с разными
//              датами: победитель по дате не выбирается.
export function documentConflicts(docs, observations) {
  const byProp = new Map();
  for (const o of observations) {
    if (NOT_DOCUMENTS.has(o.source_type)) continue;
    const k = `${o.product_id}|${o.variant_id ?? ""}|${o.spec_key}|${o.condition_key || ""}`;
    if (!byProp.has(k)) byProp.set(k, new Set());
    byProp.get(k).add(low(o.original_value));
  }
  const disputed = new Set([...byProp].filter(([, v]) => v.size > 1).map(([k]) => k));
  const value = [];
  for (const d of docs) {
    for (const o of d.observations) {
      o.disputed = disputed.has(`${o.productId}|${o.variantId ?? ""}|${o.key}|${o.conditionKey}`);
      if (o.disputed) value.push({ docId: d.id, product: o.product, label: o.label });
    }
  }
  const dates = [];
  const groups = new Map();
  for (const d of docs) {
    for (const p of d.products) {
      const k = `${p.id}|${d.type}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
  }
  for (const [k, list] of groups) {
    const dated = list.filter((d) => d.date?.value);
    if (list.length > 1 && new Set(dated.map((d) => d.date.value)).size > 1) {
      const p = list[0].products.find((x) => `${x.id}|${list[0].type}` === k);
      dates.push({ product: p?.short, type: list[0].type, typeLabel: list[0].typeLabel, docs: list.map((d) => ({ id: d.id, title: d.title, date: d.date?.value ?? null })) });
    }
  }
  return { value, dates };
}
