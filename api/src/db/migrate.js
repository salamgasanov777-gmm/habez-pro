// Миграции: schema.sql применяется идемпотентно (все CREATE — IF NOT EXISTS),
// точечные изменения дописываются в STEPS и выполняются по одному разу.
import { readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes("--fresh")) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = config.db.file + suffix;
    if (existsSync(f)) rmSync(f);
  }
  console.log("[migrate] база удалена, создаём заново");
}

const { db, get, run } = await import("./index.js");

db.exec(readFileSync(resolve(here, "schema.sql"), "utf8"));

db.exec(`CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);

const STEPS = [
  // Пример точечной миграции. Новые пункты дописывать в конец, не менять старые.
  ["2026-09-add-products-updated-trigger", `
    CREATE TRIGGER IF NOT EXISTS trg_products_updated AFTER UPDATE ON products
    BEGIN UPDATE products SET updated_at = datetime('now') WHERE id = NEW.id; END;`],
  // Кто заказывает: частник, прораб, магазин, организация. Менеджеру это
  // важно видеть сразу, а не угадывать по заполненной графе «фирма».
  // На свежей базе колонку уже создала схема — тогда шаг просто отмечается.
  ["2026-09-orders-customer-kind", () => {
    const has = db.prepare("PRAGMA table_info(orders)").all().some((c) => c.name === "customer_kind");
    if (!has) db.exec("ALTER TABLE orders ADD COLUMN customer_kind TEXT NOT NULL DEFAULT 'person'");
  }],
  // П-12: доступ гостя к заказу — по секретному токену, а не по номеру и
  // телефону. У старых заказов токена нет: их видит только владелец аккаунта
  // и сотрудники.
  ["2026-09-orders-access-token", () => {
    const has = db.prepare("PRAGMA table_info(orders)").all().some((c) => c.name === "access_token_hash");
    if (!has) db.exec("ALTER TABLE orders ADD COLUMN access_token_hash TEXT");
  }],
  // П-34/П-36–39: идемпотентность заказа и история статусов платежа.
  // Таблицу payment_events и индекс создаёт schema.sql; здесь — колонка.
  ["2026-09-orders-idempotency", () => {
    const has = db.prepare("PRAGMA table_info(orders)").all().some((c) => c.name === "idempotency_key");
    if (!has) db.exec("ALTER TABLE orders ADD COLUMN idempotency_key TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_idem ON orders(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
  }],
];

for (const [name, sql] of STEPS) {
  if (get("SELECT name FROM migrations WHERE name=?", name)) continue;
  typeof sql === "function" ? sql() : db.exec(sql);
  run("INSERT INTO migrations (name) VALUES (?)", name);
  console.log(`[migrate] ${name}`);
}

console.log(`[migrate] готово: ${config.db.file}`);
