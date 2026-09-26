import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import { Spark } from "../components/Icons.jsx";

// Habez AI — чат по товарам. Ответ идёт потоком; у каждого утверждения
// ссылка [E#] на строку данных Habez, источники — под ответом.
// Беседа живёт в этой вкладке (sessionStorage): сервер её не хранит.
// Ключ свой у каждого пользователя и уровня доступа, при выходе беседы
// стираются (store.jsx → logout): ответ администратора не достанется
// следующему, кто сядет за этот компьютер.

export const STORE_PREFIX = "habezpro.ai.chat";
const EXAMPLES = [
  "Какие сухие смеси Habez подходят для заделки швов ГКЛ?",
  "Расскажи про ШОВ",
  "Какая прочность у ШОВ?",
  "Сравни ШОВ и Стандарт",
  "Какие есть фасовки ГКЛ?",
];
const SCOPE_LABEL = { public: "данные витрины", staff: "витрина и внутренние наблюдения", admin: "все данные, включая конфиденциальные" };
const STATUS_LABEL = { single: "одно значение", agreed: "источники согласны", conflict: "расхождение", unresolved: "нерешённый вопрос сверки" };
const VERIFICATION_LABEL = { verified: "подтверждено", unverified: "не проверено", rejected: "отклонено" };
const ACCESS_LABEL = { internal: "внутренние данные", confidential: "конфиденциально — не пересылать" };

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
const storeKey = (user, inStore) => `${STORE_PREFIX}:${user?.id ?? "guest"}:${inStore ? "store" : "panel"}`;
function load(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || null; } catch { return null; }
}
function save(key, state) {
  try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* приватный режим — просто не сохраняем */ }
}

// Разбор потока: «event: …\ndata: …\n\n».
async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      let event = "message";
      let data = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) { try { yield { event, data: JSON.parse(data) }; } catch { /* пропуск */ } }
    }
  }
}

// Текст ответа без HTML: строки, списки, **жирный**, ссылки [E#].
function Rich({ text, onCite }) {
  const lines = text.split("\n");
  const inline = (s, key) => s.split(/(\*\*[^*]+\*\*|\[E\d+\])/g).filter(Boolean).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={`${key}-${i}`}>{part.slice(2, -2)}</b>;
    const m = part.match(/^\[(E\d+)\]$/);
    if (m) return <button key={`${key}-${i}`} type="button" className="ai-ref" onClick={() => onCite(m[1])}>{m[1].slice(1)}</button>;
    return part;
  });
  return (
    <div className="ai-text">
      {lines.map((l, i) => {
        const t = l.trim();
        if (!t) return <div key={i} className="ai-gap" />;
        if (/^#{1,3} /.test(t)) return <p key={i} className="ai-h">{inline(t.replace(/^#{1,3} /, ""), i)}</p>;
        if (/^[-•*] /.test(t)) return <p key={i} className="ai-li">{inline(t.slice(2), i)}</p>;
        return <p key={i}>{inline(t, i)}</p>;
      })}
    </div>
  );
}

function Sources({ citations, highlight, msgKey }) {
  const [all, setAll] = useState(false);
  if (!citations?.length) return null;
  // Нажали на ссылку, чей источник свёрнут, — разворачиваем список.
  const open = all || (highlight && !citations.slice(0, 6).some((c) => c.id === highlight) && citations.some((c) => c.id === highlight));
  const shown = open ? citations : citations.slice(0, 6);
  return (
    <div className="ai-sources">
      <div className="ai-sources-h">Источники</div>
      {shown.map((c) => (
        <div key={c.id} id={`cite-${msgKey}-${c.id}`} className={`ai-source${highlight === c.id ? " on" : ""}`}>
          <span className="ai-ref static">{c.id.slice(1)}</span>
          <div>
            <div><b>{c.product}</b>{c.label ? ` · ${c.label}` : ""}{c.value && c.label !== "описание" ? <> — <span className="mono">{String(c.value).slice(0, 160)}</span></> : null}</div>
            <div className="hint">
              {c.source}{c.where ? ` · ${c.where}` : ""}{c.condition ? ` · условие: ${c.condition}` : ""}{c.variant ? ` · фасовка: ${c.variant}` : ""}
              {c.reference ? ` · ${c.reference}` : ""}{c.verification ? ` · ${VERIFICATION_LABEL[c.verification] || c.verification}` : ""}
              {c.status && c.status !== "single" ? ` · ${STATUS_LABEL[c.status] || c.status}` : ""}
              {ACCESS_LABEL[c.access] ? <> · <span className={c.access === "confidential" ? "ai-secret" : undefined}>{ACCESS_LABEL[c.access]}</span></> : null}
            </div>
          </div>
        </div>
      ))}
      {citations.length > 6 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!open)}>{open ? "Свернуть" : `Ещё ${citations.length - 6}`}</button>
      )}
    </div>
  );
}

