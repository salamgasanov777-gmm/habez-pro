// Habez AI, фаза 1 — слой знаний по HTTP. Стиль тот же, что у панели:
// Zod на вход, роль хуком на весь модуль, каждое изменение — в audit_log.
//
// Права: читать — менеджер и выше; заводить и править — менеджер (он ведёт
// исследование); подтверждать, отклонять и править источники — администратор.
// Себестоимость, маржа и прочее конфиденциальное сюда не попадает: слой
// знаний работает только с тем, что сам же и записал.
import { z } from "zod";
import { insert } from "../../db/index.js";
import {
  listFacts, factById, createFact, updateFact, setVerification, factsSummary,
} from "../knowledge/facts.js";
import { listSources, sourceById, createSource, updateSource } from "../knowledge/sources.js";
import {
  ORIGINS, VERIFICATION_STATUSES, SOURCE_TYPES, SOURCE_STATUSES,
  SUBJECT_TYPES, FACT_TYPES, STATUS_TRANSITIONS,
} from "../knowledge/model.js";

// История изменений — в общем журнале панели, отдельной таблицы нет.
function audit(req, action, entity, entityId, diff) {
  insert("audit_log", {
    tenant_id: req.tenant.id, actor_id: req.user?.id ?? null,
    action, entity, entity_id: String(entityId ?? ""), diff: diff ?? {}, ip: req.ip,
  });
}

// Что именно изменилось — в журнал идёт только сравнение значений,
// персональных данных в фактах нет и быть не должно.
const diffOf = (before, after, keys) =>
  Object.fromEntries(keys.filter((k) => before?.[k] !== after?.[k]).map((k) => [k, { was: before?.[k] ?? null, now: after?.[k] ?? null }]));

