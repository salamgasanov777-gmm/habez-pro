import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useApp } from "./store.jsx";
import { STANDALONE } from "./lib/api.js";
import Layout from "./components/Layout.jsx";
import Catalog from "./pages/Catalog.jsx";
import Product from "./pages/Product.jsx";
import Cart from "./pages/Cart.jsx";
import Checkout from "./pages/Checkout.jsx";
import CheckoutResult from "./pages/CheckoutResult.jsx";
import Favorites from "./pages/Favorites.jsx";
import Compare from "./pages/Compare.jsx";
import Login from "./pages/Login.jsx";
import Account from "./pages/Account.jsx";

// Панель управления нужна нескольким сотрудникам, а грузится всеми. Выносим
// её в отдельный чанк: покупатель на телефоне не скачивает админку.
const Admin = lazy(() => import("./admin/AdminApp.jsx"));

function Toasts() {
  const { toasts } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`}>{t.text}</div>)}
    </div>
  );
}

export default function App() {
  const { ready, user } = useApp();

  return (
    <>
      <Routes>
        <Route path="/admin/*" element={
          STANDALONE ? <Navigate to="/" replace />
            : !ready ? <div className="empty">Загрузка…</div>
            : user && ["manager", "admin", "owner"].includes(user.role)
              ? <Suspense fallback={<div className="empty">Загрузка панели…</div>}><Admin /></Suspense>
              : <Navigate to="/login?next=/admin" replace />
        } />

        <Route path="*" element={
          <Layout>
            <Routes>
              <Route path="/" element={<Catalog />} />
              <Route path="/p/:slug" element={<Product />} />
              <Route path="/cart" element={<Cart />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route path="/checkout/result" element={<CheckoutResult />} />
              <Route path="/favorites" element={<Favorites />} />
              <Route path="/compare" element={<Compare />} />
              <Route path="/login" element={<Login />} />
              <Route path="/account" element={<Account />} />
              <Route path="*" element={<div className="empty"><h3>Страница не найдена</h3><p>Проверьте адрес или вернитесь в каталог.</p></div>} />
            </Routes>
          </Layout>
        } />
      </Routes>
      <Toasts />
    </>
  );
}