// Сравнение: строка — характеристика, столбец — товар. Таблица в своей
// прокрутке: на телефоне страница вбок не едет.
function Comparison({ data, onCite }) {
  const [all, setAll] = useState(false);
  if (!data?.rows?.length) return null;
  const rows = all ? data.rows : data.rows.slice(0, 10);
  return (
    <div className="ai-compare" role="region" aria-label="Сравнение">
      <div className="ai-compare-scroll">
        <table>
          <thead><tr><th>Характеристика</th>{data.products.map((p) => <th key={p}>{p}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.label}{r.condition ? <span className="hint"> · {r.condition}</span> : null}</th>
                {r.cells.map((c, j) => (
                  <td key={j} className={c.missing ? "muted" : ["conflict", "unresolved"].includes(c.status) ? "ai-cell-conflict" : undefined}>
                    {c.missing ? "нет данных" : c.values.join(" / ")}
                    {c.refs?.slice(0, 3).map((id) => <button key={id} type="button" className="ai-ref" onClick={() => onCite(id)}>{id.slice(1)}</button>)}
                    {["conflict", "unresolved"].includes(c.status) && <span className="hint"> · расхождение{c.decisions?.length ? ` ${c.decisions.join(", ")}` : ""}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length > 10 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!all)}>{all ? "Свернуть" : `Ещё ${data.rows.length - 10}`}</button>}
    </div>
  );
}

// Пригодность (Phase 3.3): статусы посчитала система, здесь — только показ.
// Группы в одном порядке; порядок внутри — каталожный, не рейтинг.
const SUIT_ORDER = ["SUPPORTED", "PARTIALLY_SUPPORTED", "CONFLICTED", "INSUFFICIENT_DATA", "NOT_SUPPORTED"];
function Suitability({ items, useCase, onCite }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) => SUIT_ORDER.indexOf(a.status) - SUIT_ORDER.indexOf(b.status));
  const shown = all ? sorted : sorted.slice(0, 6);
  return (
    <div className="ai-suit" role="region" aria-label="Пригодность">
      {useCase && <div className="ai-sources-h">Задача: {useCase.label}</div>}
      {shown.map((s) => (
        <div key={s.slug} className="ai-suit-card" data-status={s.status}>
          <div className="ai-suit-head"><b>{s.short || s.product}</b><span className={`ai-suit-badge s-${s.status}`}>{s.label}</span></div>
          <div className="hint">
            {s.reason}
            {s.refs?.slice(0, 4).map((id) => <button key={id} type="button" className="ai-ref" onClick={() => onCite(id)}>{id.slice(1)}</button>)}
            {s.packaging === false && <> · нужной фасовки нет</>}
          </div>
        </div>
      ))}
      {sorted.length > 6 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!all)}>{all ? "Свернуть" : `Ещё ${sorted.length - 6}`}</button>}
    </div>
  );
}

function Conflicts({ items, withheld }) {
  if (!items?.length && !withheld?.length) return null;
  return (
    <div className="ai-conflict" role="note">
      <b>Расхождение в данных Habez</b>
      <span className="hint">Система не выбирает одно значение как окончательное.</span>
      {withheld?.length > 0 && (
        <span>В системе есть дополнительные внутренние данные, поэтому окончательное значение не опубликовано: {withheld.map((w) => `${w.product} · ${w.label}`).join("; ")}.</span>
      )}
      {(items || []).slice(0, 8).map((c, i) => (
        <div key={i}>
          {c.product} · {c.label}{c.condition ? ` (${c.condition})` : ""}{c.variant?.unit ? ` · фасовка ${c.variant.unit}` : ""}: {c.values.map((v) => (v.hidden ? "скрытое значение" : v.display)).join(" / ")}
          {c.decisions?.length ? <span className="hint"> · вопрос сверки {c.decisions.join(", ")}</span> : null}
        </div>
      ))}
    </div>
  );
}

