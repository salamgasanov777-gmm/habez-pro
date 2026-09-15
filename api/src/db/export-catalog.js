// Выгрузка каталога для переноса на другой сервер. Только товарные данные:
// компания (реквизиты и настройки витрины), разделы, товары, фасовки, цены,
// фото/документы, остатки. Пользователи, сессии, заказы, заявки, платежи,
// журнал — НИКОГДА: они либо персональные, либо принадлежат тому серверу,
// где возникли. Демо-признаки настроек тоже не едут.
//
//   node src/db/export-catalog.js /tmp/catalog-export.json
//
// Файл дальше импортируется на сервере: node src/db/import-catalog.js файл.json
import { writeFileSync } from "node:fs";
import { all, get, json, db } from "./index.js";
import { config } from "../config.js";

const out = process.argv[2];
if (!out) { console.error("Куда писать: node src/db/export-catalog.js /tmp/catalog-export.json"); process.exit(1); }

const tenant = get("SELECT * FROM tenants WHERE slug=?", config.tenant.defaultSlug);
if (!tenant) { console.error("Тенант не найден"); process.exit(1); }
const t = tenant.id;

// Настройки — без демо-признаков и без всего, что задаётся на месте.
const settings = json(tenant.settings, {});
for (const k of ["demoPrices"]) delete settings[k];

const payload = {
  format: "hgz-catalog/1",
  exportedAt: new Date().toISOString(),
  tenant: {
    slug: tenant.slug, name: tenant.name, legal_name: tenant.legal_name, inn: tenant.inn,
    phone: tenant.phone, email: tenant.email, address: tenant.address, logo_url: tenant.logo_url,
    theme: json(tenant.theme, {}), settings,
  },
  categories: all("SELECT slug, name, description, icon, position, is_active FROM categories WHERE tenant_id=? ORDER BY position, id", t),
  products: all(`SELECT p.slug, p.sku, p.name, p.short_name, p.summary, p.gost, p.brand, p.status, p.badges, p.sections,
                        p.spec_tables, p.tasks, p.calc, p.attributes, p.seo_title, p.seo_description, p.position, p.created_at,
                        c.slug AS category_slug
                   FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.tenant_id=? ORDER BY p.position, p.id`, t)
    .map((p) => ({
      ...p, badges: json(p.badges, []), sections: json(p.sections, []), spec_tables: json(p.spec_tables, []),
      tasks: json(p.tasks, []), calc: json(p.calc, null), attributes: json(p.attributes, {}),
      variants: all("SELECT id, sku, unit, pack_size, pack_unit, weight_kg, per_pallet, barcode, is_default, is_active, position FROM variants WHERE tenant_id=? AND product_id=(SELECT id FROM products WHERE tenant_id=? AND slug=?) ORDER BY position, id", t, t, p.slug)
        .map((v) => ({
          ...v, id: undefined,
          prices: all("SELECT tier, amount, currency, min_qty, valid_from, valid_to FROM prices WHERE variant_id=? ORDER BY tier, min_qty", v.id),
          stock: get("SELECT qty, warehouse FROM stock WHERE variant_id=?", v.id) || null,
        })),
      media: all("SELECT kind, url, url_webp, title, mime, bytes, position FROM media WHERE tenant_id=? AND product_id=(SELECT id FROM products WHERE tenant_id=? AND slug=?) ORDER BY position, id", t, t, p.slug),
    })),
};

// Страховка: в файле не должно быть ничего, кроме перечисленного.
for (const key of Object.keys(payload)) {
  if (!["format", "exportedAt", "tenant", "categories", "products"].includes(key)) throw new Error(`лишний раздел в выгрузке: ${key}`);
}

writeFileSync(out, JSON.stringify(payload, null, 1));
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
console.log(`[export-catalog] ${payload.products.length} товаров, ${payload.categories.length} разделов → ${out} (${kb} КБ). Пользователей, заказов и заявок в файле нет.`);
db.close();
