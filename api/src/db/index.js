// Тонкий слой над node:sqlite. ORM здесь не нужен: запросов немного,
// они простые, а прямой SQL читается и профилируется без посредника.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

mkdirSync(dirname(config.db.file), { recursive: true });

export const db = new DatabaseSync(config.db.file);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

// Подготовленные запросы кешируются: одни и те же строки SQL выполняются
// на каждый запрос к API, компилировать их заново незачем.
const cache = new Map();
function prepare(sql) {
  let st = cache.get(sql);
  if (!st) {
    st = db.prepare(sql);
    cache.set(sql, st);
  }
  return st;
}

export const all = (sql, ...params) => prepare(sql).all(...params);
export const get = (sql, ...params) => prepare(sql).get(...params);
export const run = (sql, ...params) => prepare(sql).run(...params);

export function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
  const res = run(sql, ...keys.map((k) => norm(data[k])));
  return Number(res.lastInsertRowid);
}

export function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`;
  run(sql, ...keys.map((k) => norm(data[k])), id);
}

// SQLite не знает булевых значений и объектов — приводим на входе,
// чтобы вызывающий код не думал об этом на каждой вставке.
function norm(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v && typeof v === "object") return JSON.stringify(v);
  if (v === undefined) return null;
  return v;
}

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const json = (s, fallback) => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
