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
];

for (const [name, sql] of STEPS) {
  if (get("SELECT name FROM migrations WHERE name=?", name)) continue;
  db.exec(sql);
  run("INSERT INTO migrations (name) VALUES (?)", name);
  console.log(`[migrate] ${name}`);
}

console.log(`[migrate] готово: ${config.db.file}`);
