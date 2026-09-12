import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.js";
import { ApiError } from "./lib/errors.js";
import tenantPlugin from "./plugins/tenant.js";
import authPlugin from "./plugins/auth.js";

import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import catalogRoutes from "./routes/catalog.js";
import cartRoutes from "./routes/cart.js";
import orderRoutes from "./routes/orders.js";
import paymentRoutes from "./routes/payments.js";
import leadRoutes from "./routes/leads.js";
import accountRoutes from "./routes/account.js";
import adminRoutes from "./routes/admin.js";
import pushRoutes from "./routes/push.js";
import { openapi } from "./openapi.js";

export async function build() {
  const app = Fastify({
    logger: { level: config.logLevel, ...(config.isProd ? {} : { transport: undefined }) },
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
  });
  await app.register(cookie, { secret: config.auth.jwtSecret });
  await app.register(multipart, { limits: { fileSize: config.uploads.maxBytes, files: 1 } });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: "1 minute",
    keyGenerator: (req) => `${req.ip}:${req.tenant?.id ?? 0}`,
  });

  mkdirSync(config.uploads.dir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.uploads.dir, prefix: "/uploads/", decorateReply: false,
    cacheControl: true, maxAge: "30d", immutable: true,
  });

  await app.register(tenantPlugin);
  await app.register(authPlugin);

  // Заголовки безопасности ставим сами: helmet ради шести строк не нужен.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    if (config.isProd) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "validation_error", message: "Проверьте заполнение полей",
          fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: { code: "too_many_requests", message: "Слишком много запросов, подождите минуту" } });
    }
    // Непредвиденная ошибка: наружу только идентификатор запроса,
    // подробности остаются в логе сервера.
    req.log.error({ err }, "unhandled error");
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера", requestId: req.id },
    });
  });

  app.get("/api/openapi.json", async () => openapi);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(cartRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(leadRoutes);
  await app.register(accountRoutes);
  await app.register(adminRoutes);
  await app.register(pushRoutes);

  // Одним процессом можно отдавать и собранный фронтенд — так проще
  // разворачивать на одном небольшом сервере. Обработчик «не найдено»
  // ставится ровно один раз: в API он отдаёт JSON, на витрине — index.html,
  // чтобы работали ссылки вида /p/akvalayt при перезагрузке страницы.
  const webDist = resolve(config.root, "../web/dist");
  const hasWeb = existsSync(webDist);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", decorateReply: true, wildcard: false });
  }

  app.setNotFoundHandler((req, reply) => {
    if (!hasWeb || req.url.startsWith("/api/") || req.url.startsWith("/uploads/")) {
      return reply.code(404).send({ error: { code: "not_found", message: `Маршрут ${req.method} ${req.url} не найден` } });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await build();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`HGZ Pro API · ${config.publicUrl} · платежи: ${config.payments.provider}`);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      app.log.info("останавливаемся…");
      await app.close();
      process.exit(0);
    });
  }
}
