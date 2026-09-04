// Провайдер платежей за интерфейсом из трёх методов. Смена ЮKassa на другой
// эквайринг — это новый файл рядом, а не правки в заказах.
import { config } from "../config.js";
import { mockProvider } from "./mock.js";
import { yookassaProvider } from "./yookassa.js";

const providers = { mock: mockProvider, yookassa: yookassaProvider };

export function paymentProvider(name = config.payments.provider) {
  const provider = providers[name];
  if (!provider) throw new Error(`Неизвестный провайдер платежей: ${name}`);
  return provider;
}

export const providerNames = Object.keys(providers);
