import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { store } from "../lib/storage.js";
import ProductCard from "../components/ProductCard.jsx";
import { plural } from "../lib/format.js";
import { Scale } from "../components/Icons.jsx";

const SORTS = [
  { key: "default", label: "По разделам" },
  { key: "name", label: "По названию" },
  { key: "price_asc", label: "Сначала дешевле" },
  { key: "price_desc", label: "Сначала дороже" },
];

export default function Catalog() {
  const { meta } = useApp();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [compare, setCompare] = useState(() => store.session.get("compare", []));
  const abort = useRef(null);

  const filters = useMemo(() => ({
    search: params.get("search") || "",
    category: params.get("category") || "",
    task: params.get("task") || "",
    sort: params.get("sort") || "default",
  }), [params]);

  useEffect(() => {
    setLoading(true);
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;

    // Пауза перед запросом: пока человек печатает, сервер не дёргается
    // на каждую букву. Для поиска по 43 товарам этого достаточно.
    const timer = setTimeout(() => {
      api.get(`/api/catalog/products?${api.qs({ ...filters, limit: 60 })}`, { signal: ctrl.signal })
        .then(setData)
        .catch((e) => { if (e.name !== "AbortError") setData({ items: [], total: 0 }); })
        .finally(() => setLoading(false));
    }, filters.search ? 220 : 0);

    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [filters]);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  };

  const toggleCompare = (id) => {
    setCompare((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-4);
      store.session.set("compare", next);
      return next;
    });
  };

  return (
    <>
      <div className="rail">
        <div className="rail-in">
          <button className={`chip ${!filters.category ? "on" : ""}`} onClick={() => setParam("category", "")}>Все товары</button>
          {(meta?.categories || []).map((c) => (
            <button key={c.slug} className={`chip ${filters.category === c.slug ? "on" : ""}`} onClick={() => setParam("category", c.slug)}>
              {c.name}<span className="cnt">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="page">
        {!filters.search && !filters.category && (
          <section className="hero">
            <h1>Продукция завода с паспортными характеристиками</h1>
            <p>Гипсовые и цементные смеси, шпаклёвки, клеи, грунтовки. Расход считается прямо в карточке, заказ уходит менеджеру без звонка.</p>
            <div className="hero-stats">
              <div><b>{meta?.total ?? "—"}</b><span>позиций</span></div>
              <div><b>{meta?.categories?.length ?? "—"}</b><span>разделов</span></div>
              <div><b>ГОСТ</b><span>заводские данные</span></div>
            </div>
          </section>
        )}

        <div className="toolbar">
          <span className="label" style={{ marginRight: 4 }}>Подбор по задаче</span>
          {(meta?.tasks || []).map((t) => (
            <button key={t.key} className={`chip task ${filters.task === t.key ? "on" : ""}`}
              onClick={() => setParam("task", filters.task === t.key ? "" : t.key)}>
              {t.label}
            </button>
          ))}
          {/* Сортировка на телефоне не нужна — владелец её не использует, а
              выглядит она там чужеродно. На широком экране остаётся. */}
          <select className="select sort-select" style={{ width: "auto", marginLeft: "auto" }} value={filters.sort} onChange={(e) => setParam("sort", e.target.value)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        {(filters.search || filters.task || filters.category) && (
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="count muted" style={{ fontSize: 14 }}>
              {loading ? "Ищем…" : data?.total ? `Найдено ${plural(data.total, "товар", "товара", "товаров")}` : "Ничего не найдено"}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setParams({}, { replace: true })}>Сбросить фильтры</button>
          </div>
        )}

        {loading && !data ? (
          <div className="grid">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 268 }} />)}
          </div>
        ) : data?.items?.length ? (
          <div className="grid">
            {data.items.map((p) => (
              <ProductCard key={p.id} product={p} onCompare={toggleCompare} comparing={compare.includes(p.id)} />
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>Ничего не нашлось</h3>
            <p>Попробуйте другое слово или снимите фильтр по задаче.<br />
              Если нужного товара нет в каталоге — напишите менеджеру, его добавят.</p>
          </div>
        )}

        {compare.length >= 2 && (
          <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 78, zIndex: 45 }}>
            <Link to="/compare" className="btn btn-dark btn-lg" style={{ boxShadow: "var(--shadow-2)" }}>
              <Scale width={18} height={18} /> Сравнить {compare.length}
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
