import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { store } from "../lib/storage.js";
import ProductCard from "../components/ProductCard.jsx";
import { plural } from "../lib/format.js";
import { Scale, Bath, Room, Facade, Floor, Plinth, Check, Grid } from "../components/Icons.jsx";
import ProductLink from "../components/ProductLink.jsx";
import { mediaUrl } from "../lib/format.js";

// Значок к каждой задаче подбора; ключи приходят с сервера.
const TASK_ICON = { wet: Bath, dry: Room, facade: Facade, "floor-heat": Floor, plinth: Plinth };

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
        {/* Первый экран: вместо рассказа о заводе — то, с чего покупатель
            начинает. Подбор по задаче плитками, ниже новинки, дальше товары.
            Прячется, когда человек уже ищет или выбрал раздел. */}
        {!filters.search && !filters.category && (
          <section className="home">
            <p className="brand-line"><Check width={14} height={14} /> Официальный каталог Хабезского гипсового завода</p>
            <div className="tasks">
              {(meta?.tasks || []).map((t) => {
                const Icon = TASK_ICON[t.key] || Grid;
                const on = filters.task === t.key;
                return (
                  <button key={t.key} className={`task-tile ${on ? "on" : ""}`} onClick={() => setParam("task", on ? "" : t.key)}>
                    <span className="task-icon"><Icon width={22} height={22} /></span>
                    <span>{t.label}</span>
                  </button>
                );
              })}
              <button className={`task-tile all ${!filters.task ? "on" : ""}`} onClick={() => setParam("task", "")}>
                <span className="task-icon"><Grid width={22} height={22} /></span>
                <span>Все {plural(meta?.total ?? 0, "товар", "товара", "товаров")}</span>
              </button>
            </div>

            {meta?.newArrivals?.length > 0 && !filters.task && (
              <>
                <div className="label" style={{ margin: "18px 0 8px" }}>Новое в каталоге</div>
                <div className="new-row">
                  {meta.newArrivals.map((n) => (
                    <ProductLink key={n.id} slug={n.slug} className="new-item">
                      <span className="new-photo">
                        {n.photo && <img src={mediaUrl(n.photoWebp || n.photo)} alt="" loading="lazy" />}
                      </span>
                      <span className="new-name">{n.shortName || n.name}</span>
                    </ProductLink>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <div className={`toolbar ${filters.search || filters.category ? "" : "quiet"}`}>
          {(filters.search || filters.category) && (
            <>
              <span className="label" style={{ marginRight: 4 }}>Подбор по задаче</span>
              {(meta?.tasks || []).map((t) => (
                <button key={t.key} className={`chip task ${filters.task === t.key ? "on" : ""}`}
                  onClick={() => setParam("task", filters.task === t.key ? "" : t.key)}>
                  {t.label}
                </button>
              ))}
            </>
          )}
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