export default async function aiKnowledgeRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));
  const admin = { onRequest: [app.requireAuth("admin")] };

  // ── Справочник значений: словари для панели ──────────────────────────────
  app.get("/api/ai/meta", async () => ({
    origins: ORIGINS,
    statuses: VERIFICATION_STATUSES,
    transitions: STATUS_TRANSITIONS,
    sourceTypes: SOURCE_TYPES,
    sourceStatuses: SOURCE_STATUSES,
    subjectTypes: SUBJECT_TYPES,
    factTypes: FACT_TYPES,
  }));

  app.get("/api/ai/summary", async (req) => factsSummary(req.tenant.id));

  // ── Источники ────────────────────────────────────────────────────────────
  app.get("/api/ai/sources", async (req) => {
    const q = z.object({
      status: z.enum(SOURCE_STATUSES).optional(),
      sourceType: z.enum(SOURCE_TYPES).optional(),
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    return listSources(req.tenant.id, q);
  });

  app.get("/api/ai/sources/:id", async (req) => ({ source: sourceById(req.tenant.id, Number(req.params.id)) }));

  app.post("/api/ai/sources", admin, async (req, reply) => {
    const b = z.object({
      sourceType: z.enum(SOURCE_TYPES),
      name: z.string().min(2).max(200),
      url: z.string().max(500).optional().or(z.literal("")),
      publisher: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      trustBase: z.number().int().min(0).max(100).optional(),
      status: z.enum(SOURCE_STATUSES).optional(),
    }).parse(req.body);
    const source = createSource(req.tenant.id, b, req.user.id);
    audit(req, "ai.source.create", "ai_source", source.id, { name: source.name, sourceType: source.sourceType, url: source.url });
    reply.code(201);
    return { source };
  });

  app.patch("/api/ai/sources/:id", admin, async (req) => {
    const b = z.object({
      sourceType: z.enum(SOURCE_TYPES).optional(),
      name: z.string().min(2).max(200).optional(),
      url: z.string().max(500).optional().or(z.literal("")),
      publisher: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      trustBase: z.number().int().min(0).max(100).optional(),
      status: z.enum(SOURCE_STATUSES).optional(),
      checked: z.boolean().optional(),
    }).parse(req.body);
    const { source, before } = updateSource(req.tenant.id, Number(req.params.id), b, req.user.id);
    audit(req, "ai.source.update", "ai_source", source.id,
      diffOf(before, { ...before, ...b }, ["name", "url", "publisher", "source_type", "status", "trust_base"]));
    return { source };
  });

  // ── Факты ────────────────────────────────────────────────────────────────
  app.get("/api/ai/facts", async (req) => {
    const q = z.object({
      factType: z.enum(FACT_TYPES).optional(),
      subjectType: z.enum(SUBJECT_TYPES).optional(),
      subjectId: z.coerce.number().int().optional(),
      sourceId: z.coerce.number().int().optional(),
      status: z.enum(VERIFICATION_STATUSES).optional(),
      origin: z.enum(ORIGINS).optional(),
      from: z.string().max(30).optional(),
      to: z.string().max(30).optional(),
      search: z.string().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    return listFacts(req.tenant.id, q);
  });

  app.get("/api/ai/facts/:id", async (req) => ({ fact: factById(req.tenant.id, Number(req.params.id)) }));

  // История факта — выборка из общего журнала панели.
  app.get("/api/ai/facts/:id/history", async (req) => {
    const id = Number(req.params.id);
    factById(req.tenant.id, id);   // проверка принадлежности компании
    const { all, json } = await import("../../db/index.js");
    return {
      items: all(
        `SELECT a.id, a.action, a.diff, a.created_at, u.name AS actor
           FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
          WHERE a.tenant_id=? AND a.entity='ai_fact' AND a.entity_id=?
          ORDER BY a.id DESC LIMIT 200`, req.tenant.id, String(id))
        .map((a) => ({ ...a, diff: json(a.diff, {}) })),
    };
  });

  app.post("/api/ai/facts", async (req, reply) => {
    const b = z.object({
      factType: z.enum(FACT_TYPES),
      subjectType: z.enum(SUBJECT_TYPES),
      subjectId: z.number().int().positive().optional(),
      attribute: z.string().min(2).max(200),
      valueText: z.string().max(4000).optional(),
      valueNum: z.number().optional(),
      valueJson: z.record(z.any()).optional(),
      unit: z.string().max(40).optional(),
      sourceId: z.number().int().positive().optional(),
      sourceUrl: z.string().max(500).optional(),
      snapshotRef: z.string().max(500).optional(),
      origin: z.enum(ORIGINS),
      confidence: z.number().int().min(0).max(100).optional(),
      observedAt: z.string().max(30).optional(),
      recheckAfter: z.string().max(30).optional(),
      supersedesFactId: z.number().int().positive().optional(),
    }).parse(req.body);

    const fact = createFact(req.tenant.id, b, req.user.id);
    audit(req, "ai.fact.create", "ai_fact", fact.id, {
      subject: `${fact.subject.type}#${fact.subject.id ?? "—"}`, attribute: fact.attribute,
      value: fact.value.text ?? fact.value.num, origin: fact.origin, sourceId: fact.source?.id ?? null,
    });
    reply.code(201);
    return { fact };
  });

  app.patch("/api/ai/facts/:id", async (req) => {
    const b = z.object({
      attribute: z.string().min(2).max(200).optional(),
      valueText: z.string().max(4000).nullable().optional(),
      valueNum: z.number().nullable().optional(),
      valueJson: z.record(z.any()).nullable().optional(),
      unit: z.string().max(40).nullable().optional(),
      sourceId: z.number().int().positive().optional(),
      sourceUrl: z.string().max(500).nullable().optional(),
      confidence: z.number().int().min(0).max(100).optional(),
      recheckAfter: z.string().max(30).nullable().optional(),
    }).parse(req.body);
    const { fact, before, changed } = updateFact(req.tenant.id, Number(req.params.id), b, req.user.id);
    audit(req, "ai.fact.update", "ai_fact", fact.id, {
      changed, was: { value: before.value_text ?? before.value_num, unit: before.unit, attribute: before.attribute },
      now: { value: fact.value.text ?? fact.value.num, unit: fact.value.unit, attribute: fact.attribute },
      statusReset: before.verification_status === "verified" && fact.verificationStatus === "unverified" || undefined,
    });
    return { fact };
  });

  // Смена статуса проверки — отдельным маршрутом: это не «правка поля»,
  // а решение человека, и в журнале оно должно выглядеть отдельно.
  app.patch("/api/ai/facts/:id/verification", admin, async (req) => {
    const b = z.object({
      status: z.enum(VERIFICATION_STATUSES),
      note: z.string().max(1000).optional(),
    }).parse(req.body);
    const { fact, before } = setVerification(req.tenant.id, Number(req.params.id), b.status, req.user.id, b.note);
    audit(req, "ai.fact.verification", "ai_fact", fact.id,
      { was: before.verification_status, now: fact.verificationStatus, origin: fact.origin, note: b.note ?? null });
    return { fact };
  });
}
