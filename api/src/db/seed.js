// Перенос каталога из products.json в базу. Данные заводские, поэтому
// переносятся как есть: описания, ГОСТы, 109 таблиц характеристик, расчёты.
// Цены не проставляются — их у нас нет, и придумывать их нельзя. Для показа
// коммерческой части есть отдельный флаг --demo-prices, он помечает цены демо.
import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { db, get, insert, run, tx } from "./index.js";
import { hashPassword } from "../lib/crypto.js";
import { reindexProduct } from "../services/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const legacy = JSON.parse(readFileSync(resolve(here, "legacy-products.json"), "utf8"));
const withDemoPrices = process.argv.includes("--demo-prices");

const translit = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"i",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"c",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const slugify = (s) => String(s).toLowerCase().replace(/[а-яё]/g, (c) => translit[c] ?? "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

// Подбор по задаче в старом каталоге вычислялся на лету из таблицы «Область
// применения». Считаем один раз здесь и кладём в поле — фильтр становится
// обычным условием в SQL вместо перебора всех товаров на клиенте.
const TASK_RULES = [
  { key: "wet", needles: ["повышенным уровнем влажности"] },
  { key: "dry", needles: ["нормальным уровнем влажности"] },
  { key: "facade", needles: ["асад"] },
  { key: "floor-heat", needles: ["теплых полов"] },
  { key: "plinth", needles: ["Сложные поверхности", "Цоколь"] },
];

function tasksFor(p) {
  if (Array.isArray(p.tasks) && p.tasks.length) return p.tasks;
  const table = (p.tables || []).find((t) => t.title === "Область применения");
  if (!table) return [];
  return TASK_RULES.filter((rule) =>
    table.rows.some(([label, value]) => value === "ДА" && rule.needles.some((n) => label.includes(n)))
  ).map((r) => r.key);
}

const shortName = (name) => name.match(/«([^»]+)»/)?.[1] || name.split(" ").slice(-1)[0];
const packOf = (unit) => {
  const m = String(unit).match(/([\d.,]+)\s*(кг|л|г)/i);
  return m ? { size: parseFloat(m[1].replace(",", ".")), unit: m[2].toLowerCase() } : { size: null, unit: null };
};

tx(() => {
  // ── Тенант ────────────────────────────────────────────────────────────────
  let tenant = get("SELECT * FROM tenants WHERE slug='habez'");
  if (!tenant) {
    const id = insert("tenants", {
      slug: "habez",
      name: "Хабезский гипсовый завод",
      legal_name: 'ООО «Хабезский гипсовый завод»',
      phone: "+7 (878) 000-00-00",
      email: "info@habez.example",
      address: "Карачаево-Черкесская Республика, а. Хабез",
      logo_url: null,
      theme: JSON.stringify({ accent: "#2c4f78", accentWarm: "#c9762b", radius: 18 }),
      settings: JSON.stringify({
        currency: "RUB", showPrices: true, minOrder: 0, deliveryCost: 150000,
        checkoutMode: "order", orderPrefix: "ХГЗ",
        demoPrices: withDemoPrices,
      }),
    });
    tenant = get("SELECT * FROM tenants WHERE id=?", id);
    console.log("[seed] создан тенант habez");
  }

  // ── Учётные записи ────────────────────────────────────────────────────────
  const users = [
    { email: "admin@habez.local", name: "Администратор", role: "owner", password: "admin12345" },
    { email: "manager@habez.local", name: "Менеджер отдела продаж", role: "manager", password: "manager12345" },
    { email: "dealer@habez.local", name: "Дилер «СтройБаза»", role: "dealer", price_tier: "dealer", company: "ООО СтройБаза", password: "dealer12345" },
  ];
  for (const u of users) {
    if (get("SELECT id FROM users WHERE tenant_id=? AND email=?", tenant.id, u.email)) continue;
    insert("users", {
      tenant_id: tenant.id, email: u.email, name: u.name, role: u.role,
      company: u.company ?? null, price_tier: u.price_tier ?? "retail",
      password_hash: hashPassword(u.password), email_verified: 1,
    });
  }

  // ── Категории ─────────────────────────────────────────────────────────────
  const catOrder = ["Гипсовая штукатурка", "Цементные и цементно-известковые штукатурки", "Шпаклевка",
    "Клеи", "Грунтовки", "Полы", "Монтажные смеси", "Гидроизоляция", "Краски"];
  const catIds = new Map();
  for (const [i, name] of catOrder.entries()) {
    const slug = slugify(name);
    let row = get("SELECT * FROM categories WHERE tenant_id=? AND slug=?", tenant.id, slug);
    if (!row) {
      const id = insert("categories", { tenant_id: tenant.id, slug, name, position: i });
      row = get("SELECT * FROM categories WHERE id=?", id);
    }
    catIds.set(name, row.id);
  }

  // ── Товары ────────────────────────────────────────────────────────────────
  let created = 0;
  for (const [i, p] of legacy.entries()) {
    const slug = p.photo ? basename(p.photo).replace(/\.\w+$/, "") : slugify(p.name);
    if (get("SELECT id FROM products WHERE tenant_id=? AND slug=?", tenant.id, slug)) continue;

    const productId = insert("products", {
      tenant_id: tenant.id,
      category_id: catIds.get(p.category) ?? null,
      slug,
      name: p.name,
      short_name: shortName(p.name),
      summary: p.summary ?? null,
      gost: p.gost || null,
      status: "published",
      badges: p.badges ?? [],
      sections: p.sections ?? [],
      spec_tables: p.tables ?? [],
      tasks: tasksFor(p),
      calc: p.calc ? JSON.stringify(p.calc) : null,
      seo_title: `${p.name} — купить у производителя`,
      seo_description: (p.summary || p.name).slice(0, 300),
      position: i,
    });

    const pack = packOf(p.unit);
    const variantId = insert("variants", {
      tenant_id: tenant.id, product_id: productId, unit: p.unit || "шт",
      pack_size: pack.size, pack_unit: pack.unit,
      per_pallet: pack.unit === "кг" && pack.size >= 25 ? 40 : null,
      is_default: 1, sku: `HGZ-${String(productId).padStart(3, "0")}`,
    });

    // Цена по умолчанию — «по запросу» (amount NULL). Так карточка честно
    // говорит «уточните у менеджера» вместо выдуманной цифры.
    insert("prices", { tenant_id: tenant.id, variant_id: variantId, tier: "retail", amount: null });

    if (withDemoPrices && pack.size) {
      const perKg = { "Гипсовая штукатурка": 1400, "Шпаклевка": 2600, "Клеи": 1900,
        "Цементные и цементно-известковые штукатурки": 1200, "Полы": 1500, "Монтажные смеси": 1700 }[p.category] || 9000;
      const retail = Math.round((pack.size * perKg) / 100) * 100;
      run("UPDATE prices SET amount=? WHERE variant_id=? AND tier='retail'", retail, variantId);
      insert("prices", { tenant_id: tenant.id, variant_id: variantId, tier: "dealer", amount: Math.round(retail * 0.82 / 100) * 100 });
      insert("prices", { tenant_id: tenant.id, variant_id: variantId, tier: "retail", amount: Math.round(retail * 0.93 / 100) * 100, min_qty: 40 });
      insert("stock", { variant_id: variantId, tenant_id: tenant.id, qty: 40 + ((productId * 37) % 900) });
    }

    if (p.photo) {
      insert("media", {
        tenant_id: tenant.id, product_id: productId, kind: "photo",
        url: `/${p.photo}`, url_webp: `/${p.photo.replace(/\.jpg$/i, ".webp")}`, position: 0,
      });
    }

    reindexProduct(get("SELECT * FROM products WHERE id=?", productId));
    created++;
  }

  if (withDemoPrices && !get("SELECT id FROM promo_codes WHERE tenant_id=?", tenant.id)) {
    insert("promo_codes", { tenant_id: tenant.id, code: "СТРОЙКА5", kind: "percent", value: 5, min_total: 500000 });
  }

  console.log(`[seed] товаров добавлено: ${created}, всего в базе: ${get("SELECT COUNT(*) AS n FROM products").n}`);
});

console.log(`[seed] готово. Вход: admin@habez.local / admin12345${withDemoPrices ? "  ·  демо-цены проставлены" : "  ·  цены «по запросу» (реальных цен нет)"}`);
db.close();
