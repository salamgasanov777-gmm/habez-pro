// Сборка карточек товара для выдачи. Списку нужен минимум полей — тяжёлые
// разделы и таблицы (в каталоге это 688 строк характеристик) отдаются
// только в карточке одного товара.
import { all, get, json, run } from "../db/index.js";
import { priceMapFor, tierFor } from "./pricing.js";

export function listVariants(tenantId, productIds) {
  if (!productIds.length) return new Map();
  const marks = productIds.map(() => "?").join(",");
  const rows = all(
    `SELECT v.*, s.qty AS stock_qty FROM variants v
       LEFT JOIN stock s ON s.variant_id = v.id
      WHERE v.tenant_id=? AND v.product_id IN (${marks}) AND v.is_active=1
      ORDER BY v.is_default DESC, v.position, v.id`,
    tenantId, ...productIds
  );
  const map = new Map();
  for (const r of rows) {
    const arr = map.get(r.product_id) || [];
    arr.push(r);
    map.set(r.product_id, arr);
  }
  return map;
}

export function decorate(tenantId, products, user, { full = false } = {}) {
  if (!products.length) return [];
  const ids = products.map((p) => p.id);
  const variantsByProduct = listVariants(tenantId, ids);
  const allVariantIds = [...variantsByProduct.values()].flat().map((v) => v.id);
  const prices = priceMapFor(tenantId, tierFor(user), allVariantIds);

  const marks = ids.map(() => "?").join(",");
  const photos = all(
    `SELECT * FROM media WHERE product_id IN (${marks}) ORDER BY position, id`, ...ids
  );
  const photosByProduct = new Map();
  for (const m of photos) {
    const arr = photosByProduct.get(m.product_id) || [];
    arr.push(m);
    photosByProduct.set(m.product_id, arr);
  }

  return products.map((p) => {
    const variants = (variantsByProduct.get(p.id) || []).map((v) => {
      const price = prices.get(v.id) || { amount: null, onRequest: true, currency: "RUB", breaks: [] };
      return {
        id: v.id,
        sku: v.sku,
        unit: v.unit,
        packSize: v.pack_size,
        packUnit: v.pack_unit,
        perPallet: v.per_pallet,
        isDefault: !!v.is_default,
        price: price.amount,
        priceOnRequest: price.onRequest,
        priceBreaks: price.breaks,
        currency: price.currency,
        stock: v.stock_qty ?? null,
      };
    });

    const media = photosByProduct.get(p.id) || [];
    const cover = media.find((m) => m.kind === "photo");

    const base = {
      id: p.id,
      slug: p.slug,
      name: p.name,
      shortName: p.short_name,
      category: p.category_name || null,
      categorySlug: p.category_slug || null,
      summary: p.summary,
      gost: p.gost,
      badges: json(p.badges, []),
      tasks: json(p.tasks, []),
      calc: json(p.calc, null),
      photo: cover?.url || null,
      photoWebp: cover?.url_webp || null,
      variants,
      priceFrom: variants.map((v) => v.price).filter((x) => x !== null).sort((a, b) => a - b)[0] ?? null,
      inStock: variants.some((v) => (v.stock ?? 0) > 0),
    };

    if (!full) return base;

    return {
      ...base,
      sections: json(p.sections, []),
      tables: json(p.spec_tables, []),
      attributes: json(p.attributes, {}),
      seoTitle: p.seo_title,
      seoDescription: p.seo_description,
      docs: media.filter((m) => m.kind !== "photo").map((m) => ({ title: m.title, url: m.url, kind: m.kind })),
      gallery: media.filter((m) => m.kind === "photo").map((m) => ({ url: m.url, webp: m.url_webp })),
    };
  });
}

// FTS5 требует экранирования: пользовательский ввод не должен становиться
// синтаксисом запроса. Каждое слово — префиксный поиск.
// «Новое в каталоге» на главной. Новым считается то, что добавили после
// первого наполнения (первый день жизни каталога не в счёт — тогда завезли
// всё сразу) и не раньше месяца назад. Когда новинок нет, список пуст,
// и полоса на главной не показывается.
export function newArrivals(tenantId, limit = 6) {
  return all(
    `SELECT p.id, p.slug, p.name, p.short_name AS shortName, m.url AS photo, m.url_webp AS photoWebp
       FROM products p LEFT JOIN media m ON m.product_id = p.id AND m.position = 0
      WHERE p.tenant_id = ? AND p.status = 'published'
        AND p.created_at > (SELECT datetime(MIN(created_at), '+1 day') FROM products WHERE tenant_id = ? AND status = 'published')
        AND p.created_at > datetime('now', '-30 days')
      ORDER BY p.created_at DESC, p.position LIMIT ?`,
    tenantId, tenantId, limit);
}

export function ftsQuery(q) {
  const terms = String(q)
    .toLowerCase()
    .replace(/["*^]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

export function reindexProduct(p) {
  const body = [
    json(p.sections, []).map((s) => `${s.title} ${s.text}`).join(" "),
    json(p.spec_tables, []).map((t) => `${t.title} ${t.rows.map((r) => r.join(" ")).join(" ")}`).join(" "),
  ].join(" ");
  run("DELETE FROM products_fts WHERE rowid=?", p.id);
  run("INSERT INTO products_fts (rowid, name, summary, gost, body) VALUES (?,?,?,?,?)",
    p.id, p.name || "", p.summary || "", p.gost || "", body);
}

export function productBySlugOrId(tenantId, key) {
  const sql = `SELECT p.*, c.name AS category_name, c.slug AS category_slug
                 FROM products p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.tenant_id=? AND p.status='published' AND `;
  return /^\d+$/.test(key)
    ? get(sql + "p.id=?", tenantId, Number(key))
    : get(sql + "p.slug=?", tenantId, key);
}
