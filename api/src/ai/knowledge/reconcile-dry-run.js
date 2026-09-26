// Habez AI, Phase 2.2C: сверка данных — ТОЛЬКО ЧТЕНИЕ.
//
//   npm run ai:reconcile-dry-run                   отчёт в консоль
//   npm run ai:reconcile-dry-run -- --out ../docs  плюс реестр в файлы
//                                                  (JSON и Markdown)
//
// Что делает:
//   1. Для каждой строки ai_product_specs ищет строку текущей карточки
//      Habez Pro, из которой её перенесли (legacy-provenance.js).
//   2. Прослеживает значение этой строки по истории products.json
//      приложения №1 (git, только чтение) до коммита, где оно появилось,
//      и относит коммит к виду источника. Коммит без записанного
//      источника (исходный каталог 31.08) → unknown.
//   3. Собирает конфликты: внутри карточки, карточка ↔ приложение №1,
//      обязательные случаи из задачи, количество на поддоне.
//   4. Проверяет правило публикации на старых данных.
//
// Рабочая база открывается ТОЛЬКО на чтение (node:sqlite, readOnly), модуль
// db/index.js не загружается. В приложении №1 ничего не пишется: только
// `git log` и `git show`. Никаких UPDATE / INSERT / DELETE.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "../../config.js";
import { cardItems, legacyProvenance } from "./legacy-provenance.js";
import { keyForLabel, skipReason, specMeta } from "./spec-dictionary.js";
import { parseSpecValue } from "./units.js";
import { resolveGroup } from "./evidence-resolve.js";
import { publicationDecision, personalDataIn } from "./evidence-model.js";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : null;
const APP1 = process.env.APP1_DIR || join(homedir(), "Desktop/HGZ_app/app");

