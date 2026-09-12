// Push-уведомления менеджерам прямо в приложение — как у банка или
// мессенджера: телефон показывает сообщение, даже если приложение закрыто.
//
// Устройство подписывается один раз (кнопка в панели), подписка хранится
// в базе. Когда приходит заказ, сервер отправляет сообщение на каждое
// подписанное устройство через службу доставки браузера.
import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "../config.js";
import { all, run } from "../db/index.js";

let keys = null;

// Ключи — из окружения, иначе создаются один раз и лежат рядом с базой.
// Потерять их — значит, всем менеджерам придётся включить уведомления заново,
// поэтому файл входит в копию базы.
export function vapidKeys() {
  if (keys) return keys;
  if (config.notify.vapidPublicKey && config.notify.vapidPrivateKey) {
    keys = { publicKey: config.notify.vapidPublicKey, privateKey: config.notify.vapidPrivateKey };
  } else {
    const file = resolve(dirname(config.db.file), "vapid.json");
    if (existsSync(file)) {
      keys = JSON.parse(readFileSync(file, "utf8"));
    } else {
      keys = webpush.generateVAPIDKeys();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails(config.notify.vapidSubject, keys.publicKey, keys.privateKey);
  return keys;
}

export function publicKey() {
  return vapidKeys().publicKey;
}

// Отправить всем подписанным устройствам компании. Протухшие подписки
// (браузер вернул 404 или 410) удаляются, чтобы не долбить их вечно.
export async function pushToTenant(tenantId, payload, log) {
  vapidKeys();
  const subs = all("SELECT * FROM push_subscriptions WHERE tenant_id=?", tenantId);
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 6 }
      );
      run("UPDATE push_subscriptions SET last_ok_at=datetime('now') WHERE id=?", s.id);
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        run("DELETE FROM push_subscriptions WHERE id=?", s.id);
        log?.info({ id: s.id }, "push: подписка протухла, удалена");
      } else {
        log?.warn({ id: s.id, status: e.statusCode, msg: e.message }, "push: не доставлено");
      }
    }
  }
  return { sent: ok, total: subs.length };
}

// То же, но одному человеку — для кнопки «Проверить».
export async function pushToUser(tenantId, userId, payload, log) {
  vapidKeys();
  const subs = all("SELECT * FROM push_subscriptions WHERE tenant_id=? AND user_id=?", tenantId, userId);
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) run("DELETE FROM push_subscriptions WHERE id=?", s.id);
      else log?.warn({ id: s.id, status: e.statusCode }, "push: не доставлено");
    }
  }
  return { sent: ok, total: subs.length };
}
