// Импорт каталога из файла, снятого export-catalog.js. Единственный
// разрешённый способ перенести товары на боевой сервер: демо-база
// целиком туда не копируется никогда.
//
//   node src/db/import-catalog.js /tmp/catalog-export.json            применить
//   node src/db/import-catalog.js /tmp/catalog-export.json --dry-run  только показать, что изменится
//
// Что делает: обновляет карточку компании (реквизиты, настройки витрины),
// создаёт/обновляет разделы, товары (по slug), фасовки (по unit внутри
// товара), цены, остатки, фото. Что не трогает никогда: users, sessions,
// orders, payments, leads, audit_log, push_subscriptions — их в файле нет,
// а если бы были, импорт отказался бы работать.
import { readFileSync } from "node:fs";
import { all, get, insert, run, tx, db } from "./index.js";
import { config } from "../config.js";
import { reindexProduct } from "../services/catalog.js";

const [file, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!file) { console.error("Файл выгрузки: node src/db/import-catalog.js /tmp/catalog-export.json [--dry-run]"); process.exit(1); }

const data = JSON.parse(readFileSync(file, "utf8"));
if (data.format !== "hgz-catalog/1") { console.error(`Неизвестный формат файла: ${data.format}`); process.exit(1); }

// Файл с чем-то кроме каталога — не импортируем вообще.
const FORBIDDEN = ["users", "sessions", "orders", "order_items", "payments", "leads", "audit_log", "push_subscriptions", "otp_codes", "carts"];
const extra = Object.keys(data).filter((k) => !["format", "exportedAt", "tenant", "categories", "products"].includes(k));
if (extra.length) { console.error(`В файле лишние разделы (${extra.join(", ")}) — это не выгрузка каталога. Отказ.`); process.exit(1); }
if (FORBIDDEN.some((k) => k in data)) { console.error("В файле есть пользователи или заказы — отказ."); process.exit(1); }
if (data.tenant?.settings?.demoPrices) { console.error("В настройках выгрузки demoPrices — отказ: демо-цены на боевой сервер не переносятся."); process.exit(1); }

const tenant = get("SELECT * FROM tenants WHERE slug=?", config.tenant.defaultSlug);
if (!tenant) { console.error("Тенант не найден — сначала npm run migrate && npm run seed"); process.exit(1); }
const t = tenant.id;
const norm = (v) => (v && typeof v === "object" ? JSON.stringify(v) : v ?? null);

const stat = { categories: { new: 0, updated: 0 }, products: { new: 0, updated: 0 }, variants: { new: 0, updated: 0 }, prices: 0, stock: 0, media: 0 };

