// Habez AI Phase 3.3: подбор товаров под задачу — правилами.
//
//   сценарий → кандидаты (разделы каталога сценария, слово вида товара
//   из вопроса) → карточка и характеристики каждого (инструменты чтения,
//   права роли) → пригодность (intel/suitability.js) → фасовка, если
//   задана → группы по статусу.
//
// Порядок внутри группы — порядок каталога (products.position), а НЕ
// рейтинг: критерия «лучше» в данных нет. Неподходящие не выбрасываются
// молча, а идут отдельной группой с причиной.
import { all } from "../../../db/index.js";
import { callTool } from "../tools/index.js";
import { evaluateSuitability } from "./suitability.js";
import { variantSizesIn } from "../retrieval/specs.js";

const ORDER = ["SUPPORTED", "PARTIALLY_SUPPORTED", "CONFLICTED", "INSUFFICIENT_DATA", "NOT_SUPPORTED"];

export function selectProducts({ ctx, useCase, typeFilter = null, excludeCategories = [], size = null, calls, limit = 30, only = null }) {
  const rows = all(`SELECT p.id, p.slug, p.name, p.short_name, p.position, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.tenant_id=?${ctx.scope === "public" ? " AND p.status='published'" : ""} ORDER BY p.position, p.id`, ctx.tenantId);
  const candidates = only
    ? rows.filter((r) => only.includes(r.id))
    : rows.filter((r) => useCase.types.test(r.category || "") && (!typeFilter || typeFilter.test(r.category || "")) && !excludeCategories.includes(r.category)).slice(0, limit);
  const results = [];
  for (const c of candidates) {
    const t0 = Date.now();
    const p = callTool("get_product", { productId: c.id }, ctx);
    const sp = p ? callTool("get_product_specs", { productId: c.id }, ctx) : null;
    calls.push({ name: "get_product", source: "plan", ms: 0, found: p ? 1 : 0 }, { name: "get_product_specs", source: "plan", ms: Date.now() - t0, found: sp?.properties.length ?? 0 });
    if (!p || !sp) continue;
    const r = evaluateSuitability({ product: p, sp, useCase });
    // Фасовка из вопроса («нужна фасовка 25 кг»): у кандидата её нет —
    // по задаче он может подходить, но не в этой фасовке.
    const packaging = size ? (p.variants || []).some((v) => variantSizesIn(v.unit).includes(size)) : null;
    results.push({ p, sp, r, position: c.position, packaging });
  }
  results.sort((a, b) => ORDER.indexOf(a.r.status) - ORDER.indexOf(b.r.status) || a.position - b.position);
  return results;
}

// «фасовка 25 кг», «мешок 25 кг» → «25 кг».
export function sizeFromQuestion(q) {
  const m = String(q || "").toLowerCase().replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*(кг|л|мм)(?![а-я])/);
  return m ? `${Number(m[1])} ${m[2]}` : null;
}
