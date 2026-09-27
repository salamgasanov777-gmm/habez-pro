import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";

// Товары Habez глазами машины: у кого сколько характеристик и сколько из них
// в числах — то есть пригодны для сравнения и расчётов.
export default function Products() {
  const { meta } = useApp();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");

  const load = () => api.get(`/api/ai/products?${api.qs({ search })}`).then(setData).catch(() => setData({ items: [] }));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [search]);

  const totals = data?.items.reduce((a, p) => ({
    specs: a.specs + p.specs, numeric: a.numeric + p.numeric_specs, verified: a.verified + p.verified_specs,
    withSpecs: a.withSpecs + (p.specs > 0 ? 1 : 0),
  }), { specs: 0, numeric: 0, verified: 0, withSpecs: 0 });

  return (
    <div className="stack" style={{ gap: 18 }}>
      <h1>Товары</h1>
      <p className="hint" style={{ margin: 0 }}>
        Характеристики из карточек, приведённые к числам: «не менее 0,5 МПа» здесь
        становится 0,5 МПа, и такие значения уже можно сравнивать между товарами.
        Исходная запись сохраняется — она главная.
      </p>

      <input className="input" placeholder="Поиск по названию" value={search}
        onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 360 }} />

      {!data ? <div className="skeleton" style={{ height: 320 }} /> : data.items.length === 0 ? (
        <div className="empty"><h3>Товары не найдены</h3></div>
      ) : (
        <>
          <p className="dim" style={{ fontSize: 13, margin: 0 }}>
            Товаров: {data.items.length} · с характеристиками: {totals.withSpecs} ·
            записей: {totals.specs}, из них числовых: {totals.numeric}, подтверждено: {totals.verified}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Товар</th><th>Раздел</th><th>Характеристик</th><th>Числами</th><th>Подтверждено</th><th>Статус</th></tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/admin/ai/products/${p.id}`} style={{ fontWeight: 550 }}>{p.name}</Link></td>
                    <td className="muted">{p.category || "—"}</td>
                    <td className="num">{p.specs || <span className="dim">—</span>}</td>
                    <td className="num">{p.numeric_specs || <span className="dim">—</span>}</td>
                    <td className="num">{p.verified_specs || <span className="dim">0</span>}</td>
                    <td>
                      {p.specs === 0
                        ? <span className="pill">нет данных</span>
                        : <span className={`pill ${p.verified_specs ? "paid" : "pending"}`}>{p.verified_specs ? "есть проверенные" : "не проверено"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
