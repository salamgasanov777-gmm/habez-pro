// Создать (или сбросить пароль) владельцу панели. Единственный способ
// получить первую учётную запись на боевом сервере: сид их не создаёт.
//
//   npm run create-owner -- director@habez-gips.ru
//
// Пароль генерируется и печатается один раз — записать и сразу сменить
// в панели. Запускает владелец сам, когда решит.
import { db, get, insert, run } from "./index.js";
import { hashPassword, randomToken } from "../lib/crypto.js";
import { config } from "../config.js";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Укажите почту: npm run create-owner -- director@habez-gips.ru");
  process.exit(1);
}

const tenant = get("SELECT id FROM tenants WHERE slug=?", config.tenant.defaultSlug);
if (!tenant) { console.error("Тенант не найден — сначала npm run migrate && npm run seed"); process.exit(1); }

const password = randomToken(12);
const existing = get("SELECT id, role FROM users WHERE tenant_id=? AND email=?", tenant.id, email);
if (existing) {
  run("UPDATE users SET password_hash=?, role='owner', status='active' WHERE id=?", hashPassword(password), existing.id);
  console.log(`Пароль сброшен, роль owner: ${email}`);
} else {
  insert("users", { tenant_id: tenant.id, email, name: "Владелец", role: "owner", password_hash: hashPassword(password), email_verified: 1 });
  console.log(`Создан владелец: ${email}`);
}
console.log(`Пароль (показывается один раз): ${password}`);
console.log("Войдите в панель и смените его в разделе «Пользователи».");
db.close();
