import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { money, plural } from "../lib/format.js";
import PushCard from "./PushCard.jsx";

export default function Dashboard() {
  const [s, setS] = useState(null);
  useEffect(() => { api.get("/api/admin/stats").then(setS).catch(() => {}); }, []);
  if (!s) return <div className="skeleton" style={{ height: 300 }} />;

  const max = Math.max(1, ...s.chart.map((d) => d.orders));

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="spread">
        <h1>Сводка</h1>
        <a className="btn btn-sm" href="/api/admin/export/prices.csv">Выгрузить прайс в Excel</a>
      </div>

      <PushCard />

      <div className="kpis">
        <div className="kpi"><span className="label">Заказов сегодня</span><b>{s.orders.today}</b>
          <span className="delta">за 30 дней — {s.orders.month}</span></div>
        <div className="kpi"><span className="label">Оплачено за месяц</span><b>{money(s.revenue.month)}</b>
          <span className="delta">ждёт оплаты {money(s.revenue.pending)}</span></div>
        <div className="kpi"><span className="label">Новые заказы</span><b>{s.orders.new}</b>
          <span className="delta"><Link to="/admin/orders?status=new" style={{ color: "var(--accent)" }}>разобрать</Link></span></div>
        <div className="kpi"><span className="label">Новые заявки</span><b>{s.leads.new}</b>
          <span className="delta"><Link to="/admin/leads" style={{ color: "var(--accent)" }}>открыть</Link></span></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 16 }} className="dash-grid">
        <section className="panel">
          <div className="spread"><h3>Заказы за две недели</h3><span className="dim" style={{ fontSize: 13 }}>всего {s.chart.reduce((a, d) => a + d.orders, 0)}</span></div>
          <div className="bars">
            {s.chart.length === 0 && <p className="dim" style={{ fontSize: 13 }}>Заказов пока нет — график появится после первого.</p>}
            {s.chart.map((d) => (
              <div key={d.day} className="bar" style={{ height: `${(d.orders / max) * 100}%` }} title={`${d.day}: ${d.orders} на ${money(d.total)}`} />
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>Состояние каталога</h3>
          <div className="stack" style={{ gap: 9, marginTop: 12, fontSize: 14 }}>
            <div className="sum-row"><span className="muted">Товаров всего</span><span className="num">{s.catalog.products}</span></div>
            <div className="sum-row"><span className="muted">Опубликовано</span><span className="num">{s.catalog.published}</span></div>
            <div className="sum-row"><span className="muted">Без цены</span><span className="num" style={{ color: s.catalog.noPrice ? "var(--warn)" : "var(--ok)" }}>{s.catalog.noPrice}</span></div>
          </div>
          {s.catalog.noPrice > 0 && (
            <div className="notice" style={{ marginTop: 12 }}>
              У {plural(s.catalog.noPrice, "позиции", "позиций", "позиций")} нет цены — покупатель видит «по запросу».
              <Link to="/admin/products" style={{ color: "var(--accent)" }}> Проставить</Link>
            </div>
          )}
        </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        <section className="panel">
          <h3>Что смотрят и покупают</h3>
          <table className="table" style={{ marginTop: 8 }}>
            <thead><tr><th>Товар</th><th style={{ textAlign: "right" }}>Просмотры</th><th style={{ textAlign: "right" }}>Продано</th></tr></thead>
            <tbody>
              {s.topProducts.map((p, i) => (
                <tr key={i}><td>{p.name}</td><td className="num" style={{ textAlign: "right" }}>{p.views}</td><td className="num" style={{ textAlign: "right" }}>{p.sold}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h3>Искали и не нашли</h3>
          <p className="hint">Прямая подсказка, каких товаров или описаний не хватает в каталоге.</p>
          {s.missedSearches.length === 0 ? <p className="dim" style={{ fontSize: 14 }}>Пока все запросы находят товар.</p> : (
            <div className="stack" style={{ gap: 7, marginTop: 10 }}>
              {s.missedSearches.map((m, i) => (
                <div className="sum-row" key={i}><span>«{m.query}»</span><span className="num dim">{m.n}</span></div>
              ))}
            </div>
          )}
        </section>
      </div>

      <style>{`@media (max-width: 900px) { .dash-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
