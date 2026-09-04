import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { store } from "../lib/storage.js";
import { Close } from "../components/Icons.jsx";

// Сравнение сводит характеристики в таблицу на сервере: клиент только рисует.
export default function Compare() {
  const [ids, setIds] = useState(() => store.session.get("compare", []));
  const [data, setData] = useState(null);

  useEffect(() => {
    store.session.set("compare", ids);
    if (ids.length < 2) { setData(null); return; }
    api.get(`/api/catalog/compare?ids=${ids.join(",")}`).then(setData).catch(() => setData(null));
  }, [ids]);

  if (ids.length < 2) {
    return (
      <div className="empty">
        <h3>Выберите хотя бы два товара</h3>
        <p>В каталоге под карточкой есть кнопка «Сравнить» — отметьте до четырёх позиций.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 14 }}>В каталог</Link>
      </div>
    );
  }

  return (
    <main className="page" style={{ padding: "24px 20px 60px" }}>
      <div className="spread" style={{ marginBottom: 16 }}>
        <h1>Сравнение</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => setIds([])}>Очистить</button>
      </div>

      {!data ? <div className="skeleton" style={{ height: 320 }} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 190 }}>Характеристика</th>
                {data.products.map((p) => (
                  <th key={p.id} style={{ minWidth: 160 }}>
                    <div className="spread" style={{ alignItems: "flex-start" }}>
                      <Link to={`/p/${p.slug}`} style={{ textTransform: "none", letterSpacing: 0, fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{p.name}</Link>
                      <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setIds(ids.filter((x) => x !== p.id))} aria-label="Убрать">
                        <Close width={14} height={14} />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{r.label}</td>
                  {r.values.map((v, j) => (
                    <td key={j} className="num" style={{ color: v === null ? "var(--ink-3)" : undefined }}>
                      {v === "ДА" ? <span style={{ color: "var(--ok)" }}>✓</span> : v === "НЕТ" ? <span className="dim">—</span> : (v ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
