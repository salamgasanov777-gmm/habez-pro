// П-38: чек 54-ФЗ сходится с платежом копейка в копейку — со скидкой,
// доставкой и неделимыми остатками.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceipt } from "../src/payments/receipt.js";

const sum = (r) => r.items.reduce((s, l) => s + Math.round(Number(l.amount.value) * 100) * Number(l.quantity), 0);
const order = (o) => ({ customer_phone: "+7 (928) 000-00-00", customer_email: "", delivery_cost: 0, discount: 0, ...o });

test("без скидки и доставки — по строке на позицию", () => {
  const items = [{ product_name: "АКВАЛАЙТ", qty: 4, price: 45000, total: 180000 }];
  const r = buildReceipt(order({ subtotal: 180000, total: 180000 }), items, 1);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].amount.value, "450.00");
  assert.equal(sum(r), 180000);
  assert.equal(r.customer.phone, "79280000000");
});

test("доставка — отдельной строкой-услугой", () => {
  const items = [{ product_name: "А", qty: 2, price: 10000, total: 20000 }];
  const r = buildReceipt(order({ subtotal: 20000, delivery_cost: 150000, total: 170000 }), items, 1);
  const delivery = r.items.find((l) => l.payment_subject === "service");
  assert.equal(delivery.amount.value, "1500.00");
  assert.equal(sum(r), 170000);
});

test("скидка распределяется по позициям, неделимый остаток не теряется", () => {
  // 3 шт по 10,00 и 7 шт по 3,33; скидка 5 % от 53,31 = 2,66 (по floor).
  const items = [
    { product_name: "А", qty: 3, price: 1000, total: 3000 },
    { product_name: "Б", qty: 7, price: 333, total: 2331 },
  ];
  const subtotal = 5331, discount = 266;
  const r = buildReceipt(order({ subtotal, discount, total: subtotal - discount }), items, 1);
  assert.equal(sum(r), subtotal - discount);
  // Позиция, чью сумму нельзя разделить на количество поровну, стала двумя строками с разницей в копейку.
  const b = r.items.filter((l) => l.description === "Б");
  assert.ok(b.length >= 1 && b.length <= 2);
  if (b.length === 2) assert.equal(Math.round(Number(b[1].amount.value) * 100) - Math.round(Number(b[0].amount.value) * 100), 1);
  for (const l of r.items) assert.ok(Number(l.quantity) >= 1);
});

test("скидка + доставка + много позиций — всегда сходится", () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ product_name: `П${i}`, qty: i + 1, price: 777 + i * 131, total: (i + 1) * (777 + i * 131) }));
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  for (const discount of [0, 1, 99, 1234, Math.floor(subtotal * 0.05), subtotal]) {
    const total = subtotal - discount + 150000;
    const r = buildReceipt(order({ subtotal, discount, delivery_cost: 150000, total }), items, 4);
    assert.equal(sum(r), total, `скидка ${discount}`);
  }
});

test("если чек не сходится с заказом — ошибка, а не платёж на другую сумму", () => {
  const items = [{ product_name: "А", qty: 1, price: 1000, total: 1000 }];
  assert.throws(() => buildReceipt(order({ subtotal: 1000, total: 999 }), items, 1), /не сходится/);
});
