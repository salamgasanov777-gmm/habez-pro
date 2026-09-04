// Резолв тенанта на каждый запрос: сначала домен, затем заголовок, затем
// значение по умолчанию. Дальше весь код обязан фильтровать по req.tenant.id —
// это единственная граница между данными разных заводов.
import fp from "./fp.js";
import { get } from "../db/index.js";
import { config } from "../config.js";
import { notFound } from "../lib/errors.js";

export default fp(async function tenantPlugin(app) {
  app.decorateRequest("tenant", null);

  app.addHook("onRequest", async (req) => {
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(":")[0];
    const header = req.headers[config.tenant.headerName];

    let tenant = host ? get("SELECT * FROM tenants WHERE host=? AND status='active'", host) : null;
    if (!tenant && header) tenant = get("SELECT * FROM tenants WHERE slug=? AND status='active'", String(header));
    if (!tenant) tenant = get("SELECT * FROM tenants WHERE slug=? AND status='active'", config.tenant.defaultSlug);
    if (!tenant) throw notFound("Компания не найдена. Проверьте домен или заголовок x-tenant.");

    req.tenant = tenant;
  });
});
