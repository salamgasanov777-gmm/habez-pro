// Habez AI 3.5: пути Competitor Intelligence в конвейере ответа.
//
//   COMPETITOR_PROFILE     карточка компании, марки или товара конкурента
//   COMPETITOR_PRODUCTS    товары компании / марки / раздела
//   ANALOGS                аналоги товара Habez: подтверждённые, частичные,
//                          «не аналог», противоречия, отдельно предположения
//   COMPETITOR_COMPARISON  таблица «наш ↔ их» (comparisonRows 3.2) + цены
//   COMPETITOR_PRICE       цены группами: дата, источник, основа
//
// Без модели (ответ собирает сервер): гость, конкурент или товар не
// найден, данных нет, нужно уточнить товар. Статусы и группы считает
// система; модель только объясняет их, победителя не выбирает.
import { get, all } from "../../../db/index.js";
import { callTool } from "../tools/index.js";
import { listCompetitorCompanies, dctx, competitorPrices, hiddenPriceCount } from "./tools.js";
import { listBrands, listCompetitorProducts, listPacks, analogsOfCompetitorProduct, productObservations, getCompetitorProduct, findAnalogs, analogStatus } from "../../competitors/index.js";
import { GROUPS, groupFromQuestion } from "../factory/model.js";

const nameOf = (p) => p?.short || p?.short_name || p?.shortName || p?.name;
const list = (xs) => xs.join(", ").replace(/, ([^,]*)$/, " и $1");
const REL = { analog: "аналог", partial_analog: "частичный аналог", not_analog: "не аналог" };
const STATUS = { CONFIRMED: "ПОДТВЕРЖДЕНО", INFERRED: "ПРЕДПОЛОЖЕНИЕ (не подтверждено)", CONFLICTED: "ПРОТИВОРЕЧИЕ", UNKNOWN: "НЕТ ДАННЫХ" };
const BASIS = { source: "указано в источнике", employee_decision: "решение сотрудника", heuristic: "тот же раздел каталога — предположение" };
export const FORBIDDEN_TEXT = "Сведения о конкурентах доступны только сотрудникам завода. Могу рассказать о товарах Habez: характеристиках, применении, фасовках.";

function timed(calls, name, fn, found = (x) => (x ? 1 : 0)) {
  const t = Date.now();
  const out = fn();
  calls.push({ name, source: "plan", ms: Date.now() - t, found: found(out) });
  return out;
}
const PRICE_KIND_ASKED = [[/дилерск/, "dealer", "дилерская"], [/оптов/, "wholesale", "оптовая"], [/розничн|в рознице/, "retail", "розничная"],
  [/маркетплейс/, "marketplace", "маркетплейс"], [/акци|промо/, "promo", "акционная"], [/ррц|рекомендованн/, "rrp", "РРЦ"]];
