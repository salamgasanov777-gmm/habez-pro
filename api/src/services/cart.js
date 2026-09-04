// Корзина живёт у гостя по токену в cookie и «переезжает» на аккаунт при входе:
// человек кладёт мешки в корзину, потом регистрируется — терять набор нельзя.
import { all, get, insert, run } from "../db/index.js";
import { randomToken } from "../lib/crypto.js";
import { priceMapFor, tierFor, unitPrice } from "./pricing.js";
import { badRequest, notFound } from "../lib/errors.js";

export const CART_COOKIE = "hgz_cart";

export function getOrCreateCart(req, reply) {
  const token = req.cookies?.[CART_COOKIE];
  let cart = token ? get("SELECT * FROM carts WHERE token=? AND tenant_id=? AND status='open'", token, req.tenant.id) : null;

  if (cart && req.user && !cart.user_id) {
    run("UPDATE carts SET user_id=? WHERE id=?", req.user.id, cart.id);
    cart.user_id = req.user.id;
  }
  if (!cart && req.user) {
    cart = get("SELECT * FROM carts WHERE user_id=? AND tenant_id=? AND status='open' ORDER BY id DESC", req.user.id, req.tenant.id);
  }
  if (!cart) {
    const newToken = randomToken(18);
    const id = insert("carts", { tenant_id: req.tenant.id, token: newToken, user_id: req.user?.id ?? null });
    cart = get("SELECT * FROM carts WHERE id=?", id);
  }
  if (reply && cart.token !== token) {
    reply.setCookie(CART_COOKIE, cart.token, {
      path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 60,
    });
  }
  return cart;
}

export function cartView(tenantId, cart, user) {
  const items = all(
    `SELECT ci.*, v.unit, v.pack_size, v.pack_unit, v.product_id, p.name, p.slug,
            (SELECT url FROM media WHERE product_id=p.id AND kind='photo' ORDER BY position LIMIT 1) AS photo
       FROM cart_items ci
       JOIN variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE ci.cart_id=? ORDER BY ci.id`, cart.id
  );
  const prices = priceMapFor(tenantId, tierFor(user), items.map((i) => i.variant_id));

  let subtotal = 0;
  let hasOnRequest = false;
  const view = items.map((i) => {
    const info = prices.get(i.variant_id);
    const price = unitPrice(info, i.qty);
    if (price === null) hasOnRequest = true;
    else subtotal += price * i.qty;
    return {
      id: i.id,
      variantId: i.variant_id,
      productId: i.product_id,
      slug: i.slug,
      name: i.name,
      unit: i.unit,
      photo: i.photo,
      qty: i.qty,
      price,
      priceOnRequest: price === null,
      total: price === null ? null : price * i.qty,
      weightKg: i.pack_unit === "кг" && i.pack_size ? i.pack_size * i.qty : null,
    };
  });

  return {
    id: cart.id,
    items: view,
    count: view.reduce((s, i) => s + i.qty, 0),
    subtotal,
    hasOnRequest,           // в корзине есть позиции без цены → оформляем как заявку
    weightKg: view.reduce((s, i) => s + (i.weightKg || 0), 0),
  };
}

export function addItem(tenantId, cart, variantId, qty) {
  const variant = get("SELECT * FROM variants WHERE id=? AND tenant_id=? AND is_active=1", variantId, tenantId);
  if (!variant) throw notFound("Фасовка не найдена");
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw badRequest("Некорректное количество");

  const existing = get("SELECT * FROM cart_items WHERE cart_id=? AND variant_id=?", cart.id, variantId);
  if (existing) run("UPDATE cart_items SET qty=MIN(9999, qty+?) WHERE id=?", qty, existing.id);
  else insert("cart_items", { cart_id: cart.id, variant_id: variantId, qty });
  run("UPDATE carts SET updated_at=datetime('now') WHERE id=?", cart.id);
}
