// Habez AI, фаза 2 — характеристики товаров по HTTP.
// Стиль и права те же, что у слоя знаний: читает менеджер, подтверждает
// администратор, каждое изменение — в общий журнал панели.
import { z } from "zod";
import { insert } from "../../db/index.js";
import {
  listSpecs, specById, createSpec, updateSpec, setSpecVerification,
  productsOverview, productIntelligence, compareProducts, specsSummary,
} from "../knowledge/specs.js";
import { SPEC_KEYS } from "../knowledge/spec-dictionary.js";
import { UNIT_LABEL } from "../knowledge/units.js";
import { ORIGINS, VERIFICATION_STATUSES } from "../knowledge/model.js";
import { config } from "../../config.js";

// Режим чтения (AI_EVIDENCE_READ_MODE): в legacy наложения нет вовсе, и
// ответ побайтно прежний. Модуль проекции грузится только в режиме evidence.
const overlayFor = async (req) => {
  if (config.ai.readMode !== "evidence") return null;
  const { makeEvidenceOverlay } = await import("../knowledge/evidence-projection.js");
  return makeEvidenceOverlay(req.tenant.id, req.user.role);
};

function audit(req, action, entity, entityId, diff) {
  insert("audit_log", {
    tenant_id: req.tenant.id, actor_id: req.user?.id ?? null,
    action, entity, entity_id: String(entityId ?? ""), diff: diff ?? {}, ip: req.ip,
  });
}

const SPEC_KEY_LIST = Object.keys(SPEC_KEYS);

