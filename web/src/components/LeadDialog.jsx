import { useState } from "react";
import Modal from "./Modal.jsx";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { phoneMask } from "../lib/format.js";

const TITLES = {
  quote: "Запросить цену",
  dealer: "Стать дилером",
  callback: "Заказать звонок",
  question: "Вопрос по продукции",
};

// Заявка — главный канал для завода: часть позиций продаётся только через
// менеджера, и форма должна быть проще, чем оформление заказа.
export default function LeadDialog({ kind = "quote", productId, withCart, onClose }) {
  const { user, toast } = useApp();
  const [form, setForm] = useState({
    name: user?.name || "", phone: user?.phone ? phoneMask(user.phone) : "",
    company: user?.company || "", message: "", website: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: k === "phone" ? phoneMask(e.target.value) : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await api.post("/api/leads", { kind, productId, withCart, ...form });
      // Без сервера отправлять некуда: открываем готовое сообщение менеджеру
      // в WhatsApp — человек только нажимает «отправить».
      if (res?.whatsapp) {
        window.open(res.whatsapp, "_blank", "noopener");
        toast("Заявка собрана — отправьте её в WhatsApp");
      } else if (res?.text) {
        try {
          await navigator.clipboard.writeText(res.text);
          toast("Заявка скопирована — вставьте её в сообщение менеджеру");
        } catch {
          toast("Заявка собрана. Скопируйте список из корзины и отправьте менеджеру");
        }
      } else {
        toast("Заявка отправлена — менеджер свяжется с вами");
      }
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={TITLES[kind]} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Ответим в рабочее время и пришлём актуальный прайс с условиями отгрузки.
        </p>
        <label className="field"><span>Как к вам обращаться</span>
          <input className="input" required minLength={2} value={form.name} onChange={set("name")} /></label>
        <label className="field"><span>Телефон</span>
          <input className="input" required inputMode="tel" placeholder="+7 (___) ___-__-__" value={form.phone} onChange={set("phone")} /></label>
        <label className="field"><span>Компания <span className="dim">— если заказ от организации</span></span>
          <input className="input" value={form.company} onChange={set("company")} /></label>
        <label className="field"><span>Что нужно</span>
          <textarea className="textarea" placeholder="Объём, сроки, адрес отгрузки" value={form.message} onChange={set("message")} /></label>

        {/* Ловушка для ботов: поле скрыто, человек его не видит и не заполняет. */}
        <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")}
          style={{ position: "absolute", left: "-9999px" }} aria-hidden="true" />

        {err && <p className="error-text">{err}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? "Отправляем…" : "Отправить заявку"}
        </button>
        <p className="hint" style={{ textAlign: "center" }}>
          Нажимая кнопку, вы соглашаетесь на обработку персональных данных.
        </p>
      </form>
    </Modal>
  );
}
