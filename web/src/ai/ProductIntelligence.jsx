import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";
import { Back } from "../components/Icons.jsx";
import { ORIGIN_LABEL, STATUS_LABEL, STATUS_PILL, ACTION_LABEL } from "./labels.js";

// Что машина знает о конкретном товаре: характеристики по группам,
// исходное значение рядом с нормализованным.
export default function ProductIntelligence({ onChanged }) {
  const { id } = useParams();
  const { user } = useApp();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);   // характеристика в подробностях
  const isAdmin = ["admin", "owner"].includes(user.role);

  const load = () => api.get(`/api/ai/products/${id}/intelligence`).then(setData).catch(() => setData(false));
  useEffect(() => { load(); }, [id]);

  if (data === false) return <div className="empty"><h3>Товар не найден</h3><Link className="btn" to="/admin/ai/products">К списку</Link></div>;
  if (!data) return <div className="skeleton" style={{ height: 320 }} />;

  const { product, specs, groups, stats, variants } = data;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <Link to="/admin/ai/products" className="btn btn-sm"><Back width={15} height={15} /> К товарам</Link>
        <h1 style={{ marginTop: 12 }}>{product.name}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {product.category || "без раздела"}{product.gost ? ` · ${product.gost}` : ""}
        </p>
      </div>

      <div className="kpis">
        <div className="kpi"><span className="label">Характеристик</span><b>{stats.total}</b>
          <span className="delta">подтверждено {stats.verified}</span></div>
        <div className="kpi"><span className="label">В числах</span><b>{stats.numeric}</b>
          <span className="delta">пригодны для сравнения</span></div>
        <div className="kpi"><span className="label">Да / нет</span><b>{stats.boolean}</b>
          <span className="delta">пригодность и основания</span></div>
        <div className="kpi"><span className="label">Нужен взгляд</span><b>{stats.needsReview}</b>
          <span className="delta">не свелось к числу</span></div>
      </div>

      {specs.length === 0 ? (
        <div className="empty">
          <h3>Характеристик пока нет</h3>
          <p>В карточке этого товара не нашлось подписей из словаря. Их можно добавить вручную.</p>
        </div>
      ) : groups.map((g) => (
        <section className="panel" key={g.name}>
          <h3>{g.name}</h3>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr><th>Характеристика</th><th>Как в карточке</th><th>Для машины</th><th>Источник</th><th>Состояние</th></tr>
              </thead>
              <tbody>
                {g.items.map((s) => (
                  <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => setOpen(s)}>
                    <td style={{ fontWeight: 500 }}>{s.label}</td>
                    <td>{s.displayValue}</td>
                    <td className="num">{machine(s)}</td>
                    <td className="muted" style={{ fontSize: 13 }}>{s.source?.name || ORIGIN_LABEL[s.origin] || "—"}</td>
                    <td><span className={`pill ${STATUS_PILL[s.verificationStatus] || ""}`}>{STATUS_LABEL[s.verificationStatus]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="panel">
        <h3>Фасовки</h3>
        <p className="hint" style={{ margin: "8px 0 12px" }}>
          Берутся из каталога и в характеристики не копируются — иначе два списка разойдутся.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Фасовка</th><th>Размер</th><th>Вес, кг</th><th>На паллете</th></tr></thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id}>
                  <td>{v.unit}</td>
                  <td className="num">{v.pack_size ? `${v.pack_size} ${v.pack_unit || ""}` : "—"}</td>
                  <td className="num">{v.weight_kg ?? "—"}</td>
                  <td className="num">{v.per_pallet ?? "—"}</td>
                </tr>
              ))}
              {variants.length === 0 && <tr><td colSpan="4" className="dim">Фасовок нет</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {open && <SpecDetails spec={open} isAdmin={isAdmin} onClose={() => setOpen(null)}
        onDone={() => { setOpen(null); load(); onChanged?.(); }} />}
    </div>
  );
}

// Как значение выглядит для машины: число, диапазон, да/нет или прочерк.
// Внутри всё время хранится в минутах — так его сравнивают; человеку крупные
// значения показываем часами и сутками, иначе «10080 мин» никто не прочтёт.
function machine(s) {
  if (s.value.bool !== null) return s.value.bool ? "да" : "нет";
  if (s.value.num !== null) return `${prefix(s.comparator)}${amount(s.value.num, s.normalizedUnit, s.unitLabel)}`;
  if (s.value.min !== null) {
    return `${fmt(s.value.min)}–${amount(s.value.max, s.normalizedUnit, s.unitLabel)}`;
  }
  return <span className="dim">текст</span>;
}
const prefix = (c) => (c === "min" ? "≥ " : c === "max" ? "≤ " : c === "approx" ? "≈ " : "");
const fmt = (n) => String(Math.round(n * 1000) / 1000).replace(".", ",");

function amount(n, unit, unitLabel) {
  if (unit === "min") {
    if (n >= 1440 && n % 1440 === 0) return `${fmt(n / 1440)} сут`;
    if (n >= 120 && n % 60 === 0) return `${fmt(n / 60)} ч`;
  }
  return `${fmt(n)}${unitLabel ? ` ${unitLabel}` : ""}`;
}

// Подробности: исходное значение, нормализованное, источник, история.
function SpecDetails({ spec, isAdmin, onClose, onDone }) {
  const { toast } = useApp();
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(spec.displayValue);

  useEffect(() => { api.get(`/api/ai/specs/${spec.id}/history`).then((d) => setHistory(d.items)).catch(() => {}); }, [spec.id]);

  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/ai/specs/${spec.id}`, { displayValue: value.trim() }); toast("Значение изменено"); onDone(); }
    catch (e) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const verify = async (status) => {
    setBusy(true);
    try { await api.patch(`/api/ai/specs/${spec.id}/verification`, { status }); toast(`Состояние: ${STATUS_LABEL[status]}`); onDone(); }
    catch (e) { toast(e.message, "err"); } finally { setBusy(false); }
  };

  return (
    <Modal title={spec.label} onClose={onClose} wide>
      <div className="stack" style={{ gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="panel" style={{ padding: 14 }}>
            <span className="label">Как в карточке</span>
            <p style={{ fontSize: 20, fontWeight: 600, margin: "6px 0 0" }}>{spec.displayValue}</p>
          </div>
          <div className="panel" style={{ padding: 14 }}>
            <span className="label">Для машины</span>
            <p style={{ fontSize: 20, fontWeight: 600, margin: "6px 0 0" }}>{machine(spec)}</p>
            {spec.normalizedUnit && <span className="dim" style={{ fontSize: 12 }}>каноническая единица: {spec.normalizedUnit}</span>}
          </div>
        </div>

        <div className="stack" style={{ gap: 9, fontSize: 14 }}>
          <Row label="Ключ" value={spec.specKey} />
          <Row label="Происхождение" value={ORIGIN_LABEL[spec.origin] || spec.origin} />
          <Row label="Источник" value={spec.source?.name || "—"} />
          <Row label="Откуда перенесено" value={spec.importedFrom === "badge" ? "ярлык карточки" : spec.importedFrom === "spec_table" ? `таблица «${spec.sourceRef}»` : "введено вручную"} />
          <Row label="Получено" value={dateTime(spec.observedAt)} />
          <Row label="Состояние" value={STATUS_LABEL[spec.verificationStatus]} />
          {spec.verifiedBy && <Row label="Подтвердил" value={`${spec.verifiedBy.name} · ${dateTime(spec.verifiedAt)}`} />}
          {spec.parseNote && <Row label="Замечание" value={spec.parseNote} />}
        </div>

        <label className="stack" style={{ gap: 6 }}>
          <span className="label">Исправить значение (пишите как в источнике)</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
            <button className="btn btn-primary" disabled={busy || value.trim() === spec.displayValue || !value.trim()} onClick={save}>Сохранить</button>
          </div>
        </label>

        {isAdmin && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {spec.verificationStatus !== "verified" && (
              <button className="btn btn-sm btn-primary" disabled={busy || spec.origin === "ai_inference"}
                title={spec.origin === "ai_inference" ? "Вывод AI подтвердить нельзя" : undefined}
                onClick={() => verify("verified")}>Подтвердить</button>
            )}
            <button className="btn btn-sm" disabled={busy} onClick={() => verify("disputed")}>Противоречие</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => verify("rejected")}>Отклонить</button>
          </div>
        )}

        {history.length > 0 && (
          <div>
            <span className="label">История</span>
            <div className="stack" style={{ gap: 6, marginTop: 8, fontSize: 13 }}>
              {history.map((h) => (
                <div key={h.id} className="sum-row">
                  <span className="muted">{ACTION_LABEL[h.action] || h.action}</span>
                  <span className="dim">{h.actor || "—"} · {dateTime(h.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const Row = ({ label, value }) => (
  <div className="sum-row"><span className="muted">{label}</span><span>{value}</span></div>
);
