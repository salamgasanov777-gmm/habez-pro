import { get } from "../db/index.js";
import { config } from "../config.js";

const startedAt = Date.now();

export default async function healthRoutes(app) {
  // Для балансировщика и мониторинга: проверяем, что база реально отвечает.
  app.get("/api/health", async () => {
    const row = get("SELECT COUNT(*) AS n FROM products");
    return {
      status: "ok",
      version: "1.0.0",
      env: config.nodeEnv,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      products: row.n,
      paymentProvider: config.payments.provider,
    };
  });
}
