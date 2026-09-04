import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { money, dateTime, mediaUrl } from "../lib/format.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";

export default function ProductsAdmin() {
  const { toast } = useApp();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");
  const [bulk, setBulk] = useState(false);

  const load = () => api.get(`/api/admin/products?${api.qs({ search, limit: 100 })}`).then(setData);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [search]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <h1>Товары и цены</h1>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setBulk(true)}>Изменить цены группой</button>
          <Link to="/admin/products/new" className="btn btn-primary btn-sm">Добавить товар</Link>
        </div>
      </div>

      <input className="input" placeholder="Поиск по названию или артикулу" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 380 }} />

      {!data ? <div className="skeleton" style={{ height: 300 }} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th></th><th>Название</th><th>Раздел</th><th>Фасовок</th><th>Цена</th><th>Просмотры</th><th>Статус</th><th>Изменён</th></tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ width: 40, height: 40, borderRadius: 8, border: "1px solid var(--line)", background: `var(--surface-2) ${p.photo ? `url('${mediaUrl(p.photo)}') center/contain no-repeat` : ""}` }} />
                  </td>
                  <td><Link to={`/admin/products/${p.id}`} style={{ fontWeight: 550 }}>{p.name}</Link></td>
                  <td className="muted">{p.category || "—"}</td>
                  <td className="num">{p.variants}</td>
                  <td className="num">{p.price === null ? <span className="dim">по запросу</span> : money(p.price)}</td>
                  <td className="num dim">{p.views}</td>
                  <td><span className={`pill ${p.status === "published" ? "paid" : "pending"}`}>{p.status === "published" ? "на витрине" : p.status === "draft" ? "черновик" : "в архиве"}</span></td>
                  <td className="dim" style={{ fontSize: 13 }}>{dateTime(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bulk && <BulkPrices onClose={() => { setBulk(false); load(); }} toast={toast} />}
    </div>
  );
}

// Поднять или опустить цены целому разделу — обычная операция при смене
// прайса. Вручную по каждой фасовке это полдня работы менеджера.
function BulkPrices({ onClose, toast }) {
  const [percent, setPercent] = useState(5);
  const [tier, setTier] = useState("retail");
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const res = await api.post("/api/admin/prices/bulk", { percent: Number(percent), tier });
      toast(`Изменено позиций: ${res.changed}`);
      onClose();
    } catch (e) { toast(e.message, "err"); setBusy(false); }
  };

  return (
    <Modal title="Изменить цены группой" onClose={onClose}>
      <div className="stack">
        <label className="field"><span>Прайс</span>
          <select className="select" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="retail">Розничный</option><option value="dealer">Дилерский</option><option value="vip">Особые условия</option>
          </select></label>
        <label className="field"><span>Изменить на, %</span>
          <input className="input num" type="number" step="0.5" value={percent} onChange={(e) => setPercent(e.target.value)} /></label>
        <div className="notice">Позиции с ценой «по запросу» не затрагиваются. Действие попадёт в журнал изменений.</div>
        <button className="btn btn-primary btn-lg btn-block" onClick={apply} disabled={busy}>Применить</button>
      </div>
    </Modal>
  );
}
