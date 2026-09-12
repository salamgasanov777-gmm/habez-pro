// Автономный режим: приложение работает без сервера.
//
// Зачем. Сайт на GitHub Pages — это просто файлы, там нельзя запустить базу.
// Но каталог, поиск, расчёт расхода, сравнение, избранное и сбор заявки
// серверу и не нужны: данные лежат в одном выгруженном файле, а корзина
// и заявки — в памяти браузера. Полная версия с заказами, оплатой и панелью
// включается сама, как только приложение открыто рядом с сервером.
//
// Модуль повторяет ответы настоящего API один в один, поэтому страницы
// не знают, в каком режиме работают, и код не раздваивается.
import { store } from "./storage.js";

let dataPromise = null;

function load() {
  dataPromise = dataPromise || fetch(`${import.meta.env.BASE_URL}data/catalog.json`).then((r) => r.json());
  return dataPromise;
}

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");

// Поиск по всей карточке: название, ГОСТ, краткое описание, разделы
// инструкции и таблицы характеристик — как в серверной версии.
function haystack(p) {
  if (!p._hay) {
    p._hay = norm([
      p.name, p.shortName, p.summary, p.gost, p.category,
      (p.sections || []).map((s) => `${s.title} ${s.text}`).join(" "),
      (p.tables || []).map((t) => `${t.title} ${t.rows.map((r) => r.join(" ")).join(" ")}`).join(" "),
    ].join(" "));
  }
  return p._hay;
}

const brief = ({ sections, tables, attributes, docs, gallery, _hay, ...rest }) => rest;

function parseQuery(path) {
  const [, query = ""] = path.split("?");
  return Object.fromEntries(new URLSearchParams(query));
}

// ── Корзина в памяти браузера ───────────────────────────────────────────────
const CART_KEY = "cart";
const readCart = () => store.get(CART_KEY, []);
const writeCart = (items) => store.set(CART_KEY, items);

function cartView(data) {
  const items = readCart().map((line, i) => {
    const product = data.products.find((p) => p.variants.some((v) => v.id === line.variantId));
    const variant = product?.variants.find((v) => v.id === line.variantId);
    if (!product || !variant) return null;
    return {
      id: line.variantId,
      variantId: line.variantId,
      productId: product.id,
      slug: product.slug,
      name: product.name,
      unit: variant.unit,
      photo: product.photo,
      qty: line.qty,
      price: variant.price,
      priceOnRequest: variant.priceOnRequest,
      total: variant.priceOnRequest ? null : variant.price * line.qty,
      weightKg: variant.packUnit === "кг" && variant.packSize ? variant.packSize * line.qty : null,
    };
  }).filter(Boolean);

  return {
    id: "local",
    items,
    count: items.reduce((s, i) => s + i.qty, 0),
    subtotal: items.reduce((s, i) => s + (i.total || 0), 0),
    hasOnRequest: items.some((i) => i.priceOnRequest),
    weightKg: items.reduce((s, i) => s + (i.weightKg || 0), 0),
  };
}

// ── Заявки ──────────────────────────────────────────────────────────────────
// Отправить их с сайта без сервера некуда, поэтому заявка сохраняется у
// покупателя и открывается готовым сообщением в WhatsApp менеджеру.
// Кто заказывает — в тексте заявки менеджеру это видно сразу.
const WHO = { person: "частное лицо", foreman: "прораб", shop: "магазин", company: "организация" };

function saveLead(body, data) {
  const leads = store.get("leads", []);
  const lead = { ...body, id: Date.now(), createdAt: new Date().toISOString() };
  store.set("leads", [lead, ...leads].slice(0, 50));

  const lines = [
    body.kind === "dealer" ? "Заявка на дилерство" : "Заявка с сайта",
    `${body.name}${WHO[body.who] ? ` (${WHO[body.who]})` : ""}, ${body.phone}`,
    body.company ? `Компания: ${body.company}` : "",
    body.message || "",
  ];
  if (body.withCart) {
    for (const i of cartView(data).items) lines.push(`• ${i.name} — ${i.qty} × ${i.unit}`);
  }
  if (body.productId) {
    const p = data.products.find((x) => x.id === body.productId);
    if (p) lines.push(`Товар: ${p.name}`);
  }
  const text = lines.filter(Boolean).join("\n");
  const phone = data.settings.whatsapp;
  // Номер менеджера ещё не задан — отдаём готовый текст, его можно
  // вставить в любой мессенджер. Молча терять заявку нельзя.
  return {
    id: lead.id,
    ok: true,
    text,
    whatsapp: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null,
  };
}

