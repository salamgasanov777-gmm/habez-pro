// Этап 1A, пункт 1: в production база и загрузки живут вне git-checkout.
// Сервер без путей, с относительными путями или с путями внутри репозитория
// не стартует и говорит, что сделать. С правильными путями каталоги
// создаются сами; без прав на создание — понятная ошибка.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { prodDataDir, prodEnv } from "./helpers/prod-env.js";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiRoot, "..");

const boot = (env) => spawnSync("node", ["--input-type=module", "-e", `
  const { build } = await import("./src/server.js");
  const app = await build();
  const r = await app.inject("/api/health");
  console.log(r.statusCode);
  await app.close();
`], { cwd: apiRoot, encoding: "utf8", env });

test("production без DATABASE_FILE / UPLOAD_DIR не стартует", () => {
  const data = prodDataDir("hgz-paths-");
  // Переменная не задана (или подхвачена относительной из api/.env) — в любом
  // случае сервер отказывается стартовать и называет переменную.
  const noDb = prodEnv(data); delete noDb.DATABASE_FILE;
  const r1 = boot(noDb);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /DATABASE_FILE/);
  const noUp = prodEnv(data); delete noUp.UPLOAD_DIR;
  const r2 = boot(noUp);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /UPLOAD_DIR/);
});

test("production с пустой (немигрированной) базой — понятная ошибка", () => {
  const data = prodDataDir("hgz-paths-nomig-");
  const r = boot(prodEnv(data));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm run migrate/);
});

test("production с базой внутри git-checkout не стартует", () => {
  const data = prodDataDir("hgz-paths-");
  for (const bad of ["var/hgz.db", "./var/hgz.db", resolve(apiRoot, "var/prod.db"), join(repoRoot, "hgz.db")]) {
    const r = boot(prodEnv(data, { DATABASE_FILE: bad }));
    assert.equal(r.status, 1, `путь «${bad}» должен быть отвергнут`);
    assert.match(r.stderr, /DATABASE_FILE/);
    assert.ok(!existsSync(resolve(apiRoot, bad)) || bad.includes("var/hgz.db"), "файл в репозитории не создан");
  }
  const r = boot(prodEnv(data, { UPLOAD_DIR: resolve(apiRoot, "var/uploads") }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /UPLOAD_DIR/);
});

test("production с абсолютными путями вне репозитория стартует и создаёт каталоги", () => {
  const data = prodDataDir("hgz-paths-ok-");
  const db = join(data.dir, "data", "hgz.db");
  const uploads = join(data.dir, "data", "uploads");
  const env = prodEnv(data, { DATABASE_FILE: db, UPLOAD_DIR: uploads });
  // Как на сервере: миграция и боевой сид до первого запуска.
  spawnSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  spawnSync("node", ["src/db/seed.js"], { cwd: apiRoot, env, stdio: "ignore" });
  const r = boot(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "200");
  assert.ok(existsSync(db) && existsSync(uploads));
  assert.equal(statSync(db).mode & 0o777, 0o640, "файл базы — только владельцу и группе");
});

test("нет прав создать каталог — понятная ошибка, а не EACCES из драйвера", (t) => {
  if (process.getuid?.() === 0) return t.skip("root может создать что угодно");
  const data = prodDataDir("hgz-paths-ro-");
  const locked = join(data.dir, "locked");
  mkdirSync(locked); chmodSync(locked, 0o500);
  const r = boot(prodEnv(data, { DATABASE_FILE: join(locked, "deep", "hgz.db") }));
  chmodSync(locked, 0o700);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /chown hgz:hgz/);
});
