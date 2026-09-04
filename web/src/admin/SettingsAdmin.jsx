import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";

export default function SettingsAdmin() {
  const { toast } = useApp();
  const [t, setT] = useState(null);

  useEffect(() => { api.get("/api/admin/settings").then((d) => setT(d.tenant)); }, []);
  if (!t) return <div className="skeleton" style={{ height: 300 }} />;

  const s = t.settings || {};
  const setS = (k, v) => setT({ ...t, settings: { ...s, [k]: v } });

  const save = async () => {
    try {
      await api.put("/api/admin/settings", {
        name: t.name, phone: t.phone, email: t.email, address: t.address,
        legalName: t.legal_name, inn: t.inn, theme: t.theme, settings: t.settings,
      });
      toast("Настройки сохранены");
    } catch (e) { toast(e.message, "err"); }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread"><h1>Настройки</h1><button className="btn btn-primary" onClick={save}>Сохранить</button></div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <section className="panel stack">
          <h3>Компания</h3>
          <label className="field"><span>Название на витрине</span><input className="input" value={t.name || ""} onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
          <label className="field"><span>Юридическое название</span><input className="input" value={t.legal_name || ""} onChange={(e) => setT({ ...t, legal_name: e.target.value })} /></label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label className="field"><span>ИНН</span><input className="input" value={t.inn || ""} onChange={(e) => setT({ ...t, inn: e.target.value })} /></label>
            <label className="field"><span>Телефон</span><input className="input" value={t.phone || ""} onChange={(e) => setT({ ...t, phone: e.target.value })} /></label>
          </div>
          <label className="field"><span>Почта</span><input className="input" value={t.email || ""} onChange={(e) => setT({ ...t, email: e.target.value })} /></label>
          <label className="field"><span>Адрес склада</span><input className="input" value={t.address || ""} onChange={(e) => setT({ ...t, address: e.target.value })} /></label>
        </section>

        <section className="panel stack">
          <h3>Витрина и заказы</h3>
          <label className="row" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={s.showPrices !== false} onChange={(e) => setS("showPrices", e.target.checked)} />
            <span>Показывать цены посетителям</span>
          </label>
          <p className="hint" style={{ marginTop: -4 }}>
            Выключено — каталог работает как витрина с характеристиками, а вместо кнопки «Купить» посетитель оставляет заявку.
          </p>
          <label className="field"><span>Стоимость доставки, ₽</span>
            <input className="input num" type="number" value={(s.deliveryCost ?? 0) / 100}
              onChange={(e) => setS("deliveryCost", Math.round(Number(e.target.value) * 100))} /></label>
          <label className="field"><span>Минимальный заказ, ₽</span>
            <input className="input num" type="number" value={(s.minOrder ?? 0) / 100}
              onChange={(e) => setS("minOrder", Math.round(Number(e.target.value) * 100))} /></label>
          <label className="field"><span>Префикс номера заказа</span>
            <input className="input" value={s.orderPrefix || "ЗК"} onChange={(e) => setS("orderPrefix", e.target.value.toUpperCase().slice(0, 5))} /></label>
        </section>

        <section className="panel stack">
          <h3>Оформление</h3>
          <label className="field"><span>Фирменный цвет</span>
            <input className="input" type="color" style={{ height: 44, padding: 4 }} value={t.theme?.accent || "#1f3b57"}
              onChange={(e) => setT({ ...t, theme: { ...t.theme, accent: e.target.value } })} /></label>
          <label className="field"><span>Цвет кнопок действия</span>
            <input className="input" type="color" style={{ height: 44, padding: 4 }} value={t.theme?.accentWarm || "#b9722a"}
              onChange={(e) => setT({ ...t, theme: { ...t.theme, accentWarm: e.target.value } })} /></label>
          <div className="notice">
            Каждая компания в системе оформляется своими цветами и работает на своём домене — данные разных заводов не пересекаются.
          </div>
        </section>
      </div>
    </div>
  );
}
