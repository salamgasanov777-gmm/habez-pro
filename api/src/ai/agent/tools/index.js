// Habez AI Agent: инструменты чтения. Все — только SELECT; ни один не
// меняет товары, характеристики, цены, источники, проверки и вопросы
// сверки. Каждый принимает контекст { tenantId, scope } и сам решает, что
// этой роли можно отдать.
//
//   search_products      — товары по словам вопроса (витринные данные);
//   get_product          — карточка: название, раздел, описание, фасовки;
//   get_product_specs    — характеристики свойствами, с расхождениями
//                          (сотрудникам — наблюдения + строки карточки вне словаря);
//   get_product_evidence — наблюдения с происхождением (сотрудникам);
//   compare_products     — таблица сравнения: общие характеристики по
//                          ключу и условию, споры, пропуски (Phase 3.2);
//   search_knowledge     — общий поиск: товары, характеристики, условия,
//                          фасовки, разделы карточек; сотрудникам ещё
//                          наблюдения, источники и вопросы сверки;
//   search_factories     — заводы: из реквизитов и названные в данных (3.4);
//   get_factory          — профиль завода: реквизиты, группы, документы,
//                          виды источников, чего нет;
//   get_factory_products — товары завода со статусом связи
//                          (CONFIRMED / INFERRED / UNKNOWN / CONFLICTED);
//   get_factory_documents — заводские документы по товарам, виду,
//                          характеристике.
//
// Phase 3.2: у каждого инструмента — описание, схема входа и выхода, права
// и признак read_only / write: false (TOOL_SPECS). callTool проверяет
// это при каждом вызове: если за время работы инструмента в базе что-то
// изменилось (total_changes), вызов падает.
import { z } from "zod";
import { all, get } from "../../../db/index.js";
import { cardItems } from "../../knowledge/legacy-provenance.js";
import { productEvidence } from "../../knowledge/evidence.js";
import { openItemsFor } from "../../knowledge/evidence-projection.js";
import { evidenceKeyMeta } from "../../knowledge/evidence-model.js";
import { evidenceRoleForScope } from "../permissions.js";
import { groupCardProperties, groupObservationProperties, sameValueKey } from "../retrieval/conflicts.js";
import { loadFactoryData, searchFactories, factoryProfile, factoryProducts, factoryDocuments, productFactory, GROUPS } from "../factory/model.js";

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const PUBLISHED = "p.status='published'";

