// Панель управления. Всё под ролью не ниже менеджера, все изменения
// пишутся в журнал: на заводе с каталогом работают несколько человек,
// и вопрос «кто поменял цену» возникает раньше, чем кажется.
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { all, get, insert, run, update, tx, json } from "../db/index.js";
import { config } from "../config.js";
import { reindexProduct } from "../services/catalog.js";
import { setStatus, orderView, ORDER_STATUSES } from "../services/orders.js";
import { hashPassword } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";

function audit(req, action, entity, entityId, diff) {
  insert("audit_log", {
    tenant_id: req.tenant.id, actor_id: req.user?.id ?? null,
    action, entity, entity_id: String(entityId ?? ""), diff: diff ?? {}, ip: req.ip,
  });
}

const slugify = (s) => String(s).toLowerCase()
  .replace(/[а-яё]/g, (c) => ("а:a,б:b,в:v,г:g,д:d,е:e,ё:e,ж:zh,з:z,и:i,й:i,к:k,л:l,м:m,н:n,о:o,п:p,р:r,с:s,т:t,у:u,ф:f,х:h,ц:c,ч:ch,ш:sh,щ:sch,ъ:,ы:y,ь:,э:e,ю:yu,я:ya")
    .split(",").find((p) => p.startsWith(c + ":"))?.slice(2) ?? "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export default async function adminRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));

  // ── Сводка ───────────────────────────────────────────────────────────────
  app.get("/api/admin/stats", async (req) => {
    const t = req.tenant.id;
    const money = (sql, ...p) => get(sql, ...p)?.v ?? 0;
    return {
      orders: {
        today: get("SELECT COUNT(*) AS v FROM orders WHERE tenant_id=? AND date(created_at)=date('now')", t).v,
        month: get("SELECT COUNT(*) AS v FROM orders WHERE tenant_id=? AND created_at > datetime('now','-30 days')", t).v,
        new: get("SELECT COUNT(*) AS v FROM orders WHERE tenant_id=? AND status='new'", t).v,
      },
      revenue: {
        month: money("SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE tenant_id=? AND payment_status='paid' AND created_at > datetime('now','-30 days')", t),
        pending: money("SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE tenant_id=? AND payment_status='pending' AND status NOT IN ('cancelled')", t),
      },
      leads: { new: get("SELECT COUNT(*) AS v FROM leads WHERE tenant_id=? AND status='new'", t).v },
      catalog: {
        products: get("SELECT COUNT(*) AS v FROM products WHERE tenant_id=?", t).v,
        published: get("SELECT COUNT(*) AS v FROM products WHERE tenant_id=? AND status='published'", t).v,
        noPrice: get(`SELECT COUNT(*) AS v FROM variants v LEFT JOIN prices p ON p.variant_id=v.id AND p.tier='retail'
                       WHERE v.tenant_id=? AND (p.amount IS NULL)`, t).v,
      },
      chart: all(`SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total),0) AS total
                    FROM orders WHERE tenant_id=? AND created_at > datetime('now','-14 days')
                   GROUP BY day ORDER BY day`, t),
      topProducts: all(`SELECT p.name, p.views, COALESCE(SUM(oi.qty),0) AS sold
                          FROM products p LEFT JOIN order_items oi ON oi.variant_id IN (SELECT id FROM variants WHERE product_id=p.id)
                         WHERE p.tenant_id=? GROUP BY p.id ORDER BY sold DESC, p.views DESC LIMIT 8`, t),
      // Запросы без результата — прямая подсказка, чего не хватает в каталоге.
      missedSearches: all(`SELECT query, COUNT(*) AS n FROM search_log
                            WHERE tenant_id=? AND results=0 AND created_at > datetime('now','-30 days')
                            GROUP BY query ORDER BY n DESC LIMIT 10`, t),
    };
  });

  // ── Товары ───────────────────────────────────────────────────────────────
  app.get("/api/admin/products", async (req) => {
    const q = z.object({
      search: z.string().max(120).optional(),
      status: z.enum(["draft", "published", "archived"]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

    const where = ["p.tenant_id=?"];
    const params = [req.tenant.id];
    if (q.status) { where.push("p.status=?"); params.push(q.status); }
    if (q.search) { where.push("(p.name LIKE ? OR p.sku LIKE ?)"); params.push(`%${q.search}%`, `%${q.search}%`); }

    const total = get(`SELECT COUNT(*) AS n FROM products p WHERE ${where.join(" AND ")}`, ...params).n;
    const items = all(
      `SELECT p.id, p.name, p.slug, p.status, p.views, p.updated_at, c.name AS category,
              (SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id) AS variants,
              (SELECT MIN(pr.amount) FROM variants v JOIN prices pr ON pr.variant_id=v.id AND pr.tier='retail' WHERE v.product_id=p.id) AS price,
              (SELECT url FROM media m WHERE m.product_id=p.id AND m.kind='photo' ORDER BY m.position LIMIT 1) AS photo
         FROM products p LEFT JOIN categories c ON c.id=p.category_id
        WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
      ...params, q.limit, (q.page - 1) * q.limit);
    return { items, total, page: q.page, pages: Math.ceil(total / q.limit) };
  });

  app.get("/api/admin/products/:id", async (req) => {
    const p = get("SELECT * FROM products WHERE id=? AND tenant_id=?", Number(req.params.id), req.tenant.id);
    if (!p) throw notFound("Товар не найден");
    return {
      ...p,
      badges: json(p.badges, []), sections: json(p.sections, []),
      spec_tables: json(p.spec_tables, []), tasks: json(p.tasks, []), calc: json(p.calc, null),
      variants: all(`SELECT v.*, s.qty AS stock,
                            (SELECT amount FROM prices WHERE variant_id=v.id AND tier='retail' AND min_qty=1) AS price_retail,
                            (SELECT amount FROM prices WHERE variant_id=v.id AND tier='dealer' AND min_qty=1) AS price_dealer
                       FROM variants v LEFT JOIN stock s ON s.variant_id=v.id
                      WHERE v.product_id=? ORDER BY v.position, v.id`, p.id),
      media: all("SELECT * FROM media WHERE product_id=? ORDER BY position", p.id),
    };
  });

  const productSchema = z.object({
    name: z.string().min(2).max(300),
    slug: z.string().max(120).optional(),
    categoryId: z.number().int().nullable().optional(),
    sku: z.string().max(60).optional().nullable(),
    shortName: z.string().max(120).optional().nullable(),
    summary: z.string().max(4000).optional().nullable(),
    gost: z.string().max(120).optional().nullable(),
    status: z.enum(["draft", "published", "archived"]).default("published"),
    badges: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    sections: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
    tables: z.array(z.object({ title: z.string(), rows: z.array(z.array(z.string())) })).default([]),
    tasks: z.array(z.string()).default([]),
    calc: z.object({ type: z.string(), ratePerM2: z.number(), pack: z.number(), packUnit: z.string().optional() }).nullable().optional(),
    seoTitle: z.string().max(200).optional().nullable(),
    seoDescription: z.string().max(400).optional().nullable(),
  });

  const toRow = (b, tenantId) => ({
    tenant_id: tenantId, name: b.name, slug: b.slug || slugify(b.name),
    category_id: b.categoryId ?? null, sku: b.sku ?? null, short_name: b.shortName ?? null,
    summary: b.summary ?? null, gost: b.gost ?? null, status: b.status,
    badges: b.badges, sections: b.sections, spec_tables: b.tables, tasks: b.tasks,
    calc: b.calc ? JSON.stringify(b.calc) : null,
    seo_title: b.seoTitle ?? null, seo_description: b.seoDescription ?? null,
  });

  app.post("/api/admin/products", async (req, reply) => {
    const body = productSchema.parse(req.body);
    const id = insert("products", toRow(body, req.tenant.id));
    reindexProduct(get("SELECT * FROM products WHERE id=?", id));
    audit(req, "product.create", "product", id, { name: body.name });
    reply.code(201);
    return { id };
  });

  app.put("/api/admin/products/:id", async (req) => {
    const id = Number(req.params.id);
    const before = get("SELECT * FROM products WHERE id=? AND tenant_id=?", id, req.tenant.id);
    if (!before) throw notFound("Товар не найден");
    const body = productSchema.parse(req.body);
    const row = toRow(body, req.tenant.id);
    delete row.tenant_id;
    update("products", id, row);
    reindexProduct(get("SELECT * FROM products WHERE id=?", id));
    audit(req, "product.update", "product", id, { name: body.name, status: body.status });
    return { ok: true };
  });

  app.delete("/api/admin/products/:id", { onRequest: [app.requireAuth("admin")] }, async (req) => {
    const id = Number(req.params.id);
    // Товар не удаляем, а архивируем: на него могут ссылаться прошлые заказы.
    run("UPDATE products SET status='archived' WHERE id=? AND tenant_id=?", id, req.tenant.id);
    audit(req, "product.archive", "product", id);
    return { ok: true };
  });

  // ── Фасовки, цены, остатки ───────────────────────────────────────────────
  app.post("/api/admin/products/:id/variants", async (req) => {
    const productId = Number(req.params.id);
    const b = z.object({
      unit: z.string().min(1).max(80), sku: z.string().max(60).optional(),
      packSize: z.number().optional(), packUnit: z.string().max(10).optional(),
      perPallet: z.number().int().optional(), isDefault: z.boolean().default(false),
    }).parse(req.body);
    const id = insert("variants", {
      tenant_id: req.tenant.id, product_id: productId, unit: b.unit, sku: b.sku ?? null,
      pack_size: b.packSize ?? null, pack_unit: b.packUnit ?? null, per_pallet: b.perPallet ?? null,
      is_default: b.isDefault,
    });
    audit(req, "variant.create", "variant", id);
    return { id };
  });

  app.put("/api/admin/variants/:id/price", async (req) => {
    const variantId = Number(req.params.id);
    const b = z.object({
      tier: z.enum(["retail", "dealer", "vip"]).default("retail"),
      // null = «цена по запросу». Ноль и пустая цена — разные вещи.
      amount: z.number().int().min(0).nullable(),
      minQty: z.number().int().min(1).default(1),
    }).parse(req.body);

    const existing = get("SELECT * FROM prices WHERE variant_id=? AND tier=? AND min_qty=?", variantId, b.tier, b.minQty);
    if (existing) run("UPDATE prices SET amount=?, updated_at=datetime('now') WHERE id=?", b.amount, existing.id);
    else insert("prices", { tenant_id: req.tenant.id, variant_id: variantId, tier: b.tier, amount: b.amount, min_qty: b.minQty });
    audit(req, "price.set", "variant", variantId, { tier: b.tier, amount: b.amount, was: existing?.amount ?? null });
    return { ok: true };
  });

  app.put("/api/admin/variants/:id/stock", async (req) => {
    const variantId = Number(req.params.id);
    const { qty } = z.object({ qty: z.number().int().min(0) }).parse(req.body);
    const existing = get("SELECT variant_id FROM stock WHERE variant_id=?", variantId);
    if (existing) run("UPDATE stock SET qty=?, updated_at=datetime('now') WHERE variant_id=?", qty, variantId);
    else insert("stock", { variant_id: variantId, tenant_id: req.tenant.id, qty });
    audit(req, "stock.set", "variant", variantId, { qty });
    return { ok: true };
  });

  // Массовая правка прайса: менеджеру нужно поднять цены на группу товаров
  // одним действием, а не тыкать в каждую фасовку.
  app.post("/api/admin/prices/bulk", { onRequest: [app.requireAuth("admin")] }, async (req) => {
    const b = z.object({
      categoryId: z.number().int().nullable().optional(),
      tier: z.enum(["retail", "dealer", "vip"]).default("retail"),
      percent: z.number().min(-90).max(300),
    }).parse(req.body);

    const variants = all(
      `SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id
        WHERE v.tenant_id=? ${b.categoryId ? "AND p.category_id=?" : ""}`,
      ...[req.tenant.id, ...(b.categoryId ? [b.categoryId] : [])]);

    let changed = 0;
    tx(() => {
      for (const v of variants) {
        const price = get("SELECT * FROM prices WHERE variant_id=? AND tier=? AND min_qty=1", v.id, b.tier);
        if (!price || price.amount === null) continue;
        run("UPDATE prices SET amount=?, updated_at=datetime('now') WHERE id=?",
          Math.round(price.amount * (1 + b.percent / 100)), price.id);
        changed++;
      }
    });
    audit(req, "price.bulk", "category", b.categoryId ?? "all", { percent: b.percent, changed });
    return { changed };
  });

  // ── Заказы ───────────────────────────────────────────────────────────────
  app.get("/api/admin/orders", async (req) => {
    const q = z.object({
      status: z.string().optional(), search: z.string().max(80).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().max(100).default(30),
    }).parse(req.query);
    const where = ["tenant_id=?"];
    const params = [req.tenant.id];
    if (q.status && ORDER_STATUSES.includes(q.status)) { where.push("status=?"); params.push(q.status); }
    if (q.search) { where.push("(number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)"); params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`); }
    const total = get(`SELECT COUNT(*) AS n FROM orders WHERE ${where.join(" AND ")}`, ...params).n;
    const items = all(
      `SELECT id, number, status, payment_status, customer_name, customer_phone, total, created_at, delivery_type
         FROM orders WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, q.limit, (q.page - 1) * q.limit);
    return { items, total, page: q.page, pages: Math.ceil(total / q.limit) };
  });

  app.get("/api/admin/orders/:id", async (req) => orderView(req.tenant.id, Number(req.params.id)));

  app.patch("/api/admin/orders/:id", async (req) => {
    const b = z.object({
      status: z.enum(ORDER_STATUSES).optional(),
      managerNote: z.string().max(2000).optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    if (b.managerNote !== undefined) run("UPDATE orders SET manager_note=? WHERE id=? AND tenant_id=?", b.managerNote, id, req.tenant.id);
    if (b.status) {
      audit(req, "order.status", "order", id, { status: b.status });
      return setStatus(req.tenant.id, id, b.status, req.user.id, b.managerNote);
    }
    return orderView(req.tenant.id, id);
  });

  // ── Заявки ───────────────────────────────────────────────────────────────
  app.get("/api/admin/leads", async (req) => ({
    items: all(`SELECT * FROM leads WHERE tenant_id=? ORDER BY id DESC LIMIT 200`, req.tenant.id)
      .map((l) => ({ ...l, payload: json(l.payload, {}) })),
  }));

  app.patch("/api/admin/leads/:id", async (req) => {
    const { status } = z.object({ status: z.enum(["new", "in_work", "done", "spam"]) }).parse(req.body);
    run("UPDATE leads SET status=?, manager_id=? WHERE id=? AND tenant_id=?", status, req.user.id, Number(req.params.id), req.tenant.id);
    return { ok: true };
  });

  // ── Пользователи ─────────────────────────────────────────────────────────
  app.get("/api/admin/users", { onRequest: [app.requireAuth("admin")] }, async (req) => ({
    items: all(`SELECT id, name, email, phone, company, role, price_tier, status, last_login_at, created_at
                  FROM users WHERE tenant_id=? ORDER BY id DESC LIMIT 300`, req.tenant.id),
  }));

  app.patch("/api/admin/users/:id", { onRequest: [app.requireAuth("admin")] }, async (req) => {
    const b = z.object({
      role: z.enum(["customer", "dealer", "manager", "admin"]).optional(),
      priceTier: z.enum(["retail", "dealer", "vip"]).optional(),
      status: z.enum(["active", "pending", "blocked"]).optional(),
      password: z.string().min(8).max(200).optional(),
    }).parse(req.body);
    const id = Number(req.params.id);
    const target = get("SELECT * FROM users WHERE id=? AND tenant_id=?", id, req.tenant.id);
    if (!target) throw notFound("Пользователь не найден");
    // Владельца тенанта менеджер и админ трогать не могут.
    if (target.role === "owner" && req.user.role !== "owner") throw badRequest("Нельзя изменять владельца");

    const patch = {};
    if (b.role) patch.role = b.role;
    if (b.priceTier) patch.price_tier = b.priceTier;
    if (b.status) patch.status = b.status;
    if (b.password) patch.password_hash = hashPassword(b.password);
    update("users", id, patch);
    audit(req, "user.update", "user", id, { ...patch, password_hash: b.password ? "changed" : undefined });
    return { ok: true };
  });

  // ── Настройки тенанта ────────────────────────────────────────────────────
  app.get("/api/admin/settings", async (req) => ({
    tenant: { ...req.tenant, theme: json(req.tenant.theme, {}), settings: json(req.tenant.settings, {}) },
  }));

  app.put("/api/admin/settings", { onRequest: [app.requireAuth("admin")] }, async (req) => {
    const b = z.object({
      name: z.string().max(200).optional(), phone: z.string().max(40).optional(),
      email: z.string().max(120).optional(), address: z.string().max(300).optional(),
      legalName: z.string().max(300).optional(), inn: z.string().max(12).optional(),
      theme: z.record(z.any()).optional(), settings: z.record(z.any()).optional(),
    }).parse(req.body);
    const patch = {};
    for (const [k, v] of Object.entries({
      name: b.name, phone: b.phone, email: b.email, address: b.address,
      legal_name: b.legalName, inn: b.inn,
      theme: b.theme ? JSON.stringify(b.theme) : undefined,
      settings: b.settings ? JSON.stringify(b.settings) : undefined,
    })) if (v !== undefined) patch[k] = v;
    update("tenants", req.tenant.id, patch);
    audit(req, "settings.update", "tenant", req.tenant.id, patch);
    return { ok: true };
  });

  // ── Загрузка файлов ──────────────────────────────────────────────────────
  app.post("/api/admin/media", async (req) => {
    const data = await req.file();
    if (!data) throw badRequest("Файл не передан");
    const ext = (extname(data.filename) || ".bin").toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(ext)) throw badRequest("Допустимы jpg, png, webp, pdf");

    const dir = resolve(config.uploads.dir, String(req.tenant.id));
    mkdirSync(dir, { recursive: true });
    const name = `${randomUUID()}${ext}`;
    await pipeline(data.file, createWriteStream(resolve(dir, name)));
    if (data.file.truncated) throw badRequest("Файл больше допустимого размера");

    const url = `/uploads/${req.tenant.id}/${name}`;
    const productId = data.fields?.productId?.value ? Number(data.fields.productId.value) : null;
    const id = insert("media", {
      tenant_id: req.tenant.id, product_id: productId,
      kind: ext === ".pdf" ? "doc" : "photo", url, mime: data.mimetype,
      title: data.fields?.title?.value ?? data.filename,
    });
    audit(req, "media.upload", "media", id, { url });
    return { id, url };
  });

  // ── Журнал изменений ─────────────────────────────────────────────────────
  app.get("/api/admin/audit", { onRequest: [app.requireAuth("admin")] }, async (req) => ({
    items: all(`SELECT a.*, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
                 WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 200`, req.tenant.id)
      .map((a) => ({ ...a, diff: json(a.diff, {}) })),
  }));

  // ── Экспорт прайса: менеджеры живут в Excel, отдавать данные надо туда ───
  app.get("/api/admin/export/prices.csv", async (req, reply) => {
    const rows = all(
      `SELECT p.name, c.name AS category, v.unit, v.sku,
              (SELECT amount FROM prices WHERE variant_id=v.id AND tier='retail' AND min_qty=1) AS retail,
              (SELECT amount FROM prices WHERE variant_id=v.id AND tier='dealer' AND min_qty=1) AS dealer,
              (SELECT qty FROM stock WHERE variant_id=v.id) AS stock
         FROM variants v JOIN products p ON p.id=v.product_id
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE v.tenant_id=? ORDER BY c.position, p.name`, req.tenant.id);

    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["Категория;Товар;Фасовка;Артикул;Розница;Дилер;Остаток"]
      .concat(rows.map((r) => [r.category, r.name, r.unit, r.sku,
        r.retail === null ? "по запросу" : (r.retail / 100).toFixed(2),
        r.dealer === null ? "" : (r.dealer / 100).toFixed(2), r.stock ?? ""].map(esc).join(";")))
      .join("\r\n");

    reply.header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="prices-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM — иначе Excel на Windows покажет кириллицу кракозябрами.
    return "﻿" + csv;
  });
}
