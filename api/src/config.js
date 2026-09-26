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

  // Habez AI. Фаза 1 — только слой знаний (источники и факты), без модели
  // и без выхода в интернет. Выключенный раздел не регистрирует маршруты
  // вовсе: работающий каталог о нём не знает.
  // Модель наблюдений (Phase 2.2B) включается отдельно: пока она выключена,
  // маршрутов /api/ai/observations* нет, а старый путь (ai_product_specs)
  // работает как раньше. Таблицы миграция создаёт в любом случае — пустые.
  // AI_EVIDENCE_READ_MODE — чем отвечают старые /api/ai/specs, /intelligence,
  // /compare: legacy (строки ai_product_specs, по умолчанию) или evidence
  // (проекция наблюдений, те же поля + блок evidence). evidence действует,
  // только если AI_EVIDENCE_ENABLED=1; иначе — legacy.
  ai: {
    // Habez AI Agent (Phase 3.1): чат по товарам на данных слоя знаний.
    // Только чтение. Ключ провайдера — только из окружения, в коде и в
    // репозитории его нет. provider: openrouter (по умолчанию, правило
    // владельца: нейросеть — через OpenRouter), anthropic, mock (без сети —
    // для тестов и проверки без ключа).
    agent: {
      enabled: bool(env.AI_AGENT_ENABLED, false),
      // Покупатели и гости: только при AI_AGENT_PUBLIC=1 (каждый ответ стоит
      // денег). Сотрудникам — всегда, когда агент включён.
      public: bool(env.AI_AGENT_PUBLIC, false),
      provider: (env.AI_PROVIDER || "openrouter").toLowerCase(),
      model: env.AI_MODEL || "anthropic/claude-sonnet-5",
      baseUrl: (env.AI_BASE_URL || "https://openrouter.ai/api").replace(/\/$/, ""),
      apiKey: env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY || "",
      maxTokens: Number(env.AI_MAX_TOKENS || 4000),
      timeoutMs: Number(env.AI_TIMEOUT_MS || 90000),
      // Защита от расходов: вопросов за окно (сотрудник / гость и
      // покупатель), одновременных ответов на одного человека, всего ответов
      // гостям и покупателям за сутки (0 — без общего предела), длина
      // истории беседы, которую сервер передаёт модели.
      rateStaff: Number(env.AI_RATE_STAFF || 60),
      ratePublic: Number(env.AI_RATE_PUBLIC || 12),
      rateWindowMin: Number(env.AI_RATE_WINDOW_MIN || 10),
      maxConcurrent: Number(env.AI_MAX_CONCURRENT || 2),
      publicDailyMax: Number(env.AI_PUBLIC_DAILY_MAX || 300),
      historyMaxChars: Number(env.AI_HISTORY_MAX_CHARS || 12000),
      // Бюджет цикла инструментов (Phase 3.2): вызовов инструментов на ответ
      // (план + модель), ходов модели, записей в пакете доказательств, знаков
      // контекста и общее время на ответ.
      maxToolCalls: Number(env.AI_AGENT_MAX_TOOL_CALLS || 8),
      maxTurns: Number(env.AI_AGENT_MAX_TURNS || 3),
      maxEvidence: Number(env.AI_AGENT_MAX_EVIDENCE || 160),
      maxContextChars: Number(env.AI_AGENT_MAX_CONTEXT_CHARS || 48000),
      totalTimeoutMs: Number(env.AI_AGENT_TOTAL_TIMEOUT_MS || 120000),
    },
    enabled: bool(env.AI_ENABLED, false),
    evidence: bool(env.AI_EVIDENCE_ENABLED, false),
    readMode: bool(env.AI_EVIDENCE_ENABLED, false) && String(env.AI_EVIDENCE_READ_MODE || "legacy").toLowerCase() === "evidence" ? "evidence" : "legacy",
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
