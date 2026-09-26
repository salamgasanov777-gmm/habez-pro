import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { date } from "../lib/format.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";
import { SOURCE_TYPE_LABEL, SOURCE_STATUS_LABEL } from "./labels.js";

// Источники: откуда берутся сведения. Без источника факт подтвердить нельзя,
// поэтому список ведётся раньше самих фактов.
export default function Sources({ onChanged }) {
  const { user, toast } = useApp();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState(null);   // объект источника или "new"
  const isAdmin = ["admin", "owner"].includes(user.role);

  const load = () => api.get(`/api/ai/sources?${api.qs({ search })}`).then(setData).catch(() => setData({ items: [] }));
  useEffect(() => { api.get("/api/ai/meta").then(setMeta).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [search]);

  const markChecked = async (s) => {
    try {
      await api.patch(`/api/ai/sources/${s.id}`, { checked: true });
      toast("Отмечено: источник проверен сегодня");
      load();
    } catch (e) { toast(e.message, "err"); }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <h1>Источники</h1>
        {isAdmin && <button className="btn btn-primary btn-sm" onClick={() => setEdit("new")}>Добавить источник</button>}
      </div>

      <p className="hint" style={{ margin: 0 }}>
        Прайс завода, сайт производителя, прайс дилера, документ. Чем надёжнее источник,
        тем выше доверие к фактам, которые на него ссылаются.
      </p>

      <input className="input" placeholder="Поиск по названию или адресу" value={search}
        onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360 }} />

      {!data ? <div className="skeleton" style={{ height: 260 }} /> : data.items.length === 0 ? (
        <div className="empty">
          <h3>Источников пока нет</h3>
          <p>Первым обычно заводят прайс завода — на него ссылаются цены и фасовки.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Название</th><th>Вид</th><th>Издатель</th><th>Фактов</th><th>Доверие</th><th>Состояние</th><th>Проверен</th><th></th></tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span style={{ fontWeight: 550 }}>{s.name}</span>
                    {s.url && <div><a href={s.url} target="_blank" rel="noopener noreferrer" className="dim" style={{ fontSize: 12 }}>{s.url}</a></div>}
                  </td>
                  <td className="muted">{SOURCE_TYPE_LABEL[s.sourceType] || s.sourceType}</td>
                  <td className="muted">{s.publisher || "—"}</td>
                  <td className="num">{s.facts}</td>
                  <td className="num">{s.trustBase}</td>
                  <td><span className={`pill ${s.status === "active" ? "paid" : "pending"}`}>{SOURCE_STATUS_LABEL[s.status] || s.status}</span></td>
                  <td className="dim" style={{ fontSize: 13 }}>{s.lastCheckedAt ? date(s.lastCheckedAt) : "—"}</td>
                  <td>
                    {isAdmin && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => setEdit(s)}>Изменить</button>
                        <button className="btn btn-sm" onClick={() => markChecked(s)}>Проверен</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <SourceForm meta={meta} source={edit === "new" ? null : edit}
          onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); onChanged?.(); }} />
      )}
    </div>
  );
}

function SourceForm({ meta, source, onClose, onDone }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    sourceType: source?.sourceType || "price_list",
    name: source?.name || "",
    url: source?.url || "",
    publisher: source?.publisher || "",
    description: source?.description || "",
    trustBase: source?.trustBase ?? "",
    status: source?.status || "active",
  });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        sourceType: v.sourceType, name: v.name.trim(), url: v.url.trim(),
        publisher: v.publisher.trim() || undefined, description: v.description.trim() || undefined,
        status: v.status,
        ...(v.trustBase !== "" ? { trustBase: Number(v.trustBase) } : {}),
      };
      if (source) await api.patch(`/api/ai/sources/${source.id}`, body);
      else await api.post("/api/ai/sources", body);
      toast(source ? "Источник изменён" : "Источник добавлен");
      onDone();
    } catch (e) {
      toast(e.message, "err");
    } finally { setBusy(false); }
  };

  return (
    <Modal title={source ? "Источник" : "Новый источник"} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Название</span>
          <input className="input" value={v.name} onChange={set("name")} placeholder="Прайс завода от 6 сентября 2026" />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Вид</span>
          <select className="input" value={v.sourceType} onChange={set("sourceType")}>
            {(meta?.sourceTypes || []).map((t) => <option key={t} value={t}>{SOURCE_TYPE_LABEL[t] || t}</option>)}
          </select>
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Адрес страницы (если есть)</span>
          <input className="input" value={v.url} onChange={set("url")} placeholder="https://…" />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Кто издал</span>
          <input className="input" value={v.publisher} onChange={set("publisher")} placeholder="Хабезский гипсовый завод" />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Пояснение</span>
          <input className="input" value={v.description} onChange={set("description")} placeholder="для чего этот источник" />
        </label>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="stack" style={{ gap: 6, flex: "1 1 140px" }}>
            <span className="label">Доверие (0–100)</span>
            <input className="input" type="number" min="0" max="100" value={v.trustBase} onChange={set("trustBase")} placeholder="по виду источника" />
          </label>
          <label className="stack" style={{ gap: 6, flex: "1 1 160px" }}>
            <span className="label">Состояние</span>
            <select className="input" value={v.status} onChange={set("status")}>
              {(meta?.sourceStatuses || []).map((s) => <option key={s} value={s}>{SOURCE_STATUS_LABEL[s] || s}</option>)}
            </select>
          </label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={busy || v.name.trim().length < 2} onClick={save}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}
