// Habez AI, Phase 2.2B — наблюдения и связи по HTTP. Права те же, что у
// слоя знаний: читает и заводит наблюдения менеджер; подтверждает и
// связывает («B заменяет A») — администратор. Каждое изменение — в audit_log.
// Существующие /api/ai/specs и /api/ai/products/* не меняются.
import { z } from "zod";
import { all, insert, json } from "../../db/index.js";
import {
  createObservation, observationById, listObservations, setObservationVerification,
  addRelation, productEvidence,
} from "../knowledge/evidence.js";
import { VERIFICATION_STATUSES } from "../knowledge/model.js";
import { forbidden } from "../../lib/errors.js";
import {
  EVIDENCE_SOURCE_TYPES, STATEMENT_TYPES, ACCESS_LEVELS, PROVIDED_BY_ROLES, LIFECYCLE_STATUSES,
  RELATION_TYPES, RELATION_BASES, CONDITION_KEYS, VARIANT_KEYS,
} from "../knowledge/evidence-model.js";

function audit(req, action, entityId, diff) {
  insert("audit_log", {
    tenant_id: req.tenant.id, actor_id: req.user?.id ?? null,
    action, entity: "ai_observation", entity_id: String(entityId ?? ""), diff: diff ?? {}, ip: req.ip,
  });
}

export default async function aiEvidenceRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));
  const admin = { onRequest: [app.requireAuth("admin")] };

  app.get("/api/ai/evidence/meta", async () => ({
    sourceTypes: EVIDENCE_SOURCE_TYPES, statementTypes: STATEMENT_TYPES, accessLevels: ACCESS_LEVELS,
    providedBy: PROVIDED_BY_ROLES, lifecycle: LIFECYCLE_STATUSES, relationTypes: RELATION_TYPES,
    relationBases: RELATION_BASES, conditionKeys: CONDITION_KEYS, variantKeys: VARIANT_KEYS,
  }));

  app.get("/api/ai/observations", async (req) => {
    const q = z.object({
      productId: z.coerce.number().int().optional(),
      variantId: z.coerce.number().int().optional(),
      specKey: z.string().max(80).optional(),
      sourceType: z.enum(EVIDENCE_SOURCE_TYPES).optional(),
      statementType: z.enum(STATEMENT_TYPES).optional(),
      status: z.enum(VERIFICATION_STATUSES).optional(),
      lifecycle: z.enum(LIFECYCLE_STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return listObservations(req.tenant.id, q, req.user.role);
  });

  app.get("/api/ai/observations/:id", async (req) =>
    ({ observation: observationById(req.tenant.id, Number(req.params.id), req.user.role) }));

  app.get("/api/ai/products/:id/evidence", async (req) =>
    productEvidence(req.tenant.id, Number(req.params.id), req.user.role));

  app.post("/api/ai/observations", async (req, reply) => {
    const b = z.object({
      productId: z.number().int().positive(),
      variantId: z.number().int().positive().optional(),
      specKey: z.string().min(1).max(80),
      label: z.string().max(200).optional(),
      conditions: z.record(z.union([z.string().max(120), z.number()])).optional(),
      conditionText: z.string().max(300).optional(),
      statementType: z.enum(STATEMENT_TYPES).default("unknown"),
      originalValue: z.string().min(1).max(500),
      sourceType: z.enum(EVIDENCE_SOURCE_TYPES),
      sourceId: z.number().int().positive().optional(),
      sourceName: z.string().max(200).optional(),
      sourceReference: z.string().max(200).optional(),
      providedBy: z.enum(PROVIDED_BY_ROLES).optional(),
      providedAt: z.string().max(19).optional(),
      accessLevel: z.enum(ACCESS_LEVELS).default("internal"),
      evidenceNote: z.string().max(1000).optional(),
      evidenceRef: z.string().max(300).optional(),
      extractionConfidence: z.number().int().min(0).max(100).optional(),
    }).strict().parse(req.body);
    // Менеджер не заводит конфиденциальное: он бы его потом не увидел.
    if (b.accessLevel === "confidential" && !["admin", "owner"].includes(req.user.role)) {
      throw forbidden("Конфиденциальные наблюдения заводит администратор");
    }
    const o = createObservation(req.tenant.id, b, req.user.id);
    audit(req, "ai.observation.create", o.id, {
      product: o.product.name, key: o.specKey, value: o.originalValue, condition: o.conditionKey || null,
      statement: o.statementType, sourceType: o.sourceType, sourceReference: o.sourceReference,
    });
    reply.code(201);
    return { observation: o };
  });

  app.patch("/api/ai/observations/:id/verification", admin, async (req) => {
    const b = z.object({ status: z.enum(VERIFICATION_STATUSES), note: z.string().max(1000).optional() }).parse(req.body);
    const { observation, before } = setObservationVerification(req.tenant.id, Number(req.params.id), b.status, req.user.id, b.note);
    audit(req, "ai.observation.verification", observation.id, { was: before.verification_status, now: observation.verificationStatus, note: b.note ?? null });
    return { observation };
  });

  app.post("/api/ai/observations/:id/relations", admin, async (req, reply) => {
    const b = z.object({
      toObservationId: z.number().int().positive(),
      relationType: z.enum(RELATION_TYPES),
      basis: z.enum(RELATION_BASES),
      basisNote: z.string().max(1000).optional(),
      sourceReference: z.string().max(200).optional(),
    }).strict().parse(req.body);
    const r = addRelation(req.tenant.id, Number(req.params.id), b, req.user.id);
    audit(req, "ai.observation.relation", r.from.id, {
      relation: b.relationType, to: r.to.id, basis: b.basis,
      superseded: r.before.lifecycle_status !== r.to.lifecycleStatus ? r.to.id : undefined,
    });
    reply.code(201);
    return { relationId: r.relationId, from: r.from, to: r.to };
  });

  app.get("/api/ai/observations/:id/history", async (req) => {
    const id = Number(req.params.id);
    observationById(req.tenant.id, id, req.user.role);
    return {
      items: all(
        `SELECT a.id, a.action, a.diff, a.created_at, u.name AS actor
           FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
          WHERE a.tenant_id=? AND a.entity='ai_observation' AND a.entity_id=?
          ORDER BY a.id DESC LIMIT 100`, req.tenant.id, String(id))
        .map((a) => ({ ...a, diff: json(a.diff, {}) })),
    };
  });
}
