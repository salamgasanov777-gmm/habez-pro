// Заявка «запросить цену» — для завода это основной канал: часть позиций
// продаётся только через менеджера, и цена в каталоге не публикуется.
import { z } from "zod";
import { insert } from "../db/index.js";
import { getOrCreateCart, cartView } from "../services/cart.js";
import { notifyManagers } from "../lib/notify.js";

export default async function leadRoutes(app) {
  app.post("/api/leads", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const body = z.object({
      kind: z.enum(["quote", "dealer", "callback", "question"]).default("quote"),
      name: z.string().min(2).max(120),
      phone: z.string().min(10).max(20),
      email: z.string().email().optional().or(z.literal("")),
      company: z.string().max(200).optional(),
      message: z.string().max(2000).optional(),
      productId: z.number().int().optional(),
      withCart: z.boolean().default(false),
      // Ловушка для ботов: поле скрыто в вёрстке, человек его не заполняет.
      website: z.string().max(0).optional(),
    }).parse(req.body);

    const payload = { productId: body.productId ?? null };
    if (body.withCart) {
      const cart = getOrCreateCart(req, reply);
      payload.cart = cartView(req.tenant.id, cart, req.user).items.map((i) => ({ name: i.name, unit: i.unit, qty: i.qty }));
    }

    const id = insert("leads", {
      tenant_id: req.tenant.id, kind: body.kind, name: body.name, phone: body.phone,
      email: body.email || null, company: body.company ?? null, message: body.message ?? null,
      payload,
    });

    await notifyManagers(`Заявка №${id} (${body.kind})`, [
      `${body.name}, ${body.phone}`,
      body.company ? `Компания: ${body.company}` : "",
      body.message || "",
      ...(payload.cart || []).map((i) => `• ${i.name} — ${i.qty}`),
    ].filter(Boolean), req.log);

    reply.code(201);
    return { id, ok: true };
  });
}
