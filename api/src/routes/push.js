// Подписка устройства на push-уведомления. Только для сотрудников:
// клиентам такие сообщения не шлём, им незачем.
import { z } from "zod";
import { get, run, insert } from "../db/index.js";
import { publicKey, pushToUser } from "../lib/push.js";

const subscription = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(5).max(200) }),
});

export default async function pushRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));

  // Открытый ключ: браузер проверяет им подпись сервера на каждом сообщении.
  app.get("/api/push/key", async () => ({ publicKey: publicKey() }));

  // Сколько устройств у этого человека подписано — чтобы панель могла
  // показать «включено на 2 устройствах».
  app.get("/api/push/devices", async (req) => ({
    devices: get("SELECT COUNT(*) AS n FROM push_subscriptions WHERE tenant_id=? AND user_id=?", req.tenant.id, req.user.id).n,
  }));

  app.post("/api/push/subscribe", async (req) => {
    const s = subscription.parse(req.body);
    const existing = get("SELECT id FROM push_subscriptions WHERE endpoint=?", s.endpoint);
    if (existing) {
      run("UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=?, user_agent=? WHERE id=?",
        req.user.id, s.keys.p256dh, s.keys.auth, req.headers["user-agent"] || null, existing.id);
    } else {
      insert("push_subscriptions", {
        tenant_id: req.tenant.id, user_id: req.user.id,
        endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth,
        user_agent: req.headers["user-agent"] || null,
      });
    }
    return { ok: true };
  });

  app.delete("/api/push/subscribe", async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    run("DELETE FROM push_subscriptions WHERE endpoint=? AND tenant_id=?", endpoint, req.tenant.id);
    return { ok: true };
  });

  // Проверочное сообщение самому себе: убедиться, что всё доходит,
  // не дожидаясь настоящего заказа.
  app.post("/api/push/test", async (req) => {
    const r = await pushToUser(req.tenant.id, req.user.id, {
      title: "Уведомления работают",
      body: "Так будет приходить каждый новый заказ.",
      url: "/admin/orders",
    }, req.log);
    return r;
  });
}
