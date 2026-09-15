// Чек по 54-ФЗ для платёжного провайдера. Главное правило: сумма всех строк
// чека (цена × количество) должна равняться сумме платежа копейка в копейку.
// Поэтому скидка распределяется по позициям пропорционально, доставка идёт
// отдельной строкой-услугой, а остаток от деления на количество не теряется:
// позиция при необходимости делится на две строки с ценой, отличающейся
// на одну копейку.
//
// Всё в копейках, целыми числами; наружу — рубли строкой с двумя знаками.

const rubles = (kopecks) => (kopecks / 100).toFixed(2);

// Разложить сумму T на qty штук: (qty - r) штук по u и r штук по u + 1.
function splitLine(base, total, qty) {
  const unit = Math.floor(total / qty);
  const rest = total - unit * qty;
  const lines = [];
  if (qty - rest > 0) lines.push({ ...base, quantity: String(qty - rest), amount: { value: rubles(unit), currency: "RUB" } });
  if (rest > 0) lines.push({ ...base, quantity: String(rest), amount: { value: rubles(unit + 1), currency: "RUB" } });
  return lines;
}

// order: строка orders (subtotal, discount, delivery_cost, total, customer_*),
// items: строки order_items (product_name, qty, price, total), vatCode: 1..6.
export function buildReceipt(order, items, vatCode) {
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const discount = Math.min(order.discount || 0, subtotal);

  // Скидка — пропорционально стоимости позиции, остаток копеек — последней.
  let spent = 0;
  const discounted = items.map((i, n) => {
    const share = n === items.length - 1 ? discount - spent : Math.floor((discount * i.total) / (subtotal || 1));
    spent += share;
    return { item: i, total: i.total - share };
  });

  const lines = discounted.flatMap(({ item, total }) => splitLine({
    description: String(item.product_name).slice(0, 128),
    vat_code: vatCode,
    payment_mode: "full_prepayment",
    payment_subject: "commodity",
  }, total, item.qty));

  if ((order.delivery_cost || 0) > 0) {
    lines.push({
      description: "Доставка", quantity: "1", amount: { value: rubles(order.delivery_cost), currency: "RUB" },
      vat_code: vatCode, payment_mode: "full_prepayment", payment_subject: "service",
    });
  }

  const receiptTotal = lines.reduce((s, l) => s + Math.round(Number(l.amount.value) * 100) * Number(l.quantity), 0);
  if (receiptTotal !== order.total) {
    throw new Error(`Чек не сходится с заказом: ${receiptTotal} ≠ ${order.total} копеек`);
  }

  const phone = order.customer_phone?.replace(/\D/g, "");
  return {
    customer: { ...(phone ? { phone } : {}), ...(order.customer_email ? { email: order.customer_email } : {}) },
    items: lines,
  };
}
