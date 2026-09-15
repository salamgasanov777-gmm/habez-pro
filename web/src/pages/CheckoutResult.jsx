import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { store } from "../lib/storage.js";
import { money, ORDER_LABEL, PAY_LABEL } from "../lib/format.js";
import { Check } from "../components/Icons.jsx";

// Автономная копия сайта: заказ не отправлен, а собран текстом. Говорим это
// прямо и даём два пути — скопировать текст и позвонить в отдел продаж.
function StandaloneResult() {
  const { meta, toast } = useApp();
  const remembered = store.get("last-order", {}) || {};
  const text = remembered.text || "";
  const phone = meta?.tenant?.phone;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast("Заказ скопирован"); }
    catch { toast("Скопировать не вышло — выделите текст вручную", "err"); }
  };
  return (
    <main className="page" style={{ maxWidth: 640, padding: "40px 20px 60px" }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <h1>Заказ собран</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Эта версия каталога работает без сервера, поэтому заказ не отправляется сам.
          Текст заказа скопирован — вставьте его в сообщение менеджеру или позвоните в отдел продаж.
        </p>
        {text && (
          <pre style={{ textAlign: "left", whiteSpace: "pre-wrap", fontSize: 14, marginTop: 18, padding: 14,
            background: "var(--paper)", borderRadius: 12 }}>{text}</pre>
        )}
        <div className="row" style={{ justifyContent: "center", marginTop: 18, flexWrap: "wrap" }}>
          {text && <button className="btn" onClick={copy}>Скопировать ещё раз</button>}
          {phone && <a className="btn btn-primary" href={`tel:${phone}`}>Позвонить {phone}</a>}
        </div>
        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <Link to="/" className="btn btn-ghost">В каталог</Link>
        </div>
      </div>
    </main>
  );
}

export default function CheckoutResult() {
  const [params] = useSearchParams();
  if (params.get("standalone")) return <StandaloneResult />;
  return <ServerResult number={params.get("order")} params={params} />;
}

function ServerResult({ number, params }) {
  // Телефон приходит из адреса, а после возврата из банка — из памяти браузера,
  // куда его положило оформление заказа.
  const remembered = store.get("last-order", {}) || {};
  const phone = params.get("phone") || (remembered.number === number ? remembered.phone : "") || "";
  const [order, setOrder] = useState(null);
  const [tries, setTries] = useState(0);

  // После возврата из банка вебхук может прийти на секунду позже редиректа —
  // несколько раз перечитываем заказ, чтобы человек увидел «оплачен», а не «ждёт».
  useEffect(() => {
    if (!number) return;
    let stop = false;
    const load = () =>
      api.get(`/api/orders/${encodeURIComponent(number)}?phone=${encodeURIComponent(phone.replace(/\D/g, ""))}`)
        .then((o) => { if (!stop) { setOrder(o); if (o.paymentStatus === "pending" && tries < 4) setTimeout(() => setTries((t) => t + 1), 1500); } })
        .catch(() => {});
    load();
    return () => { stop = true; };
  }, [number, phone, tries]);

  if (!number) return <div className="empty"><h3>Заказ не указан</h3><Link className="btn" to="/">В каталог</Link></div>;

  const paid = order?.paymentStatus === "paid";

  return (
    <main className="page" style={{ maxWidth: 640, padding: "40px 20px 60px" }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <div style={{
          width: 62, height: 62, borderRadius: "50%", margin: "0 auto 16px", display: "grid", placeItems: "center",
          background: paid ? "var(--ok-soft)" : "var(--accent-soft)", color: paid ? "var(--ok)" : "var(--accent)",
        }}>
          <Check width={30} height={30} />
        </div>

        <h1>{paid ? "Оплачено" : "Заказ принят"}</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Номер <b className="num">{number}</b>. {paid
            ? "Оплата подтверждена, заказ передан на склад."
            : "Менеджер свяжется по телефону и подтвердит отгрузку."}
        </p>

        {order && (
          <>
            <div className="stack" style={{ marginTop: 22, textAlign: "left" }}>
              {order.items.map((i, n) => (
                <div className="sum-row" key={n}><span className="muted">{i.name} × {i.qty}</span><span className="num">{money(i.total)}</span></div>
              ))}
              <div className="sum-row total"><span>Итого</span><span>{money(order.total)}</span></div>
            </div>
            <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
              <span className={`pill ${order.status}`}>{ORDER_LABEL[order.status]}</span>
              <span className={`pill ${order.paymentStatus}`}>{PAY_LABEL[order.paymentStatus]}</span>
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: "center", marginTop: 22 }}>
          <Link to="/" className="btn">В каталог</Link>
          <Link to="/account" className="btn btn-dark">Мои заказы</Link>
        </div>
      </div>
    </main>
  );
}
