// Выгрузка каталога в один статический файл. Нужна для автономной сборки:
// сайт на GitHub Pages сервера не имеет, а каталог, поиск, расчёт расхода
// и сравнение должны работать. Данные те же самые, из той же базы.
//
//   node src/db/export-static.js                 без цен («по запросу»)
//   node src/db/export-static.js --with-prices   с ценами, что лежат в базе
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { all, get, json } from "./index.js";
import { decorate } from "../services/catalog.js";
import { TASKS } from "../routes/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../web/public/data/catalog.json");
const withPrices = process.argv.includes("--with-prices");
const slug = process.argv.find((a) => a.startsWith("--tenant="))?.split("=")[1] || "habez";

const tenant = get("SELECT * FROM tenants WHERE slug=?", slug);
if (!tenant) {
  console.error(`[export] компания «${slug}» не найдена`);
  process.exit(1);
}

const rows = all(
  `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.tenant_id=? AND p.status='published'
    ORDER BY p.position, p.name`, tenant.id);

const products = decorate(tenant.id, rows, null, { full: true }).map((p) => {
  if (withPrices) return p;
  // Без явного разрешения цены и остатки не выгружаются. Выдуманная цена
  // или «в наличии 77 шт» на публичном сайте завода — это дезинформация
  // покупателя, а не «демонстрация». Нет данных — нет и подписи.
  return {
    ...p,
    priceFrom: null,
    inStock: false,
    variants: p.variants.map((v) => ({
      ...v, price: null, priceOnRequest: true, priceBreaks: [], stock: null,
    })),
  };
});

const categories = all(
  `SELECT c.id, c.slug, c.name,
          (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.status='published') AS count
     FROM categories c WHERE c.tenant_id=? AND c.is_active=1 ORDER BY c.position, c.name`, tenant.id)
  .filter((c) => c.count > 0);

const settings = json(tenant.settings, {});

const payload = {
  generatedAt: new Date().toISOString(),
  hasPrices: withPrices,
  tenant: {
    slug: tenant.slug, name: tenant.name, phone: tenant.phone,
    email: tenant.email, address: tenant.address, logo: tenant.logo_url,
    theme: json(tenant.theme, {}),
  },
  settings: {
    currency: settings.currency || "RUB",
    // Автономная сборка без цен работает как витрина с заявкой:
    // покупатель собирает список, менеджер считает и отвечает.
    showPrices: withPrices && settings.showPrices !== false,
    minOrder: settings.minOrder || 0,
    deliveryCost: settings.deliveryCost ?? null,
    checkoutMode: withPrices ? (settings.checkoutMode || "order") : "quote",
    site: settings.site || null,
    // Номер для заявок ставится осознанно в настройках. Подставлять сюда
    // телефон из карточки компании нельзя: там может лежать заглушка,
    // и заявки уйдут в никуда.
    whatsapp: (settings.whatsapp || "").replace(/\D/g, ""),
  },
  categories,
  tasks: TASKS,
  products,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(payload));
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
console.log(`[export] ${products.length} товаров, ${categories.length} разделов → ${out} (${kb} КБ, цены: ${withPrices ? "есть" : "по запросу"})`);
