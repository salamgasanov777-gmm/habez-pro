// Habez AI, Phase 2.2D: механизм сверки и исправления данных.
//
//   buildPlan()    — только чтение: что будет записано, что сохранится,
//                    отпечаток плана (plan.hash).
//   applyPlan()    — запись одной транзакцией; только при совпадении
//                    подтверждённого отпечатка плана с пересчитанным.
//   rollbackRun()  — откат прогона по журналу, тоже одной транзакцией.
//
// Операции (docs/HABEZ-AI-PHASE-2-2D-IMPLEMENTATION-PLAN.md, часть 1):
//   R1 — 29 значений per_pallet = 40 → NULL (только с withPallets);
//        историческое «40» сохраняется наблюдением generated_default;
//   R2 — наблюдения: 726 старых строк + скрытые переносом строки карточки
//        + наблюдения плана (evidence-plan.js);
//   R3 / R4 — первоисточник известен / не доказан (поле source_type R2);
//   R5 — вопросы сверки (ai_reconciliation_items) и их участники;
//   R6 — статус unresolved у каждого нового вопроса;
//   R7 — проекция считается при чтении и в базу не пишется.
//
// Никогда: связей «заменяет», подтверждения, public, правок ai_product_specs,
// правок приложения №1.
import { createHash, randomBytes } from "node:crypto";
import { all, get, insert, run, tx, db } from "../../db/index.js";
import { createObservation, legacyObservationInput } from "./evidence.js";
import { cardItems } from "./legacy-provenance.js";
import { parseSpecValue } from "./units.js";
import { canonicalConditions, upstreamSourceType } from "./evidence-model.js";
import { resolveGroup } from "./evidence-resolve.js";
import { projectResolution } from "./evidence-projection.js";
import { REPAIRS, AUTO_CONFLICT_DECISIONS } from "./evidence-plan.js";

const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export const REQUIRED_TABLES = ["ai_spec_observations", "ai_observation_relations", "ai_reconciliation_items",
  "ai_reconciliation_members", "ai_repair_runs", "ai_repair_changes"];
export const FINGERPRINT_TABLES = ["ai_product_specs", "variants", "products", "ai_facts", "ai_sources",
  "ai_spec_observations", "ai_observation_relations", "ai_reconciliation_items", "ai_reconciliation_members"];

