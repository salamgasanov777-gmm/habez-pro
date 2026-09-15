import { useRef, useState } from "react";
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
    // Кто заказывает — менеджеру это видно сразу в списке и в уведомлении.
    kind: user?.company ? "company" : "person",
  });
  const KINDS = [
    ["person", "Частное лицо"], ["foreman", "Прораб, бригада"], ["shop", "Магазин"], ["company", "Организация"],
  ];
  const needsCompany = form.kind === "shop" || form.kind === "company";
  const [promo, setPromo] = useState("");
  const [discount, setDiscount] = useState(0);
  // 152-ФЗ: согласие — отдельная галочка, по умолчанию снята.
  const [consent, setConsent] = useState(false);
  // Автономная копия сайта (без сервера): оплатить и отправить заказ некуда,
  // поэтому оформление собирает заказ в текст для менеджера.
  const standalone = !!meta?.settings?.standalone;
  // «Картой онлайн» предлагается только когда на сервере настроен настоящий
  // провайдер оплаты. Без него покупатель не должен попасть ни на какую
  // страницу, похожую на оплату банка.
  const onlinePayment = !standalone && meta?.settings?.onlinePayment === true;
  const [payNow, setPayNow] = useState(onlinePayment);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Ключ идемпотентности на одну попытку оформления: повтор запроса после
  // обрыва сети или двойного нажатия вернёт тот же заказ, а не создаст второй.
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
  const idemKey = useRef(newKey());

  const deliveryCost = form.deliveryType === "delivery" ? (meta?.settings?.deliveryCost ?? 0) : 0;
  const total = Math.max(0, cart.subtotal - discount + deliveryCost);
  // Цены не опубликованы — это заказ «по запросу», и «К оплате 0 ₽» было бы неправдой.
  const showPrices = meta?.settings?.showPrices !== false && !cart.hasOnRequest;
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
      const order = await api.post("/api/orders", { customer: form, promoCode: promo || null, consent },
        { headers: { "idempotency-key": idemKey.current } });
      idemKey.current = newKey();
      await reloadCart();

      if (order.standalone) {
        // Заказ никуда не ушёл — он лежит текстом у покупателя. Честно
        // показываем это на итоговой странице, а не «заказ принят».
        store.set("last-order", { standalone: true, text: order.text });
        try { await navigator.clipboard.writeText(order.text); } catch { /* покажем текст на странице */ }
        nav("/checkout/result?standalone=1");
        return;
      }

      // Гость смотрит свой заказ по секретному токену из этого ответа.
      // С платёжной страницы банк возвращает только номер, поэтому токен
      // запоминаем здесь; в адрес он не попадает.
      store.set("last-order", { number: order.number, token: order.accessToken });

      if (onlinePayment && payNow && order.total > 0) {
        const pay = await api.post("/api/payments/create", { orderNumber: order.number },
          { headers: { "x-order-token": order.accessToken } });
        // Уходим на страницу банка: возврат настроен на /checkout/result.
        if (pay.url) { location.href = pay.url; return; }
      }
      nav(`/checkout/result?order=${encodeURIComponent(order.number)}`);
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
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {KINDS.map(([key, label]) => (
                <button type="button" key={key} className={`chip ${form.kind === key ? "on" : ""}`}
                  onClick={() => setForm({ ...form, kind: key })}>{label}</button>
              ))}
            </div>
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
            <h3>{needsCompany ? "Магазин или организация" : "Организация"} <span className="dim" style={{ fontWeight: 400, fontSize: 13 }}>{needsCompany ? "— как называется" : "— если нужен счёт и закрывающие документы"}</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
              <label className="field"><span>Название</span><input className="input" required={needsCompany} value={form.company} onChange={set("company")} /></label>
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

          {!standalone && <section className="panel stack">
            <h3>Оплата</h3>
            {onlinePayment ? (
              <>
                <label className="row" style={{ cursor: "pointer" }}>
                  <input type="radio" checked={payNow} onChange={() => setPayNow(true)} />
                  <span>Картой онлайн — заказ уходит в работу сразу</span>
                </label>
                <label className="row" style={{ cursor: "pointer" }}>
                  <input type="radio" checked={!payNow} onChange={() => setPayNow(false)} />
                  <span>Счёт или оплата при получении — менеджер свяжется и подтвердит</span>
                </label>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>Счёт или оплата при получении — менеджер свяжется и подтвердит.</p>
                <p className="hint" style={{ margin: 0 }}>Онлайн-оплата временно недоступна.</p>
              </>
            )}
          </section>}
        </div>

        <aside className="summary">
          <div className="label">Ваш заказ</div>
          {cart.items.map((i) => (
            <div className="sum-row" key={i.id}>
              <span className="muted" style={{ maxWidth: "60%" }}>{i.name} × {i.qty}</span>
              {showPrices && <span className="num">{money(i.total)}</span>}
            </div>
          ))}

          {!standalone && <div className="row" style={{ marginTop: 6 }}>
            <input className="input" placeholder="Промокод" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} />
            <button type="button" className="btn btn-sm" onClick={applyPromo}>ОК</button>
          </div>}

          {discount > 0 && <div className="sum-row" style={{ color: "var(--ok)" }}><span>Скидка</span><span className="num">−{money(discount)}</span></div>}
          {deliveryCost > 0 && <div className="sum-row muted"><span>Доставка</span><span className="num">{money(deliveryCost)}</span></div>}
          <div className="sum-row total"><span>{showPrices ? "К оплате" : "Стоимость"}</span><span>{showPrices ? money(total) : "по запросу"}</span></div>

          <label className="consent" style={{ marginTop: 4 }}>
            <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Согласен на обработку персональных данных на условиях <Link to="/privacy" target="_blank">политики</Link></span>
          </label>

          {err && <p className="error-text">{err}</p>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !consent}>
            {busy ? "Оформляем…" : standalone ? "Собрать заказ для менеджера" : onlinePayment && payNow ? "Перейти к оплате" : "Оформить заказ"}
          </button>
          <p className="hint">{plural(cart.count, "товар", "товара", "товаров")}{standalone && " · заказ уйдёт менеджеру сообщением или по телефону"}</p>
        </aside>
      </form>
    </main>
  );
}
