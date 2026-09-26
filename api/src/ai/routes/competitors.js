// Habez AI, 3.5 Competitor Intelligence (roadmap: Phase 3 — Competitors) —
// маршруты панели. Стиль и права — как у остальных маршрутов /api/ai:
// читает менеджер, вносит и меняет администратор (владелец — тоже),
// гость и покупатель получают 401 / 403 без данных. Проверку полей,
// компанию-арендатора, уровни доступа и журнал (audit_log в той же
// транзакции) делает доменный слой api/src/ai/competitors/ — здесь только
// номера из адреса и передача контекста. Маршрутов записи для ассистента
// нет: он пользуется только инструментами чтения.
import { z } from "zod";
import * as C from "../competitors/index.js";
import { ACCESS_LEVELS, STATEMENT_TYPES, CONDITION_KEYS } from "../knowledge/evidence-model.js";
import { VERIFICATION_STATUSES } from "../knowledge/model.js";
import { SPEC_KEYS } from "../knowledge/spec-dictionary.js";
import { callTool } from "../agent/tools/index.js";
import { scopeForRole } from "../agent/permissions.js";
import { notFound } from "../../lib/errors.js";

const id = (req, key = "id") => z.coerce.number().int().positive().parse(req.params[key]);
const ctxOf = (req) => ({ tenantId: req.tenant.id, role: req.user.role, actorId: req.user.id, ip: req.ip });
const reason = (req) => z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body ?? {}).reason;

