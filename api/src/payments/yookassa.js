// ЮKassa — основной эквайринг для российского юрлица. Ключи оформляет
// владелец бизнеса: сюда они попадают только через переменные окружения.
import { config } from "../config.js";

const y = () => config.payments.yookassa;

function authHeader() {
  const { shopId, secretKey } = y();
  return "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
}

async function call(path, { method = "GET", body, idempotenceKey } = {}) {
  const res = await fetch(`${y().apiUrl}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(idempotenceKey ? { "Idempotence-Key": idempotenceKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`ЮKassa: ${data.description || res.status}`);
    err.status = 502;
    err.details = data;
    throw err;
  }
  return data;
}

export const yookassaProvider = {
  name: "yookassa",

  async createPayment({ order, amount, idempotenceKey, items }) {
    const data = await call("/payments", {
      method: "POST",
      idempotenceKey,
      body: {
        amount: { value: (amount / 100).toFixed(2), currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: `${config.payments.returnUrl}?order=${order.number}` },
        description: `Заказ ${order.number}`,
        metadata: { order_id: String(order.id), order_number: order.number, tenant_id: String(order.tenant_id) },
        // Чек по 54-ФЗ. Без него онлайн-касса не пробьёт продажу.
        receipt: {
          customer: { phone: order.customer_phone?.replace(/\D/g, ""), email: order.customer_email || undefined },
          items: items.map((i) => ({
            description: i.product_name.slice(0, 128),
            quantity: String(i.qty),
            amount: { value: (i.price / 100).toFixed(2), currency: "RUB" },
            vat_code: y().vatCode,
            payment_mode: "full_prepayment",
            payment_subject: "commodity",
          })),
        },
      },
    });

    return {
      providerId: data.id,
      status: data.status,
      confirmationUrl: data.confirmation?.confirmation_url,
      raw: data,
    };
  },

  async fetchPayment(providerId) {
    const data = await call(`/payments/${providerId}`);
    return { providerId: data.id, status: data.status, raw: data };
  },

  // ЮKassa не подписывает вебхуки — доверять телу нельзя. Единственный
  // надёжный путь: по id из уведомления перезапросить платёж у самой ЮKassa.
  verifyWebhook() {
    return true;
  },

  parseWebhook(body) {
    return { providerId: body?.object?.id, status: body?.object?.status, verifyByFetch: true };
  },
};
