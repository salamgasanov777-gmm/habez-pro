// Уведомления вынесены за интерфейс: сегодня всё падает в лог и Telegram,
// завтра подключается SMS-агрегатор — вызовы в бизнес-коде не меняются.
import { config } from "../config.js";
import { pushToTenant } from "./push.js";

async function telegram(text) {
  const { telegramBotToken: token, telegramChatId: chat } = config.notify;
  if (!token || !chat) return false;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    });
    return true;
  } catch {
    return false;
  }
}

// В журнал — только то, что нужно для диагностики. Телефон маскируется,
// текст (в нём код входа) не пишется никогда: журнал читают люди и хранят
// системы, которым персональные данные покупателей не нужны.
export const maskPhone = (p) => String(p || "").replace(/\D/g, "").replace(/^(\d{0,3})\d*(\d{2})$/, "$1***$2");
export const maskEmail = (e) => String(e || "").replace(/^(.).*(@.*)$/, "$1***$2");

export async function sendSms(phone, text, log) {
  if (config.notify.smsProvider === "log") {
    log?.info({ phone: maskPhone(phone), chars: text.length }, "SMS (режим лога): не отправлено");
    return { delivered: false, mode: "log" };
  }
  // Здесь подключается агрегатор (SMS.ru, Devino, MTS Exolve): договор и ключ
  // оформляет владелец, поэтому реализация — точка расширения, а не заглушка «на глаз».
  throw new Error(`SMS-провайдер ${config.notify.smsProvider} не настроен`);
}

export async function sendEmail(to, subject, text, log) {
  if (config.notify.emailProvider === "log") {
    log?.info({ to: maskEmail(to), subject, chars: text.length }, "E-mail (режим лога): не отправлено");
    return { delivered: false, mode: "log" };
  }
  throw new Error(`Почтовый провайдер ${config.notify.emailProvider} не настроен`);
}

// Заказ или заявка — всем менеджерам. Push в приложение идёт всегда:
// это свой канал, без договоров. Telegram — дополнительно, если настроен.
// В журнал попадает только заголовок (в нём номер заказа или заявки) и
// результат доставки. Сам текст — имя, телефон, адрес покупателя — уходит
// только менеджерам (push, Telegram) и лежит в базе; в журнале ему не место.
export async function notifyManagers(title, lines, log, { tenantId, url } = {}) {
  const text = `<b>${title}</b>\n` + lines.join("\n");
  let pushed = { sent: 0, total: 0 };
  if (tenantId) {
    try {
      pushed = await pushToTenant(tenantId, { title, body: lines.join("\n"), url: url || "/admin" }, log);
    } catch (e) {
      log?.warn({ err: e.message }, "push: сбой отправки");
    }
  }
  const viaTelegram = await telegram(text);
  const delivered = pushed.sent > 0 || viaTelegram;
  if (!delivered) log?.warn({ title, pushDevices: pushed.total, telegram: viaTelegram }, "Уведомление менеджерам не доставлено: нет подписанных устройств");
  return { delivered, push: pushed, telegram: viaTelegram };
}
