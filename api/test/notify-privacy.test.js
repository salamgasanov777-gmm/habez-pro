// Этап 1A, пункт 2: персональные данные покупателей не попадают в журнал.
// Уведомления менеджерам по-прежнему содержат всё нужное — но в журнал
// уходит только заголовок с номером и результат доставки.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-notify.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDER = "none";
process.env.LOG_LEVEL = "silent";

let notify;
const entries = [];
const log = {
  info: (obj, msg) => entries.push({ level: "info", obj, msg }),
  warn: (obj, msg) => entries.push({ level: "warn", obj, msg }),
  error: (obj, msg) => entries.push({ level: "error", obj, msg }),
};
const dump = () => JSON.stringify(entries);

const FORBIDDEN = ["Петров", "111-22-33", "9281112233", "Ленина", "0910003701", "ivan.petrov", "123456", "секретный-токен"];

before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  const env = { ...process.env, DATABASE_FILE: testDb };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });
  notify = await import("../src/lib/notify.js");
});
after(async () => { (await import("../src/db/index.js")).db.close(); });

test("уведомление о заказе: в журнале номер заказа и факт недоставки, но не данные покупателя", async () => {
  entries.length = 0;
  const lines = [
    "Иван Петров (магазин), +7 (928) 111-22-33",
    "• Штукатурка — 3 × мешок 30 кг",
    "Итого: 4 500 ₽",
    "Доставка: г. Черкесск, ул. Ленина 5",
    "ИНН 0910003701",
    "token: секретный-токен",
  ];
  const r = await notify.notifyManagers("Новый заказ ХГЗ-2609-0042", lines, log, { tenantId: 1, url: "/admin/orders" });
  assert.equal(r.delivered, false, "подписок нет — не доставлено");
  assert.ok(entries.length >= 1, "факт недоставки записан");
  const text = dump();
  assert.match(text, /ХГЗ-2609-0042/);
  assert.match(text, /pushDevices/);
  for (const f of FORBIDDEN) assert.ok(!text.includes(f), `в журнале не должно быть «${f}»`);
});

test("SMS в режиме лога: код и полный телефон в журнал не пишутся", async () => {
  entries.length = 0;
  await notify.sendSms("+7 (928) 111-22-33", "Код входа: 123456", log);
  const text = dump();
  assert.ok(entries.length === 1);
  assert.ok(!text.includes("123456"), "код входа не должен попадать в журнал");
  assert.ok(!text.includes("9281112233"), "полный телефон не должен попадать в журнал");
  assert.match(text, /792\*\*\*33/, "телефон замаскирован");
});

test("E-mail в режиме лога: адрес замаскирован, текст не пишется", async () => {
  entries.length = 0;
  await notify.sendEmail("ivan.petrov@example.com", "Восстановление пароля", "Ваша ссылка: https://x/секретный-токен", log);
  const text = dump();
  assert.ok(!text.includes("ivan.petrov"));
  assert.ok(!text.includes("секретный-токен"));
  assert.match(text, /i\*\*\*@example\.com/);
});

test("маски работают на коротких и пустых значениях", () => {
  assert.equal(notify.maskPhone(""), "");
  assert.equal(notify.maskPhone("79280327521"), "792***21");
  assert.equal(notify.maskEmail("a@b.ru"), "a***@b.ru");
});
