// Конфигурация читается из окружения один раз при старте. Ни один модуль
// не лезет в process.env напрямую — так видно весь список настроек сразу.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Мини-загрузчик .env: отдельная зависимость ради пятнадцати строк не нужна.
const envFile = resolve(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  root,
  nodeEnv: env.NODE_ENV || "development",
  isProd: env.NODE_ENV === "production",
  port: Number(env.PORT || 4000),
  host: env.HOST || "0.0.0.0",
  publicUrl: env.PUBLIC_URL || "http://localhost:4000",
  webUrl: env.WEB_URL || "http://localhost:5173",
  corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Пути из .env бывают относительными — раскрываем их от корня api,
  // иначе запуск из другой директории ломает и базу, и раздачу файлов.
  db: { file: resolve(root, env.DATABASE_FILE || "var/hgz.db") },
  uploads: { dir: resolve(root, env.UPLOAD_DIR || "var/uploads"), maxBytes: Number(env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024) },

  auth: {
    // В проде запуск без своего секрета запрещён — см. проверку ниже.
    jwtSecret: env.JWT_SECRET || "dev-only-insecure-secret-change-me",
    accessTtl: Number(env.ACCESS_TTL_SEC || 900),            // 15 минут
    refreshTtl: Number(env.REFRESH_TTL_SEC || 60 * 60 * 24 * 30),
    otpTtl: Number(env.OTP_TTL_SEC || 300),
    otpMaxAttempts: Number(env.OTP_MAX_ATTEMPTS || 5),
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === "production"),
  },

  tenant: { defaultSlug: env.DEFAULT_TENANT || "habez", headerName: "x-tenant" },

  payments: {
    provider: env.PAYMENT_PROVIDER || "mock",   // mock | yookassa
    returnUrl: env.PAYMENT_RETURN_URL || (env.WEB_URL || "http://localhost:5173") + "/checkout/result",
    yookassa: {
      shopId: env.YOOKASSA_SHOP_ID || "",
      secretKey: env.YOOKASSA_SECRET_KEY || "",
      apiUrl: env.YOOKASSA_API_URL || "https://api.yookassa.ru/v3",
      vatCode: Number(env.YOOKASSA_VAT_CODE || 1),
    },
  },

  notify: {
    // Пока провайдера нет, коды и уведомления пишутся в лог — так вход
    // по коду работает на демо-стенде без договора с SMS-сервисом.
    smsProvider: env.SMS_PROVIDER || "log",
    emailProvider: env.EMAIL_PROVIDER || "log",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
  },

  logLevel: env.LOG_LEVEL || (env.NODE_ENV === "production" ? "info" : "debug"),
};

if (config.isProd) {
  const missing = [];
  if (config.auth.jwtSecret.startsWith("dev-only")) missing.push("JWT_SECRET");
  if (config.payments.provider === "yookassa" && !config.payments.yookassa.shopId) missing.push("YOOKASSA_SHOP_ID");
  if (missing.length) {
    console.error(`[config] в production не заданы обязательные переменные: ${missing.join(", ")}`);
    process.exit(1);
  }
}
