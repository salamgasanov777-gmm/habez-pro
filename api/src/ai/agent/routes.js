// Habez AI Agent по HTTP.
//
//   GET  /api/ai/agent/meta  — включён ли агент для этого пользователя
//   POST /api/ai/agent/chat  — ответ потоком (text/event-stream):
//        event: meta  — намерение, товары, расхождения
//        event: delta — кусок текста
//        event: done  — источники, проверка ответа, модель, время
//        event: error — понятное сообщение
//
// В журнал пишется только служебное: номер беседы и запроса, роль,
// намерение, число источников, модель, время по этапам, итог проверки,
// успех. Ни вопроса, ни ответа, ни ключей, ни значений.
//
// Защита от расходов (настройки — AI_RATE_*, AI_MAX_CONCURRENT,
// AI_PUBLIC_DAILY_MAX, AI_HISTORY_MAX_CHARS):
//   вопросов за окно — на человека (вошедшего — по учётной записи, гостя —
//   по адресу); одновременных ответов — не больше maxConcurrent на
//   человека; гостям и покупателям вместе — не больше publicDailyMax
//   ответов в сутки; длина истории — historyMaxChars знаков.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { canUseAgent } from "./permissions.js";
import { getProvider } from "./provider/index.js";
import { runAgent } from "./runtime/agent.js";

const body = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  // Длинная реплика не повод отказывать: обрезается (общий предел тела
  // запроса — 2 МБ, дальше историю ужимает cleanHistory).
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().transform((s) => s.slice(0, 8000)) })).max(20).default([]),
}).strict();

// Токен прислан, но не принят (истёк, подделан, учётная запись
// заблокирована) — это не гость: 401, чтобы интерфейс обновил вход, а не
// получил молча ответ с правами гостя.
const staleSession = (req) => req.headers.authorization?.startsWith("Bearer ") && !req.user;
const sessionExpired = (reply) => reply.code(401).send({ error: { code: "session_expired", message: "Сессия истекла — войдите заново" } });

const who = (req) => (req.user ? `u${req.user.id}` : `ip:${req.ip}`);
const inFlight = new Map();
let publicDay = { day: "", n: 0 };
function takePublicSlot() {
  const max = config.ai.agent.publicDailyMax;
  const day = new Date().toISOString().slice(0, 10);
  if (publicDay.day !== day) publicDay = { day, n: 0 };
  if (max > 0 && publicDay.n >= max) return false;
  publicDay.n += 1;
  return true;
}
// Для тестов: сбросить счётчики между сценариями.
export function resetAgentLimits() { inFlight.clear(); publicDay = { day: "", n: 0 }; }

export default async function aiAgentRoutes(app) {
  app.get("/api/ai/agent/meta", async (req, reply) => {
    if (staleSession(req)) return sessionExpired(reply);
    const access = canUseAgent(req.user);
    if (!access.ok) return reply.code(access.status).send({ error: { code: "forbidden", message: `Habez AI: ${access.reason}` } });
    return { enabled: true, scope: access.scope, provider: config.ai.agent.provider, model: config.ai.agent.model };
  });

  app.post("/api/ai/agent/chat", {
    // Каждый ответ стоит денег: гостям — строже.
    // preHandler — к этому моменту пользователь уже известен.
    config: { rateLimit: {
      hook: "preHandler", keyGenerator: who, timeWindow: config.ai.agent.rateWindowMin * 60_000,
      max: (req) => (req.user && req.user.role !== "customer" && req.user.role !== "dealer" ? config.ai.agent.rateStaff : config.ai.agent.ratePublic),
    } },
  }, async (req, reply) => {
    if (staleSession(req)) return sessionExpired(reply);
    const access = canUseAgent(req.user);
    if (!access.ok) return reply.code(access.status).send({ error: { code: "forbidden", message: `Habez AI: ${access.reason}` } });
    const b = body.parse(req.body);
    const conversationId = b.conversationId || randomUUID();
    const key = who(req);
    if ((inFlight.get(key) || 0) >= config.ai.agent.maxConcurrent) {
      return reply.code(429).send({ error: { code: "busy", message: "Дождитесь ответа на предыдущий вопрос" } });
    }
    if (access.scope === "public" && !takePublicSlot()) {
      req.log.warn({ aiAgent: { requestId: req.id, ok: false, error: "public_daily_limit" } }, "ai agent: public daily limit");
      return reply.code(429).send({ error: { code: "daily_limit", message: "Habez AI на сегодня занят. Задайте вопрос менеджеру — телефон внизу страницы." } });
    }

    let provider;
    try { provider = getProvider(); } catch (e) {
      req.log.error({ aiAgent: { conversationId, requestId: req.id, ok: false, error: "provider_config" } }, "ai agent: provider not configured");
      return reply.code(503).send({ error: { code: "unavailable", message: "Habez AI временно недоступен: не настроено подключение к модели" } });
    }

    inFlight.set(key, (inFlight.get(key) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(key) || 1) - 1;
      if (n > 0) inFlight.set(key, n); else inFlight.delete(key);
    };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "x-request-id": req.id,
    });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ctrl = new AbortController();
    // Закрыл вкладку или нажал «Стоп» — прекращаем и запрос к модели: за
    // недочитанный ответ платить незачем. Слушаем именно ответ: «close» у
    // запроса приходит, как только прочитано тело, а не при обрыве.
    res.on("close", () => { if (!res.writableEnded) ctrl.abort(new Error("клиент отключился")); });

    const t0 = Date.now();
    send("start", { conversationId, requestId: req.id });
    try {
      const r = await runAgent({
        tenantId: req.tenant.id, scope: access.scope, question: b.message, history: b.history,
        provider, signal: ctrl.signal, onEvent: send,
      });
      req.log.info({ aiAgent: {
        conversationId, requestId: req.id, role: req.user?.role ?? "guest", scope: access.scope, intent: r.intent,
        sources: r.sources, conflicts: r.conflicts, citations: r.citations.length, grounded: r.grounding.grounded,
        unsupported: r.grounding.unsupported.length, mismatched: r.grounding.mismatched.length, uncited: r.grounding.uncited.length,
        invalidCitations: r.grounding.invalidCitations.length, forbidden: r.grounding.forbidden, withheld: r.withheld,
        model: r.model, latencyMs: r.latencyMs, timings: r.timings, ok: true,
        tokens: { in: r.usage?.input_tokens ?? null, out: r.usage?.output_tokens ?? null },
      } }, "ai agent answer");
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      req.log[aborted ? "info" : "error"]({ aiAgent: { conversationId, requestId: req.id, role: req.user?.role ?? "guest", ok: false, aborted, latencyMs: Date.now() - t0, error: e.status ? `provider_${e.status}` : "runtime" } }, "ai agent failed");
      send("error", { message: e.status === 402 ? "Habez AI: у подключения к модели закончился баланс" : e.status === 429 ? "Habez AI перегружен, попробуйте через минуту" : "Habez AI не смог ответить. Попробуйте ещё раз." });
    } finally {
      release();
      res.end();
    }
  });
}
