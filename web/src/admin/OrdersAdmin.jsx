import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as api from "../lib/api.js";
import { money, dateTime, ORDER_LABEL, PAY_LABEL } from "../lib/format.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";

const FLOW = ["new", "confirmed", "paid", "shipping", "done", "cancelled"];

const KIND = { person: "частник", foreman: "прораб", shop: "магазин", company: "организация" };

export default function OrdersAdmin() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const status = params.get("status") || "";
  const [search, setSearch] = useState("");

  const load = () => api.get(`/api/admin/orders?${api.qs({ status, search })}`).then(setData);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [status, search]);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Заказы</h1>

      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className={`chip ${!status ? "on" : ""}`} onClick={() => setParams({})}>Все</button>
        {FLOW.map((s) => (
          <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams({ status: s })}>{ORDER_LABEL[s]}</button>
        ))}
        <input className="input" placeholder="Номер, имя или телефон" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260, marginLeft: "auto" }} />
      </div>

      {!data ? <div className="skeleton" style={{ height: 300 }} /> : data.items.length === 0 ? (
        <div className="empty"><h3>Заказов нет</h3><p>Здесь появятся заказы с сайта, из приложения и от менеджеров.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Номер</th><th>Покупатель</th><th>Сумма</th><th>Получение</th><th>Статус</th><th>Оплата</th><th>Создан</th></tr></thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} onClick={() => api.get(`/api/admin/orders/${o.id}`).then(setOpen)} style={{ cursor: "pointer" }}>
                  <td className="num" style={{ fontWeight: 600 }}>{o.number}</td>
                  <td>
                    {o.customer_name}
                    {o.company && <div style={{ fontSize: 13 }}>{o.company}</div>}
                    <div className="dim" style={{ fontSize: 12.5 }}>
                      {KIND[o.customer_kind] && <span className="who">{KIND[o.customer_kind]}</span>}{o.customer_phone}
                    </div>
                  </td>
                  <td className="num">{money(o.total)}</td>
                  <td className="muted">{o.delivery_type === "delivery" ? "доставка" : "самовывоз"}</td>
                  <td><span className={`pill ${o.status}`}>{ORDER_LABEL[o.status]}</span></td>
                  <td><span className={`pill ${o.payment_status}`}>{PAY_LABEL[o.payment_status]}</span></td>
                  <td className="dim" style={{ fontSize: 13 }}>{dateTime(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <OrderCard order={open} onClose={() => setOpen(null)} onChanged={(o) => { setOpen(o); load(); }} />}
    </div>
  );
}

function OrderCard({ order, onClose, onChanged }) {
  const { toast } = useApp();
  const [note, setNote] = useState("");

  const change = async (status) => {
    try {
      const updated = await api.patch(`/api/admin/orders/${order.id}`, { status, managerNote: note || undefined });
      toast(`Статус: ${ORDER_LABEL[status]}`);
      onChanged(updated);
    } catch (e) { toast(e.message, "err"); }
  };

  return (
    <Modal title={`Заказ ${order.number}`} onClose={onClose} wide>
      <div className="stack" style={{ gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <span className="label">Покупатель</span>
            <p style={{ margin: "4px 0" }}>{order.customer.name}<br />
              <a href={`tel:${order.customer.phone}`} style={{ color: "var(--accent)" }}>{order.customer.phone}</a><br />
              <span className="dim">{order.customer.email}</span></p>
            {KIND[order.customer.kind] && <p className="label" style={{ margin: "2px 0 6px" }}>{KIND[order.customer.kind]}</p>}
            {order.customer.company && <p className="muted" style={{ fontSize: 13.5 }}>{order.customer.company}{order.customer.inn && `, ИНН ${order.customer.inn}`}</p>}
          </div>
          <div>
            <span className="label">Получение</span>
            <p style={{ margin: "4px 0" }}>{order.delivery.type === "delivery" ? `Доставка: ${order.delivery.address}` : "Самовывоз со склада"}</p>
            {order.comment && <p className="muted" style={{ fontSize: 13.5 }}>Комментарий: {order.comment}</p>}
          </div>
        </div>

        <div>
          {order.items.map((i, n) => (
            <div className="sum-row" key={n}><span className="muted">{i.name} · {i.unit} × {i.qty}</span><span className="num">{money(i.total)}</span></div>
          ))}
          {order.discount > 0 && <div className="sum-row" style={{ color: "var(--ok)" }}><span>Скидка {order.promoCode}</span><span className="num">−{money(order.discount)}</span></div>}
          <div className="sum-row total"><span>Итого</span><span>{money(order.total)}</span></div>
        </div>

        <div>
          <span className="label">История</span>
          <div className="stack" style={{ gap: 5, marginTop: 6, fontSize: 13.5 }}>
            {order.events.map((e, i) => (
              <div className="row" key={i}>
                <span className={`pill ${e.status}`}>{ORDER_LABEL[e.status]}</span>
                <span className="muted">{e.note}</span>
                <span className="dim" style={{ marginLeft: "auto" }}>{dateTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        </div>

        <label className="field"><span>Заметка менеджера</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: клиент просил перезвонить после 16:00" /></label>

        <div className="row" style={{ flexWrap: "wrap" }}>
          {FLOW.filter((s) => s !== order.status).map((s) => (
            <button key={s} className={`btn btn-sm ${s === "cancelled" ? "" : "btn-dark"}`} onClick={() => change(s)}>{ORDER_LABEL[s]}</button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
