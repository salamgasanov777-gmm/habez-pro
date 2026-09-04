import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { dateTime } from "../lib/format.js";

const ACTION = {
  "product.create": "создан товар", "product.update": "изменён товар", "product.archive": "товар в архив",
  "price.set": "изменена цена", "price.bulk": "цены группой", "stock.set": "изменён остаток",
  "order.status": "статус заказа", "user.update": "изменён пользователь",
  "settings.update": "изменены настройки", "media.upload": "загружен файл",
};

// Журнал отвечает на вопрос «кто поменял цену» — он возникает на любом
// производстве, где с каталогом работает больше одного человека.
export default function AuditAdmin() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get("/api/admin/audit").then((d) => setItems(d.items)); }, []);
  if (!items) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Журнал изменений</h1>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Объект</th><th>Подробности</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className="dim" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{dateTime(a.created_at)}</td>
                <td>{a.actor || "система"}</td>
                <td>{ACTION[a.action] || a.action}</td>
                <td className="num dim">{a.entity} #{a.entity_id}</td>
                <td className="dim" style={{ fontSize: 12.5, fontFamily: "var(--mono)" }}>
                  {Object.entries(a.diff || {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