// Цены с ограниченным доступом — только числом; спрошенный вид цены, которого
// среди доступных нет, — прямо сказать.
function priceNotes(bundle, c, q, items) {
  const asked = PRICE_KIND_ASKED.filter(([re]) => re.test(String(q).toLowerCase()));
  for (const [, kind, label] of asked) if (!items.some((x) => x.groups.some((g) => g.priceKind === kind))) bundle.note(`Цен вида «${label}» среди доступных данных нет.`);
  for (const x of items) {
    const n = hiddenPriceCount(c, x.p.id);
    if (n) bundle.note(`У ${x.p.name} есть ещё цены с ограниченным доступом: ${n} — сумма, вид, дата и источник не раскрываются; они доступны администратору. Не угадывай и не выводи их из других цен.`);
  }
}
const companyName = (c, id) => get("SELECT name FROM ai_companies WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null;
const brandName = (c, id) => (id ? get("SELECT name FROM ai_brands WHERE id=? AND tenant_id=?", id, c.tenantId)?.name ?? null : null);
const categoryIdsOf = (tenantId, group) => (group ? all("SELECT id, name FROM categories WHERE tenant_id=?", tenantId)
  .filter((x) => group.cat.test(String(x.name).toLowerCase().replace(/ё/g, "е"))).map((x) => x.id) : null);

// Цель вопроса: компания, марка и товар из вопроса или из беседы.
function targetsOf(route, state, c) {
  const k = route.competitor;
  let companies = [...k.companies];
  let brands = [...k.brands];
  let products = [...k.products];
  if (k.from === "state" || (!companies.length && !brands.length && !products.length)) {
    if (k.otherBrand && state.current_competitor_company) {
      companies = [state.current_competitor_company];
      brands = listBrands(c, state.current_competitor_company).map((b) => b.id).filter((id) => id !== state.current_competitor_brand);
      products = [];
    } else {
      if (state.current_competitor_product) products = [state.current_competitor_product];
      if (state.current_competitor_company) companies = [state.current_competitor_company];
    }
  }
  // Товар конкурента известен — известны его компания и марка.
  for (const id of products) {
    const p = get("SELECT company_id, brand_id FROM ai_competitor_products WHERE id=? AND tenant_id=?", id, c.tenantId);
    if (p && !companies.includes(p.company_id)) companies.push(p.company_id);
    if (p?.brand_id && !brands.includes(p.brand_id) && !k.otherBrand) brands.push(p.brand_id);
  }
  for (const id of brands) {
    const b = get("SELECT company_id FROM ai_brands WHERE id=? AND tenant_id=?", id, c.tenantId);
    if (b && !companies.includes(b.company_id)) companies.push(b.company_id);
  }
  return { companies, brands, products };
}

// Товар конкурента для сравнения с нашим: названный, иначе — единственный
// сопоставленный с нашим (утверждение или тот же раздел) у названной
// компании / марки. Несколько — уточнить, ни одного — сказать.
function pickForComparison(c, ours, t, route) {
  if (t.products.length && !route.competitor.otherBrand) return { id: t.products[0] };
  const pool = listCompetitorProducts(c, {}).filter((p) => (t.brands.length ? t.brands.includes(p.brandId) : t.companies.includes(p.companyId)));
  if (!pool.length) return { none: true, pool };
  const related = findAnalogs(c, ours.id).filter((a) => pool.some((p) => p.id === a.competitorProduct.id));
  const strong = related.filter((a) => a.status !== "INFERRED");
  const cand = strong.length ? strong : related;
  if (cand.length === 1) return { id: cand[0].competitorProduct.id, basis: cand[0].status };
  if (cand.length > 1) return { many: cand.map((a) => a.competitorProduct) };
  return { none: true, pool };
}

export function runCompetitor({ route, q, ctx, bundle, calls, allowed, state = {} }) {
  const intent = route.intent;
  if (ctx.scope === "public" || route.competitor?.forbidden) return { mode: "COMPETITOR_FORBIDDEN", fixed: FORBIDDEN_TEXT, focus: null };
  const c = dctx(ctx);
  const t = targetsOf(route, state, c);
  const focus = { company: t.companies[0] ?? null, brand: t.brands[0] ?? null, product: t.products[0] ?? null };
  const out = { focus, competitor: { intent } };

  // Список конкурентов.
  if (intent === "competitor_lookup" && route.competitor.list && !t.companies.length) {
    const cos = timed(calls, "search_competitors", () => listCompetitorCompanies(ctx), (x) => x.length);
    if (!cos.length) return { ...out, mode: "COMPETITOR_PROFILE", fixed: "В данных Habez нет компаний, отмеченных как конкуренты." };
    return { ...out, mode: "COMPETITOR_PROFILE", competitor: { intent, companies: cos.map((x) => x.name) },
      fixed: `Компании, отмеченные в данных Habez как конкуренты: ${list(cos.map((x) => x.name))}. Спросите о любой — покажу марки, товары и источники.` };
  }
  if (!t.companies.length && !t.products.length && intent !== "analog_lookup" && intent !== "competitor_comparison") {
    return { ...out, mode: "NOT_FOUND", fixed: "Такого конкурента в данных Habez нет. Сведения о конкурентах вносит администратор; я не угадываю и не ищу в интернете." };
  }

  // Карточка компании, марки или товара.
  if (intent === "competitor_lookup") {
    if (t.products.length && !route.competitor.companies.length && !route.competitor.brands.length) {
      const p = timed(calls, "get_competitor_products", () => { try { return getCompetitorProduct(c, t.products[0]); } catch { return null; } });
      if (!p || p.lifecycleStatus !== "active") return { ...out, mode: "NOT_FOUND", fixed: "Такого товара конкурента в данных Habez нет." };
      renderCompetitorProduct(bundle, c, p);
      const links = analogsOfCompetitorProduct(c, p.id);
      for (const l of links) { allowed.add(l.product.id); bundle.analog({ label: `связь с товаром Habez ${l.product.short}`, value: `${STATUS[l.status]}${l.relation ? `: ${REL[l.relation]}` : ""}`, status: l.status, productName: p.name }); }
      // «U-Шов идентичен ШОВ?» — пара из вопроса, даже если утверждений нет
      // (предположение по разделу или «нет данных»).
      const pairs = links.map((l) => ({ product: l.product.short, status: l.status, relation: l.relation }));
      for (const ours of route.products.filter((x) => !links.some((l) => l.product.id === x.id))) {
        const a = analogStatus(c, ours.id, p.id);
        const short = ours.short_name || ours.name;
        allowed.add(ours.id);
        if (a.status === "UNKNOWN") bundle.note(`Связи ${p.name} с товаром Habez ${short} в данных нет: ни утверждения, ни общего раздела каталога.`);
        else bundle.analog({ label: `связь с товаром Habez ${short}`, value: `${STATUS[a.status]}${a.relation ? `: ${REL[a.relation]}` : ""}${a.status === "INFERRED" ? " — тот же раздел каталога, это предположение" : ""}`, status: a.status, productName: p.name });
        pairs.push({ product: short, status: a.status, relation: a.relation });
      }
      return { ...out, mode: "COMPETITOR_PROFILE", competitor: { intent, product: { id: p.id, name: p.name }, links: links.length,
        analogs: pairs.map((x) => ({ competitorProduct: p.name, product: x.product, status: x.status, relation: x.relation, confirmed: x.status === "CONFIRMED" && ["analog", "partial_analog"].includes(x.relation) })) } };
    }
    const prof = timed(calls, "get_competitor", () => callTool("get_competitor", { companyId: t.companies[0] }, ctx));
    if (!prof) return { ...out, mode: "NOT_FOUND", fixed: "Такого конкурента в данных Habez нет." };
    const co = prof.company;
    bundle.note(`\nКОНКУРЕНТ (справочник Habez; «конкурент» — только если так отмечено):`);
    const refs = [
      bundle.competitorRecord({ label: "Компания", value: co.name, where: co.legalName || null }),
      bundle.competitorRecord({ label: "Вид компании", value: co.kind }),
      bundle.competitorRecord({ label: "Отмечена как конкурент", value: { competitor: "да", not_competitor: "нет", unknown: "не установлено" }[co.competitorStatus] }),
      co.website ? bundle.competitorRecord({ label: "Сайт", value: co.website }) : null,
    ].filter(Boolean);
    const focusBrands = route.competitor.brands.length ? prof.brands.filter((b) => route.competitor.brands.includes(b.id)) : prof.brands;
    if (prof.brands.length) bundle.competitorRecord({ label: "Марки компании", value: prof.brands.map((b) => b.name).join(", "), where: "марка — не компания и не завод" });
    for (const p of prof.products.filter((x) => !route.competitor.brands.length || focusBrands.some((b) => b.name === x.brand))) {
      bundle.competitorRecord({ label: `Товар${p.brand ? ` марки ${p.brand}` : ""}`, value: p.name, where: p.category ? `наш раздел для сопоставления: ${p.category}` : null });
    }
    if (prof.regions.length) bundle.competitorRecord({ label: "Регионы", value: prof.regions.join(", ") });
    if (prof.sources.length) bundle.note(`Источники сведений: ${prof.sources.map((s) => `«${s.name}»`).join(", ")}`);
    bundle.note(`Наблюдений характеристик: ${prof.counts.observations}; цен: ${prof.counts.prices}; утверждений об аналогах: ${prof.counts.analogs}.`);
    if (prof.unresolved.length) bundle.note(`НЕ УСТАНОВЛЕНО: ${prof.unresolved.join("; ")}.`);
    return { ...out, mode: "COMPETITOR_PROFILE", competitor: { intent, company: { id: co.id, name: co.name, competitorStatus: co.competitorStatus }, brands: prof.brands.map((b) => b.name),
      products: prof.products.map((p) => p.short || p.name), unresolved: prof.unresolved, refs } };
  }

  // Товары компании / марки / раздела.
  if (intent === "competitor_products") {
    const group = route.factory?.group ? GROUPS.find((g) => g.label === route.factory.group) : groupFromQuestion(q);
    const cats = categoryIdsOf(c.tenantId, group);
    const items = timed(calls, "get_competitor_products", () => {
      const all_ = [];
      const filters = t.brands.length ? t.brands.map((brandId) => ({ brandId })) : t.companies.map((companyId) => ({ companyId }));
      for (const f of filters) all_.push(...callTool("get_competitor_products", f, ctx).items);
      return cats ? all_.filter((p) => cats.some((id) => catNameMatches(c, id, p.category))) : all_;
    }, (x) => x.length);
    const who = t.brands.length ? `марки ${list(t.brands.map((b) => brandName(c, b)).filter(Boolean))}` : `компании ${list(t.companies.map((x) => companyName(c, x)).filter(Boolean))}`;
    if (!items.length) return { ...out, mode: "COMPETITOR_PRODUCTS", fixed: `У ${who} в данных Habez нет товаров${group ? ` группы «${group.label}»` : ""}. Отсутствие записи не значит, что компания их не выпускает — в справочник внесено не всё.` };
    bundle.note(`\nТОВАРЫ КОНКУРЕНТА — ${who}${group ? `, группа «${group.label}»` : ""} (только то, что внесено в справочник Habez):`);
    for (const p of items) bundle.competitorRecord({ label: `${p.company}${p.brand ? `, марка ${p.brand}` : ""}`, value: p.name, where: [p.category ? `наш раздел: ${p.category}` : null, p.packs.length ? `фасовки: ${p.packs.join(", ")}` : null].filter(Boolean).join("; ") || null });
    return { ...out, mode: "COMPETITOR_PRODUCTS", focus: { ...focus, product: items.length === 1 ? items[0].id : null, brand: t.brands[0] ?? null },
      competitor: { intent, items: items.map((p) => ({ id: p.id, name: p.name, short: p.short, company: p.company, brand: p.brand })) } };
  }

  // Аналоги товара Habez.
  if (intent === "analog_lookup") {
    if (!route.products.length && t.products.length) {
      const p = getCompetitorProduct(c, t.products[0]);
      const links = timed(calls, "find_analogs", () => analogsOfCompetitorProduct(c, p.id), (x) => x.length);
      if (!links.length) return { ...out, mode: "ANALOGS", fixed: `Для ${nameOf(p)} в данных Habez нет сопоставленных товаров Habez — ни по источнику, ни по решению сотрудника.` };
      renderCompetitorProduct(bundle, c, p, { brief: true });
      for (const l of links) { allowed.add(l.product.id); renderPair(bundle, c, l, nameOf(p)); }
      return { ...out, mode: "ANALOGS", competitor: { intent, analogs: links.map(pairSummary) } };
    }
    const ours = route.products[0];
    if (!ours) return { ...out, mode: "CLARIFICATION", fixed: "Для какого товара Habez найти аналоги у конкурентов? Назовите товар, например «ШОВ»." };
    const res = timed(calls, "find_analogs", () => callTool("find_analogs", { productId: ours.id }, ctx), (x) => (x ? x.confirmed.length + x.conflicted.length + x.inferred.length + x.notAnalog.length : 0));
    allowed.add(ours.id);
    const n = res.confirmed.length + res.conflicted.length + res.inferred.length + res.notAnalog.length;
    if (!n) return { ...out, mode: "ANALOGS", fixed: `В данных Habez нет товаров конкурентов, сопоставленных с ${nameOf(ours)}: ни подтверждённых аналогов, ни предположений по разделу каталога.` };
    bundle.note(`\nАНАЛОГИ ${ours.name} (статусы посчитала система; «аналог» ≠ «одинаковый товар»; ПРЕДПОЛОЖЕНИЕ не выдавать за подтверждённое):`);
    for (const [title, arr] of [["ПОДТВЕРЖДЕНО: АНАЛОГ", res.confirmed.filter((x) => x.relation === "analog")],
      ["ПОДТВЕРЖДЕНО: ЧАСТИЧНЫЙ АНАЛОГ (отдельно от полных; назвать различия)", res.confirmed.filter((x) => x.relation === "partial_analog")],
      ["ПРОТИВОРЕЧИЕ", res.conflicted], ["ПОДТВЕРЖДЕНО: НЕ АНАЛОГ", res.notAnalog], ["ПРЕДПОЛОЖЕНИЯ (не подтверждены, confirmed: false)", res.inferred]]) {
      if (!arr.length) continue;
      bundle.note(`${title}:`);
      for (const x of arr) renderToolPair(bundle, x, ours);
    }
    return { ...out, mode: "ANALOGS", focus: { ...focus, product: res.confirmed.length === 1 ? res.confirmed[0].competitorProduct.id : focus.product },
      competitor: { intent, product: ours.name, analogs: [...res.confirmed, ...res.conflicted, ...res.notAnalog, ...res.inferred].map((x) => ({ competitorProduct: x.competitorProduct.name, company: x.competitorProduct.company,
        status: x.status, relation: x.relation, confirmed: x.confirmed, basisKind: x.basisKind, needsReview: x.needsReview })) } };
  }

  // Сравнение «наш ↔ их».
  if (intent === "competitor_comparison") {
    const ours = route.products[0];
    if (!ours) return { ...out, mode: "CLARIFICATION", fixed: "С каким товаром Habez сравнить? Назовите товар, например «Сравни ШОВ с …»." };
    const pick = pickForComparison(c, ours, t, route);
    if (pick.many) {
      const opts = pick.many.map((p) => `Сравни ${nameOf(ours)} с ${nameOf(p)}`);
      return { ...out, mode: "CLARIFICATION", clarification: { question: `С каким товаром сравнить ${nameOf(ours)}: ${list(pick.many.map(nameOf))}?`, options: opts },
        fixed: `С каким товаром сравнить ${nameOf(ours)}: ${list(pick.many.map(nameOf))}?` };
    }
    if (pick.none) {
      const who = t.brands.length ? `марки ${list(t.brands.map((b) => brandName(c, b)).filter(Boolean))}` : `${list(t.companies.map((x) => companyName(c, x)).filter(Boolean))}`;
      return { ...out, mode: "COMPETITOR_COMPARISON", fixed: `У ${who} в данных Habez нет товара, сопоставленного с ${nameOf(ours)} — ни по источнику, ни по разделу каталога.${pick.pool?.length ? ` Товары в справочнике: ${list(pick.pool.map(nameOf))}. Назовите, с каким сравнить.` : ""}` };
    }
    const cmp = timed(calls, "compare_with_competitor", () => callTool("compare_with_competitor", { productId: ours.id, competitorProductId: pick.id }, ctx), (x) => (x ? x.rows.length : 0));
    if (!cmp) return { ...out, mode: "NOT_FOUND", fixed: "Такого товара конкурента в данных Habez нет." };
    const [oursSp, theirsSp] = cmp.items;
    if (!theirsSp.properties.length && !cmp.prices.length) {
      return { ...out, focus: { ...focus, product: pick.id }, mode: "COMPETITOR_COMPARISON", fixed: `По ${theirsSp.product.short} в данных Habez нет ни характеристик, ни цен — сравнивать нечего. Отсутствие данных не значит, что показатель хуже или равен нулю.` };
    }
    const cp = getCompetitorProduct(c, pick.id);
    const p = callTool("get_product", { productId: ours.id }, ctx);
    p.sections = [];
    allowed.add(ours.id);
    bundle.product(p, oursSp, {});
    renderCompetitorProduct(bundle, c, cp, { brief: true });
    bundle.product({ ...theirsSp.product, category: null, sections: [], variants: [] }, theirsSp, {});
    bundle.comparison({ products: cmp.products, rows: cmp.rows });
    const a = cmp.analog;
    bundle.analog({ label: `связь ${nameOf(ours)} ↔ ${nameOf(cp)}`, value: `${STATUS[a.status]}${a.relation ? `: ${REL[a.relation]}` : ""}${a.status === "INFERRED" ? " — тот же раздел каталога, это предположение" : ""}`,
      status: a.status, productName: cp.name, where: a.basis.map((b) => `${b.basis === "user_decision" ? "решение сотрудника" : "указано в источнике"}${b.differences ? `; различия: ${b.differences}` : ""}`).join("; ") || null });
    if (a.needsReview) bundle.note("Есть внутренние сведения о связи, которые требуют сверки, — значений не раскрывать.");
    if (cmp.prices.length) bundle.prices(cmp.prices, cp.name);
    else bundle.note(`\nЦЕН на ${cp.name} в данных нет.`);
    priceNotes(bundle, c, q, [{ p: cp, groups: cmp.prices }]);
    bundle.note("Цены Habez здесь не сравниваются (это не входит в этап); «нет данных» — не ноль и не «хуже».");
    return { ...out, focus: { company: cp.companyId, brand: cp.brandId, product: cp.id }, mode: "COMPETITOR_COMPARISON",
      competitor: { intent, product: ours.name, competitorProduct: cp.name, analog: { status: a.status, relation: a.relation }, prices: cmp.prices.length } };
  }

  // Цены.
  if (intent === "competitor_price") {
    let ids = t.products;
    if (!ids.length || route.competitor.otherBrand) {
      ids = listCompetitorProducts(c, {}).filter((p) => (t.brands.length ? t.brands.includes(p.brandId) : t.companies.includes(p.companyId))).map((p) => p.id).slice(0, 6);
    }
    if (!ids.length) return { ...out, mode: "COMPETITOR_PRICE", fixed: "Товаров этого конкурента в данных Habez нет — и цен тоже." };
    const got = timed(calls, "compare_with_competitor", () => ids.map((id) => ({ p: getCompetitorProduct(c, id), groups: competitorPrices(c, id) })), (x) => x.filter((y) => y.groups.length).length);
    const withPrices = got.filter((x) => x.groups.length);
    if (!withPrices.length) {
      const hidden = got.reduce((n, x) => n + hiddenPriceCount(c, x.p.id), 0);
      return { ...out, focus: { ...focus, product: ids.length === 1 ? ids[0] : focus.product }, mode: "COMPETITOR_PRICE",
        fixed: hidden ? `Цен на ${list(got.map((x) => nameOf(x.p)))}, доступных вашей роли, в данных Habez нет. Есть цены с ограниченным доступом: ${hidden} — они доступны администратору.`
          : `Цен на ${list(got.map((x) => nameOf(x.p)))} в данных Habez нет. Цену я не называю, если её нет в источнике.` };
    }
    for (const x of withPrices) { renderCompetitorProduct(bundle, c, x.p, { brief: true }); bundle.prices(x.groups, x.p.name); }
    for (const x of got.filter((y) => !y.groups.length)) bundle.note(`Цен на ${x.p.name} в данных нет.`);
    priceNotes(bundle, c, q, got);
    return { ...out, focus: { company: withPrices[0].p.companyId, brand: withPrices[0].p.brandId, product: withPrices.length === 1 ? withPrices[0].p.id : focus.product }, mode: "COMPETITOR_PRICE",
      competitor: { intent, products: withPrices.map((x) => x.p.name), groups: withPrices.reduce((n, x) => n + x.groups.length, 0) } };
  }
  return null;
}

function catNameMatches(c, id, name) {
  return !!name && get("SELECT name FROM categories WHERE id=? AND tenant_id=?", id, c.tenantId)?.name === name;
}

function renderCompetitorProduct(bundle, c, p, { brief = false } = {}) {
  bundle.note(`\nТОВАР КОНКУРЕНТА (справочник Habez; в каталоге Habez его нет):`);
  bundle.competitorRecord({ label: "Товар", value: p.name, where: [companyName(c, p.companyId), brandName(c, p.brandId) ? `марка ${brandName(c, p.brandId)}` : null].filter(Boolean).join(", ") });
  if (brief) return;
  if (p.gost) bundle.competitorRecord({ label: "ГОСТ / ТУ по данным", value: p.gost });
  const packs = listPacks(c, p.id);
  if (packs.length) bundle.competitorRecord({ label: "Фасовки", value: packs.map((k) => k.unitLabel).join(", ") });
  const obs = productObservations(c, p.id);
  bundle.note(`Характеристик в данных: ${obs.properties.length}.`);
}

const pairSummary = (l) => ({ product: l.product.short, status: l.status, relation: l.relation });
function renderPair(bundle, c, l, cpName) {
  bundle.analog({ label: `связь с товаром Habez ${l.product.short}`, value: `${STATUS[l.status]}${l.relation ? `: ${REL[l.relation]}` : ""}`, status: l.status, productName: cpName,
    where: l.basis.map((b) => `${b.basis === "user_decision" ? "решение сотрудника" : "указано в источнике"}${b.differences ? `; различия: ${b.differences}` : ""}`).join("; ") || null });
}
function renderToolPair(bundle, x, ours) {
  const who = `${x.competitorProduct.name}${x.competitorProduct.company ? ` (${x.competitorProduct.company}${x.competitorProduct.brand ? `, марка ${x.competitorProduct.brand}` : ""})` : ""}`;
  const basis = x.basis.map((b) => `${REL[b.relation]} — ${BASIS[b.kind]}${b.source ? ` «${b.source.name}»` : ""}${b.note ? `; обоснование: ${b.note}` : ""}${b.differences ? `; различия: ${b.differences}` : ""}`).join(" | ");
  bundle.analog({ label: `${nameOf(ours)} ↔ ${who}`, value: `${STATUS[x.status]}${x.relation ? `: ${REL[x.relation]}` : ""}`, status: x.status, productName: x.competitorProduct.name,
    sourceName: x.basis.find((b) => b.source)?.source?.name ?? null, where: x.status === "INFERRED" ? BASIS.heuristic : basis || null });
  if (x.needsReview) bundle.note("  есть внутренние сведения, требующие сверки, — значения не раскрывать");
}
