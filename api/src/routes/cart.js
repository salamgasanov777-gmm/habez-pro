import { z } from "zod";
import { get, run } from "../db/index.js";
import { getOrCreateCart, cartView, addItem } from "../services/cart.js";
import { notFound } from "../lib/errors.js";

export default async function cartRoutes(app) {
  app.get("/api/cart", async (req, reply) => {
    const cart = getOrCreateCart(req, reply);
    return cartView(req.tenant.id, cart, req.user);
  });

  app.post("/api/cart/items", async (req, reply) => {
    const body = z.object({ variantId: z.number().int(), qty: z.number().int().min(1).max(999).default(1) }).parse(req.body);
    const cart = getOrCreateCart(req, reply);
    addItem(req.tenant.id, cart, body.variantId, body.qty);
    return cartView(req.tenant.id, cart, req.user);
  });

  app.patch("/api/cart/items/:id", async (req, reply) => {
    const { qty } = z.object({ qty: z.number().int().min(0).max(999) }).parse(req.body);
    const cart = getOrCreateCart(req, reply);
    const item = get("SELECT * FROM cart_items WHERE id=? AND cart_id=?", Number(req.params.id), cart.id);
    if (!item) throw notFound("Позиция не найдена");
    if (qty === 0) run("DELETE FROM cart_items WHERE id=?", item.id);
    else run("UPDATE cart_items SET qty=? WHERE id=?", qty, item.id);
    return cartView(req.tenant.id, cart, req.user);
  });

  app.delete("/api/cart/items/:id", async (req, reply) => {
    const cart = getOrCreateCart(req, reply);
    run("DELETE FROM cart_items WHERE id=? AND cart_id=?", Number(req.params.id), cart.id);
    return cartView(req.tenant.id, cart, req.user);
  });

  app.delete("/api/cart", async (req, reply) => {
    const cart = getOrCreateCart(req, reply);
    run("DELETE FROM cart_items WHERE cart_id=?", cart.id);
    return cartView(req.tenant.id, cart, req.user);
  });
}
