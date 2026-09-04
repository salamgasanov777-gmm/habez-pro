import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { useApp } from "../store.jsx";

const ROLES = { customer: "Покупатель", dealer: "Дилер", manager: "Менеджер", admin: "Администратор", owner: "Владелец" };
const TIERS = { retail: "Розница", dealer: "Дилер", vip: "Особые" };

export default function UsersAdmin() {
  const { toast } = useApp();
  const [items, setItems] = useState(null);
  const load = () => api.get("/api/admin/users").then((d) => setItems(d.items));
  useEffect(() => { load(); }, []);

  const patch = async (id, body, msg) => {
    try { await api.patch(`/api/admin/users/${id}`, body); toast(msg); load(); }
    catch (e) { toast(e.message, "err"); }
  };

  if (!items) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Пользователи</h1>
      <p className="hint">
        Дилерский прайс включается сменой колонки «Цены» — покупатель сразу увидит свои цены,
        отдельный сайт для дилеров не нужен.
      </p>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Кто</th><th>Контакты</th><th>Роль</th><th>Цены</th><th>Статус</th><th>Последний вход</th></tr></thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name || "—"}</b>{u.company && <div className="dim" style={{ fontSize: 12.5 }}>{u.company}</div>}</td>
                <td className="muted" style={{ fontSize: 13.5 }}>{u.email}<br />{u.phone}</td>
                <td>
                  <select className="select" style={{ padding: "5px 8px", fontSize: 13 }} value={u.role} disabled={u.role === "owner"}
                    onChange={(e) => patch(u.id, { role: e.target.value }, "Роль изменена")}>
                    {Object.entries(ROLES).filter(([k]) => k !== "owner").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    {u.role === "owner" && <option value="owner">Владелец</option>}
                  </select>
                </td>
                <td>
                  <select className="select" style={{ padding: "5px 8px", fontSize: 13 }} value={u.price_tier}
                    onChange={(e) => patch(u.id, { priceTier: e.target.value }, "Прайс изменён")}>
                    {Object.entries(TIERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td>
                  <button className={`pill ${u.status === "active" ? "paid" : "cancelled"}`} style={{ border: 0, cursor: "pointer" }}
                    onClick={() => patch(u.id, { status: u.status === "active" ? "blocked" : "active" }, "Статус изменён")}>
                    {u.status === "active" ? "активен" : "заблокирован"}
                  </button>
                </td>
                <td className="dim" style={{ fontSize: 13 }}>{u.last_login_at ? dateTime(u.last_login_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