export default async function aiCompetitorRoutes(app) {
  app.addHook("onRequest", app.requireAuth("manager"));
  const admin = { onRequest: [app.requireAuth("admin")] };

  // Словари для форм.
  app.get("/api/ai/competitors/meta", async () => ({
    companyKinds: C.COMPANY_KINDS, competitorStatuses: C.COMPETITOR_STATUSES, regionKinds: C.REGION_KINDS, marketStatuses: C.MARKET_STATUSES,
    sourceTypes: C.COMPETITOR_SOURCE_TYPES, statementTypes: STATEMENT_TYPES, accessLevels: ACCESS_LEVELS, conditionKeys: CONDITION_KEYS,
    priceKinds: C.PRICE_KINDS, basisUnits: C.BASIS_UNITS, vat: C.VAT, analogRelations: C.ANALOG_RELATIONS, analogBases: C.ANALOG_BASES,
    verificationStatuses: VERIFICATION_STATUSES, analogStatuses: C.ANALOG_STATUSES,
    specKeys: Object.entries(SPEC_KEYS).map(([key, m]) => ({ key, label: m.label, group: m.group })),
  }));

  // ── Компании ────────────────────────────────────────────────────────────
  app.get("/api/ai/competitors", async (req) => {
    const q = z.object({ search: z.string().max(120).optional(), kind: z.enum(C.COMPANY_KINDS).optional(), competitorStatus: z.enum(C.COMPETITOR_STATUSES).optional() }).parse(req.query);
    return C.competitorOverview(ctxOf(req), q);
  });
  app.get("/api/ai/competitors/:id", async (req) => C.companyCard(ctxOf(req), id(req)));
  app.post("/api/ai/competitors", admin, async (req, reply) => reply.code(201).send({ company: C.createCompany(ctxOf(req), req.body) }));
  app.patch("/api/ai/competitors/:id", admin, async (req) => ({ company: C.updateCompany(ctxOf(req), id(req), req.body) }));
  app.post("/api/ai/competitors/:id/withdraw", admin, async (req) => ({ company: C.withdrawCompany(ctxOf(req), id(req), reason(req)) }));

  // ── Марки ───────────────────────────────────────────────────────────────
  app.get("/api/ai/competitors/:id/brands", async (req) => ({ items: C.listBrands(ctxOf(req), id(req), { includeWithdrawn: req.query.withdrawn === "1" }) }));
  app.post("/api/ai/competitor-brands", admin, async (req, reply) => reply.code(201).send({ brand: C.createBrand(ctxOf(req), req.body) }));
  app.patch("/api/ai/competitor-brands/:id", admin, async (req) => ({ brand: C.updateBrand(ctxOf(req), id(req), req.body) }));
  app.post("/api/ai/competitor-brands/:id/withdraw", admin, async (req) => ({ brand: C.withdrawBrand(ctxOf(req), id(req), reason(req)) }));

  // ── Товары конкурента ───────────────────────────────────────────────────
  app.get("/api/ai/competitor-products", async (req) => {
    const q = z.object({ companyId: z.coerce.number().int().positive().optional(), brandId: z.coerce.number().int().positive().optional(),
      categoryId: z.coerce.number().int().positive().optional() }).parse(req.query);
    return { items: C.listCompetitorProducts(ctxOf(req), q) };
  });
  app.get("/api/ai/competitor-products/:id", async (req) => C.competitorProductCard(ctxOf(req), id(req)));
  app.post("/api/ai/competitor-products", admin, async (req, reply) => reply.code(201).send({ product: C.createCompetitorProduct(ctxOf(req), req.body) }));
  app.patch("/api/ai/competitor-products/:id", admin, async (req) => ({ product: C.updateCompetitorProduct(ctxOf(req), id(req), req.body) }));
  app.post("/api/ai/competitor-products/:id/withdraw", admin, async (req) => ({ product: C.withdrawCompetitorProduct(ctxOf(req), id(req), reason(req)) }));

  // ── Фасовки ─────────────────────────────────────────────────────────────
  app.get("/api/ai/competitor-products/:id/packs", async (req) => ({ items: C.listPacks(ctxOf(req), id(req), { includeWithdrawn: req.query.withdrawn === "1" }) }));
  app.post("/api/ai/competitor-packs", admin, async (req, reply) => reply.code(201).send({ pack: C.createPack(ctxOf(req), req.body) }));
  app.patch("/api/ai/competitor-packs/:id", admin, async (req) => ({ pack: C.updatePack(ctxOf(req), id(req), req.body) }));
  app.post("/api/ai/competitor-packs/:id/withdraw", admin, async (req) => ({ pack: C.withdrawPack(ctxOf(req), id(req), reason(req)) }));

  // ── Регионы ─────────────────────────────────────────────────────────────
  app.get("/api/ai/regions", async (req) => ({ items: C.listRegions(ctxOf(req)) }));
  app.post("/api/ai/regions", admin, async (req, reply) => reply.code(201).send({ region: C.createRegion(ctxOf(req), req.body) }));

  // ── Наблюдения характеристик ────────────────────────────────────────────
  app.get("/api/ai/competitor-observations/:id", async (req) => ({ observation: C.getObservation(ctxOf(req), id(req)) }));
  app.post("/api/ai/competitor-observations", admin, async (req, reply) => reply.code(201).send({ observation: C.createObservation(ctxOf(req), req.body) }));
  app.post("/api/ai/competitor-observations/:id/supersede", admin, async (req) => {
    const b = z.object({ replacedById: z.number().int().positive(), note: z.string().trim().min(1).max(500) }).parse(req.body ?? {});
    return { observation: C.supersedeObservation(ctxOf(req), id(req), b.replacedById, b.note) };
  });
  app.post("/api/ai/competitor-observations/:id/withdraw", admin, async (req) => ({ observation: C.withdrawObservation(ctxOf(req), id(req), reason(req)) }));
  app.post("/api/ai/competitor-observations/:id/verification", admin, async (req) => {
    const b = z.object({ status: z.enum(VERIFICATION_STATUSES), note: z.string().max(500).optional() }).parse(req.body ?? {});
    return { observation: C.setObservationVerification(ctxOf(req), id(req), b.status, b.note) };
  });

  // ── Цены ────────────────────────────────────────────────────────────────
  app.get("/api/ai/competitor-products/:id/prices", async (req) => C.productPrices(ctxOf(req), id(req)));
  app.post("/api/ai/competitor-prices", admin, async (req, reply) => reply.code(201).send({ price: C.createPrice(ctxOf(req), req.body) }));
  app.post("/api/ai/competitor-prices/:id/supersede", admin, async (req) => {
    const b = z.object({ replacedById: z.number().int().positive(), note: z.string().trim().min(1).max(500) }).parse(req.body ?? {});
    return { price: C.supersedePrice(ctxOf(req), id(req), b.replacedById, b.note) };
  });
  app.post("/api/ai/competitor-prices/:id/withdraw", admin, async (req) => ({ price: C.withdrawPrice(ctxOf(req), id(req), reason(req)) }));
  app.post("/api/ai/competitor-prices/:id/verification", admin, async (req) => {
    const b = z.object({ status: z.enum(VERIFICATION_STATUSES), note: z.string().max(500).optional() }).parse(req.body ?? {});
    return { price: C.setPriceVerification(ctxOf(req), id(req), b.status, b.note) };
  });

  // ── Аналоги ─────────────────────────────────────────────────────────────
  app.get("/api/ai/competitor-analogs", async (req) => {
    const q = z.object({ productId: z.coerce.number().int().positive() }).parse(req.query);
    return C.productAnalogs(ctxOf(req), q.productId);
  });
  app.get("/api/ai/competitor-analogs/status", async (req) => {
    const q = z.object({ productId: z.coerce.number().int().positive(), competitorProductId: z.coerce.number().int().positive() }).parse(req.query);
    return C.analogPanelView(ctxOf(req))(C.analogStatus(ctxOf(req), q.productId, q.competitorProductId));
  });
  app.post("/api/ai/competitor-analogs", admin, async (req, reply) => reply.code(201).send({ analog: C.createAnalog(ctxOf(req), req.body) }));
  app.post("/api/ai/competitor-analogs/:id/withdraw", admin, async (req) => ({ analog: C.withdrawAnalog(ctxOf(req), id(req), reason(req)) }));

  // ── Сравнение «наш ↔ их»: тот же формат, что у инструмента ассистента ────
  app.get("/api/ai/competitor-compare", async (req) => {
    const q = z.object({ productId: z.coerce.number().int().positive(), competitorProductId: z.coerce.number().int().positive() }).parse(req.query);
    const out = callTool("compare_with_competitor", q, { tenantId: req.tenant.id, scope: scopeForRole(req.user.role) });
    if (!out) throw notFound("Товар не найден");
    return out;
  });
}
