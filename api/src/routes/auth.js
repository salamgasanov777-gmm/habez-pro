// Два способа входа: пароль (менеджеры, админ) и одноразовый код на телефон
// (клиенты — им пароль заводить неудобно). Refresh-токен ротируется при
// каждом обновлении: украденный старый токен перестаёт работать.
import { z } from "zod";
import { all, get, insert, run } from "../db/index.js";
import { config } from "../config.js";
import { hashPassword, verifyPassword, signJwt, randomToken, sha256, numericCode } from "../lib/crypto.js";
import { badRequest, unauthorized, conflict, tooMany } from "../lib/errors.js";
import { sendSms } from "../lib/notify.js";

const REFRESH_COOKIE = "hgz_rt";
const phoneSchema = z.string().min(10).max(20).transform((s) => s.replace(/\D/g, "").replace(/^8/, "7"));

function issueSession(reply, user, req) {
  const refresh = randomToken(32);
  insert("sessions", {
    user_id: user.id,
    token_hash: sha256(refresh),
    user_agent: (req.headers["user-agent"] || "").slice(0, 200),
    ip: req.ip,
    expires_at: new Date(Date.now() + config.auth.refreshTtl * 1000).toISOString(),
  });
  reply.setCookie(REFRESH_COOKIE, refresh, {
    path: "/api/auth", httpOnly: true, sameSite: "lax",
    secure: config.auth.cookieSecure, domain: config.auth.cookieDomain,
    maxAge: config.auth.refreshTtl,
  });
  run("UPDATE users SET last_login_at=datetime('now') WHERE id=?", user.id);
  return signJwt({ sub: user.id, role: user.role, tenant: user.tenant_id });
}

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, company: u.company,
  role: u.role, priceTier: u.price_tier,
});

export default async function authRoutes(app) {
  app.post("/api/auth/register", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(2).max(120),
      email: z.string().email(),
      password: z.string().min(8).max(200),
      phone: phoneSchema.optional(),
      company: z.string().max(200).optional(),
    }).parse(req.body);

    const exists = get("SELECT id FROM users WHERE tenant_id=? AND email=?", req.tenant.id, body.email.toLowerCase());
    if (exists) throw conflict("Пользователь с такой почтой уже зарегистрирован");

    const id = insert("users", {
      tenant_id: req.tenant.id,
      name: body.name,
      email: body.email.toLowerCase(),
      phone: body.phone ?? null,
      company: body.company ?? null,
      password_hash: hashPassword(body.password),
      role: "customer",
    });
    const user = get("SELECT * FROM users WHERE id=?", id);
    return { user: publicUser(user), accessToken: issueSession(reply, user, req) };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = get("SELECT * FROM users WHERE tenant_id=? AND email=?", req.tenant.id, body.email.toLowerCase());
    // Пароль проверяется даже когда пользователя нет: иначе по времени ответа
    // можно перебрать, какие адреса зарегистрированы.
    const ok = verifyPassword(body.password, user?.password_hash || "scrypt$00$00");
    if (!user || !ok) throw unauthorized("Неверная почта или пароль");
    if (user.status !== "active") throw unauthorized("Аккаунт заблокирован");
    return { user: publicUser(user), accessToken: issueSession(reply, user, req) };
  });

  // Вход по коду. Провайдера SMS нет — код возвращается в ответе только
  // в режиме разработки, в проде он уходит в SMS и наружу не попадает.
  app.post("/api/auth/otp/request", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const { phone } = z.object({ phone: phoneSchema }).parse(req.body);

    const recent = get(
      `SELECT COUNT(*) AS n FROM otp_codes WHERE tenant_id=? AND destination=?
        AND created_at > datetime('now','-10 minutes')`, req.tenant.id, phone);
    if (recent.n >= 5) throw tooMany("Слишком много запросов кода. Попробуйте через 10 минут.");

    const code = numericCode(6);
    insert("otp_codes", {
      tenant_id: req.tenant.id, channel: "phone", destination: phone,
      code_hash: sha256(code), purpose: "login",
      expires_at: new Date(Date.now() + config.auth.otpTtl * 1000).toISOString(),
    });
    await sendSms(phone, `Код входа: ${code}`, req.log);
    return { sent: true, ttlSec: config.auth.otpTtl, ...(config.isProd ? {} : { devCode: code }) };
  });

  app.post("/api/auth/otp/verify", { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const { phone, code, name } = z.object({
      phone: phoneSchema, code: z.string().length(6), name: z.string().max(120).optional(),
    }).parse(req.body);

    const otp = get(
      `SELECT * FROM otp_codes WHERE tenant_id=? AND destination=? AND purpose='login'
         AND consumed_at IS NULL AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`, req.tenant.id, phone);
    if (!otp) throw badRequest("Код не найден или истёк — запросите новый");
    if (otp.attempts >= config.auth.otpMaxAttempts) throw tooMany("Слишком много попыток ввода кода");

    run("UPDATE otp_codes SET attempts=attempts+1 WHERE id=?", otp.id);
    if (sha256(code) !== otp.code_hash) throw badRequest("Неверный код");
    run("UPDATE otp_codes SET consumed_at=datetime('now') WHERE id=?", otp.id);

    let user = get("SELECT * FROM users WHERE tenant_id=? AND phone=?", req.tenant.id, phone);
    if (!user) {
      const id = insert("users", { tenant_id: req.tenant.id, phone, name: name || null, role: "customer" });
      user = get("SELECT * FROM users WHERE id=?", id);
    }
    return { user: publicUser(user), accessToken: issueSession(reply, user, req) };
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized("Сессия не найдена");
    const session = get(
      `SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > datetime('now')`,
      sha256(token));
    if (!session) throw unauthorized("Сессия истекла, войдите заново");

    const user = get("SELECT * FROM users WHERE id=? AND status='active'", session.user_id);
    if (!user) throw unauthorized();
    // Ротация: старая запись гасится, выдаётся новая пара.
    run("UPDATE sessions SET revoked_at=datetime('now') WHERE id=?", session.id);
    return { user: publicUser(user), accessToken: issueSession(reply, user, req) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) run("UPDATE sessions SET revoked_at=datetime('now') WHERE token_hash=?", sha256(token));
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    return { ok: true };
  });

  app.get("/api/auth/me", { onRequest: [app.requireAuth()] }, async (req) => ({
    user: publicUser(req.user),
    sessions: all("SELECT id, user_agent, ip, created_at FROM sessions WHERE user_id=? AND revoked_at IS NULL", req.user.id).length,
  }));
}