export function tablesReady() {
  const have = new Set(all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  return REQUIRED_TABLES.filter((t) => !have.has(t));
}

// Отпечаток таблицы: строки в порядке первичного ключа. У products берутся
// только содержательные поля: счётчик просмотров (views) и updated_at меняет
// сама витрина, и из-за каждого просмотра карточки подтверждённый план
// переставал бы совпадать, а откат — отказывал.
const FINGERPRINT_COLUMNS = {
  products: "id, tenant_id, category_id, slug, sku, name, short_name, summary, gost, brand, status, badges, sections, spec_tables, tasks, calc, attributes, position",
};
export function fingerprint(tables = FINGERPRINT_TABLES) {
  const out = {};
  for (const t of tables) out[t] = sha(all(`SELECT ${FINGERPRINT_COLUMNS[t] || "*"} FROM "${t}" ORDER BY 1`)).slice(0, 24);
  return out;
}

export function counts(tenantId) {
  const n = (sql, ...p) => get(sql, ...p).n;
  return {
    ai_product_specs: n("SELECT COUNT(*) AS n FROM ai_product_specs WHERE tenant_id=?", tenantId),
    observations: n("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE tenant_id=?", tenantId),
    observations_legacy: n("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE tenant_id=? AND legacy_spec_id IS NOT NULL", tenantId),
    observations_public: n("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE tenant_id=? AND access_level='public'", tenantId),
    observations_verified: n("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE tenant_id=? AND verification_status='verified'", tenantId),
    relations: n("SELECT COUNT(*) AS n FROM ai_observation_relations WHERE tenant_id=?", tenantId),
    items: n("SELECT COUNT(*) AS n FROM ai_reconciliation_items WHERE tenant_id=?", tenantId),
    items_unresolved: n("SELECT COUNT(*) AS n FROM ai_reconciliation_items WHERE tenant_id=? AND status='unresolved'", tenantId),
    members: n("SELECT COUNT(*) AS n FROM ai_reconciliation_members m JOIN ai_reconciliation_items i ON i.id=m.item_id WHERE i.tenant_id=?", tenantId),
    per_pallet_40: n("SELECT COUNT(*) AS n FROM variants WHERE tenant_id=? AND per_pallet=40", tenantId),
    per_pallet_null: n("SELECT COUNT(*) AS n FROM variants WHERE tenant_id=? AND per_pallet IS NULL", tenantId),
    variants: n("SELECT COUNT(*) AS n FROM variants WHERE tenant_id=?", tenantId),
  };
}

// ── Манифест первоисточников ───────────────────────────────────────────────
// Это JSON реестра сверки (reconcile-dry-run.js --out). Исправление не
// ходит в приложение №1 само: оно берёт уже проверенный человеком файл.
export function loadManifest(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const legacy = new Map((data.legacy || []).map((l) => [l.spec_id, l]));
  const hidden = new Map((data.register || [])
    .filter((r) => String(r.current_status || "").startsWith("hidden_by_importer"))
    .map((r) => [`${r.product}|${r.spec_key}|${r.label}|${r.value}`, r]));
  return { hash: sha(data).slice(0, 24), legacy, hidden, summary: data.summary ?? null };
}

// Отпечаток содержания наблюдения переноса: если по тому же backfill_key
// содержание другое — данные разошлись, прогон останавливается.
export const backfillFingerprint = (input, cond = "") => sha([
  input.productId, input.variantId ?? null, input.specKey, cond, String(input.originalValue).trim(),
  input.sourceType, input.sourceReference ?? null,
]).slice(0, 24);

function onlyBagVariant(productId) {
  const vs = all("SELECT id, unit FROM variants WHERE product_id=? AND is_active=1", productId);
  const bags = vs.filter((v) => /мешок/i.test(v.unit));
  return vs.length === 1 && bags.length === 1 ? bags[0].id : null;
}

const hasPalletRow = (product) => cardItems(product).some((i) => /поддон|паллет/i.test(i.label));

// ── План ───────────────────────────────────────────────────────────────────
export function buildPlan(tenantId, { manifest = null, withPallets = false } = {}) {
  const missing = tablesReady();
  if (missing.length) return { errors: [`нет таблиц: ${missing.join(", ")} — сначала npm run migrate`], hash: null };

  const errors = [];
  const products = new Map(all("SELECT id, slug, name, badges, spec_tables FROM products WHERE tenant_id=?", tenantId).map((p) => [p.id, p]));
  const bySlug = new Map([...products.values()].map((p) => [p.slug, p]));
  const specs = all("SELECT s.*, src.name AS source_name FROM ai_product_specs s LEFT JOIN ai_sources src ON src.id=s.source_id WHERE s.tenant_id=? ORDER BY s.id", tenantId);
  const existingByKey = new Map(all("SELECT id, backfill_key, backfill_fingerprint FROM ai_spec_observations WHERE tenant_id=? AND backfill_key IS NOT NULL", tenantId).map((r) => [r.backfill_key, r]));

  const inserts = [];   // { op, backfillKey, fingerprint, input, internal, legacySpec }
  const preserved = []; // { op, backfillKey, id }
  const plan = (op, input, internal, legacySpec = null) => {
    let cond;
    try { cond = canonicalConditions(input.conditions || {}).key; } catch (e) { errors.push(`${internal.backfillKey}: ${e.message}`); return; }
    const fp = backfillFingerprint(input, cond);
    const have = existingByKey.get(internal.backfillKey);
    if (have) {
      if (have.backfill_fingerprint !== fp) errors.push(`${internal.backfillKey}: содержание изменилось с прошлого прогона (было ${have.backfill_fingerprint}, стало ${fp})`);
      else preserved.push({ op, backfillKey: internal.backfillKey, id: have.id });
      return;
    }
    inserts.push({ op, backfillKey: internal.backfillKey, fingerprint: fp, conditionKey: cond, input, internal: { ...internal, backfillFingerprint: fp }, legacySpec });
  };

  // Манифест должен описывать именно эти строки: иначе первоисточник
  // припишется не тому значению.
  if (manifest) {
    for (const [specId, m] of manifest.legacy) {
      const s = specs.find((x) => x.id === specId);
      const p = s && products.get(s.product_id);
      if (!s || !p || p.slug !== m.product || s.spec_key !== m.spec_key || s.display_value !== m.value) {
        errors.push(`манифест: строка ai_product_specs#${specId} не совпадает (${m.product} · ${m.spec_key} · «${m.value}»)`);
      }
    }
    if (manifest.legacy.size !== specs.length) errors.push(`манифест описывает ${manifest.legacy.size} строк, в базе ${specs.length}`);
  }

  // R2 (+R3/R4): старые строки.
  for (const s of specs) {
    const { input, internal } = legacyObservationInput(s, products.get(s.product_id), manifest?.legacy.get(s.id) ?? null);
    plan("R2-legacy", input, internal, s);
  }

  // R2: строки карточки, которые перенос 2.2 скрыл (второе значение ключа).
  for (const p of products.values()) {
    const items = cardItems(p).filter((it) => it.key && !it.skipped);
    const byKey = new Map();
    for (const it of items) { if (!byKey.has(it.key)) byKey.set(it.key, []); byKey.get(it.key).push(it); }
    for (const [key, list] of byKey) {
      const meaning = (it) => { const v = parseSpecValue(it.value); return JSON.stringify([v.valueNum, v.valueMin, v.valueMax, v.valueBool, v.normalizedUnit, v.valueText ?? null]); };
      if (new Set(list.map(meaning)).size < 2) continue;
      const spec = specs.find((s) => s.product_id === p.id && s.spec_key === key);
      for (const it of list) {
        if (spec && spec.imported_from === it.from && spec.source_ref === it.ref && spec.display_value === it.display) continue;
        const m = manifest?.hidden.get(`${p.slug}|${key}|${it.label}|${it.value}`);
        const sourceType = upstreamSourceType(m?.upstream_origin);
        plan("R2-hidden", {
          productId: p.id, specKey: key, label: it.label, conditions: {}, statementType: "unknown", originalValue: it.value,
          sourceType,
          sourceReference: sourceType !== "unknown_legacy_origin" && m?.app1_commit ? `app1-commit-${m.app1_commit}` : `habez-pro-card#${p.slug}/${it.from}/${it.ref}/${it.label}`,
          accessLevel: "internal",
          evidenceNote: `строка карточки, которую перенос 2.2 не взял (взята другая строка того же ключа); первоисточник: ${m?.upstream_origin ?? "не установлен"}`,
        }, {
          captureChannel: "habez_pro_product_card", captureRef: `${it.from} / ${it.ref} / ${it.label}`,
          upstreamRef: m?.app1_commit ? `app1-commit-${m.app1_commit}` : null, upstreamRecordedAt: m?.source_date ?? null,
          backfillKey: `card-row:${p.id}:${it.from}:${it.ref}:${it.label}`,
        });
      }
    }
  }

  // R2: наблюдения плана (D2–D5, D10).
  for (const r of REPAIRS) {
    const p = bySlug.get(r.product);
    if (!p) { errors.push(`план ${r.id}: товар ${r.product} не найден`); continue; }
    const input = { ...r.observation, productId: p.id };
    if (r.variantRule === "only_bag_variant") {
      const v = onlyBagVariant(p.id);
      if (!v) { errors.push(`план ${r.id}: у товара не одна фасовка-мешок — фасовку по правилу D10 выбрать нельзя`); continue; }
      input.variantId = v;
    }
    plan("R2-plan", input, {
      captureChannel: "repair_plan", captureRef: `evidence-plan.js#${r.id}`,
      upstreamRef: r.upstream?.ref ?? null, upstreamRecordedAt: r.upstream?.recordedAt ?? null,
      backfillKey: `plan:${r.id}`,
    });
  }

  // R1: 29 значений «40 на поддоне», подставленных seed.js.
  const pallets = [];
  const palletPreserved = [];
  for (const v of all("SELECT v.*, p.slug FROM variants v JOIN products p ON p.id=v.product_id WHERE v.tenant_id=? AND v.per_pallet IS NOT NULL ORDER BY v.id", tenantId)) {
    const p = products.get(v.product_id);
    if (hasPalletRow(p)) { palletPreserved.push({ variantId: v.id, slug: v.slug, unit: v.unit, value: v.per_pallet, reason: "есть строка «на поддоне» в карточке" }); continue; }
    if (v.per_pallet === 40 && v.pack_unit === "кг" && v.pack_size >= 25) pallets.push({ variantId: v.id, productId: v.product_id, slug: v.slug, unit: v.unit, before: 40 });
    else palletPreserved.push({ variantId: v.id, slug: v.slug, unit: v.unit, value: v.per_pallet, reason: "не похоже на правило seed.js — не трогаем" });
  }
  if (withPallets) {
    for (const x of pallets) {
      plan("R1-pallet", {
        productId: x.productId, variantId: x.variantId,
        specKey: "per_pallet", originalValue: "40", statementType: "unknown", sourceType: "generated_default",
        sourceReference: "api/src/db/seed.js: per_pallet = 40 для мешка от 25 кг (до 25.09.2026)", accessLevel: "internal",
        evidenceNote: "значение подставлено программой при заполнении базы; завод не давал. Из variants убрано операцией R1",
      }, { captureChannel: "variants_record", captureRef: `variants#${x.variantId}.per_pallet`, backfillKey: `pallet-default:${x.variantId}` });
    }
  }

  // R5 / R6: вопросы сверки. Спор ищется по всем наблюдениям — уже
  // записанным и запланированным.
  const pseudo = [];
  let synthetic = -1;
  const idOf = new Map(); // backfillKey → id (реальный или отрицательный)
  for (const o of all("SELECT * FROM ai_spec_observations WHERE tenant_id=?", tenantId)) {
    if (o.backfill_key) idOf.set(o.backfill_key, o.id);
    pseudo.push({ id: o.id, productId: o.product_id, variantId: o.variant_id, specKey: o.spec_key, conditionKey: o.condition_key,
      statementType: o.statement_type, sourceType: o.source_type, lifecycleStatus: o.lifecycle_status, verificationStatus: o.verification_status,
      originalValue: o.original_value, value: { num: o.value_num, min: o.value_min, max: o.value_max, bool: o.value_bool === null ? null : !!o.value_bool, text: o.value_text },
      normalizedUnit: o.normalized_unit, comparator: o.comparator, legacySpecId: o.legacy_spec_id });
  }
  for (const ins of inserts) {
    const id = synthetic--;
    idOf.set(ins.backfillKey, id);
    const ls = ins.legacySpec;
    const v = ls ? { valueNum: ls.value_num, valueMin: ls.value_min, valueMax: ls.value_max, valueBool: ls.value_bool === null ? null : !!ls.value_bool, valueText: ls.value_text, normalizedUnit: ls.normalized_unit, comparator: ls.comparator }
      : ins.input.specKey === "per_pallet" ? { valueNum: 40, valueMin: null, valueMax: null, valueBool: null, valueText: null, normalizedUnit: "pcs", comparator: "exact" }
        : parseSpecValue(ins.input.originalValue);
    pseudo.push({ id, productId: ins.input.productId, variantId: ins.input.variantId ?? null, specKey: ins.input.specKey, conditionKey: ins.conditionKey,
      statementType: ins.input.statementType || "unknown", sourceType: ins.input.sourceType, lifecycleStatus: "active", verificationStatus: "unverified",
      originalValue: String(ins.input.originalValue).trim(), value: { num: v.valueNum, min: v.valueMin, max: v.valueMax, bool: v.valueBool, text: v.valueText },
      normalizedUnit: v.normalizedUnit, comparator: v.comparator, legacySpecId: ls?.id ?? null, backfillKey: ins.backfillKey });
  }
  const groups = new Map();
  for (const o of pseudo) {
    const k = `${o.productId}|${o.variantId ?? ""}|${o.specKey}|${o.conditionKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const existingItems = new Set(all("SELECT item_key FROM ai_reconciliation_items WHERE tenant_id=?", tenantId).map((r) => r.item_key));
  const items = [];
  const itemsPreserved = [];
  const addItem = (item) => (existingItems.has(item.itemKey) ? itemsPreserved.push(item.itemKey) : items.push(item));
  const resolutions = new Map();
  for (const [k, list] of groups) {
    const res = resolveGroup(list);
    resolutions.set(k, res);
    if (res.current?.status !== "pending_user_decision") continue;
    const [pid, vid, specKey, cond] = k.split("|");
    const p = products.get(Number(pid));
    const d = AUTO_CONFLICT_DECISIONS[`${p.slug}:${specKey}`];
    addItem({
      itemKey: `AUTO:${p.slug}:${vid || "-"}:${specKey}:${cond}`, kind: "value_conflict", decisionRef: d?.decision ?? "не назначено",
      productId: p.id, variantId: vid ? Number(vid) : null, specKey, relatedSpecKey: null, conditionKey: cond,
      note: d?.note ?? `разные значения одного свойства (${res.current.reason}); победителя нет`,
      members: res.current.observationIds.map((id) => ({ id, role: "member" })),
    });
  }
  for (const r of REPAIRS) {
    if (r.item.kind === "value_conflict") continue; // такой спор уже найден автоматически
    const p = bySlug.get(r.product);
    const legacy = specs.find((s) => s.product_id === p?.id && s.spec_key === r.legacyKey);
    const olderId = legacy ? idOf.get(`legacy-spec:${legacy.id}`) : null;
    const newerId = idOf.get(`plan:${r.id}`);
    if (!p || !olderId || !newerId) { errors.push(`вопрос ${r.decision} (${r.id}): нет одного из участников`); continue; }
    const cond = canonicalConditions(r.observation.conditions || {}).key;
    addItem({
      itemKey: `${r.decision.split(",")[0]}:${r.product}:${r.legacyKey}${r.observation.specKey !== r.legacyKey ? `~${r.observation.specKey}` : ""}`,
      kind: r.item.kind, decisionRef: r.decision, productId: p.id, variantId: null, specKey: r.legacyKey,
      relatedSpecKey: r.observation.specKey !== r.legacyKey ? r.observation.specKey : null, conditionKey: cond,
      note: r.item.note, members: [{ id: olderId, role: "older" }, { id: newerId, role: "newer" }],
    });
  }

  // R7: как изменится старая проекция в режиме evidence (в базу не пишется).
  const dbItems = all("SELECT * FROM ai_reconciliation_items WHERE tenant_id=? AND status='unresolved'", tenantId).map((i) => ({
    itemKey: i.item_key, productId: i.product_id, variantId: i.variant_id, specKey: i.spec_key, relatedSpecKey: i.related_spec_key,
    members: all("SELECT observation_id AS id FROM ai_reconciliation_members WHERE item_id=?", i.id),
  }));
  const projection = [];
  for (const s of specs) {
    const k = `${s.product_id}||${s.spec_key}|`;
    const res = resolutions.get(k);
    const open = [...items, ...dbItems]
      .filter((i) => i.productId === s.product_id && (i.specKey === s.spec_key || i.relatedSpecKey === s.spec_key) && !i.variantId)
      .map((i) => ({ key: i.itemKey, values: i.members.map((m) => pseudo.find((o) => o.id === m.id)?.originalValue).filter(Boolean) }));
    const pr = projectResolution(res?.current ?? null, open);
    const same = (pr.status === "agreed") && pr.value && pr.value.displays.includes(s.display_value) && pr.value.num === s.value_num && pr.value.min === s.value_min;
    if (!same) projection.push({ specId: s.id, product: products.get(s.product_id).slug, specKey: s.spec_key, legacy: s.display_value, status: pr.status, display: pr.displayValue, items: open.map((o) => o.key) });
  }

  const canonical = {
    tenantId, withPallets, manifest: manifest?.hash ?? null,
    inserts: inserts.map((i) => [i.op, i.backfillKey, i.fingerprint]),
    pallets: withPallets ? pallets.map((x) => x.variantId) : [],
    items: items.map((i) => [i.itemKey, i.kind, i.members.map((m) => m.role)]),
    db: fingerprint(["ai_product_specs", "variants", "products", "ai_spec_observations", "ai_reconciliation_items", "ai_observation_relations"]),
  };
  const byOp = (op) => inserts.filter((i) => i.op === op);
  return {
    tenantId, withPallets, errors, hash: sha(canonical).slice(0, 16), manifestHash: manifest?.hash ?? null,
    inserts, preserved, items, itemsPreserved, pallets: withPallets ? pallets : [], palletCandidates: pallets, palletPreserved, projection,
    summary: {
      R1_pallets_to_null: withPallets ? pallets.length : 0,
      R1_pallet_candidates: pallets.length,
      R2_legacy: byOp("R2-legacy").length,
      R2_hidden_card_rows: byOp("R2-hidden").length,
      R2_plan: byOp("R2-plan").length,
      R1_pallet_history_observations: byOp("R1-pallet").length,
      R3_known_source: byOp("R2-legacy").filter((i) => i.input.sourceType !== "unknown_legacy_origin").length,
      R4_unknown_source: byOp("R2-legacy").filter((i) => i.input.sourceType === "unknown_legacy_origin").length,
      R5_items: items.length,
      R6_unresolved: items.length,
      R7_projection_changes: projection.length,
      preserved_observations: preserved.length,
      preserved_items: itemsPreserved.length,
      relations_to_create: 0,
      verifications_to_create: 0,
      public_to_create: 0,
    },
  };
}

// ── Запись ─────────────────────────────────────────────────────────────────
// fail-fast: любая ошибка внутри — ROLLBACK всей транзакции (tx). Копия базы
// до записи — файлом рядом с базой (backupPath), если он задан.
export function applyPlan(tenantId, { manifest = null, withPallets = false, confirmHash, actor = "cli", backupPath = null } = {}) {
  const plan = buildPlan(tenantId, { manifest, withPallets });
  if (plan.errors.length) throw new Error(`план с ошибками, запись отменена:\n  ${plan.errors.join("\n  ")}`);
  if (!confirmHash || confirmHash !== plan.hash) {
    throw new Error(`отпечаток плана ${plan.hash} не совпадает с подтверждённым (${confirmHash ?? "—"}): сначала прогон без записи, затем --confirm ${plan.hash}`);
  }
  if (backupPath) db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  const runId = `rr-${now().replace(/[- :]/g, "")}-${randomBytes(3).toString("hex")}`;
  const startedAt = now();
  const countsBefore = counts(tenantId);
  const fpBefore = fingerprint();
  const confirmedBefore = plan.palletPreserved.map((x) => [x.variantId, get("SELECT per_pallet FROM variants WHERE id=?", x.variantId).per_pallet]);
  const variantsOtherBefore = sha(all("SELECT id, tenant_id, product_id, sku, unit, pack_size, pack_unit, weight_kg, barcode, is_default, is_active, position FROM variants ORDER BY id"));

  return tx(() => {
    // Запись прогона — первой: на неё ссылается журнал изменений. Итоги
    // дописываются в конце той же транзакции.
    insert("ai_repair_runs", {
      id: runId, tenant_id: tenantId, operations: withPallets ? "R1,R2,R3,R4,R5,R6" : "R2,R3,R4,R5,R6",
      plan_hash: plan.hash, manifest_hash: plan.manifestHash, status: "applying",
      counts_before: JSON.stringify(countsBefore), counts_after: "{}",
      fingerprint_before: JSON.stringify(fpBefore), fingerprint_after: "{}",
      backup_file: backupPath, actor, started_at: startedAt, finished_at: startedAt,
    });
    const idOf = new Map(plan.preserved.map((p) => [p.backfillKey, p.id]));
    for (const ins of plan.inserts) {
      const o = createObservation(tenantId, ins.input, null, { legacySpec: ins.legacySpec, internal: { ...ins.internal, runId } });
      idOf.set(ins.backfillKey, o.id);
    }
    for (const x of plan.pallets) {
      const r = run("UPDATE variants SET per_pallet=NULL WHERE id=? AND tenant_id=? AND per_pallet=40", x.variantId, tenantId);
      if (Number(r.changes) !== 1) throw new Error(`variants#${x.variantId}: per_pallet уже не 40 — прогон остановлен`);
      insert("ai_repair_changes", { run_id: runId, table_name: "variants", row_id: x.variantId, column_name: "per_pallet", before_value: "40", after_value: null, note: "R1: generated_default → NULL" });
    }
    // Синтетические номера плана → настоящие.
    const plannedIds = new Map(plan.inserts.map((ins, i) => [-(i + 1), idOf.get(ins.backfillKey)]));
    for (const item of plan.items) {
      const itemId = insert("ai_reconciliation_items", {
        tenant_id: tenantId, item_key: item.itemKey, kind: item.kind, decision_ref: item.decisionRef,
        product_id: item.productId, variant_id: item.variantId, spec_key: item.specKey, related_spec_key: item.relatedSpecKey,
        condition_key: item.conditionKey, status: "unresolved", rule_note: item.note, created_by_run: runId,
      });
      for (const m of item.members) {
        const obsId = m.id < 0 ? plannedIds.get(m.id) : m.id;
        if (!obsId) throw new Error(`вопрос ${item.itemKey}: участник не записан`);
        insert("ai_reconciliation_members", { item_id: itemId, observation_id: obsId, role: m.role });
      }
    }

    // Проверки до COMMIT: всё, что обещано «не меняется», не изменилось.
    const countsAfter = counts(tenantId);
    const fpAfter = fingerprint();
    const expect = (cond, msg) => { if (!cond) throw new Error(`проверка не прошла: ${msg}`); };
    expect(fpAfter.ai_product_specs === fpBefore.ai_product_specs, "ai_product_specs изменилась");
    expect(fpAfter.products === fpBefore.products, "products изменилась");
    expect(fpAfter.ai_facts === fpBefore.ai_facts && fpAfter.ai_sources === fpBefore.ai_sources, "ai_facts / ai_sources изменились");
    expect(fpAfter.ai_observation_relations === fpBefore.ai_observation_relations, "созданы связи");
    expect(countsAfter.observations - countsBefore.observations === plan.inserts.length, "число новых наблюдений не равно плану");
    expect(countsAfter.items - countsBefore.items === plan.items.length, "число новых вопросов не равно плану");
    expect(get("SELECT COUNT(*) AS n FROM ai_spec_observations WHERE created_by_run=? AND (verification_status<>'unverified' OR access_level<>'internal')", runId).n === 0, "новое наблюдение проверено или не internal");
    expect(countsBefore.per_pallet_40 - countsAfter.per_pallet_40 === plan.pallets.length, "число очищенных поддонов не равно плану");
    expect(sha(all("SELECT id, tenant_id, product_id, sku, unit, pack_size, pack_unit, weight_kg, barcode, is_default, is_active, position FROM variants ORDER BY id")) === variantsOtherBefore, "в variants изменилось что-то кроме per_pallet");
    for (const [id, val] of confirmedBefore) expect(get("SELECT per_pallet FROM variants WHERE id=?", id).per_pallet === val, `подтверждённый поддон variants#${id} изменился`);
    if (!withPallets) expect(fpAfter.variants === fpBefore.variants, "variants изменилась без --with-pallets");

    run("UPDATE ai_repair_runs SET status='applied', counts_after=?, fingerprint_after=?, finished_at=? WHERE id=?",
      JSON.stringify(countsAfter), JSON.stringify(fpAfter), now(), runId);
    insert("audit_log", {
      tenant_id: tenantId, actor_id: null, action: "ai.reconcile.apply", entity: "ai_repair_run", entity_id: runId,
      diff: JSON.stringify({ plan: plan.hash, summary: plan.summary, backup: backupPath }), ip: null,
    });
    return { runId, plan, countsBefore, countsAfter, fingerprintBefore: fpBefore, fingerprintAfter: fpAfter };
  });
}