export default async function aiProductRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));
  const admin = { onRequest: [app.requireAuth("admin")] };

  // Словарь характеристик: что вообще бывает и в каких единицах.
  app.get("/api/ai/spec-keys", async () => ({
    items: SPEC_KEY_LIST.map((key) => ({
      key, ...SPEC_KEYS[key], unitLabel: SPEC_KEYS[key].unit ? (UNIT_LABEL[SPEC_KEYS[key].unit] || SPEC_KEYS[key].unit) : null,
    })),
    units: Object.entries(UNIT_LABEL).map(([unit, label]) => ({ unit, label })),
  }));

  app.get("/api/ai/products/summary", async (req) => specsSummary(req.tenant.id));

  // Список товаров: у кого сколько характеристик и сколько из них числами.
  app.get("/api/ai/products", async (req) => {
    const q = z.object({
      categoryId: z.coerce.number().int().optional(),
      search: z.string().max(120).optional(),
    }).parse(req.query);
    return productsOverview(req.tenant.id, q);
  });

  // Всё, что машина знает о товаре.
  app.get("/api/ai/products/:id/intelligence", async (req) => {
    const id = Number(req.params.id);
    const result = productIntelligence(req.tenant.id, id, await overlayFor(req));
    if (config.ai.readMode !== "evidence") return result;
    // Режим evidence: то, чего в строках «одно значение на ключ» нет —
    // свойства с условием или фасовкой и открытые вопросы сверки.
    const { productEvidence } = await import("../knowledge/evidence.js");
    const { openItemsFor, projectResolution } = await import("../knowledge/evidence-projection.js");
    const ev = productEvidence(req.tenant.id, id, req.user.role);
    const open = openItemsFor(req.tenant.id, id, req.user.role);
    return {
      ...result,
      evidence: {
        mode: "evidence",
        scopedProperties: ev.properties.filter((g) => g.variantId !== null || g.conditionKey !== "").map((g) => ({
          specKey: g.specKey, variantId: g.variantId, conditionKey: g.conditionKey,
          projection: projectResolution(g.resolution.current, open.filter((i) => i.specKey === g.specKey || i.relatedSpecKey === g.specKey)),
        })),
        openItems: open,
      },
    };
  });

  // Сравнение по числам. Рядом с /api/catalog/compare, который сводит те же
  // карточки строками для человека, — здесь величины для машины.
  app.get("/api/ai/products/compare", async (req) => {
    const ids = String(req.query.ids || "").split(",").map(Number).filter(Boolean);
    return compareProducts(req.tenant.id, ids, await overlayFor(req));
  });

  // ── Характеристики ───────────────────────────────────────────────────────
  app.get("/api/ai/specs", async (req) => {
    const q = z.object({
      productId: z.coerce.number().int().optional(),
      categoryId: z.coerce.number().int().optional(),
      specKey: z.enum(SPEC_KEY_LIST).optional(),
      status: z.enum(VERIFICATION_STATUSES).optional(),
      origin: z.enum(ORIGINS).optional(),
      unit: z.string().max(20).optional(),
      numericOnly: z.coerce.boolean().optional(),
      search: z.string().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(300).default(100),
    }).parse(req.query);
    return listSpecs(req.tenant.id, q, await overlayFor(req));
  });

  app.get("/api/ai/specs/:id", async (req) => ({ spec: specById(req.tenant.id, Number(req.params.id)) }));

  app.post("/api/ai/specs", async (req, reply) => {
    const b = z.object({
      productId: z.number().int().positive(),
      variantId: z.number().int().positive().optional(),
      specKey: z.enum(SPEC_KEY_LIST),
      label: z.string().max(200).optional(),
      // Значение вводится так, как написано в источнике: разбор на число и
      // единицу делает сервер, человек не должен считать в уме.
      displayValue: z.string().min(1).max(500),
      sourceId: z.number().int().positive().optional(),
      origin: z.enum(ORIGINS).default("habez_internal"),
      confidence: z.number().int().min(0).max(100).optional(),
    }).parse(req.body);
    const spec = createSpec(req.tenant.id, b, req.user.id);
    audit(req, "ai.spec.create", "ai_spec", spec.id, {
      product: spec.product.name, key: spec.specKey, value: spec.displayValue,
      normalized: spec.value.num ?? spec.value.min ?? spec.value.bool, unit: spec.normalizedUnit, origin: spec.origin,
    });
    reply.code(201);
    return { spec };
  });

  app.patch("/api/ai/specs/:id", async (req) => {
    const b = z.object({
      label: z.string().max(200).optional(),
      displayValue: z.string().min(1).max(500).optional(),
      sourceId: z.number().int().positive().nullable().optional(),
      confidence: z.number().int().min(0).max(100).optional(),
    }).parse(req.body);
    const { spec, before, changed } = updateSpec(req.tenant.id, Number(req.params.id), b, req.user.id);
    audit(req, "ai.spec.update", "ai_spec", spec.id, {
      changed,
      was: { value: before.display_value, num: before.value_num ?? before.value_min, unit: before.normalized_unit },
      now: { value: spec.displayValue, num: spec.value.num ?? spec.value.min, unit: spec.normalizedUnit },
      statusReset: before.verification_status === "verified" && spec.verificationStatus === "unverified" || undefined,
    });
    return { spec };
  });

  app.patch("/api/ai/specs/:id/verification", admin, async (req) => {
    const b = z.object({
      status: z.enum(VERIFICATION_STATUSES),
      note: z.string().max(1000).optional(),
    }).parse(req.body);
    const { spec, before } = setSpecVerification(req.tenant.id, Number(req.params.id), b.status, req.user.id, b.note);
    audit(req, "ai.spec.verification", "ai_spec", spec.id,
      { was: before.verification_status, now: spec.verificationStatus, note: b.note ?? null });
    return { spec };
  });

  // История характеристики — из общего журнала, как у фактов.
  app.get("/api/ai/specs/:id/history", async (req) => {
    const id = Number(req.params.id);
    specById(req.tenant.id, id);
    const { all, json } = await import("../../db/index.js");
    return {
      items: all(
        `SELECT a.id, a.action, a.diff, a.created_at, u.name AS actor
           FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
          WHERE a.tenant_id=? AND a.entity='ai_spec' AND a.entity_id=?
          ORDER BY a.id DESC LIMIT 100`, req.tenant.id, String(id))
        .map((a) => ({ ...a, diff: json(a.diff, {}) })),
    };
  });
}