// ── Маршрутизация ───────────────────────────────────────────────────────────
export async function handleLocal(path, { method = "GET", body } = {}) {
  const data = await load();
  const url = path.split("?")[0];
  const q = parseQuery(path);

  if (url === "/api/catalog/meta") {
    return {
      tenant: data.tenant,
      settings: { ...data.settings, standalone: true },
      categories: data.categories,
      tasks: data.tasks,
      newArrivals: data.newArrivals || [],
      total: data.products.length,
    };
  }

  if (url === "/api/catalog/products") {
    let items = data.products;
    if (q.category) items = items.filter((p) => p.categorySlug === q.category);
    if (q.task) items = items.filter((p) => (p.tasks || []).includes(q.task));
    if (q.search) {
      const terms = norm(q.search).split(/\s+/).filter((t) => t.length > 1);
      items = items.filter((p) => terms.every((t) => haystack(p).includes(t)));
    }
    const sorted = [...items];
    if (q.sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    if (q.sort === "price_asc") sorted.sort((a, b) => (a.priceFrom ?? Infinity) - (b.priceFrom ?? Infinity));
    if (q.sort === "price_desc") sorted.sort((a, b) => (b.priceFrom ?? -Infinity) - (a.priceFrom ?? -Infinity));

    const limit = Number(q.limit || 48);
    const page = Number(q.page || 1);
    return {
      items: sorted.slice((page - 1) * limit, page * limit).map(brief),
      page, limit, total: sorted.length, pages: Math.ceil(sorted.length / limit),
    };
  }

  const one = url.match(/^\/api\/catalog\/products\/(.+)$/);
  if (one) {
    const key = decodeURIComponent(one[1]);
    const product = data.products.find((p) => p.slug === key || String(p.id) === key);
    if (!product) throw Object.assign(new Error("Товар не найден"), { status: 404 });
    const related = data.products
      .filter((p) => p.categorySlug === product.categorySlug && p.id !== product.id)
      .slice(0, 6).map(brief);
    return { product, related };
  }

  if (url === "/api/catalog/compare") {
    const ids = String(q.ids || "").split(",").map(Number).filter(Boolean);
    const products = data.products.filter((p) => ids.includes(p.id));
    const labels = new Map();
    for (const p of products) {
      for (const b of p.badges || []) labels.set(b.label, 1);
      for (const t of p.tables || []) for (const [l] of t.rows) labels.set(`${t.title} · ${l}`, 1);
    }
    const rows = [...labels.keys()].map((label) => ({
      label,
      values: products.map((p) => {
        const badge = (p.badges || []).find((b) => b.label === label);
        if (badge) return badge.value;
        const [title, l] = label.split(" · ");
        const table = (p.tables || []).find((t) => t.title === title);
        return table?.rows.find(([rl]) => rl === l)?.[1] ?? null;
      }),
    })).filter((r) => r.values.some((v) => v !== null));
    return {
      products: products.map((p) => ({ id: p.id, name: p.shortName || p.name, photo: p.photo, slug: p.slug })),
      rows,
    };
  }

  if (url === "/api/catalog/calc" && method === "POST") {
    const product = data.products.find((p) => p.id === body.productId);
    if (!product?.calc) throw Object.assign(new Error("Для этого товара расчёт не задан"), { status: 404 });
    const calc = product.calc;
    const totalRaw = calc.type === "thickness"
      ? calc.ratePerM2 * body.area * (body.thicknessMm ?? 10)
      : calc.ratePerM2 * body.area;
    const liquid = calc.type === "liquid";
    return {
      amount: liquid ? totalRaw / 1000 : totalRaw,
      unit: liquid ? (calc.packUnit === "г" ? "кг" : "л") : "кг",
      packs: Math.ceil(totalRaw / calc.pack),
      packSize: liquid ? calc.pack / 1000 : calc.pack,
      note: "Расчёт ориентировочный: расход зависит от основания и способа нанесения.",
    };
  }

  if (url === "/api/cart") {
    if (method === "DELETE") writeCart([]);
    return cartView(data);
  }

  if (url === "/api/cart/items" && method === "POST") {
    const items = readCart();
    const existing = items.find((i) => i.variantId === body.variantId);
    if (existing) existing.qty = Math.min(999, existing.qty + (body.qty || 1));
    else items.push({ variantId: body.variantId, qty: body.qty || 1 });
    writeCart(items);
    return cartView(data);
  }

  const item = url.match(/^\/api\/cart\/items\/(\d+)$/);
  if (item) {
    const variantId = Number(item[1]);
    let items = readCart();
    if (method === "DELETE" || body?.qty === 0) items = items.filter((i) => i.variantId !== variantId);
    else items = items.map((i) => (i.variantId === variantId ? { ...i, qty: body.qty } : i));
    writeCart(items);
    return cartView(data);
  }

  if (url === "/api/leads" && method === "POST") return saveLead(body, data);

  if (url === "/api/orders" && method === "POST") {
    // Без сервера заказ не примешь: платить некуда и менеджеру он не уйдёт.
    // Поэтому оформление собирает то же самое как заявку в WhatsApp.
    const res = saveLead({ ...body.customer, who: body.customer.kind, kind: "quote", withCart: true }, data);
    writeCart([]);
    return { ...res, standalone: true, number: null };
  }

  if (url.startsWith("/api/auth/")) {
    throw Object.assign(new Error("Личный кабинет работает в версии с сервером"), { status: 501 });
  }

  throw Object.assign(new Error(`Раздел недоступен без сервера: ${url}`), { status: 501 });
}
