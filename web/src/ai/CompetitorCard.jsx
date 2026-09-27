import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import { Back } from "../components/Icons.jsx";
import { COMPANY_KIND, COMPETITOR_STATUS, COMPETITOR_PILL, MARKET_STATUS, ACCESS } from "./competitorLabels.js";
import { CompanyForm, BrandForm, ProductForm, WithdrawForm } from "./CompetitorForms.jsx";

// Карточка компании: основное, марки, товары, источники с датами, что не
// установлено. Конфиденциальное роль без доступа видит только числом.
export default function CompetitorCard() {
  const { id } = useParams();
  const { user } = useApp();
  const isAdmin = ["admin", "owner"].includes(user.role);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => api.get(`/api/ai/competitors/${id}`).then(setData).catch(() => setData(false));
  useEffect(() => { load(); }, [id]);
  const done = () => { setForm(null); load(); };

  if (data === false) return <div className="empty"><h3>Компания не найдена</h3><Link className="btn" to="/admin/ai/competitors">К списку</Link></div>;
  if (!data) return <div className="skeleton" style={{ height: 320 }} />;
  const { company: c, brands, products, sources, regions, unresolved, hidden } = data;

  return (
    <div className="stack ci-page" style={{ gap: 18 }}>
      <div>
        <Link to="/admin/ai/competitors" className="btn btn-sm"><Back width={15} height={15} /> К конкурентам</Link>
        <div className="spread" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0 }}>{c.name}</h1>
          {isAdmin && c.lifecycleStatus === "active" && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={() => setForm({ kind: "company" })}>Изменить</button>
              <button className="btn btn-sm" onClick={() => setForm({ kind: "withdraw" })}>Снять</button>
            </div>
          )}
        </div>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          {COMPANY_KIND[c.kind]} · <span className={`pill ${COMPETITOR_PILL[c.competitorStatus] || ""}`}>{COMPETITOR_STATUS[c.competitorStatus]}</span>
          {c.legalName ? ` · ${c.legalName}` : ""} · доступ: {ACCESS[c.accessLevel]}
        </p>
      </div>

      <section className="panel ci-facts">
        <div><span className="label">Сайт</span>{c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer">{c.website}</a> : <span className="dim">не указан</span>}</div>
        <div><span className="label">Регион</span>{regions.length ? regions.map((r) => r.name).join(", ") : <span className="dim">не указан</span>}</div>
        <div><span className="label">Внесено</span>{c.createdAt?.slice(0, 10)}{c.updatedAt && c.updatedAt !== c.createdAt ? `, изменено ${c.updatedAt.slice(0, 10)}` : ""}</div>
        {c.notes && <div><span className="label">Заметка</span>{c.notes}</div>}
      </section>

      {unresolved.length > 0 && <div className="ci-unresolved" role="note"><b>Не установлено:</b> {unresolved.join("; ")}.</div>}

      <section className="panel">
        <div className="spread"><h3>Марки</h3>{isAdmin && <button className="btn btn-sm" onClick={() => setForm({ kind: "brand" })}>Добавить марку</button>}</div>
        {brands.filter((b) => b.lifecycleStatus === "active").length ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {brands.filter((b) => b.lifecycleStatus === "active").map((b) => <span key={b.id} className="chip">{b.name}</span>)}
          </div>
        ) : <p className="hint ci-empty" data-empty="brands">Марок в данных нет.</p>}
        <p className="hint" style={{ marginBottom: 0 }}>Марка принадлежит компании и не является ни компанией, ни заводом.</p>
      </section>

      <section className="panel">
        <div className="spread"><h3>Товары</h3>{isAdmin && <button className="btn btn-sm" onClick={() => setForm({ kind: "product" })}>Добавить товар</button>}</div>
        {products.length ? (
          <div className="ci-list" role="list" style={{ marginTop: 10 }}>
            <div className="ci-list-head ci-products" aria-hidden="true"><span>Товар</span><span>Марка</span><span>Раздел Habez</span><span>Выпуск</span><span>Характеристик</span><span>Цен</span></div>
            {products.map((p) => (
              <Link key={p.id} to={`/admin/ai/competitor-products/${p.id}`} className={`ci-list-row ci-products${p.lifecycleStatus !== "active" ? " ci-withdrawn" : ""}`} role="listitem">
                <span className="ci-name"><b>{p.shortName || p.name}</b><span className="hint">{p.name}{p.lifecycleStatus !== "active" ? " · снят" : ""}</span></span>
                <span data-label="Марка">{p.brand || <span className="dim">—</span>}</span>
                <span data-label="Раздел Habez">{p.category || <span className="dim">не выбран</span>}</span>
                <span data-label="Выпуск">{MARKET_STATUS[p.marketStatus]}</span>
                <span data-label="Характеристик" className="num">{p.observations}</span>
                <span data-label="Цен" className="num">{p.prices}{p.lastPrice ? <span className="hint"> · {p.lastPrice}</span> : null}</span>
              </Link>
            ))}
          </div>
        ) : <p className="hint ci-empty" data-empty="products">Товаров в данных нет. Отсутствие записи не значит, что компания их не выпускает.</p>}
        {hidden?.products > 0 && <p className="hint" style={{ marginBottom: 0 }}>Есть ещё {hidden.products} товар(ов) — доступны другой роли.</p>}
      </section>

      <section className="panel">
        <h3>Источники</h3>
        {sources.length ? (
          <ul className="ci-sources">
            {sources.map((s) => <li key={s.id}><b>{s.name}</b>{s.url ? <> · <a href={s.url} target="_blank" rel="noopener noreferrer">{s.url}</a></> : null}<span className="hint"> · последняя дата сведений: {s.lastDate?.slice(0, 10) || "—"}</span></li>)}
          </ul>
        ) : <p className="hint ci-empty" data-empty="sources">Источников по этой компании в данных нет.</p>}
      </section>

      {form?.kind === "company" && <CompanyForm company={c} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "brand" && <BrandForm companyId={c.id} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "product" && <ProductForm companyId={c.id} brands={brands} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "withdraw" && <WithdrawForm title="Снять компанию" url={`/api/ai/competitors/${c.id}/withdraw`} onClose={() => setForm(null)} onDone={done} />}
    </div>
  );
}
