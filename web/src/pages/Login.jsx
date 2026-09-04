import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { phoneMask } from "../lib/format.js";

// Два входа рядом: клиенту — код на телефон, сотруднику — почта и пароль.
// Заставлять прораба придумывать пароль ради одного заказа не нужно.
export default function Login() {
  const { login, toast } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/account";

  const [mode, setMode] = useState("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(null);
  const [creds, setCreds] = useState({ email: "", password: "", name: "" });
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const requestCode = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await api.post("/api/auth/otp/request", { phone });
      setSent(res);
      // На демо-стенде SMS не отправляется — код показываем прямо здесь.
      if (res.devCode) toast(`Код для входа: ${res.devCode}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await login({ phone, code }, "/api/auth/otp/verify");
      nav(next, { replace: true });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const byPassword = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await login(creds, register ? "/api/auth/register" : "/api/auth/login");
      nav(next, { replace: true });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <main className="page" style={{ maxWidth: 440, padding: "40px 20px 60px" }}>
      <div className="panel stack">
        <h1>{register ? "Регистрация" : "Вход"}</h1>

        <div className="row" style={{ gap: 6 }}>
          <button className={`chip ${mode === "phone" ? "on" : ""}`} onClick={() => setMode("phone")}>По телефону</button>
          <button className={`chip ${mode === "email" ? "on" : ""}`} onClick={() => setMode("email")}>По почте</button>
        </div>

        {mode === "phone" ? (
          !sent ? (
            <form className="stack" onSubmit={requestCode}>
              <label className="field"><span>Телефон</span>
                <input className="input" required inputMode="tel" placeholder="+7 (___) ___-__-__"
                  value={phone} onChange={(e) => setPhone(phoneMask(e.target.value))} autoFocus /></label>
              {err && <p className="error-text">{err}</p>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? "Отправляем…" : "Получить код"}</button>
              <p className="hint">Пароль не нужен — придёт код из шести цифр.</p>
            </form>
          ) : (
            <form className="stack" onSubmit={verify}>
              <label className="field"><span>Код из SMS на {phone}</span>
                <input className="input num" required inputMode="numeric" maxLength={6} style={{ fontSize: 22, letterSpacing: ".3em", textAlign: "center" }}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></label>
              {err && <p className="error-text">{err}</p>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length < 6}>Войти</button>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => { setSent(null); setCode(""); }}>Изменить номер</button>
            </form>
          )
        ) : (
          <form className="stack" onSubmit={byPassword}>
            {register && (
              <label className="field"><span>Имя</span>
                <input className="input" required minLength={2} value={creds.name} onChange={(e) => setCreds({ ...creds, name: e.target.value })} /></label>
            )}
            <label className="field"><span>Почта</span>
              <input className="input" type="email" required value={creds.email} onChange={(e) => setCreds({ ...creds, email: e.target.value })} /></label>
            <label className="field"><span>Пароль</span>
              <input className="input" type="password" required minLength={8} value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} /></label>
            {err && <p className="error-text">{err}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{register ? "Зарегистрироваться" : "Войти"}</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setRegister(!register)}>
              {register ? "У меня уже есть аккаунт" : "Создать аккаунт"}
            </button>
          </form>
        )}

        <p className="hint" style={{ textAlign: "center" }}>
          Работаете с заводом как дилер? <Link to="/?dealer=1" style={{ color: "var(--accent)" }}>Оставьте заявку</Link> — включим дилерские цены.
        </p>
      </div>
    </main>
  );
}
