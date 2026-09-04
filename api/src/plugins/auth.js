// Аутентификация: короткий access-токен в заголовке, длинный refresh
// в httpOnly-cookie. Тело access-токена не запрашивает базу — это позволяет
// каталогу отдаваться быстро даже под нагрузкой.
import fp from "./fp.js";
import { get } from "../db/index.js";
import { verifyJwt } from "../lib/crypto.js";
import { unauthorized, forbidden } from "../lib/errors.js";

const RANK = { customer: 1, dealer: 2, manager: 3, admin: 4, owner: 5 };

export default fp(async function authPlugin(app) {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const payload = verifyJwt(header.slice(7));
    if (!payload) return;
    const user = get("SELECT * FROM users WHERE id=? AND tenant_id=? AND status='active'", payload.sub, req.tenant.id);
    if (user) req.user = user;
  });

  // requireAuth() — просто вход; requireAuth('manager') — роль не ниже менеджера.
  app.decorate("requireAuth", (minRole) => async (req) => {
    if (!req.user) throw unauthorized();
    if (minRole && (RANK[req.user.role] || 0) < RANK[minRole]) throw forbidden();
  });
});

export const roleRank = RANK;
