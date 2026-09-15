// Окружение production для тестов: база и загрузки — во временном каталоге
// системы, а не в репозитории (в production внутри checkout сервер не стартует).
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function prodDataDir(prefix = "hgz-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  return { dir, db: join(dir, "hgz.db"), uploads: join(dir, "uploads") };
}

export const prodEnv = (data, extra = {}) => ({
  ...process.env,
  NODE_ENV: "production", LOG_LEVEL: "silent",
  JWT_SECRET: "x".repeat(64), PAYMENT_PROVIDER: "none",
  DATABASE_FILE: data.db, UPLOAD_DIR: data.uploads,
  ...extra,
});
