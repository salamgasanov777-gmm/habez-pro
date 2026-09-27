// Общие операции справочника (регион, компания, марка, товар, фасовка):
// создать, изменить, снять. Удаления нет: снятая запись остаётся с
// причиной, в журнале — кто и когда. Каждая запись в базу — в транзакции
// вместе со строкой журнала.
import { insert, update, tx } from "../../db/index.js";
import { conflict, badRequest } from "../../lib/errors.js";
import { requireWriter, rowOf, audit, diffOf, now } from "./model.js";
import { VERIFICATION_STATUSES, canTransition } from "../knowledge/model.js";

const uniqueError = (e) => /UNIQUE constraint failed/.test(String(e?.message));

export function createEntity(ctx, { table, what, action, row, auditFields }) {
  requireWriter(ctx);
  try {
    return tx(() => {
      const id = insert(table, { tenant_id: ctx.tenantId, ...row, created_by: ctx.actorId ?? null });
      audit(ctx, `${action}.create`, table, id, Object.fromEntries(auditFields.map((f) => [f, row[f] ?? null])));
      return id;
    });
  } catch (e) {
    if (uniqueError(e)) throw conflict(`${what} с таким названием уже есть`);
    throw e;
  }
}

export function updateEntity(ctx, { table, what, action, id, patch }) {
  requireWriter(ctx);
  const before = rowOf(ctx, table, id, { what });
  if (before.lifecycle_status !== "active") throw badRequest(`${what} снята — изменять её нельзя`);
  const changes = diffOf(before, patch);
  if (!Object.keys(changes).length) return before;
  try {
    tx(() => {
      update(table, id, { ...patch, updated_at: now() });
      audit(ctx, `${action}.update`, table, id, changes);
    });
  } catch (e) {
    if (uniqueError(e)) throw conflict(`${what} с таким названием уже есть`);
    throw e;
  }
  return rowOf(ctx, table, id, { what });
}

// Снять запись: строка остаётся, в выборке «действующих» её нет.
export function withdrawEntity(ctx, { table, what, action, id, reason }) {
  requireWriter(ctx);
  if (!String(reason ?? "").trim()) throw badRequest("Укажите причину, по которой запись снимается");
  const before = rowOf(ctx, table, id, { what });
  if (before.lifecycle_status === "withdrawn") return before;
  tx(() => {
    update(table, id, { lifecycle_status: "withdrawn", withdrawn_reason: String(reason).trim().slice(0, 500), updated_at: now() });
    audit(ctx, `${action}.withdraw`, table, id, { reason: String(reason).trim().slice(0, 500) });
  });
  return rowOf(ctx, table, id, { what });
}

// Проверка наблюдения или цены человеком — по тем же переходам, что у
// фактов и наблюдений (knowledge/model.js). Значение не меняется, меняются
// только статус проверки, кто и когда (разрешено триггером).
export function setVerification(ctx, { table, what, action, id, status, note }) {
  requireWriter(ctx);
  const row = rowOf(ctx, table, id, { what });
  if (row.lifecycle_status !== "active") throw badRequest(`${what} не действует — менять проверку нельзя`);
  if (!VERIFICATION_STATUSES.includes(status)) throw badRequest(`Неизвестный статус проверки: ${status}`);
  if (row.verification_status === status) return row;
  if (!canTransition(row.verification_status, status)) throw badRequest(`Переход «${row.verification_status} → ${status}» не разрешён`);
  tx(() => {
    update(table, id, { verification_status: status, verified_by: status === "verified" ? ctx.actorId ?? null : null, verified_at: status === "verified" ? now() : null, updated_at: now() });
    audit(ctx, `${action}.verification`, table, id, { was: row.verification_status, now: status, note: String(note ?? "").trim().slice(0, 500) || null });
  });
  return rowOf(ctx, table, id, { what });
}
