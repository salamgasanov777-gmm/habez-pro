// Личный кабинет клиента: профиль, избранное, заказы. Избранное держим
// на сервере, чтобы список сохранялся при переходе с телефона на компьютер.
import { z } from "zod";
import { all, get, run, insert } from "../db/index.js";
import { decorate } from "../services/catalog.js";
import { publicUser } from "./auth.js";

export default async function accountRoutes(app) {
  app.patch("/api/account", { onRequest: [app.requireAuth()] }, async (req) => {
    const body = z.object({
      name: z.string().min(2).max(120).optional(),
      company: z.string().max(200).optional(),
      inn: z.string().max(12).optional(),
      email: z.string().email().optional(),
    }).parse(req.body);
    const fields = Object.entries(body).filter(([, v]) => v !== undefined);
    if (fields.length) {
      run(`UPDATE users SET ${fields.map(([k]) => `${k}=?`).join(",")} WHERE id=?`, ...fields.map(([, v]) => v), req.user.id);
    }
    return { user: publicUser(get("SELECT * FROM users WHERE id=?", req.user.id)) };
  });

  app.get("/api/account/favorites", { onRequest: [app.requireAuth()] }, async (req) => {
    const rows = all(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM favorites f JOIN products p ON p.id=f.product_id
         LEFT JOIN categories c ON c.id=p.category_id
        WHERE f.user_id=? AND p.tenant_id=? ORDER BY f.created_at DESC`,
      req.user.id, req.tenant.id);
    return { items: decorate(req.tenant.id, rows, req.user) };
  });

  app.put("/api/account/favorites/:productId", { onRequest: [app.requireAuth()] }, async (req) => {
    const productId = Number(req.params.productId);
    const existing = get("SELECT 1 AS x FROM favorites WHERE user_id=? AND product_id=?", req.user.id, productId);
    if (existing) {
      run("DELETE FROM favorites WHERE user_id=? AND product_id=?", req.user.id, productId);
      return { favorite: false };
    }
    insert("favorites", { user_id: req.user.id, product_id: productId });
    return { favorite: true };
  });

  // Перенос избранного из localStorage после первого входа: в старом
  // каталоге звёздочки жили только в браузере, терять их нельзя.
  app.post("/api/account/favorites/merge", { onRequest: [app.requireAuth()] }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(500) }).parse(req.body);
    for (const id of ids) {
      const exists = get("SELECT 1 AS x FROM products WHERE id=? AND tenant_id=?", id, req.tenant.id);
      if (exists) run("INSERT OR IGNORE INTO favorites (user_id, product_id) VALUES (?,?)", req.user.id, id);
    }
    return { merged: ids.length };
  });
}
