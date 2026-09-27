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
  // Конфиденциальное «для фасада ДА» у ШОВ против карточки «НЕТ»: подбор
  // гостю и сотруднику не должен из-за него менять оценку (Phase 3.3).
  ev.createObservation(1, { productId: ids.shov, specKey: "suitable_facade", originalValue: "ДА", sourceType: "measurement",
    sourceReference: "lab-shov-facade", accessLevel: "confidential" }, null);

  // Phase 3.4 — заводы и документы. Как в рабочей базе: один пакет
  // паспортов качества на несколько товаров (коммит №1 3bbbfb3, даты
  // документа нет), сайт и прайс завода для ГКЛ.
  for (const s of ["paint-interior", "paint-facade", "polymer-waterproofing", "melissa", "teplokom", "nal", "kompozit"]) ids[s] = get("SELECT id FROM products WHERE slug=?", s)?.id;
  const legacy = (upstreamRef, upstreamRecordedAt) => ({ internal: { upstreamRef, upstreamRecordedAt, captureChannel: "habez_pro_product_card" } });
  ev.createObservation(1, { productId: ids["paint-interior"], specKey: "adhesion_strength", originalValue: "0,2 МПа", sourceType: "quality_passport",
    sourceReference: "app1-commit-3bbbfb3", accessLevel: "internal" }, null, legacy("app1-commit-3bbbfb3", "2026-09-10"));
  ev.createObservation(1, { productId: ids["paint-facade"], specKey: "adhesion_strength", originalValue: "не менее 0,1 МПа", sourceType: "quality_passport",
    sourceReference: "app1-commit-3bbbfb3", accessLevel: "internal" }, null, legacy("app1-commit-3bbbfb3", "2026-09-10"));
  ev.createObservation(1, { productId: ids["polymer-waterproofing"], specKey: "consumption", originalValue: "0,8 кг/м²", sourceType: "quality_passport",
    sourceReference: "app1-commit-3bbbfb3", accessLevel: "internal" }, null, legacy("app1-commit-3bbbfb3", "2026-09-10"));
  ev.createObservation(1, { productId: ids.gkl, specKey: "sheet_size", originalValue: "1200 × 2500 мм", sourceType: "price_list",
    sourceReference: "app1-commit-a57506d", accessLevel: "internal" }, null, legacy("app1-commit-a57506d", "2026-09-07"));
  ev.createObservation(1, { productId: ids.gkl, specKey: "thickness", originalValue: "9,5 мм / 12,5 мм", sourceType: "factory_site",
    sourceReference: "app1-commit-4f4c18e", accessLevel: "internal" }, null, legacy("app1-commit-4f4c18e", "2026-09-11"));
  // Прямые записи об изготовителе — только в тестовой базе (в рабочей их нет):
  //   МЕЛИССА  — этикетка называет свой завод → CONFIRMED;
  //   ТЕПЛОКОМ — этикетка и ТУ называют разных изготовителей → CONFLICTED;
  //   НАЛЬ     — две площадки → оба CONFIRMED, не противоречие;
  //   КОМПОЗИТ — конфиденциальный сторонний изготовитель: гость и сотрудник
  //              видят только «нужна сверка».
  ev.createObservation(1, { productId: ids.melissa, specKey: "manufacturer", originalValue: "ООО «Хабезский гипсовый завод»", sourceType: "label",
    sourceReference: "label-melissa-2026-09", sourceName: "Этикетка МЕЛИССА от 12.09.2026", providedAt: "2026-09-12", providedBy: "factory_technologist", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.teplokom, specKey: "manufacturer", originalValue: "Хабезский гипсовый завод", sourceType: "label",
    sourceReference: "label-teplokom-2026-09", sourceName: "Этикетка ТЕПЛОКОМ от 01.09.2026", providedAt: "2026-09-01", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.teplokom, specKey: "manufacturer", originalValue: "ООО «Черкесский завод смесей»", sourceType: "technical_document",
    sourceReference: "tu-teplokom-2019", sourceName: "ТУ на ТЕПЛОКОМ, редакция 2", providedAt: "2019-03-15", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.nal, specKey: "production_site", originalValue: "Хабезский гипсовый завод", sourceType: "label",
    sourceReference: "label-nal-a", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.nal, specKey: "production_site", originalValue: "Черкесский завод смесей", sourceType: "label",
    sourceReference: "label-nal-b", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.kompozit, specKey: "manufacturer", originalValue: "ООО «Стороннее производство»", sourceType: "measurement",
    sourceReference: "contract-kompozit", accessLevel: "confidential" }, null);
  // Два паспорта качества Бетоноконтакта с разными датами — победителя по
  // дате нет.
  ids.betonokontakt = get("SELECT id FROM products WHERE slug='betonokontakt'")?.id;
  ev.createObservation(1, { productId: ids.betonokontakt, specKey: "shelf_life", originalValue: "6 месяцев", sourceType: "quality_passport",
    sourceReference: "passport-betonokontakt-0801", sourceName: "Паспорт качества Бетоноконтакт от 01.08.2026", providedAt: "2026-08-01", accessLevel: "internal" }, null);
  ev.createObservation(1, { productId: ids.betonokontakt, specKey: "shelf_life", originalValue: "12 месяцев", sourceType: "quality_passport",
    sourceReference: "passport-betonokontakt-0915", sourceName: "Паспорт качества Бетоноконтакт от 15.09.2026", providedAt: "2026-09-15", accessLevel: "internal" }, null);
  return ids;
}