export default function Assistant({ inStore = false }) {
  const { user } = useApp();
  const key = storeKey(user, inStore);
  const saved = useMemo(() => load(key), [key]);
  const [conversationId, setConversationId] = useState(saved?.conversationId || newId());
  const [messages, setMessages] = useState(saved?.messages || []);
  // Phase 3.2: о чём сейчас беседа (присылает сервер) и с какого номера
  // продолжать ссылки [E#]: у каждого сообщения — свои номера.
  const [agentState, setAgentState] = useState(saved?.agentState || {});
  const [refNext, setRefNext] = useState(saved?.refNext || 0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(null);
  const [unavailable, setUnavailable] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  // Сменился пользователь (выход, вход другого) — своя беседа или новая.
  // owner — чья беседа сейчас на экране: пока она не сменилась, сохранять
  // её под новым ключом нельзя.
  const [owner, setOwner] = useState(key);
  useEffect(() => {
    if (owner === key) return;
    abortRef.current?.abort();
    setMessages(saved?.messages || []);
    setConversationId(saved?.conversationId || newId());
    setAgentState(saved?.agentState || {});
    setRefNext(saved?.refNext || 0);
    setOwner(key);
  }, [key, owner, saved]);
  useEffect(() => {
    api.get("/api/ai/agent/meta").then((m) => { setScope(m.scope); setUnavailable(null); })
      .catch((e) => setUnavailable(e.status === 401 && user ? "Сессия истекла — войдите заново." : e.message || "Habez AI недоступен"));
  }, [user?.id]);
  useEffect(() => { if (owner === key) save(key, { conversationId, agentState, refNext, messages: messages.filter((m) => m.status !== "streaming") }); }, [owner, key, conversationId, agentState, refNext, messages]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(q) {
    const question = (q ?? text).trim();
    if (!question || busy) return;
    setText("");
    // История для сервера: последние 10 реплик, каждая не длиннее 4000 знаков
    // (сервер больше и не берёт) — иначе после длинного ответа следующий
    // вопрос отклонялся бы как слишком большой.
    const history = messages.filter((m) => m.status === "done" || m.role === "user")
      .map((m) => ({ role: m.role, content: m.withheld ? "" : String(m.content).slice(0, 4000) })).slice(-10);
    // Ответ правится по своему номеру, а не «последний в списке»: после
    // «Новой беседы» опоздавший кусок потока не попадёт в чужую беседу.
    const id = newId();
    const patch = (fn) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
    setMessages((ms) => [...ms, { role: "user", content: question }, { id, role: "assistant", content: "", status: "streaming", meta: null, citations: [] }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await api.streamPost("/api/ai/agent/chat", { message: question, conversationId, history, state: agentState, refBase: refNext }, { signal: ctrl.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(res.status === 401 && user ? "Сессия истекла — войдите заново." : err?.error?.message || `Ошибка ${res.status}`);
      }
      for await (const { event, data } of readSse(res)) {
        if (event === "start") patch((m) => ({ ...m, requestId: data.requestId }));
        else if (event === "status") patch((m) => ({ ...m, phase: data.text }));
        else if (event === "meta") {
          patch((m) => ({ ...m, meta: data }));
          // Номера этого ответа заняты сразу: даже если ответ прервут,
          // следующий не повторит их.
          setRefNext((n) => Math.max(n, (data.refBase || 0) + (data.evidenceCount || 0)));
        } else if (event === "reset") patch((m) => ({ ...m, content: "" }));
        else if (event === "delta") patch((m) => ({ ...m, content: m.content + data.text }));
        else if (event === "done") {
          if (data.state) setAgentState(data.state);
          if (Number.isInteger(data.refNext)) setRefNext((n) => Math.max(n, data.refNext));
          patch((m) => ({ ...m, status: "done", citations: data.citations, grounding: data.grounding, truncated: data.truncated, mode: data.mode,
            ...(data.withheld ? { withheld: true, content: "Ответ скрыт: в нём оказались данные, которые вашему уровню доступа не положены. Задайте вопрос иначе или обратитесь к администратору." } : {}) }));
        } else if (event === "error") patch((m) => ({ ...m, status: "error", error: data.message }));
      }
      patch((m) => (m.status === "streaming" ? { ...m, status: m.content ? "done" : "error", error: m.content ? null : "Ответ оборвался. Попробуйте ещё раз." } : m));
    } catch (e) {
      if (ctrl.signal.aborted) patch((m) => ({ ...m, status: m.content ? "done" : "error", stopped: true, error: m.content ? null : "Остановлено" }));
      else patch((m) => ({ ...m, status: "error", error: e.message || "Нет связи с сервером" }));
    } finally {
      if (abortRef.current === ctrl) {
        setBusy(false);
        abortRef.current = null;
      }
      inputRef.current?.focus();
    }
  }

  function retry() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setMessages((ms) => ms.slice(0, -2));
    setTimeout(() => send(lastUser.content), 0);
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages([]);
    setConversationId(newId());
    setAgentState({});
    setRefNext(0);
    setText("");
    inputRef.current?.focus();
  }

  // Номера [E#] свои у каждого ответа — ссылка ведёт к источнику того же ответа.
  function cite(msgKey, id) {
    setHighlight(`${msgKey}:${id}`);
    // Источник мог быть свёрнут: ждём, пока список развернётся.
    requestAnimationFrame(() => document.getElementById(`cite-${msgKey}-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  return (
    <div className={`ai-chat${inStore ? " in-store" : ""}`}>
      <div className="ai-head">
        <div className="row" style={{ gap: 10 }}>
          <span className="ai-mark"><Spark width={20} height={20} /></span>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Habez AI</h2>
            <span className="hint">Ответы только по данным Habez{scope ? ` · ${SCOPE_LABEL[scope]}` : ""}</span>
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={reset} disabled={!messages.length && !busy}>Новая беседа</button>
      </div>

      {unavailable && <div className="ai-conflict"><b>Habez AI недоступен</b><span className="hint">{unavailable}</span></div>}

      <div className="ai-log" aria-live="polite">
        {!messages.length && !unavailable && (
          <div className="ai-empty">
            <p className="muted">Спросите о товарах, характеристиках, применении или сравнении. Если в заводских данных есть расхождение, Habez AI покажет все значения и не станет выбирать одно.</p>
            <div className="ai-examples">
              {EXAMPLES.map((e) => <button key={e} type="button" className="chip" onClick={() => send(e)} disabled={busy}>{e}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (m.role === "user"
          ? <div key={i} className="ai-msg user">{m.content}</div>
          : (
            <div key={m.id || i} className="ai-msg bot" data-status={m.status} data-mode={m.mode || m.meta?.mode || ""}>
              <Conflicts items={["COMPARISON", "PRODUCT_SELECTION"].includes(m.meta?.mode) ? [] : m.meta?.conflicts} withheld={m.meta?.withheldProperties} />
              {m.content ? <Rich text={m.content} onCite={(id) => cite(i, id)} /> : m.status === "streaming" ? (
                <div className="ai-typing-row"><div className="ai-typing"><span /><span /><span /></div>{m.phase && <span className="hint">{m.phase}</span>}</div>
              ) : null}
              {m.meta?.mode === "COMPARISON" && <Comparison data={m.meta.comparison} onCite={(id) => cite(i, id)} />}
              {m.meta?.suitability?.length > 0 && m.status !== "streaming" && <Suitability items={m.meta.suitability} useCase={m.meta.useCase} onCite={(id) => cite(i, id)} />}
              {m.meta?.application?.missing?.length > 0 && m.status !== "streaming" && <p className="hint">В данных Habez нет: {m.meta.application.missing.join(", ")}.</p>}
              {m.meta?.profile?.gaps?.length > 0 && m.status !== "streaming" && <p className="hint">В данных Habez нет: {m.meta.profile.gaps.join(", ")}.</p>}
              {m.meta?.clarification?.options?.length > 0 && m.status !== "streaming" && (
                <div className="ai-examples ai-clarify">
                  {m.meta.clarification.options.map((o) => <button key={o} type="button" className="chip" onClick={() => send(o)} disabled={busy}>{o}</button>)}
                </div>
              )}
              {m.status === "error" && (
                <div className="ai-error">{m.error} <button type="button" className="btn btn-sm" onClick={retry} disabled={busy}>Повторить</button></div>
              )}
              {m.truncated && <p className="hint">Ответ обрезан по длине. Уточните вопрос.</p>}
              {m.stopped && m.content && <p className="hint">Остановлено — ответ неполный.</p>}
              {!m.withheld && (m.grounding?.unsupported?.length > 0 || m.grounding?.mismatched?.length > 0) && (
                <p className="ai-warn">Проверка: в ответе есть значения, которых нет в указанных источниках Habez — {[...(m.grounding.unsupported || []), ...(m.grounding.mismatched || [])].join(", ")}. Не опирайтесь на них.</p>
              )}
              {!m.withheld && !m.grounding?.unsupported?.length && !m.grounding?.mismatched?.length && m.grounding?.uncited?.length > 0 && (
                <p className="hint">Часть значений приведена без ссылки на источник — сверьте их по списку ниже.</p>
              )}
              {!m.withheld && m.grounding?.fromHistory?.length > 0 && (
                <p className="hint">Значения из прошлого ответа в этом ответе не перепроверены: {m.grounding.fromHistory.join(", ")}.</p>
              )}
              <Sources citations={m.citations} msgKey={i} highlight={highlight?.startsWith(`${i}:`) ? highlight.slice(String(i).length + 1) : null} />
            </div>
          )))}
        <div ref={endRef} />
      </div>

      <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef}
          className="textarea"
          rows={2}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Спросите о товарах, характеристиках, применении или сравнении…"
          aria-label="Вопрос для Habez AI"
          disabled={!!unavailable}
        />
        {busy
          ? <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Стоп</button>
          : <button type="submit" className="btn btn-primary" disabled={!text.trim() || !!unavailable}>Отправить</button>}
      </form>
    </div>
  );
}
