// Сверка и исправление данных Habez AI (Phase 2.2D).
//
//   npm run ai:reconcile-repair                         прогон БЕЗ ЗАПИСИ (по умолчанию)
//   npm run ai:reconcile-repair -- --with-pallets       то же, с операцией R1 (поддоны)
//   npm run ai:reconcile-repair -- --apply --confirm <отпечаток> [--with-pallets]
//                                                       запись в рабочую базу
//   npm run ai:reconcile-repair -- --rollback <run_id>  откат прогона
//
// Прогон без записи: рабочая база копируется (открывается только на чтение),
// на копии выполняются миграция, план, запись, повторный прогон (должен
// ничего не записать) и откат (должен вернуть всё как было). Копия
// удаляется. В конце печатается отпечаток плана — его и подтверждают
// флагом --confirm.
//
// Запись: только с --apply и совпадающим --confirm. Перед записью — копия
// базы файлом рядом с ней. Всё — одной транзакцией; любая ошибка — ROLLBACK.
// Манифест первоисточников: docs/habez-ai-reconciliation-register.json
// (npm run ai:reconcile-dry-run -- --out ../docs), путь меняется --manifest.
import { DatabaseSync, backup } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const manifestPath = resolve(value("--manifest") || resolve(apiRoot, "../docs/habez-ai-reconciliation-register.json"));
const withPallets = flag("--with-pallets");

async function loadManifestFile(loadManifest) {
  if (flag("--no-manifest")) return null;
  if (!existsSync(manifestPath)) {
    console.error(`[repair] манифест не найден: ${manifestPath} — без него все первоисточники будут unknown (или --no-manifest)`);
    process.exit(1);
  }
  return loadManifest(readFileSync(manifestPath, "utf8"));
}

// ── Работник прогона: всё на временной копии ─────────────────────────────
if (flag("--worker")) {
  const { get } = await import("../../db/index.js");
  const { config } = await import("../../config.js");
  const R = await import("./reconciliation.js");
  const t = get("SELECT id FROM tenants WHERE slug=?", config.tenant.defaultSlug).id;
  const manifest = await loadManifestFile(R.loadManifest);
  const plan = R.buildPlan(t, { manifest, withPallets });
  const lines = [];
  if (!plan.errors.length) {
    const before = R.fingerprint();
    const res = R.applyPlan(t, { manifest, withPallets, confirmHash: plan.hash, actor: "dry-run-copy" });
    lines.push(`запись на копии: прогон ${res.runId}; наблюдений ${res.countsBefore.observations} → ${res.countsAfter.observations}, вопросов ${res.countsBefore.items} → ${res.countsAfter.items}, per_pallet=40: ${res.countsBefore.per_pallet_40} → ${res.countsAfter.per_pallet_40}`);
    lines.push(`  public: ${res.countsAfter.observations_public}, verified: ${res.countsAfter.observations_verified}, связей: ${res.countsAfter.relations}`);
    const again = R.buildPlan(t, { manifest, withPallets });
    lines.push(`повторный прогон: вставок ${again.inserts.length}, вопросов ${again.items.length}, поддонов ${again.pallets.length}, ошибок ${again.errors.length} — ${again.inserts.length + again.items.length + again.pallets.length === 0 && !again.errors.length ? "идемпотентно" : "НЕ идемпотентно"}`);
    const rb = R.rollbackRun(t, res.runId, { actor: "dry-run-copy" });
    const after = R.fingerprint();
    const same = Object.keys(before).every((k) => before[k] === after[k]);
    lines.push(`откат на копии: удалено наблюдений ${rb.deleted.observations}, вопросов ${rb.deleted.items}; состояние ${same ? "совпадает с исходным" : "НЕ совпадает"}`);
  }
  console.log(R.formatPlan(plan, { simulation: lines.join("\n") }));
  process.exit(plan.errors.length ? 2 : 0);
}

// ── Запись в рабочую базу ─────────────────────────────────────────────────
if (flag("--apply") || flag("--rollback")) {
  const { get } = await import("../../db/index.js");
  const { config } = await import("../../config.js");
  const R = await import("./reconciliation.js");
  const t = get("SELECT id FROM tenants WHERE slug=?", config.tenant.defaultSlug).id;
  const missing = R.tablesReady();
  if (missing.length) { console.error(`[repair] нет таблиц ${missing.join(", ")}: сначала npm run migrate`); process.exit(1); }
  if (flag("--rollback")) {
    const res = R.rollbackRun(t, value("--rollback"));
    console.log(`[repair] откат ${res.runId}: удалено наблюдений ${res.deleted.observations}, вопросов ${res.deleted.items}`);
    process.exit(0);
  }
  const confirm = value("--confirm");
  if (!confirm) { console.error("[repair] --apply без --confirm <отпечаток плана>: сначала прогон без записи"); process.exit(1); }
  const manifest = await loadManifestFile(R.loadManifest);
  const backupPath = `${config.db.file}.pre-reconcile-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.db`;
  const res = R.applyPlan(t, { manifest, withPallets, confirmHash: confirm, actor: process.env.USER || "cli", backupPath });
  console.log(`[repair] записано. Прогон ${res.runId}. Копия базы до записи: ${backupPath}`);
  console.log(`[repair] откат: npm run ai:reconcile-repair -- --rollback ${res.runId}`);
  process.exit(0);
}

// ── Прогон без записи (по умолчанию) ─────────────────────────────────────
const { config } = await import("../../config.js");
const source = config.db.file;
if (!existsSync(source)) { console.error(`База не найдена: ${source}`); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), "habez-repair-"));
const copy = join(dir, "copy.db");
let code = 0;
try {
  const src = new DatabaseSync(source, { readOnly: true });
  await backup(src, copy);
  src.close();
  const env = { ...process.env, DATABASE_FILE: copy, LOG_LEVEL: "silent" };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  console.log("[repair] ПРОГОН БЕЗ ЗАПИСИ: рабочая база открыта только на чтение, всё ниже — на временной копии");
  try {
    execFileSync("node", [fileURLToPath(import.meta.url), "--worker", ...args], { cwd: apiRoot, env, stdio: "inherit" });
  } catch (e) { code = e.status ?? 1; }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nРабочая база ${source} открывалась только на чтение. Копия удалена.`);
console.log("REAL DATA CHANGED: NO");
process.exit(code);
