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
import AiApp from "../ai/AiApp.jsx";
import Assistant from "../ai/Assistant.jsx";
import { Chart, Box, Cart, Phone, User, Settings, Doc, Back, Search, Spark } from "../components/Icons.jsx";

const NAV = [
  { to: "/admin", end: true, label: "Сводка", icon: <Chart width={17} height={17} /> },
  { to: "/admin/products", label: "Товары и цены", icon: <Box width={17} height={17} /> },
  { to: "/admin/orders", label: "Заказы", icon: <Cart width={17} height={17} /> },
  { to: "/admin/leads", label: "Заявки", icon: <Phone width={17} height={17} /> },
  // Habez AI появляется в меню, только когда раздел включён на сервере.
  { to: "/admin/assistant", label: "Habez AI", icon: <Spark width={17} height={17} />, agent: true },
  { to: "/admin/ai", label: "База знаний AI", icon: <Search width={17} height={17} />, ai: true },
  { to: "/admin/users", label: "Пользователи", icon: <User width={17} height={17} />, admin: true },
  { to: "/admin/settings", label: "Настройки", icon: <Settings width={17} height={17} />, admin: true },
  { to: "/admin/audit", label: "Журнал", icon: <Doc width={17} height={17} />, admin: true },
];

export default function AdminApp() {
  const { user, meta } = useApp();
  const isAdmin = ["admin", "owner"].includes(user.role);
  const aiEnabled = !!meta?.settings?.ai;
  const agentEnabled = !!meta?.settings?.aiAgent;

  return (
    <div className="admin">
      <aside className="admin-side">
        <Link to="/" className="logo" style={{ padding: "4px 12px 14px" }}>
          <img className="logo-mark" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width="36" height="36" />
          <span className="logo-text"><b>Панель</b><span>{meta?.tenant?.name?.split(" ")[0]}</span></span>
        </Link>

        {NAV.filter((n) => (!n.admin || isAdmin) && (!n.ai || aiEnabled) && (!n.agent || agentEnabled)).map((n) => (
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
          {aiEnabled && <Route path="ai/*" element={<AiApp />} />}
          {agentEnabled && <Route path="assistant" element={<Assistant />} />}
        </Routes>
      </main>
    </div>
  );
}
