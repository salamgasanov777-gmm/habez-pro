// Тестовая база для Habez AI: каталог из seed, характеристики из карточек,
// слой знаний — как в рабочей базе после сверки 2.2D (наблюдения и вопросы
// сверки D1–D10), плюс то, чего нет в seed: ГКЛ двух толщин, КОРОЕД 3,5 и
// наблюдения трёх уровней доступа с приметными значениями.
//
// Вызывать ПОСЛЕ того, как в process.env записан DATABASE_FILE, и до
// импорта модулей сервера.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Приметные значения прочности на изгиб ШОВ: по ним видно, какой уровень
// доступа до чего дотянулся.
export const LEVEL_VALUES = { public: "1,4 МПа", internal: "1,6 МПа", confidential: "1,9 МПа" };
export const SECRET_REF = "lab-protocol-77";
export const KOROED_SECRET = { value: "не менее 9 МПа", reference: "lab-koroed-9" };

export async function prepareAiDb({ demo = false } = {}) {
  const file = process.env.DATABASE_FILE;
  for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true });
  const env = { ...process.env };
  execFileSync("node", ["src/db/migrate.js"], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js", ...(demo ? ["--demo-prices"] : [])], { cwd: apiRoot, env, stdio: "ignore" });
  execFileSync("node", ["src/ai/knowledge/import-specs.js"], { cwd: apiRoot, env, stdio: "ignore" });
  const { get, insert, run } = await import("../../src/db/index.js");
  const R = await import("../../src/ai/knowledge/reconciliation.js");
  const plan = R.buildPlan(1, {});
  R.applyPlan(1, { confirmHash: plan.hash });

  const ids = {};
  for (const slug of ["shov", "standart", "antipleseni", "koroed", "styazhka"]) ids[slug] = get("SELECT id FROM products WHERE slug=?", slug)?.id;
  // Как в рабочей базе: КОРОЕД 3,5 (правило проекта), ГКЛ — свой раздел.
  run("UPDATE products SET name='Тонкослойная декоративная штукатурка «КОРОЕД 3,5»', short_name='КОРОЕД 3,5' WHERE slug='koroed25'");
  if (!get("SELECT id FROM products WHERE slug='gkl'")) {
    const cat = get("SELECT id FROM categories WHERE slug='gipsokarton'")?.id ?? insert("categories", { tenant_id: 1, slug: "gipsokarton", name: "Гипсокартон" });
    ids.gkl = insert("products", { tenant_id: 1, slug: "gkl", name: "Гипсокартонный лист ХАБЕЗ", short_name: "ГКЛ", category_id: cat, status: "published",
      spec_tables: JSON.stringify([{ title: "Технические характеристики", rows: [["Толщина", "9,5 мм / 12,5 мм"], ["Листов на паллете", "63 шт (9,5 мм) / 51 шт (12,5 мм)"]] }]) });
    insert("variants", { tenant_id: 1, product_id: ids.gkl, unit: "лист 9,5 мм", pack_size: 9.5, pack_unit: "мм", per_pallet: 63, sku: "GKL-95" });
    insert("variants", { tenant_id: 1, product_id: ids.gkl, unit: "лист 12,5 мм", pack_size: 12.5, pack_unit: "мм", per_pallet: 51, sku: "GKL-125" });
  } else ids.gkl = get("SELECT id FROM products WHERE slug='gkl'").id;

  // Три уровня доступа на одном свойстве ШОВ.
  const ev = await import("../../src/ai/knowledge/evidence.js");
  ev.createObservation(1, { productId: ids.shov, specKey: "flexural_strength", originalValue: LEVEL_VALUES.public, sourceType: "factory_site",
    sourceReference: "habez-gips.ru/shov", accessLevel: "public" }, null);
  ev.createObservation(1, { productId: ids.shov, specKey: "flexural_strength", originalValue: LEVEL_VALUES.internal, sourceType: "quality_passport",
    sourceReference: "passport-2026-09", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.shov, specKey: "flexural_strength", originalValue: LEVEL_VALUES.confidential, sourceType: "measurement",
    sourceReference: SECRET_REF, accessLevel: "confidential" }, null);
  // Конфиденциальный замер, который расходится с карточкой КОРОЕД (прочность
  // на сжатие): гость и сотрудник видят только факт, администратор — всё.
  ev.createObservation(1, { productId: ids.koroed, specKey: "compressive_strength", originalValue: "не менее 9 МПа", sourceType: "measurement",
    sourceReference: "lab-koroed-9", accessLevel: "confidential" }, null);
  return ids;
}
