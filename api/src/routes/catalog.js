// Публичный каталог. Самая горячая часть API: отвечает на каждый заход,
// в том числе поисковым роботам, поэтому здесь ETag и кеш-заголовки.
import { z } from "zod";
import { createHash } from "node:crypto";
import { all, get, insert, run } from "../db/index.js";
import { decorate, ftsQuery, productBySlugOrId } from "../services/catalog.js";
import { notFound } from "../lib/errors.js";

// Подбор по задаче: те же пять сценариев, что в каталоге завода.
export const TASKS = [
  { key: "wet", label: "Ванная" },
  { key: "dry", label: "Комната" },
  { key: "facade", label: "Фасад" },
  { key: "floor-heat", label: "Тёплый пол" },
  { key: "plinth", label: "Цоколь" },
];

function etagFor(payload) {
  return 'W/"' + createHash("sha1").update(JSON.stringify(payload)).digest("base64url").slice(0, 27) + '"';
}

export default async function catalogRoutes(app) {
  app.get("/api/catalog/meta", async (req, reply) => {
    const categories = all(
      `SELECT c.id, c.slug, c.name, c.icon,
              (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.status='published') AS count
         FROM categories c WHERE c.tenant_id=? AND c.is_active=1 ORDER BY c.position, c.name`,
      req.tenant.id);
    const settings = JSON.parse(req.tenant.settings || "{}");
    const payload = {
      tenant: {
        slug: req.tenant.slug, name: req.tenant.name, phone: req.tenant.phone,
        email: req.tenant.email, address: req.tenant.address, logo: req.tenant.logo_url,
        theme: JSON.parse(req.tenant.theme || "{}"),
      },
      settings: {
        currency: settings.currency || "RUB",
        showPrices: settings.showPrices !== false,
        minOrder: settings.minOrder || 0,
        deliveryCost: settings.deliveryCost ?? null,
        checkoutMode: settings.checkoutMode || "order", // order | quote
      },
      categories: categories.filter((c) => c.count > 0),
      tasks: TASKS,
      total: get("SELECT COUNT(*) AS n FROM products WHERE tenant_id=? AND status='published'", req.tenant.id).n,
    };
    const etag = etagFor(payload);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("etag", etag).header("cache-control", "public, max-age=60, stale-while-revalidate=600");
    return payload;
  });

  app.get("/api/catalog/products", async (req, reply) => {
    const q = z.object({
      search: z.string().max(120).optional(),
      category: z.string().max(120).optional(),
      task: z.string().max(40).optional(),
      inStock: z.coerce.boolean().optional(),
      sort: z.enum(["default", "name", "price_asc", "price_desc", "new"]).default("default"),
      page: z.coerce.number().int().min(1).max(500).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(48),
    }).parse(req.query);

    const where = ["p.tenant_id = ?", "p.status = 'published'"];
    const params = [req.tenant.id];
    let joinFts = "";

    if (q.category) {
      where.push("c.slug = ?");
      params.push(q.category);
    }
    if (q.task) {
      // JSON-массив задач фильтруется прямо в SQLite — отдельная таблица
      // связей ради пяти значений усложнила бы схему без выигрыша.
      where.push("EXISTS (SELECT 1 FROM json_each(p.tasks) WHERE json_each.value = ?)");
      params.push(q.task);
    }
    const fts = q.search ? ftsQuery(q.search) : null;
    if (fts) {
      joinFts = "JOIN products_fts f ON f.rowid = p.id";
      where.push("products_fts MATCH ?");
      params.push(fts);
    }

    const order = {
      default: "p.position, p.name",
      name: "p.name",
      new: "p.created_at DESC",
      price_asc: "price_from ASC NULLS LAST",
      price_desc: "price_from DESC NULLS LAST",
    }[q.sort];

    const base = `FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${joinFts}
      WHERE ${where.join(" AND ")}`;

    const total = get(`SELECT COUNT(*) AS n ${base}`, ...params).n;
    const rows = all(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
              (SELECT MIN(pr.amount) FROM variants v JOIN prices pr ON pr.variant_id=v.id
                WHERE v.product_id=p.id AND pr.tier='retail') AS price_from
         ${base} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params, q.limit, (q.page - 1) * q.limit);

    let items = decorate(req.tenant.id, rows, req.user);
    if (q.inStock) items = items.filter((i) => i.inStock);

    // Что ищут и чего не находят — материал для решения, какие товары
    // добавить в каталог. Пишем только сам запрос, без привязки к человеку.
    if (q.search && q.page === 1) {
      insert("search_log", { tenant_id: req.tenant.id, query: q.search.slice(0, 120), results: total });
    }

    reply.header("cache-control", "public, max-age=30, stale-while-revalidate=300");
    return { items, page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) };
  });

  app.get("/api/catalog/products/:key", async (req, reply) => {
    const row = productBySlugOrId(req.tenant.id, req.params.key);
    if (!row) throw notFound("Товар не найден");
    run("UPDATE products SET views = views + 1 WHERE id=?", row.id);
    const [product] = decorate(req.tenant.id, [row], req.user, { full: true });

    const related = all(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE p.tenant_id=? AND p.category_id=? AND p.id<>? AND p.status='published'
        ORDER BY p.position LIMIT 6`, req.tenant.id, row.category_id, row.id);

    reply.header("cache-control", "public, max-age=60, stale-while-revalidate=600");
    return { product, related: decorate(req.tenant.id, related, req.user) };
  });

  // Сравнение: сервер сам сводит характеристики в общую таблицу, клиенту
  // остаётся её нарисовать. Так одна и та же логика работает и на сайте, и в боте.
  app.get("/api/catalog/compare", async (req) => {
    const ids = String(req.query.ids || "").split(",").map(Number).filter(Boolean).slice(0, 6);
    if (ids.length < 2) return { rows: [], products: [] };
    const marks = ids.map(() => "?").join(",");
    const rows = all(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE p.tenant_id=? AND p.id IN (${marks}) AND p.status='published'`, req.tenant.id, ...ids);
    const products = decorate(req.tenant.id, rows, req.user, { full: true });

    const labels = new Map();
    for (const p of products) {
      for (const b of p.badges) labels.set(b.label, "badge");
      for (const t of p.tables) for (const [l] of t.rows) labels.set(`${t.title} · ${l}`, "table");
    }
    const compareRows = [...labels.keys()].map((label) => ({
      label,
      values: products.map((p) => {
        const badge = p.badges.find((b) => b.label === label);
        if (badge) return badge.value;
        const [title, l] = label.split(" · ");
        const table = p.tables.find((t) => t.title === title);
        return table?.rows.find(([rl]) => rl === l)?.[1] ?? null;
      }),
    })).filter((r) => r.values.some((v) => v !== null));

    return { products: products.map((p) => ({ id: p.id, name: p.shortName || p.name, photo: p.photo, slug: p.slug })), rows: compareRows };
  });

  // Калькулятор считается на сервере: одна формула на сайт, приложение и бота.
  app.post("/api/catalog/calc", async (req) => {
    const body = z.object({
      productId: z.number().int(),
      area: z.number().positive().max(100000),
      thicknessMm: z.number().positive().max(200).optional(),
    }).parse(req.body);

    const row = get("SELECT * FROM products WHERE id=? AND tenant_id=?", body.productId, req.tenant.id);
    if (!row?.calc) throw notFound("Для этого товара расчёт не задан");
    const calc = JSON.parse(row.calc);

    const totalRaw = calc.type === "thickness"
      ? calc.ratePerM2 * body.area * (body.thicknessMm ?? 10)
      : calc.ratePerM2 * body.area;

    const liquid = calc.type === "liquid";
    const packs = Math.ceil(totalRaw / calc.pack);
    return {
      amount: liquid ? totalRaw / 1000 : totalRaw,
      unit: liquid ? (calc.packUnit === "г" ? "кг" : "л") : "кг",
      packs,
      packSize: liquid ? calc.pack / 1000 : calc.pack,
      note: "Расчёт ориентировочный: расход зависит от основания и способа нанесения.",
    };
  });
}
