// Форматирование денег, дат и склонений — в одном месте: цена в карточке,
// в корзине и в письме должна выглядеть одинаково.
export const money = (kopecks, opts = {}) =>
  kopecks === null || kopecks === undefined
    ? "—"
    : (kopecks / 100).toLocaleString("ru-RU", {
        style: "currency", currency: "RUB",
        minimumFractionDigits: 0, maximumFractionDigits: opts.exact ? 2 : 0,
      });

export const num = (n, digits = 1) =>
  Number(n).toLocaleString("ru-RU", { maximumFractionDigits: digits });

export const date = (iso) => {
  const d = new Date(iso?.includes("T") ? iso : `${iso}Z`.replace(" ", "T"));
  return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
};

export const dateTime = (iso) => {
  const d = new Date(iso?.includes("T") ? iso : `${iso}Z`.replace(" ", "T"));
  return isNaN(d) ? "" : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

// «1 товар / 2 товара / 5 товаров» — без этого интерфейс выглядит machine-made.
export const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
};

export const phoneMask = (v) => {
  const d = String(v).replace(/\D/g, "").replace(/^8/, "7").slice(0, 11);
  if (!d) return "";
  const p = d.startsWith("7") ? d : "7" + d;
  const g = [p.slice(1, 4), p.slice(4, 7), p.slice(7, 9), p.slice(9, 11)];
  return `+7${g[0] ? " (" + g[0] : ""}${g[0].length === 3 ? ")" : ""}${g[1] ? " " + g[1] : ""}${g[2] ? "-" + g[2] : ""}${g[3] ? "-" + g[3] : ""}`;
};

export const ORDER_LABEL = {
  new: "Новый", confirmed: "Подтверждён", paid: "Оплачен",
  shipping: "В доставке", done: "Выполнен", cancelled: "Отменён",
};
export const PAY_LABEL = { pending: "Ожидает оплаты", paid: "Оплачен", failed: "Не прошла", refunded: "Возврат" };

// Приложение может лежать не в корне домена (на GitHub Pages это папка
// репозитория). Пути к фотографиям приходят от сервера как "/products/…",
// поэтому приводим их к тому месту, где приложение реально развёрнуто.
export const mediaUrl = (u) => {
  if (!u) return u;
  if (/^(https?:|data:|blob:)/.test(u)) return u;
  return import.meta.env.BASE_URL + String(u).replace(/^\//, "");
};
