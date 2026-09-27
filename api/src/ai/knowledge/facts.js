// Работа с фактами: запись, изменение, смена статуса проверки.
// Все правила достоверности проверяются здесь, а не в маршрутах, — тогда
// они действуют и для будущих агентов, которые пойдут мимо HTTP.
import { createHash } from "node:crypto";
import { all, get, insert, update, run } from "../../db/index.js";
import { badRequest, notFound, conflict } from "../../lib/errors.js";
import {
  ORIGINS, ORIGINS_NEVER_VERIFIED, VERIFICATION_STATUSES, canTransition,
  defaultConfidence, recheckAfter, FACT_TYPES, SUBJECT_TYPES,
} from "./model.js";

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Хеш значения: та же величина из того же источника не записывается дважды
// (на это же стоит уникальный индекс в схеме).
export const contentHash = (f) =>
  createHash("sha256")
    .update([f.subject_type, f.subject_id ?? "", f.attribute, f.value_text ?? "", f.value_num ?? "", f.unit ?? "", f.value_json ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 32);

// Объект, на который ссылается факт, обязан существовать и принадлежать той
// же компании. Иначе фактом можно было бы указать на чужой товар и прочитать
// его название через subject_label.
export function resolveSubject(tenantId, subjectType, subjectId) {
  if (!SUBJECT_TYPES.includes(subjectType)) throw badRequest(`Неизвестный тип объекта: ${subjectType}`);
  if (subjectType === "market") return { label: "рынок" };
  if (subjectType === "company") {
    const t = get("SELECT name FROM tenants WHERE id=?", tenantId);
    return { label: t?.name || "компания" };
  }
  if (!subjectId) throw badRequest("Для этого типа объекта нужен subjectId");

  const table = { product: "products", variant: "variants", category: "categories" }[subjectType];
  if (subjectType === "variant") {
    const v = get(`SELECT v.id, v.unit, p.name FROM variants v JOIN products p ON p.id=v.product_id
                    WHERE v.id=? AND v.tenant_id=?`, subjectId, tenantId);
    if (!v) throw notFound("Фасовка не найдена");
    return { label: `${v.name} · ${v.unit}` };
  }
  const row = get(`SELECT name FROM ${table} WHERE id=? AND tenant_id=?`, subjectId, tenantId);
  if (!row) throw notFound(subjectType === "product" ? "Товар не найден" : "Раздел не найден");
  return { label: row.name };
}

// Источник обязателен для всего, кроме вывода модели: у сведения должно быть
// происхождение, которое можно открыть и проверить.
function resolveSource(tenantId, sourceId, origin) {
  if (!sourceId) {
    if (origin === "ai_inference") return null;
    throw badRequest("Нужен источник: без него сведение проверить нельзя");
  }
  const src = get("SELECT * FROM ai_sources WHERE id=? AND tenant_id=?", sourceId, tenantId);
  if (!src) throw notFound("Источник не найден");
  if (src.status === "archived") throw badRequest("Источник в архиве: выберите действующий");
  return src;
}

export function createFact(tenantId, input, actorId) {
  if (!FACT_TYPES.includes(input.factType)) throw badRequest(`Неизвестный тип факта: ${input.factType}`);
  if (!ORIGINS.includes(input.origin)) throw badRequest(`Неизвестное происхождение: ${input.origin}`);
  if (input.valueText == null && input.valueNum == null && input.valueJson == null) {
    throw badRequest("Пустой факт: нужно значение");
  }

  const subject = resolveSubject(tenantId, input.subjectType, input.subjectId ?? null);
  const source = resolveSource(tenantId, input.sourceId ?? null, input.origin);

  const observedAt = input.observedAt || now();
  const row = {
    tenant_id: tenantId,
    fact_type: input.factType,
    subject_type: input.subjectType,
    subject_id: input.subjectId ?? null,
    subject_label: subject.label,
    attribute: input.attribute,
    value_text: input.valueText ?? null,
    value_num: input.valueNum ?? null,
    value_json: input.valueJson ? JSON.stringify(input.valueJson) : null,
    unit: input.unit ?? null,
    source_id: source?.id ?? null,
    source_url: input.sourceUrl ?? source?.url ?? null,
    snapshot_ref: input.snapshotRef ?? null,
    origin: input.origin,
    // Новое сведение всегда непроверенное, кем бы оно ни было заведено.
    // Подтверждение — отдельное действие человека, см. setVerification.
    verification_status: "unverified",
    confidence: input.confidence ?? Math.min(defaultConfidence(input.origin), source?.trust_base ?? 100),
    observed_at: observedAt,
    checked_at: null,
    recheck_after: input.recheckAfter || recheckAfter(input.factType, observedAt),
    supersedes_fact_id: input.supersedesFactId ?? null,
    created_by: actorId ?? null,
  };
  row.content_hash = contentHash(row);

  const twin = get(
    `SELECT id FROM ai_facts WHERE tenant_id=? AND subject_type=? AND subject_id IS ? AND attribute=? AND source_id IS ? AND content_hash=?`,
    tenantId, row.subject_type, row.subject_id, row.attribute, row.source_id, row.content_hash);
  if (twin) throw conflict(`Такой факт от этого источника уже записан (№${twin.id})`);

  const id = insert("ai_facts", row);
  if (row.supersedes_fact_id) {
    // Предыдущее значение не удаляем: помечаем устаревшим и оставляем в истории.
    run("UPDATE ai_facts SET verification_status='stale', updated_at=datetime('now') WHERE id=? AND tenant_id=?",
      row.supersedes_fact_id, tenantId);
  }
  return factById(tenantId, id);
}

// Правка значения. Статус проверки здесь не меняется намеренно: изменил
// значение — подтверждение прежнего значения силы не имеет.
export function updateFact(tenantId, id, patch, actorId) {
  const fact = get("SELECT * FROM ai_facts WHERE id=? AND tenant_id=?", id, tenantId);
  if (!fact) throw notFound("Факт не найден");

  const next = {};
  if (patch.attribute !== undefined) next.attribute = patch.attribute;
  if (patch.valueText !== undefined) next.value_text = patch.valueText;
  if (patch.valueNum !== undefined) next.value_num = patch.valueNum;
  if (patch.valueJson !== undefined) next.value_json = patch.valueJson ? JSON.stringify(patch.valueJson) : null;
  if (patch.unit !== undefined) next.unit = patch.unit;
  if (patch.sourceUrl !== undefined) next.source_url = patch.sourceUrl;
  if (patch.confidence !== undefined) next.confidence = patch.confidence;
  if (patch.recheckAfter !== undefined) next.recheck_after = patch.recheckAfter;
  if (patch.sourceId !== undefined) {
    const src = resolveSource(tenantId, patch.sourceId, fact.origin);
    next.source_id = src?.id ?? null;
  }
  if (!Object.keys(next).length) return factById(tenantId, id);

  const valueTouched = ["value_text", "value_num", "value_json", "unit", "attribute"].some((k) => k in next);
  if (valueTouched) {
    next.content_hash = contentHash({ ...fact, ...next });
    if (fact.verification_status === "verified") {
      next.verification_status = "unverified";
      next.verified_by = null;
      next.verified_at = null;
      next.verify_note = `подтверждение снято: значение изменил пользователь №${actorId ?? "—"}`;
    }
  }
  next.updated_at = now();
  update("ai_facts", id, next);
  return { fact: factById(tenantId, id), before: fact, changed: Object.keys(next) };
}

// Смена статуса проверки — единственный способ сделать факт подтверждённым.
export function setVerification(tenantId, id, status, actorId, note) {
  if (!VERIFICATION_STATUSES.includes(status)) throw badRequest(`Неизвестный статус: ${status}`);
  const fact = get("SELECT * FROM ai_facts WHERE id=? AND tenant_id=?", id, tenantId);
  if (!fact) throw notFound("Факт не найден");
  if (fact.verification_status === status) return { fact: factById(tenantId, id), before: fact };

  // Главное правило слоя знаний: вывод модели не становится фактом.
  if (status === "verified" && ORIGINS_NEVER_VERIFIED.includes(fact.origin)) {
    throw badRequest(
      "Вывод AI нельзя подтвердить как факт. Найдите источник и заведите отдельный факт с ним — " +
      "иначе система начнёт ссылаться сама на себя.");
  }
  if (!canTransition(fact.verification_status, status)) {
    throw badRequest(`Нельзя перейти из «${fact.verification_status}» в «${status}»`);
  }
  if (status === "verified" && !fact.source_id) {
    throw badRequest("Подтвердить можно только факт с источником");
  }

  const next = { verification_status: status, updated_at: now() };
  if (status === "verified") {
    next.verified_by = actorId ?? null;
    next.verified_at = now();
    next.checked_at = now();
    next.verify_note = note ?? null;
    // Подтверждённое человеком доверяем не ниже базового доверия источника.
    const src = get("SELECT trust_base FROM ai_sources WHERE id=?", fact.source_id);
    next.confidence = Math.max(fact.confidence, src?.trust_base ?? fact.confidence);
  } else {
    next.verify_note = note ?? null;
    if (status === "rejected" || status === "disputed") next.checked_at = now();
    if (status !== "verified") { next.verified_by = null; next.verified_at = null; }
  }
  update("ai_facts", id, next);
  return { fact: factById(tenantId, id), before: fact };
}

const FIELDS = `f.id, f.fact_type, f.subject_type, f.subject_id, f.subject_label, f.attribute,
  f.value_text, f.value_num, f.value_json, f.unit, f.source_id, f.source_url, f.snapshot_ref,
  f.origin, f.verification_status, f.confidence, f.observed_at, f.checked_at, f.recheck_after,
  f.verified_by, f.verified_at, f.verify_note, f.supersedes_fact_id, f.created_at, f.updated_at`;

export function factById(tenantId, id) {
  const row = get(
    `SELECT ${FIELDS}, s.name AS source_name, s.source_type, u.name AS verified_by_name
       FROM ai_facts f LEFT JOIN ai_sources s ON s.id=f.source_id
       LEFT JOIN users u ON u.id=f.verified_by
      WHERE f.id=? AND f.tenant_id=?`, id, tenantId);
  if (!row) throw notFound("Факт не найден");
  return view(row);
}

export function listFacts(tenantId, q = {}) {
  const where = ["f.tenant_id=?"];
  const params = [tenantId];
  const eq = (sql, value) => { if (value !== undefined && value !== null && value !== "") { where.push(sql); params.push(value); } };
  eq("f.fact_type=?", q.factType);
  eq("f.subject_type=?", q.subjectType);
  eq("f.subject_id=?", q.subjectId);
  eq("f.source_id=?", q.sourceId);
  eq("f.verification_status=?", q.status);
  eq("f.origin=?", q.origin);
  eq("f.observed_at >= ?", q.from);
  eq("f.observed_at <= ?", q.to);
  if (q.search) {
    where.push("(f.attribute LIKE ? OR f.value_text LIKE ? OR f.subject_label LIKE ?)");
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  const clause = where.join(" AND ");
  const total = get(`SELECT COUNT(*) AS n FROM ai_facts f WHERE ${clause}`, ...params).n;
  const limit = q.limit ?? 50;
  const page = q.page ?? 1;
  const items = all(
    `SELECT ${FIELDS}, s.name AS source_name, s.source_type, u.name AS verified_by_name
       FROM ai_facts f LEFT JOIN ai_sources s ON s.id=f.source_id
       LEFT JOIN users u ON u.id=f.verified_by
      WHERE ${clause} ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, (page - 1) * limit).map(view);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}

// Сводка для панели и для будущих агентов: сколько чего и что протухло.
export function factsSummary(tenantId) {
  const byStatus = all("SELECT verification_status AS k, COUNT(*) AS n FROM ai_facts WHERE tenant_id=? GROUP BY k", tenantId);
  const byOrigin = all("SELECT origin AS k, COUNT(*) AS n FROM ai_facts WHERE tenant_id=? GROUP BY k", tenantId);
  return {
    total: get("SELECT COUNT(*) AS n FROM ai_facts WHERE tenant_id=?", tenantId).n,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.k, r.n])),
    byOrigin: Object.fromEntries(byOrigin.map((r) => [r.k, r.n])),
    needsRecheck: get(
      `SELECT COUNT(*) AS n FROM ai_facts WHERE tenant_id=? AND recheck_after IS NOT NULL
         AND recheck_after < datetime('now') AND verification_status NOT IN ('stale','rejected')`, tenantId).n,
    sources: get("SELECT COUNT(*) AS n FROM ai_sources WHERE tenant_id=? AND status='active'", tenantId).n,
  };
}

function view(row) {
  return {
    id: row.id,
    factType: row.fact_type,
    subject: { type: row.subject_type, id: row.subject_id, label: row.subject_label },
    attribute: row.attribute,
    value: { text: row.value_text, num: row.value_num, json: row.value_json ? JSON.parse(row.value_json) : null, unit: row.unit },
    source: row.source_id ? { id: row.source_id, name: row.source_name, type: row.source_type, url: row.source_url } : null,
    snapshotRef: row.snapshot_ref,
    origin: row.origin,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    observedAt: row.observed_at,
    checkedAt: row.checked_at,
    recheckAfter: row.recheck_after,
    // Факт «просрочен» — подсказка Data Quality в фазе 7, считаем на лету.
    outdated: !!row.recheck_after && row.recheck_after < now() && !["stale", "rejected"].includes(row.verification_status),
    verifiedBy: row.verified_by ? { id: row.verified_by, name: row.verified_by_name } : null,
    verifiedAt: row.verified_at,
    verifyNote: row.verify_note,
    supersedesFactId: row.supersedes_fact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