function apply() {
  // Компания: реквизиты и настройки — поверх текущих, но без демо-признаков
  // и без полей, которые задаются на сервере (host).
  const cur = JSON.parse(tenant.settings || "{}");
  const settings = { ...cur, ...(data.tenant.settings || {}) };
  delete settings.demoPrices;
  run(`UPDATE tenants SET name=?, legal_name=?, inn=?, phone=?, email=?, address=?, logo_url=?, theme=?, settings=? WHERE id=?`,
    data.tenant.name ?? tenant.name, data.tenant.legal_name ?? tenant.legal_name, data.tenant.inn ?? tenant.inn,
    data.tenant.phone ?? tenant.phone, data.tenant.email ?? tenant.email, data.tenant.address ?? tenant.address,
    data.tenant.logo_url ?? tenant.logo_url, JSON.stringify(data.tenant.theme || JSON.parse(tenant.theme || "{}")), JSON.stringify(settings), t);

  const catId = {};
  for (const c of data.categories || []) {
    const ex = get("SELECT id FROM categories WHERE tenant_id=? AND slug=?", t, c.slug);
    if (ex) {
      run("UPDATE categories SET name=?, description=?, icon=?, position=?, is_active=? WHERE id=?", c.name, c.description ?? null, c.icon ?? null, c.position ?? 0, c.is_active ?? 1, ex.id);
      catId[c.slug] = ex.id; stat.categories.updated++;
    } else {
      catId[c.slug] = insert("categories", { tenant_id: t, slug: c.slug, name: c.name, description: c.description ?? null, icon: c.icon ?? null, position: c.position ?? 0, is_active: c.is_active ?? 1 });
      stat.categories.new++;
    }
  }

  for (const p of data.products || []) {
    const row = {
      category_id: p.category_slug ? (catId[p.category_slug] ?? get("SELECT id FROM categories WHERE tenant_id=? AND slug=?", t, p.category_slug)?.id ?? null) : null,
      sku: p.sku ?? null, name: p.name, short_name: p.short_name ?? null, summary: p.summary ?? null, gost: p.gost ?? null,
      brand: p.brand ?? null, status: p.status || "published", badges: norm(p.badges || []), sections: norm(p.sections || []),
      spec_tables: norm(p.spec_tables || []), tasks: norm(p.tasks || []), calc: p.calc ? JSON.stringify(p.calc) : null,
      attributes: norm(p.attributes || {}), seo_title: p.seo_title ?? null, seo_description: p.seo_description ?? null, position: p.position ?? 0,
    };
    let productId = get("SELECT id FROM products WHERE tenant_id=? AND slug=?", t, p.slug)?.id;
    if (productId) {
      run(`UPDATE products SET ${Object.keys(row).map((k) => `${k}=?`).join(",")} WHERE id=?`, ...Object.values(row), productId);
      stat.products.updated++;
    } else {
      productId = insert("products", { tenant_id: t, slug: p.slug, ...row, created_at: p.created_at || new Date().toISOString().slice(0, 19).replace("T", " ") });
      stat.products.new++;
    }

    for (const v of p.variants || []) {
      let variantId = get("SELECT id FROM variants WHERE tenant_id=? AND product_id=? AND unit=?", t, productId, v.unit)?.id;
      const vrow = { sku: v.sku ?? null, pack_size: v.pack_size ?? null, pack_unit: v.pack_unit ?? null, weight_kg: v.weight_kg ?? null, per_pallet: v.per_pallet ?? null, barcode: v.barcode ?? null, is_default: v.is_default ?? 0, is_active: v.is_active ?? 1, position: v.position ?? 0 };
      if (variantId) { run(`UPDATE variants SET ${Object.keys(vrow).map((k) => `${k}=?`).join(",")} WHERE id=?`, ...Object.values(vrow), variantId); stat.variants.updated++; }
      else { variantId = insert("variants", { tenant_id: t, product_id: productId, unit: v.unit, ...vrow }); stat.variants.new++; }

      for (const pr of v.prices || []) {
        const ex = get("SELECT id FROM prices WHERE variant_id=? AND tier=? AND min_qty=?", variantId, pr.tier, pr.min_qty ?? 1);
        if (ex) run("UPDATE prices SET amount=?, currency=?, valid_from=?, valid_to=?, updated_at=datetime('now') WHERE id=?", pr.amount ?? null, pr.currency || "RUB", pr.valid_from ?? null, pr.valid_to ?? null, ex.id);
        else insert("prices", { tenant_id: t, variant_id: variantId, tier: pr.tier, amount: pr.amount ?? null, currency: pr.currency || "RUB", min_qty: pr.min_qty ?? 1, valid_from: pr.valid_from ?? null, valid_to: pr.valid_to ?? null });
        stat.prices++;
      }
      if (v.stock) {
        if (get("SELECT variant_id FROM stock WHERE variant_id=?", variantId)) run("UPDATE stock SET qty=?, warehouse=?, updated_at=datetime('now') WHERE variant_id=?", v.stock.qty ?? 0, v.stock.warehouse || "main", variantId);
        else insert("stock", { variant_id: variantId, tenant_id: t, qty: v.stock.qty ?? 0, warehouse: v.stock.warehouse || "main" });
        stat.stock++;
      }
    }

    // Фото и документы: заменяем набор целиком — это справочник карточки, не история.
    run("DELETE FROM media WHERE tenant_id=? AND product_id=?", t, productId);
    for (const m of p.media || []) {
      insert("media", { tenant_id: t, product_id: productId, kind: m.kind || "photo", url: m.url, url_webp: m.url_webp ?? null, title: m.title ?? null, mime: m.mime ?? null, bytes: m.bytes ?? null, position: m.position ?? 0 });
      stat.media++;
    }
    reindexProduct(get("SELECT * FROM products WHERE id=?", productId));
  }
}

if (dryRun) {
  // Прогон в транзакции с откатом: считаем, что изменилось бы, ничего не сохраняя.
  try { tx(() => { apply(); throw new Error("__dry_run__"); }); } catch (e) { if (e.message !== "__dry_run__") throw e; }
  console.log("[import-catalog] --dry-run, ничего не записано. Было бы:", JSON.stringify(stat));
} else {
  tx(apply);
  console.log("[import-catalog] готово:", JSON.stringify(stat));
}

const users = get("SELECT COUNT(*) AS n FROM users").n;
console.log(`[import-catalog] товаров в базе: ${get("SELECT COUNT(*) AS n FROM products").n}, пользователей: ${users} (импорт их не создаёт)`);
db.close();
