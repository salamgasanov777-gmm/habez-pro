import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import { Back } from "../components/Icons.jsx";
import { MARKET_STATUS, ACCESS, STATEMENT, PROPERTY_STATUS, VERIFICATION, LIFECYCLE } from "./competitorLabels.js";
import { ProductForm, PackForm, ObservationForm, PriceForm, AnalogForm, WithdrawForm } from "./CompetitorForms.jsx";
import { AnalogList, PriceGroups, CompareTable } from "./CompetitorParts.jsx";

// Карточка товара конкурента: основное, фасовки (каждая отдельно),
// характеристики по группам словаря, цены группами, связи с товарами Habez
// и сравнение «наш ↔ их».
export default function CompetitorProduct() {
  const { id } = useParams();
  const { user } = useApp();
  const isAdmin = ["admin", "owner"].includes(user.role);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(null);
  const [ours, setOurs] = useState([]);
  const [cmpWith, setCmpWith] = useState("");
  const [cmp, setCmp] = useState(null);
  const load = () => api.get(`/api/ai/competitor-products/${id}`).then(setData).catch(() => setData(false));
  useEffect(() => { load(); api.get("/api/ai/competitors/meta").then(setMeta).catch(() => {}); api.get("/api/ai/products").then((d) => setOurs(d.items || [])).catch(() => {}); }, [id]);
  // Сравнение по умолчанию — с первым подтверждённым аналогом.
  useEffect(() => {
    if (!data || cmpWith) return;
    const first = data.analogs.find((a) => a.status === "CONFIRMED" && a.relation !== "not_analog") || data.analogs[0];
    if (first) setCmpWith(String(first.product.id));
  }, [data]);
  useEffect(() => {
    if (!cmpWith) { setCmp(null); return; }
    api.get(`/api/ai/competitor-compare?${api.qs({ productId: cmpWith, competitorProductId: id })}`).then(setCmp).catch(() => setCmp(false));
  }, [cmpWith, id, data]);
  const done = () => { setForm(null); load(); };

  if (data === false) return <div className="empty"><h3>Товар конкурента не найден</h3><Link className="btn" to="/admin/ai/competitors">К конкурентам</Link></div>;
  if (!data) return <div className="skeleton" style={{ height: 320 }} />;
  const { product: p, packs, properties, prices, analogs } = data;
  const active = p.lifecycleStatus === "active";

  return (
    <div className="stack ci-page" style={{ gap: 18 }}>
      <div>
        <Link to={`/admin/ai/competitors/${p.companyId}`} className="btn btn-sm"><Back width={15} height={15} /> {p.company || "К компании"}</Link>
        <div className="spread" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0 }}>{p.name}</h1>
          {isAdmin && active && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={() => setForm({ kind: "product" })}>Изменить</button>
              <button className="btn btn-sm" onClick={() => setForm({ kind: "withdraw" })}>Снять</button>
            </div>
          )}
        </div>
        <p className="hint" style={{ margin: "6px 0 0" }}>Товар конкурента — в каталоге Habez его нет.</p>
      </div>

      <section className="panel ci-facts">
        <div><span className="label">Короткое имя</span>{p.shortName || <span className="dim">—</span>}</div>
        <div><span className="label">Компания</span>{p.company}</div>
        <div><span className="label">Марка</span>{p.brand || <span className="dim">не указана</span>}</div>
        <div><span className="label">Раздел каталога Habez</span>{p.category || <span className="dim">не выбран</span>}</div>
        <div><span className="label">Выпуск</span>{MARKET_STATUS[p.marketStatus]}{!active ? " · запись снята" : ""}</div>
        <div><span className="label">ГОСТ / ТУ</span>{p.gost || <span className="dim">не указан</span>}</div>
        <div><span className="label">Доступ</span>{ACCESS[p.accessLevel]}</div>
      </section>

      <section className="panel">
        <div className="spread"><h3>Фасовки</h3>{isAdmin && active && <button className="btn btn-sm" onClick={() => setForm({ kind: "pack" })}>Добавить фасовку</button>}</div>
        {packs.length ? (
          <div className="ci-packs">{packs.map((k) => (
            <div key={k.id} className={`ci-pack${k.lifecycleStatus !== "active" ? " ci-withdrawn" : ""}`}>
              <b>{k.unitLabel}</b>
              <span className="hint">{[k.weightKg ? `${k.weightKg} кг` : null, k.barcode ? `штрихкод ${k.barcode}` : null, k.lifecycleStatus !== "active" ? "снята" : null].filter(Boolean).join(" · ") || "—"}</span>
            </div>
          ))}</div>
        ) : <p className="hint ci-empty" data-empty="packs">Фасовок в данных нет.</p>}
      </section>

      <section className="panel" data-block="properties">
        <div className="spread"><h3>Характеристики</h3>{isAdmin && active && <button className="btn btn-sm" onClick={() => setForm({ kind: "observation" })}>Добавить наблюдение</button>}</div>
        {properties.length ? properties.map((g) => (
          <div key={g.group} style={{ marginTop: 14 }}>
            <div className="label">{g.group}</div>
            <div className="table-wrap ci-scroll" style={{ marginTop: 6 }}>
              <table className="table">
                <thead><tr><th>Характеристика</th><th>Значение</th><th>Условие</th><th>Утверждение</th><th>Источник, дата</th><th>Состояние</th></tr></thead>
                <tbody>
                  {g.items.map((it, i) => (
                    <tr key={i} className={it.status === "conflict" ? "ci-conflict" : undefined}>
                      <td>{it.label}{it.pack ? <div className="hint">фасовка {it.pack}</div> : null}</td>
                      <td>{it.observations.map((o) => <div key={o.id}>{o.value}</div>)}
                        {it.history.length > 0 && <div className="hint">история: {it.history.map((o) => `${o.value} (${LIFECYCLE[o.lifecycleStatus]})`).join("; ")}</div>}</td>
                      <td>{it.conditionText || <span className="dim">—</span>}</td>
                      <td>{[...new Set(it.observations.map((o) => STATEMENT[o.statementType] || o.statementType))].join(", ") || "—"}</td>
                      <td className="muted">{it.observations.map((o) => <div key={o.id}>{o.source?.name || "—"}{o.providedAt ? `, ${o.providedAt}` : `, внесено ${o.capturedAt?.slice(0, 10)}`}</div>)}</td>
                      <td>
                        <span className={`pill ${it.status === "conflict" ? "pending" : ""}`}>{PROPERTY_STATUS[it.status]}</span>
                        {it.status === "conflict" && <div className="hint">значения расходятся — система не выбирает</div>}
                        {it.hiddenCount > 0 && <div className="hint">есть ещё {it.hiddenCount} — доступно другой роли{it.hiddenDisagreement ? ", расходится с видимым" : ""}</div>}
                        <div className="hint">{[...new Set(it.observations.map((o) => VERIFICATION[o.verificationStatus]))].join(", ")}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )) : <p className="hint ci-empty" data-empty="properties">Характеристик в данных нет. «Нет данных» — не ноль и не отрицательный вывод.</p>}
      </section>

      <section className="panel" data-block="prices">
        <div className="spread"><h3>Цены</h3>{isAdmin && active && <button className="btn btn-sm" onClick={() => setForm({ kind: "price" })}>Добавить цену</button>}</div>
        <PriceGroups groups={prices.groups} hidden={prices.hidden} />
        {prices.history.length > 0 && <p className="hint">История: {prices.history.length} снятых или заменённых цен сохранены.</p>}
      </section>

      <section className="panel" data-block="analogs">
        <div className="spread"><h3>Связи с товарами Habez</h3>{isAdmin && active && <button className="btn btn-sm" onClick={() => setForm({ kind: "analog" })}>Добавить связь</button>}</div>
        <p className="hint">«Аналог» не значит «одинаковый товар». Предположение по разделу каталога подтверждением не является.</p>
        <AnalogList items={analogs} side="competitor" onWithdraw={isAdmin ? (b) => setForm({ kind: "withdrawAnalog", id: b.id }) : null} />
      </section>

      <section className="panel" data-block="compare">
        <h3>Сравнение с товаром Habez</h3>
        <label className="stack" style={{ gap: 6, maxWidth: 360, marginTop: 10 }}>
          <span className="label">Товар Habez</span>
          <select className="input" value={cmpWith} onChange={(e) => setCmpWith(e.target.value)} aria-label="Товар Habez для сравнения">
            <option value="">— выберите —</option>
            {ours.map((o) => <option key={o.id} value={o.id}>{o.short_name || o.name}</option>)}
          </select>
        </label>
        {cmp === false ? <p className="hint">Сравнение недоступно.</p> : cmp ? (
          <div style={{ marginTop: 12 }}>
            {cmp.analog && <p className="hint">Связь: {{ CONFIRMED: "подтверждена", INFERRED: "предположение (не подтверждено)", CONFLICTED: "основания противоречат", UNKNOWN: "нет данных" }[cmp.analog.status]}. Система не выбирает одно значение.</p>}
            <CompareTable data={cmp} />
          </div>
        ) : null}
      </section>

      {form?.kind === "product" && <ProductForm product={p} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "withdraw" && <WithdrawForm title="Снять товар конкурента" url={`/api/ai/competitor-products/${p.id}/withdraw`} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "pack" && <PackForm competitorProductId={p.id} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "observation" && <ObservationForm competitorProductId={p.id} packs={packs} meta={meta} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "price" && <PriceForm competitorProductId={p.id} packs={packs} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "analog" && <AnalogForm competitorProductId={p.id} onClose={() => setForm(null)} onDone={done} />}
      {form?.kind === "withdrawAnalog" && <WithdrawForm title="Снять утверждение о связи" url={`/api/ai/competitor-analogs/${form.id}/withdraw`} onClose={() => setForm(null)} onDone={done} />}
    </div>
  );
}
