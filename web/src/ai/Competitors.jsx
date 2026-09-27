import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import { COMPANY_KIND, COMPETITOR_STATUS, COMPETITOR_PILL } from "./competitorLabels.js";
import { CompanyForm } from "./CompetitorForms.jsx";

// Конкуренты (3.5 Competitor Intelligence): справочник, который вносит
// администратор. Только ручной ввод подтверждённых сведений — без сбора с
// сайтов. На телефоне таблица становится карточками.
export default function Competitors() {
  const { user } = useApp();
  const isAdmin = ["admin", "owner"].includes(user.role);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [f, setF] = useState({ search: "", competitorStatus: "", kind: "" });
  const [adding, setAdding] = useState(false);
  const load = () => api.get(`/api/ai/competitors?${api.qs(f)}`).then((d) => { setData(d); setError(null); }).catch((e) => { setError(e); setData({ items: [] }); });
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [f.search, f.competitorStatus, f.kind]);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  if (error?.status === 403) return <div className="empty"><h3>Сведения о конкурентах доступны сотрудникам</h3></div>;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <h1>Конкуренты</h1>
        {isAdmin && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>Добавить компанию</button>}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Только то, что внесено вручную по источникам: сайт производителя, прайс, документ. Запись о компании не делает её
        конкурентом — это отмечает администратор. Оценочных выводов здесь нет — только сведения рядом.
      </p>
      <div className="row ci-filters" style={{ flexWrap: "wrap", gap: 10 }}>
        <input className="input" placeholder="Компания, марка или товар" value={f.search} onChange={set("search")} style={{ maxWidth: 320 }} aria-label="Поиск" />
        <select className="input" value={f.competitorStatus} onChange={set("competitorStatus")} style={{ maxWidth: 200 }} aria-label="Статус">
          <option value="">Любой статус</option>
          {Object.entries(COMPETITOR_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={f.kind} onChange={set("kind")} style={{ maxWidth: 200 }} aria-label="Вид">
          <option value="">Любой вид</option>
          {Object.entries(COMPANY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {!data ? <div className="skeleton" style={{ height: 240 }} /> : data.items.length === 0 ? (
        <div className="empty ci-empty" data-empty="competitors">
          <h3>{f.search || f.competitorStatus || f.kind ? "Ничего не найдено" : "Конкурентов пока нет"}</h3>
          <p>{isAdmin ? "Добавьте компанию, затем её марки, товары и сведения с источниками." : "Сведения о конкурентах вносит администратор."}</p>
        </div>
      ) : (
        <div className="ci-list" role="list">
          <div className="ci-list-head" aria-hidden="true"><span>Компания</span><span>Статус</span><span>Марки</span><span>Товаров</span><span>Источников</span><span>Регионы</span></div>
          {data.items.map((c) => (
            <Link key={c.id} to={`/admin/ai/competitors/${c.id}`} className="ci-list-row" role="listitem">
              <span className="ci-name"><b>{c.name}</b><span className="hint">{COMPANY_KIND[c.kind]}</span></span>
              <span data-label="Статус"><span className={`pill ${COMPETITOR_PILL[c.competitorStatus] || ""}`}>{COMPETITOR_STATUS[c.competitorStatus]}</span></span>
              <span data-label="Марки">{c.brands.length ? c.brands.join(", ") : <span className="dim">нет</span>}</span>
              <span data-label="Товаров" className="num">{c.products}</span>
              <span data-label="Источников" className="num">{c.sources}</span>
              <span data-label="Регионы">{c.regions.length ? c.regions.join(", ") : <span className="dim">не указаны</span>}</span>
            </Link>
          ))}
        </div>
      )}
      {adding && <CompanyForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </div>
  );
}
