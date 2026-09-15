// Этап 1A, пункт 4: перенос каталога между серверами — только каталог.
// Экспорт с базы-источника не содержит пользователей и заказов; импорт на
// чистую боевую базу воспроизводит товары, цены, фото и настройки и
// отказывается работать с файлом, где есть что-то лишнее.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { prodDataDir, prodEnv } from "./helpers/prod-env.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = prodDataDir("hgz-src-");     // «демо-стенд» с пользователями и заказом
const dst = prodDataDir("hgz-dst-");     // «боевой сервер», чистый
const dump = join(src.dir, "catalog.json");
const sql = (db, q) => execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim();
const node = (args, env) => spawnSync("node", args, { cwd: apiRoot, encoding: "utf8", env });

before(() => {
  const env = { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_FILE: src.db, UPLOAD_DIR: src.uploads, PAYMENT_PROVIDER: "none" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", "--demo-prices"], { cwd: apiRoot, env, stdio: "ignore" });
  // На источнике — то, что переносить нельзя: заказ, заявка, лишний пользователь, и то, что нужно: своя цена.
  sql(src.db, `INSERT INTO orders (tenant_id, number, customer_name, customer_phone, total) VALUES (1,'ХГЗ-0001','Тайный Клиент','+79280000000',100);
               INSERT INTO leads (tenant_id, name, phone) VALUES (1,'Заявитель','+79280000001');
               UPDATE prices SET amount=123400 WHERE id=(SELECT id FROM prices WHERE tier='retail' AND min_qty=1 LIMIT 1);`);
});

test("экспорт: только каталог, без пользователей, заказов и demoPrices", () => {
  const env = { ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_FILE: src.db, UPLOAD_DIR: src.uploads };
  const r = node(["src/db/export-catalog.js", dump], env);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(dump, "utf8"));
  assert.deepEqual(Object.keys(data).sort(), ["categories", "exportedAt", "format", "products", "tenant"]);
  const text = JSON.stringify(data);
  for (const bad of ["Тайный Клиент", "+79280000000", "Заявитель", "habez.local", "password", "scrypt$"]) assert.ok(!text.includes(bad), `в выгрузке не должно быть «${bad}»`);
  assert.equal(data.tenant.settings.demoPrices, undefined);
  assert.equal(data.products.length, 43);
  assert.ok(data.products.some((p) => p.variants.some((v) => v.prices.some((pr) => pr.amount === 123400))), "цена уехала");
});

test("импорт на чистую боевую базу: товары есть, пользователей нет, owner не создан", () => {
  const env = prodEnv(dst);
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });   // боевой сид: без цен и пользователей
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM users"), "0");

  const dry = node(["src/db/import-catalog.js", dump, "--dry-run"], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM prices WHERE amount=123400"), "0", "dry-run ничего не записал");

  const r = node(["src/db/import-catalog.js", dump], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM products"), "43");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM prices WHERE amount=123400"), "1");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM users"), "0", "пользователи не появились");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM orders"), "0");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM leads"), "0");
  assert.equal(sql(dst.db, "SELECT json_extract(settings,'$.demoPrices') FROM tenants"), "");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH 'аквалайт'"), "1", "поиск переиндексирован");

  // Повторный импорт — идемпотентен.
  const again = node(["src/db/import-catalog.js", dump], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM products"), "43");
  assert.equal(sql(dst.db, "SELECT COUNT(*) FROM media"), sql(src.db, "SELECT COUNT(*) FROM media"));
});

test("файл с пользователями или заказами импорт отвергает", () => {
  const env = prodEnv(dst);
  const data = JSON.parse(readFileSync(dump, "utf8"));
  const bad = join(src.dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...data, users: [{ email: "x@y", password_hash: "…" }] }));
  const r = node(["src/db/import-catalog.js", bad], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Отказ|отказ/);
  writeFileSync(bad, JSON.stringify({ ...data, tenant: { ...data.tenant, settings: { ...data.tenant.settings, demoPrices: true } } }));
  assert.equal(node(["src/db/import-catalog.js", bad], env).status, 1);
});
