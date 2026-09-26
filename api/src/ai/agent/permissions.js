// Habez AI Agent: кто что видит. Агент не обходит права — он читает только
// то, что этой роли и так разрешено.
//
//   гость, покупатель, дилер → public: только данные карточки товара, которые
//                               уже показаны на витрине;
//   менеджер                 → staff: плюс внутренние наблюдения, источники,
//                               вопросы сверки;
//   администратор, владелец  → admin: плюс конфиденциальные наблюдения.
import { config } from "../../config.js";

export const SCOPES = ["public", "staff", "admin"];

export function scopeForRole(role) {
  if (role === "admin" || role === "owner") return "admin";
  if (role === "manager") return "staff";
  return "public";
}

// Роль, от имени которой productEvidence отбирает наблюдения.
export const evidenceRoleForScope = (scope) => (scope === "admin" ? "owner" : scope === "staff" ? "manager" : null);

// Может ли пользователь вообще говорить с агентом.
export function canUseAgent(user) {
  if (!config.ai.agent.enabled) return { ok: false, status: 404, reason: "агент выключен" };
  const scope = scopeForRole(user?.role);
  if (scope !== "public") return { ok: true, scope };
  if (!config.ai.agent.public) return { ok: false, status: user ? 403 : 401, reason: "для покупателей и гостей агент не включён" };
  return { ok: true, scope };
}
