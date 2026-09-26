import { useState } from "react";
import { Link } from "react-router-dom";
import { RELATION, BASIS, ANALOG_STATUS, money, PRICE_KIND, BASIS_UNIT, VAT, VERIFICATION, SOURCE_KIND } from "./competitorLabels.js";

// Общие блоки раздела «Конкуренты»: связи с товарами Habez, цены, таблица
// сравнения. Только показ того, что посчитал сервер; оценок нет.

const STATUS_CLASS = { CONFIRMED: "done", CONFLICTED: "pending", INFERRED: "", UNKNOWN: "" };

// Связи «наш товар ↔ товар конкурента». Предположение — отдельной пометкой,
// частичный аналог — с различиями, противоречие — все основания.
export function AnalogList({ items, side = "competitor", onWithdraw }) {
  if (!items?.length) return <p className="hint ci-empty" data-empty="analogs">Связей с товарами Habez в данных нет — ни подтверждённых, ни предполагаемых.</p>;
  return (
    <div className="ci-analogs">
      {items.map((a, i) => (
        <div key={i} className="ci-analog" data-status={a.status}>
          <div className="ci-analog-head">
            <b>{side === "competitor" ? a.product.short || a.product.name : (
              <Link to={`/admin/ai/competitor-products/${a.competitorProduct.id}`}>{a.competitorProduct.short || a.competitorProduct.name}</Link>)}</b>
            {side !== "competitor" && a.competitorProduct.company && <span className="hint">{a.competitorProduct.company}</span>}
            <span className={`pill ${STATUS_CLASS[a.status] || ""}`}>{ANALOG_STATUS[a.status]}{a.relation ? `: ${RELATION[a.relation]}` : ""}</span>
          </div>
          {a.status === "INFERRED" && <div className="hint">Предположение: {a.inferredBasis || "тот же раздел каталога"}. Подтверждением не является.</div>}
          {a.status === "CONFLICTED" && <div className="hint">Основания противоречат друг другу — показаны все, система не выбирает.</div>}
          {a.basis?.map((b, j) => (
            <div key={j} className="hint ci-basis">
              {RELATION[b.relation]} — {BASIS[b.kind] || b.kind}{b.source ? ` «${b.source.name}»` : ""}{b.note ? `; обоснование: ${b.note}` : ""}
              {b.differences && <span className="ci-diff">; различия: {b.differences}</span>}
              {onWithdraw && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onWithdraw(b)}>Снять</button>}
            </div>
          ))}
          {a.needsReview && <div className="hint">Есть сведения, доступные другой роли; нужна сверка.</div>}
        </div>
      ))}
    </div>
  );
}

// Цены группами сравнимых цен: разные основы и виды — разные группы.
export function PriceGroups({ groups, hidden = 0 }) {
  if (!groups?.length) return (
    <p className="hint ci-empty" data-empty="prices">Цен в данных нет.{hidden ? ` Есть ещё ${hidden} — доступны другой роли.` : ""}</p>
  );
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="hint" style={{ margin: 0 }}>Группа — один вид цены, одна основа, НДС, фасовка и регион. Цены разных групп не сравниваются и не пересчитываются; действующая цена не выбирается.</p>
      {groups.map((g, i) => (
        <div key={i} className="ci-price-group" data-status={g.status}>
          <div className="ci-price-head">
            <b>{PRICE_KIND[g.priceKind] || g.priceKind}, {g.basis}</b>
            <span className="hint">{[BASIS_UNIT[g.basisUnit], g.basisQty ? `количество ${g.basisQty}` : null, VAT[g.vat], g.pack ? `фасовка ${g.pack}` : null, g.region].filter(Boolean).join(" · ")}</span>
            {g.status === "CONFLICTED" && <span className="pill pending">противоречие: на одну дату разные суммы</span>}
          </div>
          <div className="table-wrap ci-scroll">
            <table className="table">
              <thead><tr><th>Цена</th><th>Дата</th><th>Регион</th><th>Продавец</th><th>Источник</th><th>Проверка</th></tr></thead>
              <tbody>
                {g.observations.map((o) => (
                  <tr key={o.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{money(o.amountMinor, o.currency)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{o.observedAt}</td>
                    <td>{o.region || "—"}</td>
                    <td>{o.seller || "—"}</td>
                    <td className="muted">{o.source?.name || "—"}{o.sourceReference ? `, ${o.sourceReference}` : ""}</td>
                    <td className="dim">{VERIFICATION[o.verificationStatus] || o.verificationStatus}{o.accessLevel === "confidential" ? " · конфиденциально" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {hidden > 0 && <p className="hint" style={{ margin: 0 }}>Есть ещё {hidden} цен(ы) — доступны другой роли.</p>}
    </div>
  );
}

// Сравнение «наш ↔ их» в формате comparisonRows (3.2) на готовом
// .ai-compare: у каждой ячейки значения, единицы, источники и даты;
// «нет данных»; расхождение; разные единицы — без пересчёта.
export function CompareTable({ data }) {
  const [all, setAll] = useState(false);
  if (!data?.rows?.length) return <p className="hint ci-empty" data-empty="compare">Характеристик для сравнения в данных нет.</p>;
  const [ours, theirs] = data.products;
  const rows = all ? data.rows : data.rows.slice(0, 12);
  const cell = (r, p) => {
    const prop = r.cells[p.id];
    if (!prop) return <td className="muted">нет данных</td>;
    const conflict = ["conflict", "unresolved"].includes(prop.status);
    return (
      <td className={conflict ? "ai-cell-conflict" : undefined}>
        {prop.values.map((v, i) => (
          <div key={i}>
            {v.hidden ? <span className="hint">скрытое значение — доступно другой роли</span> : v.display}
            {v.evidence?.[0] && <span className="hint"> · {v.evidence[0].sourceName || v.evidence[0].where || SOURCE_KIND[v.evidence[0].sourceType] || "карточка товара"}{v.evidence[0].sourceDate ? `, ${v.evidence[0].sourceDate}` : ""}</span>}
          </div>
        ))}
        {conflict && <span className="hint">расхождение — система не выбирает</span>}
      </td>
    );
  };
  const units = (r) => new Set([ours, theirs].map((p) => r.cells[p.id]).filter(Boolean).flatMap((pr) => pr.values.map((v) => v.unit)).filter(Boolean)).size > 1;
  return (
    <div className="ai-compare" role="region" aria-label="Сравнение">
      <div className="ai-compare-scroll">
        <table>
          <thead><tr><th>Характеристика</th><th>{ours.short || ours.name}</th><th>{theirs.short || theirs.name}</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.label}{r.conditionText ? <span className="hint"> · {r.conditionText}</span> : null}{units(r) ? <span className="hint"> · разные единицы, не пересчитано</span> : null}</th>
                {cell(r, ours)}
                {cell(r, theirs)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length > 12 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!all)}>{all ? "Свернуть" : `Ещё ${data.rows.length - 12}`}</button>}
    </div>
  );
}
