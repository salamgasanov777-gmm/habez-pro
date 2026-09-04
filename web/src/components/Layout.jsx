import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../store.jsx";
import { STANDALONE } from "../lib/api.js";
import { Search, Cart, Star, Sun, Moon, User, Grid, Scale } from "./Icons.jsx";
import LeadDialog from "./LeadDialog.jsx";

function Header() {
  const { meta, cart, favorites, theme, setTheme, user } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState("");

  // Строка поиска отражает адрес: вернулся назад — запрос на месте.
  useEffect(() => {
    setQ(new URLSearchParams(loc.search).get("search") || "");
  }, [loc.search]);

  const submit = (e) => {
    e.preventDefault();
    nav(q ? `/?search=${encodeURIComponent(q)}` : "/");
  };

  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  return (
    <header className="header">
      <div className="header-in">
        <Link to="/" className="logo">
          <img className="logo-mark" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width="36" height="36" />
          <span className="logo-text">
            <b>Habez Gips</b>
            <span>каталог продукции</span>
          </span>
        </Link>

        <form className="searchbar" onSubmit={submit} role="search">
          <Search width={18} height={18} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по названию, ГОСТу, характеристике…"
            aria-label="Поиск по каталогу"
            type="search"
          />
        </form>

        <nav className="nav-actions">
          <button className="icon-btn" onClick={() => setTheme(dark ? "light" : "dark")} aria-label="Сменить тему">
            {dark ? <Sun /> : <Moon />}
          </button>
          <Link to="/favorites" className="icon-btn" aria-label="Избранное">
            <Star filled={false} />
            {favorites.size > 0 && <span className="counter">{favorites.size}</span>}
          </Link>
          <Link to="/cart" className="icon-btn" aria-label="Корзина">
            <Cart />
            {cart.count > 0 && <span className="counter">{cart.count}</span>}
          </Link>
          {!STANDALONE && (
            <Link to={user ? "/account" : "/login"} className="icon-btn" aria-label="Кабинет">
              <User />
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

function TabBar() {
  const { cart, favorites, user } = useApp();
  const tabs = [
    { to: "/", icon: <Grid width={21} height={21} />, label: "Каталог", end: true },
    { to: "/compare", icon: <Scale width={21} height={21} />, label: "Сравнить" },
    { to: "/favorites", icon: <Star width={21} height={21} />, label: "Избранное", badge: favorites.size },
    { to: "/cart", icon: <Cart width={21} height={21} />, label: "Корзина", badge: cart.count },
    { to: user ? "/account" : "/login", icon: <User width={21} height={21} />, label: user ? "Кабинет" : "Вход" },
  ].filter((t) => !STANDALONE || !t.to.startsWith("/login") && !t.to.startsWith("/account"));
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? "on" : "")}>
          <span style={{ position: "relative" }}>
            {t.icon}
            {t.badge > 0 && <span className="counter" style={{ top: -4, right: -8 }}>{t.badge}</span>}
          </span>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Footer() {
  const { meta } = useApp();
  const [lead, setLead] = useState(false);
  return (
    <footer style={{ borderTop: "1px solid var(--line)", marginTop: 40, padding: "28px 0 40px", background: "var(--surface)" }}>
      <div className="page" style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
        <div>
          <div className="logo" style={{ marginBottom: 10 }}>
            <img className="logo-mark" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width="36" height="36" />
            <span className="logo-text"><b>{meta?.tenant?.name}</b><span>производитель сухих смесей</span></span>
          </div>
          <p className="dim" style={{ fontSize: 13, margin: 0 }}>{meta?.tenant?.address}</p>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Каталог</div>
          <div className="stack" style={{ gap: 6, fontSize: 14 }}>
            {(meta?.categories || []).slice(0, 5).map((c) => (
              <Link key={c.slug} to={`/?category=${c.slug}`} className="muted">{c.name}</Link>
            ))}
          </div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Связь</div>
          <div className="stack" style={{ gap: 6, fontSize: 14 }}>
            <a href={`tel:${meta?.tenant?.phone}`}>{meta?.tenant?.phone}</a>
            <a href={`mailto:${meta?.tenant?.email}`} className="muted">{meta?.tenant?.email}</a>
            <button className="btn btn-sm" style={{ justifySelf: "start", marginTop: 4 }} onClick={() => setLead(true)}>Запросить прайс</button>
          </div>
        </div>
      </div>
      {lead && <LeadDialog kind="quote" onClose={() => setLead(false)} />}
    </footer>
  );
}

export default function Layout({ children }) {
  const loc = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <>
      <Header />
      {children}
      <Footer />
      <TabBar />
    </>
  );
}
