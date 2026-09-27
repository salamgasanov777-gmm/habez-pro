// Habez AI, 3.5 Competitor Intelligence (roadmap: Phase 3 — Competitors):
// словари, права, журнал и проверки — общие для всех модулей слоя.
// Правила достоверности — те же, что у модели наблюдений 2.2B
// (knowledge/evidence-model.js); здесь они не копируются, а используются.
//
// Контекст вызова: { tenantId, role, actorId, ip }. Каждая функция слоя
// сама проверяет права — так правила действуют и для будущих вызовов мимо
// HTTP (как в knowledge/facts.js).
import { z } from "zod";
import { get, insert } from "../../db/index.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { roleRank } from "../../plugins/auth.js";
import { ACCESS_LEVELS, personalDataIn } from "../knowledge/evidence-model.js";

export const COMPANY_KINDS = ["manufacturer", "brand_owner", "dealer", "distributor", "retail_chain", "marketplace", "unknown"];
// Запись о компании сама по себе не делает её конкурентом.
export const COMPETITOR_STATUSES = ["competitor", "not_competitor", "unknown"];
export const REGION_KINDS = ["country", "district", "region", "city", "other"];
export const MARKET_STATUSES = ["active", "discontinued", "unknown"];
export const ENTITY_LIFECYCLE = ["active", "withdrawn"];
export const OBSERVATION_LIFECYCLE = ["active", "superseded", "withdrawn"];

// Вид документа для внешнего факта — подмножество видов 2.2B. Нет:
// карточки Habez Pro, сайта и прайса нашего завода, ручного ввода без
// документа, подставленного программой, вывода модели и записи без
// первоисточника — у сведения о конкуренте должен быть документ.
export const COMPETITOR_SOURCE_TYPES = ["technical_document", "quality_passport", "label", "marking_card", "factory_catalog", "price_list", "public_source", "measurement"];

export const PRICE_KINDS = ["retail", "wholesale", "dealer", "rrp", "promo", "marketplace"];
// Основа цены: за что цена. Цены с разной основой не сравниваются и не
// пересчитываются друг в друга («за мешок 25 кг» ≠ «за кг»).
export const BASIS_UNITS = ["pack", "kg", "l", "m2", "pcs", "other"];
export const VAT = ["with_vat", "without_vat", "unknown"];

export const ANALOG_RELATIONS = ["analog", "partial_analog", "not_analog"];
export const ANALOG_BASES = ["explicit_source_statement", "user_decision"];
// Статус связи вычисляется, а не хранится (как в Phase 3.4).
export const ANALOG_STATUSES = ["CONFIRMED", "INFERRED", "UNKNOWN", "CONFLICTED"];

// Имя для уникальности и поиска: SQLite не приводит кириллицу к одному
// регистру сам.
export const nameKey = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[«»"“”„']/g, " ").replace(/\s+/g, " ").trim();
export const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Кто что видит. Гость, покупатель, дилер — ничего о конкурентах;
// менеджер — public + internal; администратор и владелец — всё.
export function scopeOf(role) {
  const r = roleRank[role] ?? 0;
  if (r >= roleRank.admin) return "admin";
  if (r >= roleRank.manager) return "staff";
  return "public";
}
export const levelsFor = (role) => (scopeOf(role) === "admin" ? ACCESS_LEVELS : scopeOf(role) === "staff" ? ACCESS_LEVELS.filter((l) => l !== "confidential") : []);

function checkCtx(ctx) {
  if (!ctx || !Number.isInteger(ctx.tenantId)) throw new Error("competitors: нужен контекст с tenantId");
}
export function requireReader(ctx) {
  checkCtx(ctx);
  const levels = levelsFor(ctx.role);
  if (!levels.length) throw forbidden("Сведения о конкурентах доступны сотрудникам");
  return levels;
}
// Вносит и меняет сведения только администратор (и владелец).
export function requireWriter(ctx) {
  checkCtx(ctx);
  if (scopeOf(ctx.role) !== "admin") throw forbidden("Сведения о конкурентах вносит администратор");
}

// Проверка входа схемой Zod — ошибка понятным текстом.
export function parse(schema, input) {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw badRequest(`Некорректное поле ${i.path.join(".") || "запроса"}: ${i.message}`);
  }
  return r.data;
}
export const zId = z.number().int().positive();
export const zText = (max = 200) => z.string().trim().min(1).max(max);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата вида 2026-09-26");
export const zAccess = z.enum(ACCESS_LEVELS);

// Личные контакты в свободных полях не храним (правило 2.2B).
export function assertNoPersonalData(input, fields) {
  for (const f of fields) {
    const found = personalDataIn(input[f]);
    if (found) throw badRequest(`В поле ${f} найден ${found}. Личные контакты в сведениях о конкурентах не храним`);
  }
}

// Журнал панели (audit_log) — в той же транзакции, что и запись.
export function audit(ctx, action, entity, entityId, diff = {}) {
  insert("audit_log", {
    tenant_id: ctx.tenantId, actor_id: ctx.actorId ?? null, action, entity,
    entity_id: String(entityId ?? ""), diff, ip: ctx.ip ?? null,
  });
}

// Строка своей компании (tenant) — иначе notFound. Уровень доступа строки
// проверяется для таблиц, где он есть.
export function rowOf(ctx, table, id, { what = "Запись", levels = null } = {}) {
  const row = get(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`, id, ctx.tenantId);
  if (!row) throw notFound(`${what} не найдена`);
  if (levels && row.access_level && !levels.includes(row.access_level)) throw notFound(`${what} не найдена`);
  return row;
}

// Изменённые поля: было → стало (для журнала).
export function diffOf(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v && !["updated_at", "name_key"].includes(k)) out[k] = { was: before[k] ?? null, now: v ?? null };
  return out;
}
