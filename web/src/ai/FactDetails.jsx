import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { useApp } from "../store.jsx";
import { Back } from "../components/Icons.jsx";
import {
  ORIGIN_LABEL, ORIGIN_HINT, STATUS_LABEL, STATUS_PILL, FACT_TYPE_LABEL,
  SUBJECT_TYPE_LABEL, ACTION_LABEL, factValue,
} from "./labels.js";

// Карточка факта: значение, источник, состояние проверки и вся история.
export default function FactDetails({ onChanged }) {
  const { id } = useParams();
  const { user, toast } = useApp();
  const [fact, setFact] = useState(null);
  const [meta, setMeta] = useState(null);
  const [history, setHistory] = useState([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const isAdmin = ["admin", "owner"].includes(user.role);

  const load = () => {
    api.get(`/api/ai/facts/${id}`).then((d) => setFact(d.fact)).catch(() => setFact(false));
    api.get(`/api/ai/facts/${id}/history`).then((d) => setHistory(d.items)).catch(() => {});
  };
  useEffect(() => { load(); api.get("/api/ai/meta").then(setMeta).catch(() => {}); }, [id]);

  if (fact === false) return <div className="empty"><h3>Факт не найден</h3><Link className="btn" to="/admin/ai">К списку</Link></div>;
  if (!fact) return <div className="skeleton" style={{ height: 320 }} />;

  const allowed = meta?.transitions?.[fact.verificationStatus] || [];
  const isInference = fact.origin === "ai_inference";

  const change = async (status) => {
    setBusy(true);
    try {
      const d = await api.patch(`/api/ai/facts/${id}/verification`, { status, ...(note.trim() ? { note: note.trim() } : {}) });
      setFact(d.fact);
      setNote("");
      toast(`Состояние: ${STATUS_LABEL[status]}`);
      load();
      onChanged?.();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="spread">
        <div>
          <Link to="/admin/ai" className="btn btn-sm"><Back width={15} height={15} /> К фактам</Link>
          <h1 style={{ marginTop: 12 }}>{fact.attribute}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {SUBJECT_TYPE_LABEL[fact.subject.type] || fact.subject.type}: {fact.subject.label || "—"}
          </p>
        </div>
        <span className={`pill ${STATUS_PILL[fact.verificationStatus] || ""}`}>{STATUS_LABEL[fact.verificationStatus]}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: 16 }} className="dash-grid">
        <section className="panel">
          <h3>Значение</h3>
          <p style={{ fontSize: 22, fontWeight: 600, margin: "10px 0 16px" }}>{factValue(fact) || "—"}</p>
          <div className="stack" style={{ gap: 9, fontSize: 14 }}>
            <Row label="Тип сведения" value={FACT_TYPE_LABEL[fact.factType] || fact.factType} />
            <Row label="Происхождение" value={ORIGIN_LABEL[fact.origin] || fact.origin} />
            <Row label="Доверие" value={`${fact.confidence} из 100`} />
            <Row label="Получено" value={dateTime(fact.observedAt)} />
            <Row label="Последняя сверка" value={fact.checkedAt ? dateTime(fact.checkedAt) : "не сверялся"} />
            <Row label="Перепроверить после" value={fact.recheckAfter ? dateTime(fact.recheckAfter) : "—"} />
            {fact.verifiedBy && <Row label="Подтвердил" value={`${fact.verifiedBy.name} · ${dateTime(fact.verifiedAt)}`} />}
            {fact.verifyNote && <Row label="Примечание" value={fact.verifyNote} />}
          </div>
          {fact.value.json && (
            <pre className="dim" style={{ marginTop: 14, fontSize: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(fact.value.json, null, 2)}</pre>
          )}
          {isInference && (
            <p className="hint" style={{ marginTop: 14 }}>
              Это предположение модели, а не факт. Подтвердить его нельзя: чтобы утверждение
              стало фактом, нужен источник — заведите отдельную запись со ссылкой на него.
            </p>
          )}
          {fact.outdated && <p className="hint" style={{ marginTop: 10, color: "var(--warn)" }}>Срок перепроверки истёк — сведения могли устареть.</p>}
        </section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="panel">
            <h3>Источник</h3>
            {fact.source ? (
              <div className="stack" style={{ gap: 9, marginTop: 12, fontSize: 14 }}>
                <Row label="Название" value={fact.source.name} />
                <Row label="Вид" value={ORIGIN_HINT[fact.origin]} />
                {fact.source.url && (
                  <div className="sum-row">
                    <span className="muted">Адрес</span>
                    <a href={fact.source.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>открыть</a>
                  </div>
                )}
                {fact.snapshotRef && <Row label="Копия страницы" value={fact.snapshotRef} />}
              </div>
            ) : <p className="dim" style={{ fontSize: 13, marginTop: 10 }}>Источника нет — это предположение.</p>}
          </section>

          {isAdmin && (
            <section className="panel">
              <h3>Проверка</h3>
              <p className="hint" style={{ margin: "8px 0 12px" }}>
                Подтверждайте только то, что сверили с источником сами.
              </p>
              <input className="input" placeholder="Примечание: что именно сверили" value={note}
                onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 10 }} />
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {allowed.map((s) => (
                  <button key={s} className={`btn btn-sm ${s === "verified" ? "btn-primary" : ""}`}
                    disabled={busy || (s === "verified" && isInference)}
                    title={s === "verified" && isInference ? "Вывод AI нельзя подтвердить" : undefined}
                    onClick={() => change(s)}>
                    {STATUS_LABEL[s]}
                  </button>
                ))}
                {allowed.length === 0 && <span className="dim" style={{ fontSize: 13 }}>Переходов из этого состояния нет.</span>}
              </div>
            </section>
          )}
        </div>
      </div>

      <section className="panel">
        <h3>История изменений</h3>
        {history.length === 0 ? (
          <p className="dim" style={{ fontSize: 13, marginTop: 10 }}>Записей пока нет.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead><tr><th>Когда</th><th>Что произошло</th><th>Кто</th><th>Подробности</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="dim" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{dateTime(h.created_at)}</td>
                    <td>{ACTION_LABEL[h.action] || h.action}</td>
                    <td className="muted">{h.actor || "—"}</td>
                    <td className="dim" style={{ fontSize: 12 }}>{describe(h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const Row = ({ label, value }) => (
  <div className="sum-row"><span className="muted">{label}</span><span>{value}</span></div>
);

// Подробности из журнала — обычными словами, без служебных ключей.
function describe(h) {
  const d = h.diff || {};
  if (h.action === "ai.fact.verification") return `${STATUS_LABEL[d.was] || d.was} → ${STATUS_LABEL[d.now] || d.now}${d.note ? ` · ${d.note}` : ""}`;
  if (h.action === "ai.fact.update") {
    const was = [d.was?.value, d.was?.unit].filter(Boolean).join(" ");
    const now = [d.now?.value, d.now?.unit].filter(Boolean).join(" ");
    return was || now ? `${was || "—"} → ${now || "—"}${d.statusReset ? " · подтверждение снято" : ""}` : "";
  }
  if (h.action === "ai.fact.create") return `${d.attribute || ""}${d.value ? `: ${d.value}` : ""}`;
  return "";
}