// ── Откат ──────────────────────────────────────────────────────────────────
export function rollbackRun(tenantId, runId, { actor = "cli" } = {}) {
  const r = get("SELECT * FROM ai_repair_runs WHERE id=? AND tenant_id=?", runId, tenantId);
  if (!r) throw new Error(`прогон ${runId} не найден`);
  if (r.status !== "applied") throw new Error(`прогон ${runId} уже в статусе ${r.status}`);
  return tx(() => {
    const later = get(`SELECT COUNT(*) AS n FROM ai_observation_relations rel JOIN ai_spec_observations o
        ON o.id IN (rel.from_observation_id, rel.to_observation_id) WHERE o.created_by_run=?`, runId).n;
    if (later) throw new Error(`на наблюдения прогона уже ссылаются связи (${later}) — откат остановлен`);
    const laterMembers = get(`SELECT COUNT(*) AS n FROM ai_reconciliation_members m JOIN ai_spec_observations o ON o.id=m.observation_id
        JOIN ai_reconciliation_items i ON i.id=m.item_id WHERE o.created_by_run=? AND (i.created_by_run IS NOT ? )`, runId, runId).n;
    if (laterMembers) throw new Error(`на наблюдения прогона ссылаются вопросы других прогонов (${laterMembers}) — откат остановлен`);
    for (const c of all("SELECT * FROM ai_repair_changes WHERE run_id=? ORDER BY id DESC", runId)) {
      if (c.table_name !== "variants" || c.column_name !== "per_pallet") throw new Error(`неизвестное изменение ${c.table_name}.${c.column_name}`);
      const cur = get("SELECT per_pallet FROM variants WHERE id=?", c.row_id);
      if (!cur || (cur.per_pallet === null ? null : String(cur.per_pallet)) !== c.after_value) {
        throw new Error(`variants#${c.row_id}: значение изменили после прогона — откат остановлен`);
      }
      run("UPDATE variants SET per_pallet=? WHERE id=?", c.before_value === null ? null : Number(c.before_value), c.row_id);
    }
    const members = run("DELETE FROM ai_reconciliation_members WHERE item_id IN (SELECT id FROM ai_reconciliation_items WHERE created_by_run=?)", runId).changes;
    const items = run("DELETE FROM ai_reconciliation_items WHERE created_by_run=?", runId).changes;
    const obs = run("DELETE FROM ai_spec_observations WHERE created_by_run=?", runId).changes;
    const before = JSON.parse(r.fingerprint_before);
    const after = fingerprint();
    for (const t of ["ai_product_specs", "variants", "products", "ai_spec_observations", "ai_reconciliation_items", "ai_reconciliation_members"]) {
      if (after[t] !== before[t]) throw new Error(`после отката ${t} не совпадает с состоянием до прогона — откат отменён`);
    }
    run("UPDATE ai_repair_runs SET status='rolled_back', rolled_back_at=? WHERE id=?", now(), runId);
    insert("audit_log", {
      tenant_id: tenantId, actor_id: null, action: "ai.reconcile.rollback", entity: "ai_repair_run", entity_id: runId,
      diff: JSON.stringify({ observations: Number(obs), items: Number(items), members: Number(members), actor }), ip: null,
    });
    return { runId, deleted: { observations: Number(obs), items: Number(items), members: Number(members) } };
  });
}

