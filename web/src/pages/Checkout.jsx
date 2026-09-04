import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { store } from "../lib/storage.js";
import { money, phoneMask, plural } from "../lib/format.js";

export default function Checkout() {
  const { cart, user, meta, reloadCart, toast } = useApp();
  const nav = useNavigate();
  const [form, setForm] = useState({
    name: user?.name || "", phone: user?.phone ? phoneMask(user.phone) : "", email: user?.email || "",
    company: user?.company || "", inn: "", deliveryType: "pickup", deliveryAddress: "", comment: "",
  });
  const [promo, setPromo] = useState("");
  const [discount, setDiscount] = useState(0);
  const [payNow, setPayNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const deliveryCost = form.deliveryType === "delivery" ? (meta?.settings?.deliveryCost ?? 0) : 0;
  const total = Math.max(0, cart.subtotal - discount + deliveryCost);
  const set = (k) => (e) => setForm({ ...form, [k]: k === "phone" ? phoneMask(e.target.value) : e.target.value });

  if (!cart.items.length) return <div className="empty"><h3>Корзина пуста</h3><Link to="/" className="btn">В каталог</Link></div>;

  const applyPromo = async () => {
    try {
      const res = await api.post("/api/orders/promo", { code: promo });
      setDiscount(res.discount);
      toast(`Промокод применён: −${money(res.discount)}`);
    } catch (e) { setErr(e.message); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const order = await api.post("/api/orders", { customer: form, promoCode: promo || null });
      await reloadCart();

      // Гость смотрит свой заказ по номеру и телефону. С платёжной страницы
      // банк возвращает только номер, поэтому телефон запоминаем здесь.
      store.set("last-order", { number: order.number, phone: form.phone });

      if (payNow && order.total > 0) {
        const pay = await api.post("/api/payments/create", { orderNumber: order.number });
        // Уходим на страницу банка: возврат настроен на /checkout/result.
        if (pay.url) { location.href = pay.url; return; }
      }
      nav(`/checkout/result?order=${encodeURIComponent(order.number)}&phone=${encodeURIComponent(form.phone)}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ padding: "24px 20px 60px" }}>
      <h1 style={{ marginBottom: 18 }}>Оформление заказа</h1>

      <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 26, alignItems: "start" }} className="cart-layout">
        <div className="stack" style={{ gap: 18 }}>
          <section className="panel stack">
            <h3>Кто получает</h3>
            <label className="field"><span>Имя и фамилия</span>
              <input className="input" required minLength={2} value={form.name} onChange={set("name")} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label className="field"><span>Телефон</span>
                <input className="input" required inputMode="tel" placeholder="+7 (___) ___-__-__" value={form.phone} onChange={set("phone")} /></label>
              <label className="field"><span>Почта <span className="dim">— для чека</span></span>
                <input className="input" type="email" value={form.email} onChange={set("email")} /></label>
            </div>
          </section>

          <section className="panel stack">
            <h3>Организация <span className="dim" style={{ fontWeight: 400, fontSize: 13 }}>— если нужен счёт и закрывающие документы</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
              <label className="field"><span>Название</span><input className="input" value={form.company} onChange={set("company")} /></label>
              <label className="field"><span>ИНН</span><input className="input" inputMode="numeric" maxLength={12} value={form.inn} onChange={set("inn")} /></label>
            </div>
          </section>

          <section className="panel stack">
            <h3>Получение</h3>
            <div className="variant-list">
              <button type="button" className={`variant ${form.deliveryType === "pickup" ? "on" : ""}`} onClick={() => setForm({ ...form, deliveryType: "pickup" })}>
                <span><b>Самовывоз со склада</b><br /><span className="dim" style={{ fontSize: 13 }}>{meta?.tenant?.address}</span></span>
                <span className="num">0 ₽</span>
              </button>
              <button type="button" className={`variant ${form.deliveryType === "delivery" ? "on" : ""}`} onClick={() => setForm({ ...form, deliveryType: "delivery" })}>
                <span><b>Доставка</b><br /><span className="dim" style={{ fontSize: 13 }}>по согласованию с менеджером</span></span>
                <span className="num">от {money(meta?.settings?.deliveryCost ?? 0)}</span>
              </button>
            </div>
            {form.deliveryType === "delivery" && (
              <label className="field"><span>Адрес доставки</span>
                <input className="input" required value={form.deliveryAddress} onChange={set("deliveryAddress")} placeholder="Город, улица, дом, ориентир" /></label>
            )}
            <label className="field"><span>Комментарий</span>
              <textarea className="textarea" value={form.comment} onChange={set("comment")} placeholder="Когда удобно принять, нужна ли разгрузка" /></label>
          </section>

          <section className="panel stack">
            <h3>Оплата</h3>
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="radio" checked={payNow} onChange={() => setPayNow(true)} />
              <span>Картой онлайн — заказ уходит в работу сразу</span>
            </label>
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="radio" checked={!payNow} onChange={() => setPayNow(false)} />
              <span>Счёт или оплата при получении — менеджер свяжется и подтвердит</span>
            </label>
          </section>
        </div>

        <aside className="summary">
          <div className="label">Ваш заказ</div>
          {cart.items.map((i) => (
            <div className="sum-row" key={i.id}>
              <span className="muted" style={{ maxWidth: "60%" }}>{i.name} × {i.qty}</span>
              <span className="num">{money(i.total)}</span>
            </div>
          ))}

          <div className="row" style={{ marginTop: 6 }}>
            <input className="input" placeholder="Промокод" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} />
            <button type="button" className="btn btn-sm" onClick={applyPromo}>ОК</button>
          </div>

          {discount > 0 && <div className="sum-row" style={{ color: "var(--ok)" }}><span>Скидка</span><span className="num">−{money(discount)}</span></div>}
          {deliveryCost > 0 && <div className="sum-row muted"><span>Доставка</span><span className="num">{money(deliveryCost)}</span></div>}
          <div className="sum-row total"><span>К оплате</span><span>{money(total)}</span></div>

          {err && <p className="error-text">{err}</p>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? "Оформляем…" : payNow ? "Перейти к оплате" : "Оформить заказ"}
          </button>
          <p className="hint">{plural(cart.count, "товар", "товара", "товаров")} · нажимая кнопку, вы соглашаетесь на обработку персональных данных</p>
        </aside>
      </form>
    </main>
  );
}
