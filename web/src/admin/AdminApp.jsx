import { Routes, Route, NavLink, Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import Dashboard from "./Dashboard.jsx";
import ProductsAdmin from "./ProductsAdmin.jsx";
import ProductEditor from "./ProductEditor.jsx";
import OrdersAdmin from "./OrdersAdmin.jsx";
import LeadsAdmin from "./LeadsAdmin.jsx";
import UsersAdmin from "./UsersAdmin.jsx";
import SettingsAdmin from "./SettingsAdmin.jsx";
import AuditAdmin from "./AuditAdmin.jsx";
import { Chart, Box, Cart, Phone, User, Settings, Doc, Back } from "../components/Icons.jsx";

const NAV = [
  { to: "/admin", end: true, label: "Сводка", icon: <Chart width={17} height={17} /> },
  { to: "/admin/products", label: "Товары и цены", icon: <Box width={17} height={17} /> },
  { to: "/admin/orders", label: "Заказы", icon: <Cart width={17} height={17} /> },
  { to: "/admin/leads", label: "Заявки", icon: <Phone width={17} height={17} /> },
  { to: "/admin/users", label: "Пользователи", icon: <User width={17} height={17} />, admin: true },
  { to: "/admin/settings", label: "Настройки", icon: <Settings width={17} height={17} />, admin: true },
  { to: "/admin/audit", label: "Журнал", icon: <Doc width={17} height={17} />, admin: true },
];

export default function AdminApp() {
  const { user, meta } = useApp();
  const isAdmin = ["admin", "owner"].includes(user.role);

  return (
    <div className="admin">
      <aside className="admin-side">
        <Link to="/" className="logo" style={{ padding: "4px 12px 14px" }}>
          <img className="logo-mark" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width="36" height="36" />
          <span className="logo-text"><b>Панель</b><span>{meta?.tenant?.name?.split(" ")[0]}</span></span>
        </Link>

        {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "on" : "")}>
            {n.icon}{n.label}
          </NavLink>
        ))}

        <div style={{ marginTop: "auto", paddingTop: 14 }}>
          <Link to="/" className="btn btn-sm btn-block"><Back width={15} height={15} /> На витрину</Link>
          <p className="hint" style={{ marginTop: 10, padding: "0 12px" }}>{user.name}<br />{user.role}</p>
        </div>
      </aside>

      <main className="admin-main">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="products" element={<ProductsAdmin />} />
          <Route path="products/:id" element={<ProductEditor />} />
          <Route path="orders" element={<OrdersAdmin />} />
          <Route path="leads" element={<LeadsAdmin />} />
          <Route path="users" element={<UsersAdmin />} />
          <Route path="settings" element={<SettingsAdmin />} />
          <Route path="audit" element={<AuditAdmin />} />
        </Routes>
      </main>
    </div>
  );
}
