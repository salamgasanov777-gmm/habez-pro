// Конфигурация читается из окружения один раз при старте. Ни один модуль
// не лезет в process.env напрямую — так видно весь список настроек сразу.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
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
  // В production сервер слушает только локальный адрес: снаружи к нему
  // ходит nginx. Открытый порт 4000 позволил бы подставлять X-Forwarded-For
  // и обходить ограничение частоты запросов. В Docker нужен 0.0.0.0 —
  // там порт наружу не публикуется (см. docker-compose.yml).
  host: env.HOST || (env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"),
  // Чьим заголовкам X-Forwarded-* верить. По умолчанию — только обратному
  // прокси на этой же машине; в Docker задать подсеть, например TRUST_PROXY=172.16.0.0/12.
  trustProxy: env.TRUST_PROXY ? (/^(true|false)$/i.test(env.TRUST_PROXY) ? /^true$/i.test(env.TRUST_PROXY) : env.TRUST_PROXY.split(",").map((s) => s.trim())) : "loopback",
  publicUrl: env.PUBLIC_URL || "http://localhost:4000",
  webUrl: env.WEB_URL || "http://localhost:5173",
  corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Пути из .env бывают относительными — раскрываем их от корня api,
  // иначе запуск из другой директории ломает и базу, и раздачу файлов.
  // В production умолчаний нет: база и загрузки обязаны лежать вне
  // git-checkout (см. проверку ниже), иначе `git clean` или переустановка
  // папки уничтожит заказы.
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
    // none — онлайн-оплаты нет (заказ оплачивается менеджеру или по счёту),
    // mock — имитация для демо-стенда, в production запрещена, yookassa — боевой.
    provider: env.PAYMENT_PROVIDER || "none",   // none | mock | yookassa
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
    // Вход по коду из SMS доступен покупателям, только если код реально
    // отправляется. В режиме «log» он виден лишь в журнале сервера — на
    // живом сайте это выглядело бы как сломанный вход, поэтому там его нет.
    // Вне production код возвращается в ответе (devCode) — для разработки и тестов.
    get phoneLogin() { return this.smsProvider !== "log" || env.NODE_ENV !== "production"; },
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    // Push в приложение. Пара ключей VAPID — подпись сервера, по которой
    // браузер понимает, что уведомление наше. Можно задать в окружении;
    // если не задана — создаётся при первом запуске и хранится в var/vapid.json.
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || "",
    vapidSubject: env.VAPID_SUBJECT || "mailto:salam-gasanov@mail.ru",
  },

  logLevel: env.LOG_LEVEL || (env.NODE_ENV === "production" ? "info" : "debug"),
};

// Корень репозитория (checkout): база и загрузки в production не могут лежать
// внутри него. Сравниваем по реальным путям, чтобы симлинки не обманули.
const insideCheckout = (path) => {
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const rel = relative(real(resolve(root, "..")), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

if (config.isProd) {
  const missing = [];
  if (config.auth.jwtSecret.startsWith("dev-only")) missing.push("JWT_SECRET");
  if (!env.DATABASE_FILE) missing.push("DATABASE_FILE");
  if (!env.UPLOAD_DIR) missing.push("UPLOAD_DIR");
  if (config.payments.provider === "yookassa" && !config.payments.yookassa.shopId) missing.push("YOOKASSA_SHOP_ID");
  if (missing.length) {
    console.error(`[config] в production не заданы обязательные переменные: ${missing.join(", ")}`);
    process.exit(1);
  }
  // База внутри checkout — это база, которую сотрёт следующее обновление.
  for (const [name, path] of [["DATABASE_FILE", config.db.file], ["UPLOAD_DIR", config.uploads.dir]]) {
    if (!isAbsolute(env[name] || "")) {
      console.error(`[config] ${name} в production должен быть абсолютным путём вне репозитория, например /var/lib/hgz/${name === "DATABASE_FILE" ? "hgz.db" : "uploads"}`);
      process.exit(1);
    }
    if (insideCheckout(path)) {
      console.error(`[config] ${name}=${path} лежит внутри git-checkout (${resolve(root, "..")}). В production данные хранятся отдельно: /var/lib/hgz`);
      process.exit(1);
    }
  }
  // Имитация оплаты на живом сайте — это поддельная страница банка и
  // возможность пометить заказ оплаченным без денег. В production её нет.
  if (config.payments.provider === "mock") {
    console.error("[config] PAYMENT_PROVIDER=mock запрещён в production: используйте none или yookassa");
    process.exit(1);
  }
}
if (!["none", "mock", "yookassa"].includes(config.payments.provider)) {
  console.error(`[config] неизвестный PAYMENT_PROVIDER: ${config.payments.provider}`);
  process.exit(1);
}
