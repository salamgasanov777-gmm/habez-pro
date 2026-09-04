// Деньги везде в копейках целым числом. Дробные рубли в float дают
// расхождения в копейку на больших заказах — в счёте это недопустимо.
export const rub = (kopecks) => (kopecks / 100).toLocaleString("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
export const toKopecks = (rubles) => Math.round(Number(rubles) * 100);
export const fromKopecks = (kopecks) => kopecks / 100;