const db = new DatabaseSync(config.db.file, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const tenant = q1("SELECT id FROM tenants WHERE slug=?", config.tenant.defaultSlug);
const T = tenant.id;

// ── Коммиты products.json приложения №1 → вид источника ───────────────────
// Классификация по сообщениям коммитов (прочитаны 25.09, в отчёт текст
// сообщений не копируется: в одном из них есть личные данные).
const COMMIT_CLASS = {
  e4ddf47: "initial_catalog_unrecorded", // исходный каталог 31.08, источник не записан
  cfae436: "app1_edit", "4df7d7c": "app1_edit", b45a32f: "app1_edit", aa9226c: "app1_edit",
  fc43d40: "app1_edit", "5d22df0": "app1_edit", f7e409a: "app1_edit", "062b744": "app1_edit", d1e1873: "app1_edit",
  "8ca2dcc": "factory_technologist", "1e43732": "factory_technologist", b4866a5: "factory_technologist",
  "09fa92f": "label", "4f97b6e": "label", "8826d35": "label",
  "4745fc4": "marking_card",
  "3bbbfb3": "quality_passport",
  a57506d: "price_list",           // из прайса 06.09 через habez-pro 29f2b60
  b41cdd0: "app1_owner_entry",     // владелец: только названия и толщина
  "4f4c18e": "factory_site",       // сайт завода habez-gips.ru
  "3f3fdbd": "factory_catalog",    // страница заводского каталога
};
const UNKNOWN_UPSTREAM = new Set(["initial_catalog_unrecorded", "app1_edit", "not_in_app1", "app1_unavailable"]);
const FACTORY_DOCS = new Set(["factory_technologist", "quality_passport", "label", "marking_card", "factory_catalog"]);

const clean = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const normName = (s) => clean(s).replace(/ё/g, "е").toLowerCase();

function app1Rows(p) {
  const rows = [];
  for (const b of p.badges || []) if (b?.label) rows.push({ from: "badge", ref: "ярлык карточки", label: clean(b.label), value: clean(b.value) });
  const t = p.tables;
  const tables = Array.isArray(t) ? t.map((x) => [x.title, x.rows]) : Object.entries(t || {});
  for (const [title, rs] of tables) for (const r of rs || []) if (Array.isArray(r) && r[0]) rows.push({ from: "spec_table", ref: clean(title || "таблица"), label: clean(r[0]), value: clean(r[1]) });
  return rows;
}

let versions = [];
let app1Available = existsSync(join(APP1, "products.json"));
if (app1Available) {
  try {
    const git = (...a) => execFileSync("git", ["-C", APP1, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const log = git("log", "--reverse", "--format=%h %ad", "--date=short", "--", "products.json").trim().split("\n");
    versions = log.map((line) => {
      const [hash, date] = line.split(" ");
      return { hash, date, products: JSON.parse(git("show", `${hash}:products.json`)) };
    });
  } catch (e) {
    console.error(`[reconcile] история приложения №1 недоступна: ${e.message.split("\n")[0]}`);
    app1Available = false;
  }
}
const head = versions[versions.length - 1];

// Индекс истории: «товар | вид | заголовок | подпись» → значение в каждой версии.
const series = new Map();
const seriesByLabel = new Map(); // без заголовка таблицы — на случай переименования таблицы
versions.forEach((v, i) => {
  for (const p of v.products) {
    for (const r of app1Rows(p)) {
      for (const [map, k] of [[series, `${normName(p.name)}|${r.from}|${r.ref}|${r.label}`], [seriesByLabel, `${normName(p.name)}|${r.from}|${r.label}`]]) {
        if (!map.has(k)) map.set(k, new Array(versions.length).fill(undefined));
        map.get(k)[i] = r.value;
      }
    }
  }
});

function trace(app1Name, row) {
  if (!app1Available) return { upstream: "app1_unavailable" };
  const tryKeys = [series.get(`${normName(app1Name)}|${row.from}|${clean(row.ref)}|${clean(row.label)}`),
    seriesByLabel.get(`${normName(app1Name)}|${row.from}|${clean(row.label)}`)];
  const V = clean(row.value);
  for (const s of tryKeys) {
    if (!s) continue;
    let intro = -1;
    for (let i = 0; i < s.length; i++) if (s[i] === V && (i === 0 || s[i - 1] !== V)) intro = i;
    if (intro < 0) continue;
    let changed = -1;
    for (let j = intro + 1; j < s.length; j++) if (s[j] !== V) { changed = j; break; }
    const c = versions[intro];
    return {
      upstream: COMMIT_CLASS[c.hash] || "app1_edit",
      introCommit: c.hash, introDate: c.date,
      app1Head: s[s.length - 1] ?? null,
      changedIn: changed >= 0 ? { commit: versions[changed].hash, date: versions[changed].date, to: s[changed] ?? null, category: COMMIT_CLASS[versions[changed].hash] || "app1_edit" } : null,
    };
  }
  return { upstream: "not_in_app1" };
}

// ── Данные Habez Pro (только чтение) ─────────────────────────────────────
const products = q("SELECT id, slug, name, short_name, status, badges, spec_tables, sections FROM products WHERE tenant_id=? ORDER BY position, id", T);
const productById = new Map(products.map((p) => [p.id, p]));
const app1ByName = new Map((head?.products || []).map((p) => [normName(p.name), p]));
const app1ById = new Map((head?.products || []).map((p) => [p.id, p]));
// КОРОЕД 3,5 намеренно отличается от №1 (правило проекта): сопоставляем по номеру.
const INTENTIONAL = { koroed25: "КОРОЕД 3,5 намеренно отличается от приложения №1 (CLAUDE.md)" };
function app1For(p) {
  return app1ByName.get(normName(p.name)) || (INTENTIONAL[p.slug] ? app1ById.get(p.id) : null) || null;
}
const specs = q(`SELECT s.*, src.name AS source_name FROM ai_product_specs s LEFT JOIN ai_sources src ON src.id=s.source_id WHERE s.tenant_id=? ORDER BY s.id`, T);
const variants = q("SELECT v.*, p.slug, p.name AS product_name, p.badges, p.spec_tables FROM variants v JOIN products p ON p.id=v.product_id WHERE v.tenant_id=? ORDER BY v.id", T);

// ── 1. Происхождение 726 старых записей ──────────────────────────────────
const legacy = specs.map((s) => {
  const p = productById.get(s.product_id);
  const prov = legacyProvenance(s, p);
  const a1 = p ? app1For(p) : null;
  const tr = prov.row && a1 ? trace(a1.name, prov.row) : { upstream: prov.row ? "not_in_app1" : "no_card_row" };
  const origin = prov.sourceType !== "product_card" ? prov.sourceType
    : UNKNOWN_UPSTREAM.has(tr.upstream) ? `unknown_legacy_origin (${tr.upstream})` : tr.upstream;
  // Предлагаемое наблюдение при переносе: доступ internal, проверка как есть.
  const proposed = {
    id: s.id, sourceType: prov.sourceType, accessLevel: "internal", lifecycleStatus: "active",
    verificationStatus: ["generated_default", "ai_inference", "unknown_legacy_origin"].includes(prov.sourceType) ? "unverified" : s.verification_status,
  };
  const onStorefront = !!prov.row && p?.status === "published";
  const asIfPublic = publicationDecision({ ...proposed, accessLevel: "public" }, { status: "agreed", supporting: [s.id] });
  return { spec: s, product: p, prov, trace: tr, origin, proposed, onStorefront, asIfPublic,
    decision: publicationDecision(proposed, { status: "agreed", supporting: [s.id] }), intentional: INTENTIONAL[p?.slug] || null };
});

// ── 3–4. Конфликты ───────────────────────────────────────────────────────
const register = [];
const groups = new Map();
function addRow(group, row) {
  if (!groups.has(group.id)) groups.set(group.id, { ...group, rows: 0 });
  groups.get(group.id).rows++;
  register.push({ conflict_group: group.id, ...row });
}
const assertionOf = (v) => /фактически/i.test(v) ? "declared+measured (одной строкой)" : /норм[аы] по гост/i.test(v) ? "measured+norm (одной строкой)" : "unknown";
const condHint = (label) => { const m = String(label).match(/(\d+)\s*сут/); return m ? `в подписи: «${m[0]}» (age_days=${m[1]}), не разобрано` : null; };
const unitOf = (v) => parseSpecValue(v).normalizedUnit;
const legacyBySpecId = new Map(legacy.map((l) => [l.spec.id, l]));

// A. Внутри карточки Habez Pro: ярлык и таблица дают разные значения одного ключа.
for (const p of products) {
  const items = cardItems(p).filter((it) => it.key && !it.skipped);
  const byKey = new Map();
  for (const it of items) { if (!byKey.has(it.key)) byKey.set(it.key, []); byKey.get(it.key).push(it); }
  for (const [key, list] of byKey) {
    const parsed = list.map((it) => ({ it, v: parseSpecValue(it.value) }));
    const meaning = (x) => JSON.stringify([x.v.valueNum, x.v.valueMin, x.v.valueMax, x.v.valueBool, x.v.normalizedUnit, x.v.valueText ?? null]);
    if (new Set(parsed.map(meaning)).size < 2) continue;
    const spec = specs.find((s) => s.product_id === p.id && s.spec_key === key);
    const gid = `CARD:${p.slug}:${key}`;
    for (const { it, v } of parsed) {
      const isLegacy = spec && spec.imported_from === it.from && spec.source_ref === it.ref && spec.display_value === v.displayValue;
      const a1 = app1For(p);
      const tr = a1 ? trace(a1.name, it) : { upstream: "not_in_app1" };
      addRow({ id: gid, kind: "card_internal", product: p.slug, spec_key: key }, {
        product: p.slug, variant: null, spec_key: key, label: it.label, value: it.value, unit: v.normalizedUnit, comparator: v.comparator,
        condition: condHint(it.label), assertion_type: assertionOf(it.value),
        source_type: "product_card", upstream_origin: tr.upstream,
        source_id: `habez-pro-card:${p.slug}:${it.from}:${it.ref}`, source_date: tr.introDate ?? null, source_date_kind: tr.introDate ? "app1_commit_date" : null,
        app1_commit: tr.introCommit ?? null,
        verification: isLegacy ? spec.verification_status : "—", access_level: "internal (предложено)",
        current_status: isLegacy ? "legacy_active: отдаётся старым API как единственное значение" : "hidden_by_importer: в ai_product_specs не попало",
        proposed_action: "сохранить оба как наблюдения; победителя не выбирать",
        decision_required: p.slug === "standart" && key === "adhesion_strength" ? "D1" : "D-CARD",
      });
    }
  }
}

// B. Строка карточки Habez Pro изменена или убрана в приложении №1.
for (const l of legacy) {
  if (!l.trace.changedIn) continue;
  const s = l.spec; const ch = l.trace.changedIn;
  const gid = `APP1:${l.product.slug}:${s.spec_key}`;
  const candidate = FACTORY_DOCS.has(ch.category);
  addRow({ id: gid, kind: "app1_changed", product: l.product.slug, spec_key: s.spec_key }, {
    product: l.product.slug, variant: null, spec_key: s.spec_key, label: l.prov.row.label, value: s.display_value, unit: s.normalized_unit, comparator: s.comparator,
    condition: condHint(l.prov.row.label), assertion_type: "unknown",
    source_type: "product_card", upstream_origin: l.trace.upstream,
    source_id: `ai_product_specs#${s.id}`, source_date: l.trace.introDate, source_date_kind: "app1_commit_date", app1_commit: l.trace.introCommit,
    verification: s.verification_status, access_level: "internal (предложено)",
    current_status: `legacy_active; в №1 изменено коммитом ${ch.commit} (${ch.date}, ${ch.category}) на ${ch.to === null ? "— (строка убрана или переименована)" : `«${ch.to}»`}`,
    proposed_action: candidate ? "кандидат на замену: завести наблюдение из документа завода; связь «заменяет» — только решением" : "показать владельцу; ничего не менять",
    decision_required: candidate ? "D-APP1-DOC" : "D-APP1",
  });
}

// C. Количество на поддоне.
const palletMentions = (v) => {
  const hits = [];
  for (const it of cardItems(v)) if (/поддон|паллет/i.test(it.label)) hits.push(`${it.label}: ${it.value}`);
  return hits;
};
const pallets = variants.filter((v) => v.per_pallet !== null).map((v) => {
  const hits = palletMentions(v);
  return { variant: v, confirmed: hits.length > 0, hits };
});
for (const x of pallets) {
  const v = x.variant;
  const p = productById.get(v.product_id);
  const a1 = app1For(p);
  let tr = null;
  if (x.confirmed && a1) {
    const it = cardItems(v).find((i) => /поддон|паллет/i.test(i.label));
    tr = trace(a1.name, it);
  }
  addRow({ id: `PALLET:${x.confirmed ? "confirmed" : "generated"}`, kind: "pallet" }, {
    product: v.slug, variant: `${v.id} «${v.unit}»`, spec_key: "per_pallet", label: "variants.per_pallet", value: String(v.per_pallet), unit: "pcs", comparator: "exact",
    condition: null, assertion_type: "unknown",
    source_type: x.confirmed ? "product_card" : "generated_default", upstream_origin: x.confirmed ? (tr?.upstream ?? "not_in_app1") : "seed.js (правило «мешок от 25 кг → 40»)",
    source_id: x.confirmed ? `habez-pro-card:${v.slug}` : "api/src/db/seed.js",
    source_date: tr?.introDate ?? null, source_date_kind: tr?.introDate ? "app1_commit_date" : null, app1_commit: tr?.introCommit ?? null,
    verification: "unverified (в variants проверки нет)", access_level: "public (видно на витрине)",
    current_status: x.confirmed ? `подтверждено карточкой: ${x.hits.join(" | ")}` : "подставлено программой; в карточке нет",
    proposed_action: x.confirmed ? "оставить; завести наблюдение с источником" : "не удалять до решения; наблюдение generated_default, не подтверждается и не публикуется",
    decision_required: x.confirmed ? "—" : "D7",
  });
}

// D. Обязательные случаи — разбор по фактам.
function cardRow(slug, pred) { const p = products.find((x) => x.slug === slug); return p ? cardItems(p).filter(pred) : []; }
function app1Row(slug, pred) {
  const p = products.find((x) => x.slug === slug); const a1 = p && app1For(p);
  return a1 ? app1Rows(a1).filter(pred).map((r) => ({ ...r, trace: trace(a1.name, r) })) : [];
}
const cases = [];
function caseOf(id, title, facts) { cases.push({ id, title, ...facts }); }
{
  const oldA = cardRow("shov", (r) => r.from === "badge" && r.label === "Прочность на отрыв")[0];
  const newA = app1Row("shov", (r) => /сцепления.*7 сут/.test(r.label))[0];
  caseOf("SHOV-ADHESION", "ШОВ: 0,5 МПа и 0,3 МПа", {
    a: oldA && { label: oldA.label, value: oldA.value, where: "Habez Pro, ярлык", key: oldA.key, unit: unitOf(oldA.value), comparator: parseSpecValue(oldA.value).comparator },
    b: newA && { label: newA.label, value: newA.value, where: `№1, таблица, коммит ${newA.trace.introCommit} (${newA.trace.upstream})`, key: keyForLabel(newA.label) ?? "нет ключа словаря (подпись с возрастом)", unit: unitOf(newA.value), comparator: parseSpecValue(newA.value).comparator },
    same_property: "по смыслу — да (прочность сцепления = прочность на отрыв); по словарю новая подпись не сопоставлена", same_condition: "нет: у старого возраста нет, у нового «в возрасте 7 сут»",
    same_unit: "да (MPa); признак границы разный (точное / «не менее»)", replacement_proven: "формулировка «0,3 МПа вместо 0,5» есть только в сообщении коммита 1e43732 — вторичная запись; сам документ технолога на диске отсутствует",
    evidence: "строка таблицы в products.json №1 после 1e43732 — дословная перепечатка документа технолога", unresolved: "связывать ли как замену (D4)", decision: "D4",
  });
  const oldS = cardRow("shov", (r) => r.from === "badge" && r.label === "Время схватывания")[0];
  const newS = app1Row("shov", (r) => r.from === "spec_table" && /Начало схватывания/.test(r.label))[0];
  caseOf("SHOV-SETTING", "ШОВ: 60 мин и 70 мин", {
    a: oldS && { label: oldS.label, value: oldS.value, where: "Habez Pro, ярлык", key: oldS.key, unit: unitOf(oldS.value) },
    b: newS && { label: newS.label, value: newS.value, where: `№1, таблица, коммит ${newS.trace.introCommit} (${newS.trace.upstream})`, key: keyForLabel(newS.label), unit: unitOf(newS.value) },
    same_property: "не доказано: setting_time («Время схватывания») и setting_time_start («Начало схватывания») — разные ключи", same_condition: "условий нет",
    same_unit: "да (min)", replacement_proven: "нет для тождества свойств; «70 мин вместо 60» — только в сообщении коммита",
    evidence: "подпись и значение нового — из №1 после 1e43732", unresolved: "одно ли это свойство (D6) и какое значение действует (D3)", decision: "D3, D6",
  });
  const oldC = cardRow("shov", (r) => r.from === "badge" && r.label === "Прочность не менее")[0];
  const newC = app1Row("shov", (r) => r.from === "spec_table" && /сжатие.*7 сут/.test(r.label))[0];
  caseOf("SHOV-COMPRESSIVE", "ШОВ: 2 МПа и ≥2,5 МПа", {
    a: oldC && { label: oldC.label, value: oldC.value, where: "Habez Pro, ярлык", key: oldC.key, unit: unitOf(oldC.value) },
    b: newC && { label: newC.label, value: newC.value, where: `№1, таблица, коммит ${newC.trace.introCommit} (${newC.trace.upstream})`, key: keyForLabel(newC.label) ?? "нет ключа словаря (подпись с возрастом)", unit: unitOf(newC.value) },
    same_property: "та же величина (прочность на сжатие)", same_condition: "нет: у старого возраста нет («Прочность не менее»), у нового 7 сут",
    same_unit: "да (MPa)", replacement_proven: "нет: в записи о письме замена прочности на сжатие не упомянута",
    evidence: "подпись нового — из №1 после 1e43732", unresolved: "устарело ли «2 МПа» или это другой возраст (D2)", decision: "D2",
  });
  const oldAP = cardRow("antipleseni", (r) => r.key === "consumption");
  const newAP = app1Row("antipleseni", (r) => keyForLabel(r.label) === "consumption");
  caseOf("ANTIPLESEN-CONSUMPTION", "АНТИПЛЕСЕНЬ: 90–100 мл/м² и 200 г/м²", {
    a: oldAP.map((r) => ({ label: r.label, value: r.value, where: `Habez Pro, ${r.from}`, unit: unitOf(r.value) })),
    b: newAP.map((r) => ({ label: r.label, value: r.value, where: `№1, ${r.from}, коммит ${r.trace.introCommit} (${r.trace.upstream})`, unit: unitOf(r.value) })),
    same_property: "ключ тот же (consumption)", same_condition: "у старого «при однослойном нанесении», у нового условия нет",
    same_unit: "нет: l/m2 (объём) и kg/m2 (масса); пересчёт не делается", replacement_proven: "«200 г/м² вместо 90–100 мл/м²» — в сообщении коммита b4866a5; на этикетке (коммит 4f97b6e) расход записан как «около 200 грамм на 1 м²»",
    evidence: "в самом №1 ярлык до сих пор 90–100 мл/м², таблица — 200 г/м²", unresolved: "замена или другое свойство (D5)", decision: "D5",
  });
  const stA = cardRow("standart", (r) => r.key === "adhesion_strength").map((r) => {
    const a1 = app1Row("standart", (x) => x.from === r.from && x.label === r.label)[0];
    return { label: r.label, value: r.value, from: r.from, unit: unitOf(r.value), comparator: parseSpecValue(r.value).comparator, commit: a1?.trace.introCommit, upstream: a1?.trace.upstream, app1_head: a1?.value };
  });
  caseOf("STANDART-ADHESION", "СТАНДАРТ: 0,5 МПа и ≥0,6 МПа", {
    rows: stA,
    same_source: stA.every((r) => r.commit === stA[0]?.commit) ? `да: обе строки из одного коммита ${stA[0]?.commit} (${stA[0]?.upstream}) — один и тот же исходный документ противоречит сам себе` : "нет",
    assertion_type: "обе — нижние границы: у ярлыка «не менее» стоит в подписи, у таблицы — в значении; ни одна не помечена как норма ГОСТ",
    declared_vs_norm: "нет оснований: в тексте нет слов «норма», «ГОСТ требует», «фактически». Разнести по declared/norm значит выдумать тип утверждения",
    coexist: "да, как два наблюдения одного свойства в статусе «ждёт решения». Логически «≥0,6» не противоречит «≥0,5», но заявленный минимум у завода один",
    legacy_api: "старый путь отдаёт 0,6 МПа (перенос берёт таблицу вместо ярлыка) — это правило кода, не утверждённая истина",
    decision: "D1",
  });
  const gkl = ["gkl", "gklv", "gklo", "gklvo"].map((slug) => ({
    slug,
    thickness_legacy: specs.find((s) => s.product_id === products.find((p) => p.slug === slug)?.id && s.spec_key === "thickness")?.display_value ?? null,
    variants: variants.filter((v) => v.slug === slug).map((v) => ({ id: v.id, unit: v.unit, pack_size: v.pack_size, per_pallet: v.per_pallet })),
    gtin: app1Row(slug, (r) => /GTIN|NTIN/.test(r.label)).map((r) => `${r.label}: ${r.value}`),
  }));
  caseOf("GKL-VARIANTS", "ГКЛ: 9,5 мм и 12,5 мм", {
    rows: gkl,
    conclusion: "в ai_product_specs толщина хранится одной строкой товара «9,5 мм / 12,5 мм» (текст, не число) — значения не смешаны, но и не разнесены; фасовки 9,5 и 12,5 мм в variants отдельные; в модели наблюдений ключи per_pallet / gtin / ntin только с фасовкой — перезаписать друг друга не могут (тесты)",
  });
  const ages = specs.filter((s) => /compressive_strength/.test(s.spec_key)).map((s) => ({ product: productById.get(s.product_id)?.slug, key: s.spec_key, value: s.display_value, from: s.imported_from }));
  const ageRows = products.flatMap((p) => cardItems(p).filter((it) => /\d+\s*сут/.test(it.label)).map((it) => ({ product: p.slug, label: it.label, value: it.value, key: it.key })));
  caseOf("AGE-7-28", "7 и 28 суток", {
    legacy_keys: ages, card_rows_with_age: ageRows,
    conclusion: "в старом слое возраст зашит в ключ (compressive_strength_28d) или стоит только в подписи и строка не сопоставлена (ключ null); значений 7 и 28 суток одного ключа нет — спора нет. В модели наблюдений возраст — условие age_days с цитатой",
  });
  const kor = products.find((p) => p.slug === "koroed");
  const korSection = JSON.parse(kor?.sections || "[]").find((s) => /мешок/.test(s.text || ""));
  caseOf("KOROED-WATER", "КОРОЕД: 5–7 л на 1 мешок", {
    legacy: specs.filter((s) => s.product_id === kor?.id && s.spec_key === "water_ratio").map((s) => ({ value: s.display_value, unit: s.normalized_unit, from: s.imported_from, ref: s.source_ref })),
    section: korSection ? { title: korSection.title, quote: (korSection.text.match(/[^.]*мешок[^.]*\./) || [""])[0].trim() } : null,
    conclusion: "в старом слое основание «на мешок» потеряно (5–7 l, нормализатор ждёт l/kg); в модели наблюдений — условие per=bag с цитатой «на 1 мешок», без привязки к фасовке 25 кг и без пересчёта в л/кг",
    decision: "D10",
  });
}

// ── Итоги ────────────────────────────────────────────────────────────────
const count = (arr, f) => arr.filter(f).length;
const byOrigin = new Map();
for (const l of legacy) {
  if (!byOrigin.has(l.origin)) byOrigin.set(l.origin, []);
  byOrigin.get(l.origin).push(l);
}
const provTable = [...byOrigin.entries()].sort((a, b) => b[1].length - a[1].length).map(([origin, list]) => ({
  origin, count: list.length,
  public_eligible: count(list, (l) => l.decision.publishable),
  verified: count(list, (l) => l.spec.verification_status === "verified"),
  unknown: count(list, (l) => l.origin.startsWith("unknown") || l.prov.sourceType !== "product_card"),
  on_storefront: count(list, (l) => l.onStorefront),
}));
const cardEvidence = count(legacy, (l) => l.prov.sourceType === "product_card");
const unknownUpstream = count(legacy, (l) => l.origin.startsWith("unknown"));
const conflictSpecIds = new Set(register.filter((r) => r.source_id.startsWith("ai_product_specs#")).map((r) => Number(r.source_id.split("#")[1])));
for (const r of register.filter((x) => x.current_status?.startsWith("legacy_active") && x.source_id.startsWith("habez-pro-card:"))) {
  const s = specs.find((x) => x.spec_key === r.spec_key && productById.get(x.product_id)?.slug === r.product);
  if (s) conflictSpecIds.add(s.id);
}
const needsManual = new Set([...conflictSpecIds, ...legacy.filter((l) => l.origin.startsWith("unknown") || l.intentional).map((l) => l.spec.id)]);
const reasons = {};
for (const l of legacy) if (!l.decision.publishable) reasons[l.decision.reason] = (reasons[l.decision.reason] || 0) + 1;
const reasonsIfPublic = {};
for (const l of legacy) if (!l.asIfPublic.publishable) reasonsIfPublic[l.asIfPublic.reason] = (reasonsIfPublic[l.asIfPublic.reason] || 0) + 1;
const hiddenByImporter = register.filter((r) => r.current_status?.startsWith("hidden_by_importer"));
const candidates = register.filter((r) => r.decision_required === "D-APP1-DOC");

// Резолвер на старых данных: у каждого свойства одно наблюдение — спора
// быть не может, и это само по себе показывает, что старый слой спор скрывает.
const legacyResolved = count(legacy, (l) => resolveGroup([{ ...l.proposed, originalValue: l.spec.display_value, statementType: "unknown",
  value: { num: l.spec.value_num, min: l.spec.value_min, max: l.spec.value_max, bool: l.spec.value_bool === null ? null : !!l.spec.value_bool, text: l.spec.value_text },
  normalizedUnit: l.spec.normalized_unit, comparator: l.spec.comparator }]).current?.status === "agreed");

const summary = {
  generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
  database: "только чтение",
  app1: app1Available ? `история products.json: ${versions.length} версий, последняя ${head.hash} (${head.date})` : "недоступно",
  legacy_records: specs.length,
  product_card_evidence: cardEvidence,
  not_product_card_evidence: specs.length - cardEvidence,
  unknown_upstream_origin: unknownUpstream,
  requires_manual_reconciliation: needsManual.size,
  public_eligible_now: count(legacy, (l) => l.decision.publishable),
  public_blockers: reasons,
  public_blockers_if_access_were_public: reasonsIfPublic,
  displayed_on_storefront: count(legacy, (l) => l.onStorefront),
  previously_planned_public: specs.length,
  single_value_per_property_in_legacy: legacyResolved,
  conflict_groups: groups.size,
  conflict_groups_by_kind: [...groups.values()].reduce((a, g) => ({ ...a, [g.kind]: (a[g.kind] || 0) + 1 }), {}),
  hidden_by_importer: hiddenByImporter.length,
  candidate_replacements: candidates.length,
  generated_default: count(pallets, (x) => !x.confirmed),
  pallet_confirmed: count(pallets, (x) => x.confirmed),
  intentional_divergence: count(legacy, (l) => l.intentional),
};

// ── Вывод ────────────────────────────────────────────────────────────────
const hr = (t) => console.log(`\n══ ${t} ${"═".repeat(Math.max(0, 70 - t.length))}`);
console.log("[reconcile] СВЕРКА ТОЛЬКО НА ЧТЕНИЕ: база открыта readOnly, приложение №1 — git log / git show");
console.log(summary.app1);

hr("1. Происхождение старых записей");
console.log("origin".padEnd(52), "count  public-eligible  verified  unknown  на витрине");
for (const r of provTable) console.log(r.origin.padEnd(52), String(r.count).padStart(5), String(r.public_eligible).padStart(16), String(r.verified).padStart(9), String(r.unknown).padStart(8), String(r.on_storefront).padStart(11));
console.log(`\nдоказанно из карточки Habez Pro: ${cardEvidence} · не доказано: ${specs.length - cardEvidence}`);
console.log(`происхождение выше карточки неизвестно: ${unknownUpstream} · требуют ручной сверки: ${needsManual.size}`);

hr("2. Публикация");
console.log(`публикуемых по правилу сейчас: ${summary.public_eligible_now} из ${specs.length}`);
console.log(`почему нет (перенос делает internal): ${JSON.stringify(reasons)}`);
console.log(`почему нет, даже если бы доступ был public: ${JSON.stringify(reasonsIfPublic)}`);
console.log(`видно на витрине сейчас (строка в опубликованной карточке): ${summary.displayed_on_storefront}`);
console.log(`в плане 2.2B были бы public: ${specs.length} → после исправления: 0 (все internal до решения D9)`);

hr("3. Конфликты");
for (const [kind, n] of Object.entries(summary.conflict_groups_by_kind)) console.log(`${kind}: ${n} групп`);
console.log(`скрыто переносом (в ai_product_specs не попало): ${hiddenByImporter.length} строк`);
for (const r of hiddenByImporter) console.log(`  ${r.product} · ${r.spec_key}: скрыто «${r.value}» (${r.label}); отдаётся другое значение`);
console.log(`кандидатов на замену (в №1 изменено документом завода): ${candidates.length}`);
for (const r of candidates) console.log(`  ${r.product} · ${r.spec_key}: «${r.value}» — ${r.current_status.replace("legacy_active; ", "")}`);

hr("4. Обязательные случаи");
for (const c of cases) console.log(`\n[${c.id}] ${c.title}\n${JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => !["id", "title"].includes(k))), null, 1)}`);

hr("5. Поддоны");
console.log(`per_pallet заполнен: ${pallets.length} · подтверждено карточкой: ${summary.pallet_confirmed} · подставлено seed.js: ${summary.generated_default}`);
for (const r of register.filter((x) => x.conflict_group === "PALLET:confirmed")) console.log(`  ✓ ${r.product} ${r.variant} = ${r.value} ← ${r.current_status.replace("подтверждено карточкой: ", "")} · выше карточки: ${r.upstream_origin}${r.app1_commit ? ` (${r.app1_commit}, ${r.source_date})` : ""}`);
console.log(`  ✗ 40 без источника: ${pallets.filter((p) => !p.confirmed).map((x) => x.variant.slug).join(", ")}`);

hr("6. Приватность отчёта");
const leaks = register.filter((r) => Object.values(r).some((v) => personalDataIn(v))).length + cases.filter((c) => personalDataIn(JSON.stringify(c))).length;
console.log(`почта или телефон в реестре: ${leaks}`);

hr("Итог");
console.log(JSON.stringify(summary, null, 1));

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const payload = { summary, provenance: provTable, groups: [...groups.values()], register, cases,
    legacy: legacy.map((l) => ({ spec_id: l.spec.id, product: l.product?.slug, spec_key: l.spec.spec_key, value: l.spec.display_value,
      unit: l.spec.normalized_unit, card_row: l.prov.row ? `${l.prov.row.from}/${l.prov.row.ref}/${l.prov.row.label}` : null,
      extraction: l.prov.sourceType, upstream: l.trace.upstream, app1_commit: l.trace.introCommit ?? null, app1_date: l.trace.introDate ?? null,
      app1_changed: l.trace.changedIn ?? null, origin: l.origin, verification: l.spec.verification_status,
      proposed_access: l.proposed.accessLevel, publishable: l.decision.publishable, blocker: l.decision.reason, intentional: l.intentional })) };
  if (personalDataIn(JSON.stringify(payload))) { console.error("В реестре найдены личные данные — файлы не записаны"); process.exit(1); }
  writeFileSync(join(outDir, "habez-ai-reconciliation-register.json"), JSON.stringify(payload, null, 1) + "\n");
  const md = [
    "# Habez AI — реестр сверки (Phase 2.2C)", "",
    `Сформирован: ${summary.generated_at}. Команда: \`npm --prefix api run ai:reconcile-dry-run -- --out ../docs\`. Только чтение. Машиночитаемая версия — \`habez-ai-reconciliation-register.json\`.`, "",
    "## Происхождение 726 старых записей", "",
    "| origin | count | public-eligible | verified | unknown | на витрине |", "|---|---:|---:|---:|---:|---:|",
    ...provTable.map((r) => `| ${r.origin} | ${r.count} | ${r.public_eligible} | ${r.verified} | ${r.unknown} | ${r.on_storefront} |`), "",
    "## Реестр конфликтов", "",
    "Победитель не выбирается. `source_date` — дата коммита в приложении №1 (когда значение записано), а не дата документа.", "",
    "| group | product | variant | spec_key | value | unit | condition | assertion | source_type | upstream | source_id | source_date | verification | access | current_status | proposed_action | decision |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...register.map((r) => `| ${r.conflict_group} | ${r.product} | ${r.variant ?? "—"} | ${r.spec_key} | ${String(r.value).replace(/\|/g, "/")} | ${r.unit ?? "—"} | ${r.condition ?? "—"} | ${r.assertion_type} | ${r.source_type} | ${r.upstream_origin} | ${r.source_id} | ${r.source_date ?? "—"} | ${r.verification} | ${r.access_level} | ${String(r.current_status).replace(/\|/g, "/")} | ${r.proposed_action} | ${r.decision_required} |`),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "HABEZ-AI-RECONCILIATION-REGISTER.md"), md);
  console.log(`\nРеестр записан: ${join(outDir, "HABEZ-AI-RECONCILIATION-REGISTER.md")} и .json`);
}
db.close();
console.log("\nREAL DATA CHANGED: NO (база открыта только на чтение)");