// Товар, видимый роли. Гость и покупатель видят только опубликованное —
// как витрина.
function productRow(ctx, productId) {
  const where = ctx.scope === "public" ? ` AND ${PUBLISHED}` : "";
  return get(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.id=? AND p.tenant_id=?${where}`, productId, ctx.tenantId);
}

const schemas = {
  search_products: z.object({ terms: z.array(z.string().min(2).max(40)).max(12), limit: z.number().int().min(1).max(12).default(6) }),
  get_product: z.object({ productId: z.number().int().positive() }),
  get_product_specs: z.object({ productId: z.number().int().positive(), keyFilter: z.any().optional() }),
  get_product_evidence: z.object({ productId: z.number().int().positive() }),
  compare_products: z.object({ productIds: z.array(z.number().int().positive()).min(2).max(4), keyFilter: z.any().optional() }),
  search_knowledge: z.object({ terms: z.array(z.string().min(2).max(40)).max(12), limit: z.number().int().min(1).max(20).default(8), minScore: z.number().int().min(1).max(5).default(1) }),
  search_factories: z.object({ terms: z.array(z.string().min(2).max(60)).max(12) }),
  get_factory: z.object({ factoryId: z.string().regex(/^[a-z0-9а-я-]{1,60}$/) }),
  get_factory_products: z.object({ factoryId: z.string().regex(/^[a-z0-9а-я-]{1,60}$/), group: z.string().max(40).nullable().optional(), productIds: z.array(z.number().int().positive()).max(60).optional() }),
  get_factory_documents: z.object({ factoryId: z.string().regex(/^[a-z0-9а-я-]{1,60}$/).nullable().optional(), productIds: z.array(z.number().int().positive()).max(60).optional(),
    types: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(12).optional(), specKeys: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).max(12).optional() }),
};

function searchProducts(ctx, { terms, limit }) {
  if (!terms.length) return { items: [] };
  const rows = all(`SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.badges, p.spec_tables, p.sections, p.tasks, c.name AS category
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=? AND ${PUBLISHED}`, ctx.tenantId);
  const scored = rows.map((r) => {
    const hay = [r.name, r.summary, r.category, r.sections, r.spec_tables, r.tasks].join(" ").toLowerCase().replace(/ё/g, "е");
    const inName = [r.name, r.summary].join(" ").toLowerCase().replace(/ё/g, "е");
    let score = 0;
    for (const t of terms) { if (inName.includes(t)) score += 3; else if (hay.includes(t)) score += 1; }
    return { r, score };
  // Одно слово где-то в глубине описания — случайность, а не ответ.
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || a.r.id - b.r.id).slice(0, limit);
  return {
    items: scored.map(({ r, score }) => ({
      id: r.id, slug: r.slug, name: r.name, short: r.short_name, category: r.category, summary: r.summary, score,
      // Строки «Область применения» — прямой ответ на «что подходит для…».
      application: json(r.spec_tables, []).filter((t) => /применени|основани/i.test(t.title || ""))
        .flatMap((t) => (t.rows || []).map((row) => ({ table: t.title, label: row[0], value: row[1] }))).slice(0, 14),
    })),
  };
}

function getProduct(ctx, { productId }) {
  const p = productRow(ctx, productId);
  if (!p) return null;
  const variants = all(`SELECT id, sku, unit, pack_size, pack_unit, weight_kg, per_pallet FROM variants
    WHERE tenant_id=? AND product_id=? AND is_active=1 ORDER BY position, id`, ctx.tenantId, productId);
  const sections = json(p.sections, []).map((s) => ({ title: s.title, text: String(s.text || "").slice(0, 700) }));
  return {
    id: p.id, slug: p.slug, name: p.name, short: p.short_name, category: p.category, summary: p.summary, gost: p.gost,
    variants, sections,
  };
}

function getProductSpecs(ctx, { productId, keyFilter }) {
  const p = productRow(ctx, productId);
  if (!p) return null;
  if (ctx.scope === "public") {
    // Гостю и покупателю — ровно то, что напечатано в карточке на витрине.
    const props = groupCardProperties(p, cardItems(p), keyFilter);
    // Есть внутренние или конфиденциальные сведения, которые расходятся с
    // карточкой по тому же свойству и условию, — гостю можно сказать только
    // это, без значений.
    const hidden = all("SELECT spec_key, condition_key, original_value FROM ai_spec_observations WHERE tenant_id=? AND product_id=? AND lifecycle_status='active'", ctx.tenantId, productId);
    for (const prop of props) {
      if (!prop.key) continue;
      const shown = new Set(prop.values.map((v) => sameValueKey(v.display, { withBool: true }) ?? String(v.display).toLowerCase()));
      prop.hiddenDisagreement = hidden.some((o) => o.spec_key === prop.key && (o.condition_key || "") === (prop.conditionKey || "")
        && !shown.has(sameValueKey(o.original_value, { withBool: true }) ?? String(o.original_value).toLowerCase()));
    }
    // Сам факт открытых вопросов сверки по товару можно назвать, значения и
    // источники — нет.
    const internalOpenItems = all("SELECT COUNT(*) AS n FROM ai_reconciliation_items WHERE tenant_id=? AND product_id=? AND status='unresolved'", ctx.tenantId, productId)[0]?.n ?? 0;
    return { product: { id: p.id, slug: p.slug, name: p.name, short: p.short_name }, channel: "catalog_card", properties: props, internalOpenItems };
  }
  const role = evidenceRoleForScope(ctx.scope);
  const ev = productEvidence(ctx.tenantId, productId, role);
  const open = openItemsFor(ctx.tenantId, productId, role);
  const props = groupObservationProperties(p, ev.properties, open, keyFilter);
  // Сотрудник видит не меньше покупателя. Строки карточки, которые в
  // наблюдения не попали: вне словаря («Заливка наливных полов — через 7
  // суток»), с ключом без наблюдений или со вторым значением, которое
  // перенос 2.1 отбросил («50 циклов» при «F50»), — добавляются как строки
  // карточки. Значение, которое уже есть среди наблюдений, не повторяется.
  const seen = (display, key) => {
    const d = String(display ?? "").toLowerCase().trim();
    const opt = { withBool: !!key };
    const k = sameValueKey(display, opt);
    return props.some((g) => (key ? g.key === key : true) && g.values.some((v) => !v.hidden && (String(v.display ?? "").toLowerCase().trim() === d || (k && sameValueKey(v.display, opt) === k))));
  };
  // Значение карточки по свойству, у которого есть наблюдения, встаёт в ту
  // же строку: при открытом вопросе сверки оно участвует в споре, иначе —
  // это расхождение карточки и наблюдений. Отдельной строкой «одно
  // значение» оно не показывается никогда.
  const extra = [];
  for (const g of groupCardProperties(p, cardItems(p), keyFilter)) {
    const values = g.values.filter((v) => !seen(v.display, g.key));
    if (!values.length) continue;
    const twin = g.key && props.find((o) => o.key === g.key && !o.variant && (o.conditionKey || "") === (g.conditionKey || ""));
    if (twin) {
      twin.values = [...twin.values, ...values];
      if (twin.status !== "unresolved") twin.status = "conflict";
      const units = new Set(twin.values.map((v) => v.unit).filter(Boolean));
      if (twin.status === "conflict") twin.reason = units.size > 1 ? "different_units" : "values_differ";
      continue;
    }
    const units = new Set(values.map((v) => v.unit).filter(Boolean));
    const status = values.length > 1 ? "conflict" : values[0].evidence.length > 1 ? "agreed" : "single";
    extra.push({ ...g, values, status, reason: status === "conflict" ? (units.size > 1 ? "different_units" : "values_differ") : null });
  }
  const cardOnly = extra;
  return { product: { id: p.id, slug: p.slug, name: p.name, short: p.short_name }, channel: "observations", properties: [...props, ...cardOnly], internalOpenItems: open.length };
}

function getProductEvidence(ctx, { productId }) {
  if (ctx.scope === "public") return { forbidden: true, reason: "наблюдения и их происхождение доступны сотрудникам" };
  const p = productRow(ctx, productId);
  if (!p) return null;
  return productEvidence(ctx.tenantId, productId, evidenceRoleForScope(ctx.scope));
}

// Сравнение: для каждой характеристики (ключ × условие) — ячейка по каждому
// товару: значения, статус спора или «нет данных». Строки без ключа
// (надписи карточки) сравниваются по подписи. Победитель не выбирается.
function compareProducts(ctx, { productIds, keyFilter }) {
  const items = productIds.map((id) => getProductSpecs(ctx, { productId: id, keyFilter })).filter(Boolean);
  return { items, products: items.map((it) => it.product), rows: comparisonRows(items) };
}

// Строки сравнения по уже отобранным свойствам (план может сузить их по
// условиям и фасовке — тогда строки пересчитываются).
export function comparisonRows(items) {
  const rows = new Map();
  for (const it of items) {
    for (const prop of it.properties) {
      if (prop.variant) continue; // фасовки сравниваются отдельно
      const rk = prop.key ? `${prop.key}|${prop.conditionKey || ""}` : `label:${String(prop.label).toLowerCase()}`;
      if (!rows.has(rk)) rows.set(rk, { key: prop.key, label: prop.label, conditionKey: prop.conditionKey || "", conditionText: prop.conditionText, cells: {} });
      rows.get(rk).cells[it.product.id] = prop;
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, common: items.every((it) => r.cells[it.product.id]), missing: items.filter((it) => !r.cells[it.product.id]).map((it) => it.product.id) }));
  // Сначала общие строки, затем те, что есть не у всех.
  list.sort((a, b) => Number(b.common) - Number(a.common));
  return list;
}

// Общий поиск по слоям: карточки (название, короткое имя, разделы, строки
// таблиц), фасовки (название, артикул), а сотрудникам — наблюдения (подпись,
// значение, условие, ключ), источники и вопросы сверки. Правила, без
// векторов: счёт — число слов запроса, найденных в строке.
function searchKnowledge(ctx, { terms, limit, minScore }) {
  if (!terms.length) return { items: [] };
  const low = (x) => String(x ?? "").toLowerCase().replace(/ё/g, "е");
  const score = (...parts) => { const hay = low(parts.join(" ")); return terms.filter((t) => hay.includes(t)).length; };
  const published = ctx.scope === "public" ? ` AND ${PUBLISHED}` : "";
  const out = [];
  for (const p of all(`SELECT p.id, p.slug, p.name, p.short_name, p.summary, p.sections, p.spec_tables, p.badges FROM products p WHERE p.tenant_id=?${published}`, ctx.tenantId)) {
    const s0 = score(p.name, p.short_name, p.slug, p.summary);
    if (s0) out.push({ type: "product", productId: p.id, slug: p.slug, product: p.name, label: "описание", value: p.summary || p.name, score: s0 + 1 });
    for (const sec of json(p.sections, [])) {
      const s1 = score(sec.title, sec.text);
      if (s1) out.push({ type: "section", productId: p.id, slug: p.slug, product: p.name, label: sec.title, value: String(sec.text || "").slice(0, 400), score: s1 });
    }
    for (const it of cardItems(p)) {
      const s2 = score(it.label, it.value, evidenceKeyMeta(it.key)?.label);
      if (s2) out.push({ type: "card_row", productId: p.id, slug: p.slug, product: p.name, label: it.label, value: it.value, score: s2 });
    }
  }
  for (const v of all(`SELECT v.id, v.product_id, v.unit, v.sku, v.per_pallet, p.slug, p.name FROM variants v JOIN products p ON p.id=v.product_id
      WHERE v.tenant_id=? AND v.is_active=1${published}`, ctx.tenantId)) {
    const s3 = score(v.unit, v.sku, "фасовка", v.name);
    if (s3 >= 2 || score(v.unit, v.sku)) out.push({ type: "variant", productId: v.product_id, slug: v.slug, product: v.name, label: "фасовка", value: v.unit, variant: v.unit, perPallet: v.per_pallet, score: s3 });
  }
  if (ctx.scope !== "public") {
    const levels = ctx.scope === "admin" ? ["public", "internal", "confidential"] : ["public", "internal"];
    const rows = all(`SELECT o.id, o.product_id, p.slug, p.name AS product_name, o.spec_key, o.label, o.original_value, o.condition_text, o.source_type,
        o.source_name, o.source_reference, o.access_level, o.verification_status FROM ai_spec_observations o JOIN products p ON p.id=o.product_id
       WHERE o.tenant_id=? AND o.lifecycle_status='active' AND o.access_level IN (${levels.map(() => "?").join(",")})`, ctx.tenantId, ...levels);
    for (const r of rows) {
      const s4 = score(r.label, r.original_value, r.condition_text, evidenceKeyMeta(r.spec_key)?.label, r.source_name, r.source_reference);
      if (s4) out.push({ type: "observation", productId: r.product_id, slug: r.slug, product: r.product_name, observationId: r.id, key: r.spec_key,
        label: evidenceKeyMeta(r.spec_key)?.label || r.label, value: r.original_value, condition: r.condition_text, sourceType: r.source_type,
        reference: r.source_reference, access: r.access_level, verification: r.verification_status, score: s4 });
    }
    for (const q of all(`SELECT i.item_key, i.kind, i.decision_ref, i.spec_key, i.rule_note, p.slug, p.name AS product_name, p.id AS product_id
        FROM ai_reconciliation_items i JOIN products p ON p.id=i.product_id WHERE i.tenant_id=? AND i.status='unresolved'`, ctx.tenantId)) {
      const s5 = score(q.decision_ref, q.rule_note, evidenceKeyMeta(q.spec_key)?.label, q.product_name, "сверка расхождение вопрос");
      if (s5 >= 2) out.push({ type: "question", productId: q.product_id, slug: q.slug, product: q.product_name, key: q.spec_key,
        label: `вопрос сверки ${q.decision_ref || ""}`.trim(), value: evidenceKeyMeta(q.spec_key)?.label || q.spec_key, decision: q.decision_ref, score: s5 });
    }
  }
  return { items: out.filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score || a.productId - b.productId).slice(0, limit) };
}

// Factory Intelligence (Phase 3.4): тот же контекст роли, те же правила
// видимости (factory/model.js). Выход — производные записи, база не меняется.
const groupByLabel = (label) => (label ? GROUPS.find((g) => g.label === label) || null : null);
const IMPL = {
  search_products: searchProducts, get_product: getProduct, get_product_specs: getProductSpecs,
  get_product_evidence: getProductEvidence, compare_products: compareProducts, search_knowledge: searchKnowledge,
  search_factories: (ctx, { terms }) => ({ items: searchFactories(loadFactoryData(ctx), terms) }),
  get_factory: (ctx, { factoryId }) => {
    const data = loadFactoryData(ctx);
    return data.factories.has(factoryId) ? factoryProfile(data, factoryId) : null;
  },
  get_factory_products: (ctx, { factoryId, group, productIds }) => {
    const data = loadFactoryData(ctx);
    return data.factories.has(factoryId) ? factoryProducts(data, factoryId, { group: groupByLabel(group), productIds }) : null;
  },
  get_factory_documents: (ctx, args) => {
    const data = loadFactoryData(ctx);
    const out = factoryDocuments(data, args);
    // Гостю документы слоя знаний не видны: только упоминания в карточке.
    const products = (args.productIds || []).map((id) => data.productsById.get(id)).filter(Boolean).map((p) => productFactory(data, p));
    return { ...out, products };
  },
};

export const TOOL_NAMES = Object.keys(IMPL);

// Единый контракт инструментов (Phase 3.2). input_schema — то, что видит
// модель (имена товаров и слова, а не номера из базы: номера подставляет
// сервер через resolver). output_schema — что возвращается (кратко).
const PRODUCT = { type: "string", description: "Название или короткое имя товара, как его пишет пользователь (ШОВ, «Стандарт», ГКЛ 12,5)" };
const SPECS = { type: "array", items: { type: "string" }, description: "Характеристики словами пользователя: «прочность сцепления», «время схватывания», «расход воды»" };
const CONDITION = { type: "string", description: "Условие словами: «через 28 суток», «на мешок», «при толщине слоя 1 мм», «12,5 мм»" };
export const TOOL_SPECS = {
  search_products: {
    description: "Найти товары Habez по задаче или словам (например, «для заделки швов ГКЛ»). Только опубликованные товары.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    output_schema: "товары: название, раздел, описание, строки «Область применения»",
    permissions: { public: "опубликованные товары", staff: "опубликованные товары", admin: "опубликованные товары" },
  },
  get_product: {
    description: "Карточка товара: название, раздел, описание, разделы карточки, фасовки.",
    input_schema: { type: "object", properties: { product: PRODUCT }, required: ["product"] },
    output_schema: "карточка и фасовки (каждая отдельно)",
    permissions: { public: "только опубликованные", staff: "все товары компании", admin: "все товары компании" },
  },
  get_product_specs: {
    description: "Характеристики товара со статусом: одно значение, согласны, расхождение, нерешённый вопрос сверки. Можно сузить характеристиками, условием и фасовкой.",
    input_schema: { type: "object", properties: { product: PRODUCT, specs: SPECS, condition: CONDITION }, required: ["product"] },
    output_schema: "свойства: ключ, условие, фасовка, значения с источниками, статус",
    permissions: { public: "строки карточки витрины", staff: "наблюдения public+internal и строки карточки", admin: "все наблюдения" },
  },
  get_product_evidence: {
    description: "Наблюдения по товару с происхождением: вид источника, документ, дата, проверка, уровень доступа. Для вопросов «откуда это значение».",
    input_schema: { type: "object", properties: { product: PRODUCT, specs: SPECS }, required: ["product"] },
    output_schema: "наблюдения с источником, датой, проверкой и уровнем доступа",
    permissions: { public: "запрещено", staff: "public+internal", admin: "всё" },
  },
  compare_products: {
    description: "Сравнить 2–4 товара: общие характеристики по одному ключу и условию, расхождения, пропуски данных. Победителя не выбирает.",
    input_schema: { type: "object", properties: { products: { type: "array", items: PRODUCT, minItems: 2, maxItems: 4 }, specs: SPECS }, required: ["products"] },
    output_schema: "таблица: строка — характеристика, ячейка — значения и статус по каждому товару или «нет данных»",
    permissions: { public: "как get_product_specs", staff: "как get_product_specs", admin: "как get_product_specs" },
  },
  search_knowledge: {
    description: "Общий поиск по данным Habez: товары, характеристики, условия, фасовки, разделы карточек; сотрудникам ещё наблюдения, источники, вопросы сверки.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    output_schema: "найденные строки с типом (товар, раздел, строка карточки, фасовка, наблюдение, вопрос сверки)",
    permissions: { public: "витрина: товары, разделы, строки карточек, фасовки", staff: "+ наблюдения public+internal, вопросы сверки", admin: "+ конфиденциальные наблюдения" },
  },
  search_factories: {
    description: "Найти завод или производственную площадку: завод из реквизитов организации и заводы, прямо названные в данных о товарах как изготовитель или место производства.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "Название завода или слово «завод»" } }, required: ["query"] },
    output_schema: "заводы: имя, юрлицо, статус (из реквизитов / назван в данных), основание",
    permissions: { public: "реквизиты витрины", staff: "+ заводы, названные во внутренних наблюдениях", admin: "+ конфиденциальные" },
  },
  get_factory: {
    description: "Профиль завода: название, юрлицо, адрес из реквизитов (это адрес организации, не площадки), марки, товарные группы, документы, виды источников, что не установлено. Площади, мощности, численности в данных нет.",
    input_schema: { type: "object", properties: { factory: { type: "string", description: "Название завода; пусто — завод из реквизитов" } } },
    output_schema: "профиль завода с основаниями",
    permissions: { public: "реквизиты, каталог, упоминания документов в карточках", staff: "+ документы и наблюдения public+internal", admin: "+ конфиденциальные" },
  },
  get_factory_products: {
    description: "Товары завода со статусом связи «производит»: CONFIRMED (источник прямо называет изготовителя), INFERRED (косвенно), UNKNOWN (нет данных), CONFLICTED (источники противоречат). Можно сузить товарной группой: сухие смеси, краски, гипсокартон, грунтовки…",
    input_schema: { type: "object", properties: { factory: { type: "string" }, group: { type: "string", description: "Товарная группа словами" } } },
    output_schema: "товары: раздел каталога, статус связи, основания; сводка по группам",
    permissions: { public: "каталог витрины", staff: "+ основания из внутренних документов", admin: "+ конфиденциальные" },
  },
  get_factory_documents: {
    description: "Заводские документы: паспорт качества, этикетка, маркировочная карточка, письмо технолога, сайт, прайс, карточка товара. По товару, виду документа или характеристике. У документа — вид, дата документа (если известна), товары, наблюдения.",
    input_schema: { type: "object", properties: { products: { type: "array", items: PRODUCT }, type: { type: "string", description: "Вид: паспорт качества, этикетка, письмо технолога, прайс, сайт" }, specs: SPECS } },
    output_schema: "документы: вид, название, дата документа, дата записи, товары, наблюдения, доступ",
    permissions: { public: "только упоминания документов в карточках витрины", staff: "документы public+internal", admin: "всё" },
  },
};
for (const [name, spec] of Object.entries(TOOL_SPECS)) Object.assign(spec, { name, read_only: true, write: false });
// Инструмент с записью сюда попасть не может: проверка при загрузке.
if (Object.values(TOOL_SPECS).some((t) => t.write !== false || t.read_only !== true) || TOOL_NAMES.some((n) => !TOOL_SPECS[n])) {
  throw new Error("Habez AI: инструменты агента — только чтение");
}
// Какие инструменты показывать модели для этой роли.
export const toolsForScope = (scope) => Object.values(TOOL_SPECS)
  .filter((t) => scope !== "public" || t.name !== "get_product_evidence")
  .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

const changes = () => get("SELECT total_changes() AS n").n;

// Единая точка вызова: проверка аргументов по схеме, контекст обязателен,
// и гарантия «только чтение» на деле: база за время вызова не изменилась.
export function callTool(name, args, ctx) {
  if (!IMPL[name]) throw new Error(`нет инструмента ${name}`);
  if (!ctx || !ctx.tenantId || !["public", "staff", "admin"].includes(ctx.scope)) throw new Error("инструменту нужен контекст с ролью");
  const parsed = schemas[name].parse(args);
  return readOnly(name, () => IMPL[name](ctx, parsed));
}

// Гарантия «только чтение» на деле: если за время работы в базе что-то
// изменилось (total_changes этого соединения), вызов падает.
export function readOnly(name, fn) {
  const before = changes();
  const out = fn();
  if (changes() !== before) throw new Error(`инструмент ${name} изменил базу — это запрещено`);
  return out;
}

