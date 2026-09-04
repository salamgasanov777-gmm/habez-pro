import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import { money } from "../lib/format.js";

const BLANK = {
  name: "", slug: "", categoryId: null, sku: "", shortName: "", summary: "", gost: "",
  status: "draft", badges: [], sections: [], tables: [], tasks: [], calc: null,
  seoTitle: "", seoDescription: "",
};

// Редактор карточки. Устроен как заводской паспорт: сверху название и ГОСТ,
// ниже — показатели, разделы инструкции и таблицы характеристик.
export default function ProductEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, toast } = useApp();
  const isNew = id === "new";
  const [form, setForm] = useState(isNew ? BLANK : null);
  const [extra, setExtra] = useState({ variants: [], media: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api.get(`/api/admin/products/${id}`).then((p) => {
      setForm({
        name: p.name, slug: p.slug, categoryId: p.category_id, sku: p.sku || "", shortName: p.short_name || "",
        summary: p.summary || "", gost: p.gost || "", status: p.status,
        badges: p.badges, sections: p.sections, tables: p.spec_tables, tasks: p.tasks, calc: p.calc,
        seoTitle: p.seo_title || "", seoDescription: p.seo_description || "",
      });
      setExtra({ variants: p.variants, media: p.media });
    });
  }, [id, isNew]);

  if (!form) return <div className="skeleton" style={{ height: 400 }} />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const res = await api.post("/api/admin/products", form);
        toast("Товар создан");
        nav(`/admin/products/${res.id}`, { replace: true });
      } else {
        await api.put(`/api/admin/products/${id}`, form);
        toast("Сохранено");
      }
    } catch (e) { toast(e.message, "err"); } finally { setBusy(false); }
  };

  const setPrice = async (variantId, tier, rubles) => {
    const amount = rubles === "" ? null : Math.round(Number(String(rubles).replace(",", ".")) * 100);
    await api.put(`/api/admin/variants/${variantId}/price`, { tier, amount });
    toast(amount === null ? "Цена снята — покажем «по запросу»" : `Цена: ${money(amount)}`);
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="spread">
        <h1>{isNew ? "Новый товар" : form.name}</h1>
        <div className="row">
          <select className="select" style={{ width: "auto" }} value={form.status} onChange={set("status")}>
            <option value="draft">Черновик</option><option value="published">На витрине</option><option value="archived">В архиве</option>
          </select>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Сохранить</button>
        </div>
      </div>

      <div className="editor-grid">
        <div className="stack" style={{ gap: 16 }}>
          <section className="panel stack">
            <h3>Основное</h3>
            <label className="field"><span>Название</span><input className="input" value={form.name} onChange={set("name")} /></label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label className="field"><span>Короткое имя <span className="dim">— для сравнения</span></span><input className="input" value={form.shortName} onChange={set("shortName")} /></label>
              <label className="field"><span>ГОСТ / ТУ</span><input className="input" value={form.gost} onChange={set("gost")} /></label>
            </div>
            <label className="field"><span>Раздел</span>
              <select className="select" value={form.categoryId ?? ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— без раздела —</option>
                {(meta?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="field"><span>Краткое описание</span><textarea className="textarea" value={form.summary} onChange={set("summary")} /></label>
          </section>

          <ListEditor title="Показатели в карточке" hint="Крупные цифры вверху карточки: прочность, время схватывания."
            items={form.badges} columns={["Подпись", "Значение"]} keys={["label", "value"]}
            onChange={(badges) => setForm({ ...form, badges })} />

          <ListEditor title="Разделы инструкции" hint="Область применения, подготовка основания, порядок работы."
            items={form.sections} columns={["Заголовок", "Текст"]} keys={["title", "text"]} multiline
            onChange={(sections) => setForm({ ...form, sections })} />

          <section className="panel stack">
            <h3>Таблицы характеристик</h3>
            <p className="hint">Строки формата «Показатель — Значение». Переносятся из паспорта продукции.</p>
            {form.tables.map((t, ti) => (
              <div key={ti} className="stack" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 12 }}>
                <div className="row">
                  <input className="input" value={t.title} onChange={(e) => {
                    const tables = [...form.tables]; tables[ti] = { ...t, title: e.target.value }; setForm({ ...form, tables });
                  }} />
                  <button className="btn btn-sm" onClick={() => setForm({ ...form, tables: form.tables.filter((_, i) => i !== ti) })}>Удалить</button>
                </div>
                {t.rows.map((r, ri) => (
                  <div className="row" key={ri}>
                    <input className="input" value={r[0]} onChange={(e) => {
                      const tables = structuredClone(form.tables); tables[ti].rows[ri][0] = e.target.value; setForm({ ...form, tables });
                    }} />
                    <input className="input" style={{ maxWidth: 180 }} value={r[1]} onChange={(e) => {
                      const tables = structuredClone(form.tables); tables[ti].rows[ri][1] = e.target.value; setForm({ ...form, tables });
                    }} />
                    <button className="icon-btn" onClick={() => {
                      const tables = structuredClone(form.tables); tables[ti].rows.splice(ri, 1); setForm({ ...form, tables });
                    }}>✕</button>
                  </div>
                ))}
                <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => {
                  const tables = structuredClone(form.tables); tables[ti].rows.push(["", ""]); setForm({ ...form, tables });
                }}>+ строка</button>
              </div>
            ))}
            <button className="btn btn-sm" style={{ justifySelf: "start" }}
              onClick={() => setForm({ ...form, tables: [...form.tables, { title: "Технические характеристики", rows: [["", ""]] }] })}>
              + таблица
            </button>
          </section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          {!isNew && (
            <section className="panel stack">
              <h3>Фасовки и цены</h3>
              {extra.variants.map((v) => (
                <div key={v.id} className="stack" style={{ gap: 8, borderBottom: "1px solid var(--line)", paddingBottom: 12 }}>
                  <b style={{ fontSize: 14 }}>{v.unit}</b>
                  <label className="field"><span>Розница, ₽ <span className="dim">(пусто = по запросу)</span></span>
                    <input className="input num" defaultValue={v.price_retail === null ? "" : v.price_retail / 100}
                      onBlur={(e) => setPrice(v.id, "retail", e.target.value)} /></label>
                  <label className="field"><span>Дилер, ₽</span>
                    <input className="input num" defaultValue={v.price_dealer === null ? "" : v.price_dealer / 100}
                      onBlur={(e) => setPrice(v.id, "dealer", e.target.value)} /></label>
                  <label className="field"><span>Остаток, шт</span>
                    <input className="input num" defaultValue={v.stock ?? 0}
                      onBlur={(e) => api.put(`/api/admin/variants/${v.id}/stock`, { qty: Number(e.target.value) || 0 }).then(() => toast("Остаток обновлён"))} /></label>
                </div>
              ))}
              <p className="hint">Цена сохраняется, когда вы уходите из поля.</p>
            </section>
          )}

          <section className="panel stack">
            <h3>Подбор по задаче</h3>
            <p className="hint">Отметьте, для чего годится товар — по этим кнопкам покупатель фильтрует каталог.</p>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {(meta?.tasks || []).map((t) => (
                <button key={t.key} className={`chip task ${form.tasks.includes(t.key) ? "on" : ""}`}
                  onClick={() => setForm({ ...form, tasks: form.tasks.includes(t.key) ? form.tasks.filter((x) => x !== t.key) : [...form.tasks, t.key] })}>
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="panel stack">
            <h3>Расчёт расхода</h3>
            {form.calc ? (
              <>
                <label className="field"><span>Расход, кг/м² {form.calc.type === "thickness" ? "на 1 мм" : ""}</span>
                  <input className="input num" value={form.calc.ratePerM2}
                    onChange={(e) => setForm({ ...form, calc: { ...form.calc, ratePerM2: Number(e.target.value) || 0 } })} /></label>
                <label className="field"><span>Упаковка</span>
                  <input className="input num" value={form.calc.pack}
                    onChange={(e) => setForm({ ...form, calc: { ...form.calc, pack: Number(e.target.value) || 0 } })} /></label>
                <button className="btn btn-sm" onClick={() => setForm({ ...form, calc: null })}>Убрать калькулятор</button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setForm({ ...form, calc: { type: "thickness", ratePerM2: 1, pack: 30 } })}>
                Добавить калькулятор
              </button>
            )}
          </section>

          <section className="panel stack">
            <h3>Для поисковиков</h3>
            <label className="field"><span>Заголовок</span><input className="input" value={form.seoTitle} onChange={set("seoTitle")} /></label>
            <label className="field"><span>Описание</span><textarea className="textarea" value={form.seoDescription} onChange={set("seoDescription")} /></label>
          </section>
        </div>
      </div>
    </div>
  );
}

function ListEditor({ title, hint, items, columns, keys, onChange, multiline }) {
  return (
    <section className="panel stack">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {items.map((item, i) => (
        <div className="stack" key={i} style={{ gap: 7 }}>
          <div className="row">
            <input className="input" placeholder={columns[0]} value={item[keys[0]]}
              onChange={(e) => { const next = [...items]; next[i] = { ...item, [keys[0]]: e.target.value }; onChange(next); }} />
            <button className="icon-btn" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Удалить">✕</button>
          </div>
          {multiline
            ? <textarea className="textarea" placeholder={columns[1]} value={item[keys[1]]}
                onChange={(e) => { const next = [...items]; next[i] = { ...item, [keys[1]]: e.target.value }; onChange(next); }} />
            : <input className="input" placeholder={columns[1]} value={item[keys[1]]}
                onChange={(e) => { const next = [...items]; next[i] = { ...item, [keys[1]]: e.target.value }; onChange(next); }} />}
        </div>
      ))}
      <button className="btn btn-sm" style={{ justifySelf: "start" }}
        onClick={() => onChange([...items, { [keys[0]]: "", [keys[1]]: "" }])}>+ добавить</button>
    </section>
  );
}
