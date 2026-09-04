// Уведомления вынесены за интерфейс: сегодня всё падает в лог и Telegram,
// завтра подключается SMS-агрегатор — вызовы в бизнес-коде не меняются.
import { config } from "../config.js";

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

export async function sendSms(phone, text, log) {
  if (config.notify.smsProvider === "log") {
    log?.info({ phone, text }, "SMS (режим лога)");
    return { delivered: false, mode: "log" };
  }
  // Здесь подключается агрегатор (SMS.ru, Devino, MTS Exolve): договор и ключ
  // оформляет владелец, поэтому реализация — точка расширения, а не заглушка «на глаз».
  throw new Error(`SMS-провайдер ${config.notify.smsProvider} не настроен`);
}

export async function sendEmail(to, subject, text, log) {
  if (config.notify.emailProvider === "log") {
    log?.info({ to, subject, text }, "E-mail (режим лога)");
    return { delivered: false, mode: "log" };
  }
  throw new Error(`Почтовый провайдер ${config.notify.emailProvider} не настроен`);
}

export async function notifyManagers(title, lines, log) {
  const text = `<b>${title}</b>\n` + lines.join("\n");
  const sent = await telegram(text);
  if (!sent) log?.info({ title, lines }, "Уведомление менеджерам (режим лога)");
}
