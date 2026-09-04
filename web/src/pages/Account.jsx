import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { money, dateTime, ORDER_LABEL, PAY_LABEL } from "../lib/format.js";

export default function Account() {
  const { user, logout, ready } = useApp();
  const nav = useNavigate();
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    if (ready && !user) nav("/login", { replace: true });
    if (user) api.get("/api/orders").then((d) => setOrders(d.items)).catch(() => setOrders([]));
  }, [user, ready, nav]);

  if (!user) return <div className="empty">Загрузка…</div>;

  const TIERS = { retail: "Розничные цены", dealer: "Дилерские цены", vip: "Особые условия" };

  return (
    <main className="page" style={{ padding: "24px 20px 60px", display: "grid", gap: 20 }}>
      <div className="panel spread">
        <div>
          <h1>{user.name || user.phone}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {user.company && <>{user.company} · </>}{TIERS[user.priceTier]}
          </p>
        </div>
        <div className="row">
          {["manager", "admin", "owner"].includes(user.role) && (
            <Link to="/admin" className="btn btn-dark">Панель управления</Link>
          )}
          <button className="btn" onClick={() => logout().then(() => nav("/"))}>Выйти</button>
        </div>
      </div>

      <section>
        <h2 style={{ marginBottom: 14 }}>Мои заказы</h2>
        {!orders ? <div className="skeleton" style={{ height: 120 }} /> : orders.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            <p>Заказов пока нет.</p>
            <Link to="/" className="btn btn-primary">Перейти в каталог</Link>
          </div>
        ) : (
          <div className="stack">
            {orders.map((o) => (
              <div className="panel" key={o.id}>
                <div className="spread" style={{ marginBottom: 10 }}>
                  <div>
                    <b className="num">{o.number}</b>
                    <span className="dim" style={{ marginLeft: 10, fontSize: 13 }}>{dateTime(o.createdAt)}</span>
                  </div>
                  <div className="row">
                    <span className={`pill ${o.status}`}>{ORDER_LABEL[o.status]}</span>
                    <span className={`pill ${o.paymentStatus}`}>{PAY_LABEL[o.paymentStatus]}</span>
                  </div>
                </div>
                {o.items.map((i, n) => (
                  <div className="sum-row" key={n}><span className="muted">{i.name} × {i.qty}</span><span className="num">{money(i.total)}</span></div>
                ))}
                <div className="sum-row total"><span>Итого</span><span>{money(o.total)}</span></div>
                {o.payment?.url && o.paymentStatus === "pending" && (
                  <a href={o.payment.url} className="btn btn-primary btn-block" style={{ marginTop: 12 }}>Оплатить</a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
