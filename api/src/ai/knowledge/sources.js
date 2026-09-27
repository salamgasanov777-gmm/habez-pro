// Источники сведений: откуда взялось то, что знает Habez AI.
import { all, get, insert, update } from "../../db/index.js";
import { badRequest, notFound, conflict } from "../../lib/errors.js";
import { SOURCE_TYPES, SOURCE_STATUSES, ORIGIN_TRUST } from "./model.js";
import { personalDataIn } from "./evidence-model.js";

// Источник — часть происхождения каждого наблюдения, его название видят все
// сотрудники. Почту и телефон сюда не пишем: «Письмо главного технолога
// завода от 05.09.2026», а не адрес отправителя.
function assertNoPersonalData(fields) {
  for (const [name, value] of Object.entries(fields)) {
    const found = personalDataIn(value);
    if (found) throw badRequest(`В поле ${name} найден ${found} — личные контакты в источниках не храним`);
  }
}

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Базовое доверие по виду источника: прайс завода выше сайта дилера, тот —
// выше новостей. Значение можно переопределить руками при заведении.
const TRUST_BY_TYPE = {
  habez_internal: ORIGIN_TRUST.habez_internal,
  price_list: 85,
  document: 85,
  manufacturer_site: ORIGIN_TRUST.official_manufacturer,
  manual_research: 80,
  dealer_site: ORIGIN_TRUST.official_dealer,
  marketplace: 45,
  news_media: ORIGIN_TRUST.external_source,
};

export function listSources(tenantId, q = {}) {
  const where = ["s.tenant_id=?"];
  const params = [tenantId];
  if (q.status) { where.push("s.status=?"); params.push(q.status); }
  if (q.sourceType) { where.push("s.source_type=?"); params.push(q.sourceType); }
  if (q.search) { where.push("(s.name LIKE ? OR s.url LIKE ? OR s.publisher LIKE ?)"); params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`); }
  const clause = where.join(" AND ");
  const items = all(
    `SELECT s.*, (SELECT COUNT(*) FROM ai_facts f WHERE f.source_id=s.id) AS facts
       FROM ai_sources s WHERE ${clause} ORDER BY s.id DESC LIMIT ?`,
    ...params, q.limit ?? 200).map(view);
  return { items, total: items.length };
}

export function sourceById(tenantId, id) {
  const row = get(
    `SELECT s.*, (SELECT COUNT(*) FROM ai_facts f WHERE f.source_id=s.id) AS facts
       FROM ai_sources s WHERE s.id=? AND s.tenant_id=?`, id, tenantId);
  if (!row) throw notFound("Источник не найден");
  return view(row);
}

export function createSource(tenantId, input, actorId) {
  if (!SOURCE_TYPES.includes(input.sourceType)) throw badRequest(`Неизвестный вид источника: ${input.sourceType}`);
  assertNoPersonalData({ name: input.name, url: input.url, publisher: input.publisher, description: input.description });
  const url = input.url?.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) throw badRequest("Адрес источника должен начинаться с http:// или https://");
  if (url && get("SELECT id FROM ai_sources WHERE tenant_id=? AND url=?", tenantId, url)) {
    throw conflict("Источник с таким адресом уже заведён");
  }
  const id = insert("ai_sources", {
    tenant_id: tenantId,
    source_type: input.sourceType,
    name: input.name,
    url,
    publisher: input.publisher ?? null,
    description: input.description ?? null,
    trust_base: input.trustBase ?? TRUST_BY_TYPE[input.sourceType] ?? 50,
    status: input.status ?? "active",
    created_by: actorId ?? null,
  });
  return sourceById(tenantId, id);
}

export function updateSource(tenantId, id, patch, _actorId) {
  const before = get("SELECT * FROM ai_sources WHERE id=? AND tenant_id=?", id, tenantId);
  if (!before) throw notFound("Источник не найден");

  assertNoPersonalData({ name: patch.name, url: patch.url, publisher: patch.publisher, description: patch.description });
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.publisher !== undefined) next.publisher = patch.publisher;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.trustBase !== undefined) next.trust_base = patch.trustBase;
  if (patch.sourceType !== undefined) {
    if (!SOURCE_TYPES.includes(patch.sourceType)) throw badRequest(`Неизвестный вид источника: ${patch.sourceType}`);
    next.source_type = patch.sourceType;
  }
  if (patch.status !== undefined) {
    if (!SOURCE_STATUSES.includes(patch.status)) throw badRequest(`Неизвестный статус: ${patch.status}`);
    next.status = patch.status;
  }
  if (patch.url !== undefined) {
    const url = patch.url?.trim() || null;
    if (url && !/^https?:\/\//i.test(url)) throw badRequest("Адрес источника должен начинаться с http:// или https://");
    const twin = url ? get("SELECT id FROM ai_sources WHERE tenant_id=? AND url=? AND id<>?", tenantId, url, id) : null;
    if (twin) throw conflict("Источник с таким адресом уже заведён");
    next.url = url;
  }
  if (patch.checked === true) next.last_checked_at = now();

  if (!Object.keys(next).length) return { source: sourceById(tenantId, id), before, changed: [] };
  next.updated_at = now();
  update("ai_sources", id, next);
  return { source: sourceById(tenantId, id), before, changed: Object.keys(next) };
}

function view(row) {
  return {
    id: row.id,
    sourceType: row.source_type,
    name: row.name,
    url: row.url,
    publisher: row.publisher,
    description: row.description,
    trustBase: row.trust_base,
    status: row.status,
    facts: row.facts ?? 0,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
