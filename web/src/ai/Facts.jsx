import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { dateTime, date } from "../lib/format.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";
import {
  ORIGIN_LABEL, ORIGIN_HINT, STATUS_LABEL, STATUS_PILL, FACT_TYPE_LABEL,
  SUBJECT_TYPE_LABEL, factValue,
} from "./labels.js";

// Список фактов: что известно, откуда и насколько этому можно верить.
export default function Facts({ onChanged }) {
  const { user } = useApp();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [f, setF] = useState({ search: "", status: "", origin: "", factType: "" });
  const [adding, setAdding] = useState(false);
  const canAdd = ["manager", "admin", "owner"].includes(user.role);

  const load = () => api.get(`/api/ai/facts?${api.qs({ ...f, limit: 100 })}`).then(setData).catch(() => setData({ items: [], total: 0 }));
  useEffect(() => { api.get("/api/ai/meta").then(setMeta).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [f.search, f.status, f.origin, f.factType]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <h1>Факты</h1>
        {canAdd && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Добавить факт</button>}
      </div>

      <p className="hint" style={{ margin: 0 }}>
        Здесь хранится то, что Habez AI считает известным. У каждого сведения есть источник,
        дата и состояние проверки. Предположения модели помечены отдельно и подтверждёнными
        фактами не становятся.
      </p>

      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <input className="input" placeholder="Поиск по объекту, полю или значению" value={f.search}
          onChange={set("search")} style={{ maxWidth: 320 }} />
        <select className="input" value={f.status} onChange={set("status")} style={{ maxWidth: 190 }}>
          <option value="">Любое состояние</option>
          {(meta?.statuses || []).map((s) => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
        </select>
        <select className="input" value={f.origin} onChange={set("origin")} style={{ maxWidth: 210 }}>
          <option value="">Любое происхождение</option>
          {(meta?.origins || []).map((o) => <option key={o} value={o}>{ORIGIN_LABEL[o] || o}</option>)}
        </select>
        <select className="input" value={f.factType} onChange={set("factType")} style={{ maxWidth: 190 }}>
          <option value="">Любой тип</option>
          {(meta?.factTypes || []).map((t) => <option key={t} value={t}>{FACT_TYPE_LABEL[t] || t}</option>)}
        </select>
      </div>

      {!data ? <div className="skeleton" style={{ height: 300 }} /> : data.items.length === 0 ? (
        <div className="empty">
          <h3>Фактов пока нет</h3>
          <p>Начните с источника — прайса завода или сайта производителя, — затем добавьте первые сведения.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Объект</th><th>Что известно</th><th>Значение</th><th>Источник</th>
                <th>Происхождение</th><th>Состояние</th><th>Доверие</th><th>Проверен</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link to={`/admin/ai/facts/${x.id}`} style={{ fontWeight: 550 }}>{x.subject.label || "—"}</Link>
                    <div className="dim" style={{ fontSize: 12 }}>{SUBJECT_TYPE_LABEL[x.subject.type] || x.subject.type}</div>
                  </td>
                  <td>{x.attribute}<div className="dim" style={{ fontSize: 12 }}>{FACT_TYPE_LABEL[x.factType] || x.factType}</div></td>
                  <td>{factValue(x) || <span className="dim">—</span>}</td>
                  <td className="muted">{x.source?.name || <span className="dim">нет</span>}</td>
                  <td>
                    <span className="muted" style={{ fontSize: 13 }} title={ORIGIN_HINT[x.origin]}>{ORIGIN_LABEL[x.origin] || x.origin}</span>
                  </td>
                  <td><span className={`pill ${STATUS_PILL[x.verificationStatus] || ""}`}>{STATUS_LABEL[x.verificationStatus]}</span></td>
                  <td className="num">{x.confidence}</td>
                  <td className="dim" style={{ fontSize: 13 }}>
                    {x.checkedAt ? date(x.checkedAt) : "—"}
                    {x.outdated && <div style={{ color: "var(--warn)" }}>пора перепроверить</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && <p className="dim" style={{ fontSize: 13 }}>Всего: {data.total}</p>}
      {adding && <AddFact meta={meta} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); onChanged?.(); }} />}
    </div>
  );
}

// Добавление факта вручную: объект → что известно → откуда.
function AddFact({ meta, onClose, onDone }) {
  const { toast } = useApp();
  const [sources, setSources] = useState([]);
  const [products, setProducts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    factType: "spec", subjectType: "product", subjectId: "", attribute: "",
    valueText: "", valueNum: "", unit: "", sourceId: "", origin: "habez_internal",
  });

  useEffect(() => {
    api.get("/api/ai/sources?status=active").then((d) => setSources(d.items)).catch(() => {});
    api.get("/api/admin/products?limit=200").then((d) => setProducts(d.items)).catch(() => {});
  }, []);

  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const needsSubject = ["product", "variant", "category"].includes(v.subjectType);

  const save = async () => {
    setBusy(true);
    try {
      await api.post("/api/ai/facts", {
        factType: v.factType,
        subjectType: v.subjectType,
        ...(needsSubject && v.subjectId ? { subjectId: Number(v.subjectId) } : {}),
        attribute: v.attribute.trim(),
        ...(v.valueText.trim() ? { valueText: v.valueText.trim() } : {}),
        ...(v.valueNum !== "" ? { valueNum: Number(v.valueNum) } : {}),
        ...(v.unit.trim() ? { unit: v.unit.trim() } : {}),
        ...(v.sourceId ? { sourceId: Number(v.sourceId) } : {}),
        origin: v.origin,
      });
      toast("Факт записан. Он ждёт проверки");
      onDone();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Новый факт" onClose={onClose} wide>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="stack" style={{ gap: 6, flex: "1 1 200px" }}>
            <span className="label">Тип сведения</span>
            <select className="input" value={v.factType} onChange={set("factType")}>
              {(meta?.factTypes || []).map((t) => <option key={t} value={t}>{FACT_TYPE_LABEL[t] || t}</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: 6, flex: "1 1 200px" }}>
            <span className="label">Объект</span>
            <select className="input" value={v.subjectType} onChange={set("subjectType")}>
              {(meta?.subjectTypes || []).map((t) => <option key={t} value={t}>{SUBJECT_TYPE_LABEL[t] || t}</option>)}
            </select>
          </label>
        </div>

        {needsSubject && (
          <label className="stack" style={{ gap: 6 }}>
            <span className="label">{v.subjectType === "product" ? "Товар из каталога" : "Номер объекта"}</span>
            {v.subjectType === "product" ? (
              <select className="input" value={v.subjectId} onChange={set("subjectId")}>
                <option value="">— выберите товар —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <input className="input" value={v.subjectId} onChange={set("subjectId")} placeholder="номер фасовки или раздела" />
            )}
          </label>
        )}

        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Что известно</span>
          <input className="input" value={v.attribute} onChange={set("attribute")} placeholder="прочность на сжатие, расход, цена розничная" />
        </label>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="stack" style={{ gap: 6, flex: "2 1 240px" }}>
            <span className="label">Значение словами</span>
            <input className="input" value={v.valueText} onChange={set("valueText")} placeholder="не менее 2 МПа" />
          </label>
          <label className="stack" style={{ gap: 6, flex: "1 1 120px" }}>
            <span className="label">Числом</span>
            <input className="input" type="number" step="any" value={v.valueNum} onChange={set("valueNum")} placeholder="2" />
          </label>
          <label className="stack" style={{ gap: 6, flex: "1 1 100px" }}>
            <span className="label">Единица</span>
            <input className="input" value={v.unit} onChange={set("unit")} placeholder="МПа" />
          </label>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="stack" style={{ gap: 6, flex: "1 1 240px" }}>
            <span className="label">Источник</span>
            <select className="input" value={v.sourceId} onChange={set("sourceId")}>
              <option value="">— выберите источник —</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: 6, flex: "1 1 240px" }}>
            <span className="label">Происхождение</span>
            <select className="input" value={v.origin} onChange={set("origin")}>
              {(meta?.origins || []).map((o) => <option key={o} value={o}>{ORIGIN_LABEL[o] || o}</option>)}
            </select>
          </label>
        </div>
        <p className="hint" style={{ margin: 0 }}>{ORIGIN_HINT[v.origin]}</p>

        <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={busy || !v.attribute.trim()} onClick={save}>Записать</button>
        </div>
      </div>
    </Modal>
  );
}
