import { useCallback, useEffect, useState } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import * as api from "../lib/api.js";
import Facts from "./Facts.jsx";
import FactDetails from "./FactDetails.jsx";
import Sources from "./Sources.jsx";
import Products from "./Products.jsx";
import ProductIntelligence from "./ProductIntelligence.jsx";

// Habez AI → База знаний. Пока это слой данных: источники и проверяемые
// факты. Чат и анализ появятся следующими фазами и встанут сюда же
// вкладками, не ломая существующее.
export default function AiApp() {
  const [s, setS] = useState(null);
  const [p, setP] = useState(null);
  // Счётчики перечитываются после каждой записи: иначе «фактов 0» висит
  // рядом с таблицей, где факт уже есть.
  const reload = useCallback(() => {
    api.get("/api/ai/summary").then(setS).catch(() => {});
    api.get("/api/ai/products/summary").then(setP).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <NavLink to="/admin/ai" end className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : ""}`}>Факты</NavLink>
        <NavLink to="/admin/ai/products" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : ""}`}>Товары</NavLink>
        <NavLink to="/admin/ai/sources" className={({ isActive }) => `btn btn-sm ${isActive ? "btn-primary" : ""}`}>Источники</NavLink>
      </div>

      {s && (
        <div className="kpis">
          <div className="kpi"><span className="label">Фактов всего</span><b>{s.total}</b>
            <span className="delta">источников: {s.sources}</span></div>
          <div className="kpi"><span className="label">Подтверждено</span><b>{s.byStatus?.verified ?? 0}</b>
            <span className="delta">не проверено — {s.byStatus?.unverified ?? 0}</span></div>
          <div className="kpi"><span className="label">Пора перепроверить</span><b>{s.needsRecheck}</b>
            <span className="delta">истёк срок сверки</span></div>
          <div className="kpi"><span className="label">Предположений AI</span><b>{s.byOrigin?.ai_inference ?? 0}</b>
            <span className="delta">фактами не считаются</span></div>
          <div className="kpi"><span className="label">Характеристик товаров</span><b>{p?.specs ?? 0}</b>
            <span className="delta">числами — {p?.numeric ?? 0}</span></div>
        </div>
      )}

      <Routes>
        <Route index element={<Facts onChanged={reload} />} />
        <Route path="facts/:id" element={<FactDetails onChanged={reload} />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductIntelligence onChanged={reload} />} />
        <Route path="sources" element={<Sources onChanged={reload} />} />
      </Routes>
    </div>
  );
}
