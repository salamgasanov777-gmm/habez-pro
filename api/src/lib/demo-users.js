// Учётные записи демо-стенда. Пароли известны всем, кто читал README, —
// поэтому они создаются только сидом с --demo-prices и никогда не должны
// оказаться на живом сервере: server.js в production проверяет базу и
// отказывается стартовать, если такая запись входит своим демо-паролем.
export const DEMO_USERS = [
  { email: "admin@habez.local", name: "Администратор", role: "owner", password: "admin12345" },
  { email: "manager@habez.local", name: "Менеджер отдела продаж", role: "manager", password: "manager12345" },
  { email: "dealer@habez.local", name: "Дилер «СтройБаза»", role: "dealer", price_tier: "dealer", company: "ООО СтройБаза", password: "dealer12345" },
];
