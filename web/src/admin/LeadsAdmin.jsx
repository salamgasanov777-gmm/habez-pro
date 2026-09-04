import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { useApp } from "../store.jsx";

const KIND = { quote: "Запрос цены", dealer: "Дилерство", callback: "Звонок", question: "Вопрос" };
const STATUS = { new: "Новая", in_work: "В работе", done: "Закрыта", spam: "Спам" };

export default function LeadsAdmin() {
  const { toast } = useApp();
  const [items, setItems] = useState(null);
  const load = () => api.get("/api/admin/leads").then((d) => setItems(d.items));
  useEffect(() => { load(); }, []);

  const setStatus = async (id, status) => {
    await api.patch(`/api/admin/leads/${id}`, { status });
    toast(`Заявка: ${STATUS[status]}`);
    load();
  };

  if (!items) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Заявки</h1>
      {items.length === 0 ? (
        <div className="empty"><h3>Заявок нет</h3><p>Сюда попадают запросы цены, заявки дилеров и вопросы с сайта.</p></div>
      ) : (
        <div className="stack">
          {items.map((l) => (
            <div className="panel" key={l.id} style={{ opacity: l.status === "done" || l.status === "spam" ? 0.6 : 1 }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <div className="row">
                  <span className="pill new">{KIND[l.kind]}</span>
                  <b>{l.name}</b>
                  <a href={`tel:${l.phone}`} style={{ color: "var(--accent)" }}>{l.phone}</a>
                  {l.company && <span className="muted">{l.company}</span>}
                </div>
                <span className="dim" style={{ fontSize: 13 }}>{dateTime(l.created_at)}</span>
              </div>
              {l.message && <p className="muted" style={{ margin: "0 0 8px" }}>{l.message}</p>}
              {l.payload?.cart?.length > 0 && (
                <div className="notice" style={{ marginBottom: 8 }}>
                  Корзина: {l.payload.cart.map((i) => `${i.name} × ${i.qty}`).join("; ")}
                </div>
              )}
              <div className="row">
                {Object.entries(STATUS).filter(([k]) => k !== l.status).map(([k, label]) => (
                  <button key={k} className="btn btn-sm" onClick={() => setStatus(l.id, k)}>{label}</button>
                ))}
                <a className="btn btn-sm btn-dark" style={{ marginLeft: "auto" }}
                  href={`https://wa.me/${l.phone.replace(/\D/g, "")}`} target="_blank" rel="noopener">Написать в WhatsApp</a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
