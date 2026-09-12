import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ProductLink from "../components/ProductLink.jsx";
import { useApp } from "../store.jsx";
import { money, plural, mediaUrl } from "../lib/format.js";
import LeadDialog from "../components/LeadDialog.jsx";

export default function Cart() {
  const { cart, setQty, removeItem, clearCart, meta } = useApp();
  const nav = useNavigate();
  const [lead, setLead] = useState(false);
  const delivery = meta?.settings?.deliveryCost ?? 0;
  // Когда цены не опубликованы, корзина — это список для заявки. Показывать
  // в ней «Итого 0 ₽» было бы просто неправдой.
  const showPrices = meta?.settings?.showPrices !== false && !cart.hasOnRequest;

  if (!cart.items.length) {
    return (
      <div className="empty">
        <h3>Список пуст</h3>
        <p>Добавьте товары из каталога — количество можно будет изменить перед отправкой.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 14 }}>Перейти в каталог</Link>
      </div>
    );
  }

  return (
    <main className="page" style={{ padding: "24px 20px 60px" }}>
      <div className="spread" style={{ marginBottom: 18 }}>
        <h1>{showPrices ? "Корзина" : "Список для заявки"}</h1>
        <button className="btn btn-ghost btn-sm" onClick={clearCart}>Очистить</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 26, alignItems: "start" }} className="cart-layout">
        <div>
          {cart.items.map((i) => (
            <div className="cart-line" key={i.id}>
              <ProductLink slug={i.slug} className="ph" style={{ backgroundImage: i.photo ? `url('${mediaUrl(i.photo)}')` : "none" }} />
              <div>
                <ProductLink slug={i.slug} style={{ fontWeight: 550 }}>{i.name}</ProductLink>
                <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>{i.unit}</div>
                {i.priceOnRequest
                  ? <div style={{ color: "var(--accent)", fontSize: 13.5, marginTop: 4 }}>Цену уточнит менеджер</div>
                  : <div className="num muted" style={{ fontSize: 13.5, marginTop: 4 }}>{money(i.price)} за шт</div>}
              </div>
              <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
                <div className="qty">
                  <button onClick={() => setQty(i.id, Math.max(1, i.qty - 1))}>−</button>
                  <input value={i.qty} onChange={(e) => setQty(i.id, Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))} inputMode="numeric" />
                  <button onClick={() => setQty(i.id, i.qty + 1)}>+</button>
                </div>
                {i.total !== null && <div className="num" style={{ fontWeight: 620 }}>{money(i.total)}</div>}
                <button className="btn btn-ghost btn-sm" onClick={() => removeItem(i.id)}>Удалить</button>
              </div>
            </div>
          ))}
        </div>

        <aside className="summary">
          <div className="sum-row">
            <span>{plural(cart.count, "позиция", "позиции", "позиций")}</span>
            {showPrices && <span className="num">{money(cart.subtotal)}</span>}
          </div>
          {cart.weightKg > 0 && <div className="sum-row muted"><span>Общий вес</span><span className="num">{Math.round(cart.weightKg)} кг</span></div>}
          {showPrices && delivery > 0 && <div className="sum-row muted"><span>Доставка</span><span className="num">от {money(delivery)}</span></div>}
          {showPrices && <div className="sum-row total"><span>Итого</span><span>{money(cart.subtotal)}</span></div>}

          {cart.hasOnRequest ? (
            <>
              <div className="notice">В корзине есть позиции без цены — оформим как <b>заявку</b>, менеджер посчитает и пришлёт счёт.</div>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => setLead(true)}>Отправить заявку</button>
            </>
          ) : (
            <button className="btn btn-primary btn-lg btn-block" onClick={() => nav("/checkout")}>Оформить заказ</button>
          )}
          <Link to="/" className="btn btn-block">Продолжить покупки</Link>
        </aside>
      </div>

      {lead && <LeadDialog kind="quote" withCart onClose={() => setLead(false)} />}
    </main>
  );
}
