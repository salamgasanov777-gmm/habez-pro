// Habez AI Agent (Phase 3.2): выборка по маршруту — какие свойства товара
// относятся к вопросу. Общая для плана (runtime/agent.js) и для
// инструментов, которые вызывает модель (runtime/tool-runner.js).
//
//   характеристики — только спрошенные (или все, если не спрошены);
//   условия       — «через 28 суток» отбрасывает значения на 7 суток;
//                   значение без указанного возраста остаётся с пометкой;
//   фасовка       — «12,5 мм» отбрасывает свойства и строки карточки
//                   других фасовок;
//   история       — подставленное программой (40 шт/поддон) не идёт.
import { callTool } from "../tools/index.js";
import { matchesConditions, conditionOfProperty, variantSizesIn, specLabel, resolveSpecs } from "../retrieval/specs.js";

const onlyGenerated = (prop) => prop.values.length > 0 && prop.values.every((v) => !v.hidden && v.evidence.length && v.evidence.every((e) => e.sourceType === "generated_default"));
const PACKAGING_KEYS = /thickness|sheet|area|weight|per_pallet|size|gtin|ntin/;

const condText = (c) => Object.entries(c).map(([k, v]) => (k === "age_days" ? `${v} сут` : k === "layer_mm" ? `слой ${v} мм` : k === "per" ? { bag: "на мешок", kg: "на 1 кг", m2: "на 1 м²" }[v] || v : `${k}=${v}`)).join(", ");

// sp — результат get_product_specs (меняется на месте). Возвращает, чего нет.
export function selectProperties(sp, p, { keys = [], groups = [], conditions = {}, variant = null, packaging = false } = {}) {
  const otherConditions = new Set();
  let props = sp.properties.filter((x) => !onlyGenerated(x));
  // Строка карточки без ключа словаря («Прочность на растяжение при изгибе в
  // возрасте 7 сут») подходит, если её подпись говорит о той же характеристике.
  if (keys.length) props = props.filter((x) => (x.key ? keys.includes(x.key) : resolveSpecs(x.label).keys.some((k) => keys.includes(k))));
  if (packaging && !keys.length) props = props.filter((x) => x.packaging || (x.key && PACKAGING_KEYS.test(x.key)) || x.variant);
  if (Object.keys(conditions).length) {
    props = props.filter((x) => {
      if (matchesConditions(x, conditions)) return true;
      const c = conditionOfProperty(x);
      if (Object.keys(c).length) otherConditions.add(condText(c));
      return false;
    });
  }
  if (variant) {
    const asked = variantSizesIn(variant.unit);
    const others = (p.variants || []).filter((v) => v.unit !== variant.unit).flatMap((v) => variantSizesIn(v.unit)).filter((t) => !asked.includes(t));
    props = props.filter((x) => {
      if (x.variant) return x.variant.unit === variant.unit;
      // Строка карточки про другую фасовку («63 шт (9,5 мм) / 51 шт (12,5 мм)»)
      // к вопросу о 12,5 мм не относится целиком: в ней есть чужое число.
      const text = `${x.label} ${x.values.map((v) => v.display).join(" ")}`;
      return !variantSizesIn(text).some((t) => others.includes(t));
    });
  }
  sp.properties = props.slice(0, 80);
  const covers = (x, g) => (x.key ? g.keys.includes(x.key) : resolveSpecs(x.label).keys.some((k) => g.keys.includes(k)));
  // Количество на поддоне хранится и в самой фасовке (variants.per_pallet).
  const inVariants = (g) => g.keys.includes("per_pallet") && (p.variants || []).some((v) => (!variant || v.id === variant.id) && v.per_pallet);
  const missing = groups.filter((g) => !props.some((x) => covers(x, g)) && !inVariants(g)).map((g) => g.label);
  return { missing, otherConditions: [...otherConditions] };
}

// Карточка и свойства одного товара по маршруту. Каждый вызов инструмента
// записывается в calls.
export function fetchProduct(ctx, productId, route, calls, { variant = null, source = "plan" } = {}) {
  const t0 = Date.now();
  const p = callTool("get_product", { productId }, ctx);
  calls.push({ name: "get_product", source, ms: Date.now() - t0, found: p ? 1 : 0 });
  if (!p) return null;
  // Без фильтра ключей: отбор (в т. ч. строк карточки по подписи) — в selectProperties.
  const t1 = Date.now();
  const sp = callTool("get_product_specs", { productId }, ctx);
  calls.push({ name: "get_product_specs", source, ms: Date.now() - t1, found: sp?.properties.length ?? 0 });
  if (variant) p.variants = p.variants.filter((v) => v.id === variant.id);
  return { p, sp };
}

// Группы характеристик для пометок «нет данных».
export function specGroups(route) {
  if (route.specs.groups?.length) return route.specs.groups.map((g) => ({ label: g.label, keys: g.keys }));
  if (route.specs.keys?.length) return [{ label: route.specs.terms?.[0] || route.specs.keys.map(specLabel).join(", "), keys: route.specs.keys }];
  return [];
}
