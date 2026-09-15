// Этап 1A, пункт 3: настройки SQLite и поведение транзакций.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDb = resolve(apiRoot, "var/test-pragmas.db");
process.env.DATABASE_FILE = testDb;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

let mod;
before(async () => {
  for (const s of ["", "-wal", "-shm"]) rmSync(testDb + s, { force: true });
  mod = await import("../src/db/index.js");
  mod.db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
});
after(() => mod?.db.close());

test("pragmas: WAL, synchronous=FULL, foreign_keys, busy_timeout", () => {
  const { get } = mod;
  assert.equal(get("PRAGMA journal_mode").journal_mode, "wal");
  assert.equal(get("PRAGMA synchronous").synchronous, 2, "2 = FULL");
  assert.equal(get("PRAGMA foreign_keys").foreign_keys, 1);
  assert.equal(get("PRAGMA busy_timeout").timeout, 5000);
});

test("tx() берёт блокировку записи сразу: второй писатель ждёт, а не ломает транзакцию", () => {
  const { tx, run, get } = mod;
  tx(() => {
    // Внутри транзакции ещё ничего не записано, но блокировка уже наша.
    const other = new DatabaseSync(testDb);
    other.exec("PRAGMA busy_timeout = 0");
    assert.throws(() => other.exec("INSERT INTO t (v) VALUES ('чужой')"), /SQLITE_BUSY|database is locked/);
    other.close();
    run("INSERT INTO t (v) VALUES (?)", "наш");
  });
  assert.equal(get("SELECT COUNT(*) AS n FROM t").n, 1);
  assert.equal(get("SELECT v FROM t").v, "наш");
});

test("tx() откатывает всё при ошибке и снимает блокировку", () => {
  const { tx, run, get } = mod;
  assert.throws(() => tx(() => { run("INSERT INTO t (v) VALUES ('будет откачено')"); throw new Error("стоп"); }), /стоп/);
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='будет откачено'").n, 0);
  // После отката второй писатель проходит без ожидания.
  const other = new DatabaseSync(testDb);
  other.exec("PRAGMA busy_timeout = 0");
  other.exec("INSERT INTO t (v) VALUES ('после отката')");
  other.close();
  assert.equal(get("SELECT COUNT(*) AS n FROM t").n, 2);
});

test("чтение при открытой транзакции записи не блокируется (WAL)", () => {
  const { tx } = mod;
  tx(() => {
    const reader = new DatabaseSync(testDb);
    reader.exec("PRAGMA busy_timeout = 0");
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM t").get().n, 2);
    reader.close();
  });
});
