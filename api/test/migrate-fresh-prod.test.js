// Этап 1A-5: `npm run reset` / `migrate --fresh` на боевом сервере не должны
// стирать базу с заказами. В production флаг отвергается до любых действий
// с файлами; в разработке и тестах сброс работает как прежде.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { prodDataDir, prodEnv } from "./helpers/prod-env.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const sql = (db, q) => execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim();

test("production: migrate --fresh отвергается, база остаётся байт в байт прежней", () => {
  const data = prodDataDir("hgz-fresh-");
  const env = prodEnv(data);
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });
  sql(data.db, "INSERT INTO orders (tenant_id, number, customer_name, customer_phone, total) VALUES (1,'ХГЗ-0001','Клиент','+79280000000',100);");
  const before = { hash: sha(data.db), size: statSync(data.db).size, orders: sql(data.db, "SELECT COUNT(*) FROM orders") };
  assert.equal(before.orders, "1");

  const r = spawnSync("node", ["src/db/migrate.js", "--fresh"], { cwd: apiRoot, env, encoding: "utf8" });
  assert.equal(r.status, 1, "команда завершается ошибкой");
  assert.match(r.stderr, /--fresh/);
  assert.match(r.stderr, /запрещён в production/);
  assert.ok(existsSync(data.db), "файл базы на месте");
  assert.equal(sha(data.db), before.hash, "содержимое не изменилось");
  assert.equal(statSync(data.db).size, before.size);
  assert.equal(sql(data.db, "SELECT COUNT(*) FROM orders"), "1", "заказ на месте");

  // Тот же сценарий через npm run reset — до сида дело не доходит.
  const reset = spawnSync("npm", ["run", "reset", "--silent"], { cwd: apiRoot, env, encoding: "utf8" });
  assert.notEqual(reset.status, 0);
  assert.equal(sha(data.db), before.hash, "reset ничего не тронул");
  assert.equal(sql(data.db, "SELECT COUNT(*) FROM users"), "0", "демо-учётные записи не появились");
});

test("вне production migrate --fresh по-прежнему пересоздаёт базу", () => {
  const data = prodDataDir("hgz-fresh-dev-");
  const env = { ...prodEnv(data), NODE_ENV: "test" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  sql(data.db, "INSERT INTO tenants (slug, name) VALUES ('x','X');");
  const r = spawnSync("node", ["src/db/migrate.js", "--fresh"], { cwd: apiRoot, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sql(data.db, "SELECT COUNT(*) FROM tenants WHERE slug='x'"), "0", "база пересоздана");
});