// ── Отчёт прогона без записи ──────────────────────────────────────────────
export function formatPlan(plan, extra = {}) {
  const L = [];
  const s = plan.summary;
  L.push(`ОТПЕЧАТОК ПЛАНА: ${plan.hash}${plan.manifestHash ? ` · манифест ${plan.manifestHash}` : " · манифест не задан (все первоисточники — unknown)"}`);
  if (plan.errors.length) { L.push("\nОШИБКИ (запись будет отклонена):"); plan.errors.forEach((e) => L.push(`  ✗ ${e}`)); }
  L.push("\n── WOULD CHANGE ──");
  L.push(`  вставить наблюдений: ${plan.inserts.length}`);
  L.push(`    R2 старые строки ai_product_specs: ${s.R2_legacy} (R3 первоисточник известен: ${s.R3_known_source}, R4 не доказан: ${s.R4_unknown_source})`);
  L.push(`    R2 скрытые переносом строки карточки: ${s.R2_hidden_card_rows}`);
  L.push(`    R2 наблюдения плана D2–D5, D10: ${s.R2_plan}`);
  L.push(`    R1 история «40 на поддоне» (generated_default): ${s.R1_pallet_history_observations}`);
  L.push(`  обновить строк variants.per_pallet 40 → NULL (R1): ${s.R1_pallets_to_null}${plan.withPallets ? "" : ` (выключено; кандидатов ${s.R1_pallet_candidates} — нужен --with-pallets)`}`);
  L.push(`  вопросов сверки (R5), все unresolved (R6): ${s.R5_items}`);
  for (const i of plan.items) L.push(`    · ${i.itemKey} [${i.kind}, ${i.decisionRef}] участников ${i.members.length}`);
  L.push("\n── WOULD NOT CHANGE ──");
  L.push(`  ai_product_specs: все строки, побайтно (проверка до COMMIT)`);
  L.push(`  products, ai_facts, ai_sources: без изменений (проверка до COMMIT)`);
  L.push(`  подтверждённые поддоны: ${plan.palletPreserved.map((x) => `${x.slug} «${x.unit}» = ${x.value}`).join("; ") || "—"}`);
  L.push(`  уже записано раньше (повтор не пишет): наблюдений ${s.preserved_observations}, вопросов ${s.preserved_items}`);
  L.push(`  связей «заменяет»: создаётся ${s.relations_to_create} · подтверждений: ${s.verifications_to_create} · public: ${s.public_to_create}`);
  L.push("  приложение №1: не читается и не пишется этой командой");
  L.push("\n── СПОРЫ / НЕРЕШЁННОЕ ──");
  L.push(`  споров значений (value_conflict): ${plan.items.filter((i) => i.kind === "value_conflict").length}`);
  L.push(`  кандидатов на замену: ${plan.items.filter((i) => i.kind === "candidate_replacement").length}`);
  L.push(`  кандидатов «одно свойство»: ${plan.items.filter((i) => i.kind === "semantic_mapping_candidate").length}`);
  L.push("\n── GENERATED DEFAULTS ──");
  L.push(`  «40 на поддоне» без источника: ${s.R1_pallet_candidates} → ${plan.withPallets ? "NULL в variants, история — наблюдение" : "не трогаются без --with-pallets"}`);
  L.push("\n── PUBLIC DEMOTIONS ──");
  L.push(`  наблюдений, которые в плане 2.2B стали бы public, а теперь internal: ${s.R2_legacy}`);
  L.push(`  исчезнет с витрины: ${plan.withPallets ? `строка «На паллете 40 шт» у ${s.R1_pallets_to_null} фасовок` : "ничего (R1 выключен)"}`);
  L.push("\n── PROJECTION CHANGES (режим evidence, в базу не пишется) ──");
  L.push(`  строк старого API, которые отдадут другое: ${s.R7_projection_changes}`);
  for (const p of plan.projection.slice(0, 40)) L.push(`    · ${p.product} · ${p.specKey}: «${p.legacy}» → ${p.status}${p.display ? ` «${p.display}»` : ""}${p.items.length ? ` [${p.items.join(", ")}]` : ""}`);
  if (plan.projection.length > 40) L.push(`    … и ещё ${plan.projection.length - 40}`);
  L.push("\n── ROLLBACK ──");
  L.push("  при ошибке внутри — ROLLBACK транзакции, база как до прогона");
  L.push("  после прогона — npm run ai:reconcile-repair -- --rollback <run_id> (одна транзакция, по журналу ai_repair_changes)");
  L.push("  дополнительно — копия базы VACUUM INTO перед записью");
  if (extra.simulation) L.push(`\n── СИМУЛЯЦИЯ НА КОПИИ ──\n${extra.simulation}`);
  return L.join("\n");
}
