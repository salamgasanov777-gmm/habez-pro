// Локальный провайдер: оплата подтверждается кнопкой на своей же странице.
// Нужен, чтобы весь путь «корзина → заказ → оплата → статус» работал на
// демо-стенде без договора с банком и без ключей.
import { config } from "../config.js";

export const mockProvider = {
  name: "mock",

  async createPayment({ order, amount, idempotenceKey }) {
    return {
      providerId: `mock_${idempotenceKey.slice(0, 16)}`,
      status: "pending",
      confirmationUrl: `${config.publicUrl}/api/payments/mock/${order.number}?key=${idempotenceKey}`,
      raw: { mock: true, amount },
    };
  },

  async fetchPayment(providerId) {
    return { providerId, status: "pending", raw: {} };
  },

  // Подписи в демо-режиме нет: вебхук приходит с нашей же страницы оплаты.
  verifyWebhook() {
    return true;
  },

  parseWebhook(body) {
    return { providerId: body?.object?.id, status: body?.object?.status === "succeeded" ? "succeeded" : "canceled" };
  },
};
