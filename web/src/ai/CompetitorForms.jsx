import { useEffect, useState } from "react";
import * as api from "../lib/api.js";
import { useApp } from "../store.jsx";
import Modal from "../components/Modal.jsx";
import { COMPANY_KIND, COMPETITOR_STATUS, MARKET_STATUS, ACCESS, SOURCE_TYPE, STATEMENT, PRICE_KIND, BASIS_UNIT, VAT, RELATION } from "./competitorLabels.js";

// Формы раздела «Конкуренты». Вносит сведения только администратор; сервер
// проверяет всё ещё раз (источник, дата, основа цены, уровень доступа,
// условие с цитатой) — здесь проверка до отправки, чтобы не терять ввод.
// После сохранения вызывается onDone — карточка перечитывает данные.

const Field = ({ label, hint, children }) => (
  <label className="stack" style={{ gap: 6 }}>
    <span className="label">{label}</span>
    {children}
    {hint && <span className="hint">{hint}</span>}
  </label>
);
const Row = ({ children }) => <div className="ci-form-row">{children}</div>;

// Общий каркас: ошибки проверки, ошибка сервера, «Сохранить» заблокирована,
// пока обязательное не заполнено.
function FormShell({ title, problems, error, busy, onSave, onClose, children, wide }) {
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form className="stack ci-form" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (!problems.length && !busy) onSave(); }}>
        {children}
        {problems.length > 0 && <p className="hint" role="status">Нужно заполнить: {problems.join("; ")}.</p>}
        {error && <div className="ai-error" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={busy || problems.length > 0}>Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

function useSubmit(onDone, okText) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); toast(okText); onDone(); } catch (e) {
      const fields = (e.fields || []).map((f) => `${f.path}: ${f.message}`).join("; ");
      setError(fields ? `${e.message} (${fields})` : e.message);
    } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

const AccessSelect = ({ value, onChange }) => (
  <Field label="Уровень доступа" hint="Внутренние видят сотрудники, конфиденциальные — только администратор.">
    <select className="input" value={value} onChange={onChange}>
      {Object.entries(ACCESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  </Field>
);

// Источники — из раздела «Источники» (без источника внешнее сведение не
// принимается).
function useSources() {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get("/api/ai/sources?status=active").then((d) => setItems(d.items)).catch(() => setItems([])); }, []);
  return items;
}
function SourceSelect({ value, onChange, sources }) {
  return (
    <Field label="Источник (обязательно)" hint={sources && !sources.length ? "Источников нет — сначала добавьте его в разделе «Источники»." : "Откуда сведение: страница, прайс, документ."}>
      <select className={`input${value ? "" : " err"}`} value={value} onChange={onChange} required>
        <option value="">— выберите источник —</option>
        {(sources || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );
}
const today = () => new Date().toISOString().slice(0, 10);
const opt = (v) => (String(v ?? "").trim() === "" ? undefined : v);

export function CompanyForm({ company, onClose, onDone }) {
  const [v, setV] = useState({ name: company?.name || "", legalName: company?.legalName || "", website: company?.website || "", kind: company?.kind || "manufacturer",
    competitorStatus: company?.competitorStatus || "unknown", notes: company?.notes || "", accessLevel: company?.accessLevel || "internal" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, company ? "Компания изменена" : "Компания добавлена");
  const problems = [!v.name.trim() && "название", v.website && !/^https?:\/\/\S+\.\S+/.test(v.website) && "адрес сайта вида https://…"].filter(Boolean);
  const body = { name: v.name.trim(), legalName: opt(v.legalName.trim()) ?? null, website: opt(v.website.trim()) ?? null, kind: v.kind, competitorStatus: v.competitorStatus, notes: opt(v.notes.trim()) ?? null, accessLevel: v.accessLevel };
  return (
    <FormShell title={company ? "Компания" : "Новая компания"} problems={problems} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => (company ? api.patch(`/api/ai/competitors/${company.id}`, body) : api.post("/api/ai/competitors", body)))}>
      <Field label="Название"><input className="input" name="name" value={v.name} onChange={set("name")} /></Field>
      <Field label="Юридическое лицо"><input className="input" value={v.legalName} onChange={set("legalName")} /></Field>
      <Field label="Сайт"><input className="input" value={v.website} onChange={set("website")} placeholder="https://…" /></Field>
      <Row>
        <Field label="Вид"><select className="input" value={v.kind} onChange={set("kind")}>{Object.entries(COMPANY_KIND).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Конкурент?" hint="Запись сама по себе не делает компанию конкурентом.">
          <select className="input" value={v.competitorStatus} onChange={set("competitorStatus")}>{Object.entries(COMPETITOR_STATUS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select>
        </Field>
      </Row>
      <AccessSelect value={v.accessLevel} onChange={set("accessLevel")} />
      <Field label="Заметка" hint="Без телефонов и почты сотрудников."><input className="input" value={v.notes} onChange={set("notes")} /></Field>
    </FormShell>
  );
}

export function BrandForm({ companyId, brand, onClose, onDone }) {
  const [name, setName] = useState(brand?.name || "");
  const { busy, error, submit } = useSubmit(onDone, brand ? "Марка изменена" : "Марка добавлена");
  return (
    <FormShell title={brand ? "Марка" : "Новая марка"} problems={[!name.trim() && "название марки"].filter(Boolean)} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => (brand ? api.patch(`/api/ai/competitor-brands/${brand.id}`, { name: name.trim() }) : api.post("/api/ai/competitor-brands", { companyId, name: name.trim() })))}>
      <Field label="Название марки" hint="Марка принадлежит компании и компанией не становится."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </FormShell>
  );
}

export function ProductForm({ companyId, brands: given, product, onClose, onDone }) {
  const [cats, setCats] = useState([]);
  const [brands, setBrands] = useState(given || null);
  useEffect(() => { api.get("/api/catalog/meta").then((m) => setCats(m.categories || [])).catch(() => {}); }, []);
  // Марки — той же компании (при правке товара — его компании).
  useEffect(() => { if (!given) api.get(`/api/ai/competitors/${companyId ?? product?.companyId}/brands`).then((d) => setBrands(d.items)).catch(() => setBrands([])); }, []);
  const [v, setV] = useState({ name: product?.name || "", shortName: product?.shortName || "", brandId: product?.brandId ?? "", categoryId: product?.categoryId ?? "",
    gost: product?.gost || "", marketStatus: product?.marketStatus || "unknown", accessLevel: product?.accessLevel || "internal" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, product ? "Товар изменён" : "Товар добавлен");
  const body = { name: v.name.trim(), shortName: opt(v.shortName.trim()) ?? null, brandId: v.brandId ? Number(v.brandId) : null, categoryId: v.categoryId ? Number(v.categoryId) : null,
    gost: opt(v.gost.trim()) ?? null, marketStatus: v.marketStatus, accessLevel: v.accessLevel };
  return (
    <FormShell title={product ? "Товар конкурента" : "Новый товар конкурента"} problems={[!v.name.trim() && "название"].filter(Boolean)} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => (product ? api.patch(`/api/ai/competitor-products/${product.id}`, body) : api.post("/api/ai/competitor-products", { companyId, ...body })))}>
      <Field label="Название, как у производителя"><input className="input" value={v.name} onChange={set("name")} /></Field>
      <Row>
        <Field label="Короткое имя"><input className="input" value={v.shortName} onChange={set("shortName")} /></Field>
        <Field label="Марка"><select className="input" value={v.brandId} onChange={set("brandId")}><option value="">— без марки —</option>{(brands || []).filter((b) => b.lifecycleStatus === "active").map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      </Row>
      <Row>
        <Field label="Раздел каталога Habez" hint="Для сопоставления с нашими товарами."><select className="input" value={v.categoryId} onChange={set("categoryId")}><option value="">— не выбран —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Выпуск"><select className="input" value={v.marketStatus} onChange={set("marketStatus")}>{Object.entries(MARKET_STATUS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      </Row>
      <Field label="ГОСТ / ТУ по данным"><input className="input" value={v.gost} onChange={set("gost")} /></Field>
      <AccessSelect value={v.accessLevel} onChange={set("accessLevel")} />
    </FormShell>
  );
}

export function PackForm({ competitorProductId, onClose, onDone }) {
  const [v, setV] = useState({ unitLabel: "", packSize: "", packUnit: "кг", weightKg: "", barcode: "" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, "Фасовка добавлена");
  const problems = [!v.unitLabel.trim() && "подпись фасовки", v.barcode && !/^\d{8,14}$/.test(v.barcode) && "штрихкод — 8–14 цифр"].filter(Boolean);
  return (
    <FormShell title="Новая фасовка" problems={problems} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => api.post("/api/ai/competitor-packs", { competitorProductId, unitLabel: v.unitLabel.trim(), packSize: v.packSize ? Number(v.packSize) : null,
        packUnit: opt(v.packUnit) ?? null, weightKg: v.weightKg ? Number(v.weightKg) : null, barcode: opt(v.barcode) ?? null }))}>
      <Field label="Фасовка, как в источнике"><input className="input" value={v.unitLabel} onChange={set("unitLabel")} placeholder="мешок 25 кг" /></Field>
      <Row>
        <Field label="Размер"><input className="input" type="number" min="0" step="any" value={v.packSize} onChange={set("packSize")} /></Field>
        <Field label="Единица"><input className="input" value={v.packUnit} onChange={set("packUnit")} /></Field>
        <Field label="Вес, кг"><input className="input" type="number" min="0" step="any" value={v.weightKg} onChange={set("weightKg")} /></Field>
      </Row>
      <Field label="Штрихкод"><input className="input" inputMode="numeric" value={v.barcode} onChange={set("barcode")} /></Field>
    </FormShell>
  );
}

// Наблюдение характеристики: ключ словаря, значение как в источнике,
// условие — только с дословной цитатой (как в модели наблюдений 2.2B).
export function ObservationForm({ competitorProductId, packs, meta, onClose, onDone }) {
  const sources = useSources();
  const [v, setV] = useState({ specKey: "", originalValue: "", packId: "", statementType: "declared", sourceType: "technical_document", sourceId: "", sourceReference: "",
    providedAt: "", condKey: "", condValue: "", conditionText: "", accessLevel: "internal", evidenceNote: "" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, "Наблюдение добавлено");
  const hasCond = !!v.condKey;
  const problems = [!v.specKey && "характеристика", !v.originalValue.trim() && "значение", !v.sourceId && "источник",
    hasCond && !v.condValue.trim() && "значение условия", hasCond && !v.conditionText.trim() && "цитата условия из источника"].filter(Boolean);
  const groups = new Map();
  for (const k of meta?.specKeys || []) { if (!groups.has(k.group)) groups.set(k.group, []); groups.get(k.group).push(k); }
  return (
    <FormShell title="Новое наблюдение характеристики" wide problems={problems} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => api.post("/api/ai/competitor-observations", {
        competitorProductId, packId: v.packId ? Number(v.packId) : null, specKey: v.specKey, originalValue: v.originalValue.trim(), statementType: v.statementType,
        sourceType: v.sourceType, sourceId: Number(v.sourceId), sourceReference: opt(v.sourceReference.trim()) ?? null, providedAt: opt(v.providedAt) ?? null,
        ...(hasCond ? { conditions: { [v.condKey]: v.condValue.trim() }, conditionText: v.conditionText.trim() } : {}),
        accessLevel: v.accessLevel, evidenceNote: opt(v.evidenceNote.trim()) ?? null,
      }))}>
      <Row>
        <Field label="Характеристика">
          <select className="input" value={v.specKey} onChange={set("specKey")}>
            <option value="">— выберите —</option>
            {[...groups].map(([g, ks]) => <optgroup key={g} label={g}>{ks.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</optgroup>)}
          </select>
        </Field>
        <Field label="Значение, как в источнике"><input className="input" value={v.originalValue} onChange={set("originalValue")} placeholder="не менее 0,5 МПа" /></Field>
      </Row>
      <Row>
        <Field label="Тип утверждения"><select className="input" value={v.statementType} onChange={set("statementType")}>{Object.entries(STATEMENT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Фасовка (если значение её)"><select className="input" value={v.packId} onChange={set("packId")}><option value="">— весь товар —</option>{(packs || []).filter((p) => p.lifecycleStatus === "active").map((p) => <option key={p.id} value={p.id}>{p.unitLabel}</option>)}</select></Field>
      </Row>
      <fieldset className="ci-fieldset">
        <legend className="label">Условие (если есть) — только с дословной цитатой</legend>
        <Row>
          <Field label="Вид условия"><select className="input" value={v.condKey} onChange={set("condKey")}><option value="">— без условия —</option>{Object.entries(meta?.conditionKeys || {}).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select></Field>
          <Field label="Значение условия"><input className="input" value={v.condValue} onChange={set("condValue")} disabled={!hasCond} placeholder="28" /></Field>
        </Row>
        <Field label="Цитата из источника"><input className="input" value={v.conditionText} onChange={set("conditionText")} disabled={!hasCond} placeholder="в возрасте 28 сут" /></Field>
      </fieldset>
      <Row>
        <Field label="Вид документа"><select className="input" value={v.sourceType} onChange={set("sourceType")}>{Object.entries(SOURCE_TYPE).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <SourceSelect value={v.sourceId} onChange={set("sourceId")} sources={sources} />
      </Row>
      <Row>
        <Field label="Где в источнике"><input className="input" value={v.sourceReference} onChange={set("sourceReference")} placeholder="стр. 2, таблица 1" /></Field>
        <Field label="Дата документа или страницы"><input className="input" type="date" max={today()} value={v.providedAt} onChange={set("providedAt")} /></Field>
      </Row>
      <AccessSelect value={v.accessLevel} onChange={set("accessLevel")} />
      <Field label="Цитата-доказательство (необязательно)"><input className="input" value={v.evidenceNote} onChange={set("evidenceNote")} /></Field>
    </FormShell>
  );
}

// Цена: сумма, вид, основа («за мешок 25 кг»), дата и источник обязательны.
// Разные основы не пересчитываются.
export function PriceForm({ competitorProductId, packs, onClose, onDone }) {
  const sources = useSources();
  const [regions, setRegions] = useState([]);
  const [sellers, setSellers] = useState([]);
  useEffect(() => {
    api.get("/api/ai/regions").then((d) => setRegions(d.items)).catch(() => {});
    api.get("/api/ai/competitors").then((d) => setSellers(d.items)).catch(() => {});
  }, []);
  const [v, setV] = useState({ amount: "", currency: "RUB", priceKind: "retail", priceBasis: "", basisUnit: "pack", basisQty: "", vat: "unknown", packId: "", regionId: "",
    sellerCompanyId: "", observedAt: "", sourceId: "", sourceReference: "", accessLevel: "internal" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, "Цена добавлена");
  const amountMinor = Math.round(Number(String(v.amount).replace(",", ".").replace(/\s/g, "")) * 100);
  const problems = [!(v.amount && Number.isFinite(amountMinor) && amountMinor >= 0) && "сумма", !v.priceBasis.trim() && "основа цены (за что цена)",
    !v.observedAt && "дата наблюдения", v.observedAt > today() && "дата не позже сегодняшней", !v.sourceId && "источник"].filter(Boolean);
  return (
    <FormShell title="Новая цена" wide problems={problems} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => api.post("/api/ai/competitor-prices", {
        competitorProductId, amountMinor, currency: v.currency, priceKind: v.priceKind, priceBasis: v.priceBasis.trim(), basisUnit: v.basisUnit,
        basisQty: v.basisQty ? Number(String(v.basisQty).replace(",", ".")) : null, vat: v.vat, packId: v.packId ? Number(v.packId) : null,
        regionId: v.regionId ? Number(v.regionId) : null, sellerCompanyId: v.sellerCompanyId ? Number(v.sellerCompanyId) : null,
        observedAt: v.observedAt, sourceId: Number(v.sourceId), sourceReference: opt(v.sourceReference.trim()) ?? null, accessLevel: v.accessLevel,
      }))}>
      <Row>
        <Field label="Сумма, ₽"><input className="input" inputMode="decimal" value={v.amount} onChange={set("amount")} placeholder="450,00" /></Field>
        <Field label="Вид цены"><select className="input" value={v.priceKind} onChange={set("priceKind")}>{Object.entries(PRICE_KIND).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="НДС"><select className="input" value={v.vat} onChange={set("vat")}>{Object.entries(VAT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
      </Row>
      <Row>
        <Field label="Основа цены, как в источнике" hint="«за мешок 25 кг» и «за кг» не пересчитываются."><input className="input" value={v.priceBasis} onChange={set("priceBasis")} placeholder="за мешок 25 кг" /></Field>
        <Field label="Единица основы"><select className="input" value={v.basisUnit} onChange={set("basisUnit")}>{Object.entries(BASIS_UNIT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Количество"><input className="input" inputMode="decimal" value={v.basisQty} onChange={set("basisQty")} placeholder="25" /></Field>
      </Row>
      <Row>
        <Field label="Фасовка"><select className="input" value={v.packId} onChange={set("packId")}><option value="">— не указана —</option>{(packs || []).filter((p) => p.lifecycleStatus === "active").map((p) => <option key={p.id} value={p.id}>{p.unitLabel}</option>)}</select></Field>
        <Field label="Регион"><select className="input" value={v.regionId} onChange={set("regionId")}><option value="">— не указан —</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Продавец"><select className="input" value={v.sellerCompanyId} onChange={set("sellerCompanyId")}><option value="">— не указан —</option>{sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </Row>
      <Row>
        <Field label="Дата наблюдения (обязательно)"><input className={`input${v.observedAt ? "" : " err"}`} type="date" max={today()} value={v.observedAt} onChange={set("observedAt")} required /></Field>
        <SourceSelect value={v.sourceId} onChange={set("sourceId")} sources={sources} />
      </Row>
      <Field label="Где в источнике"><input className="input" value={v.sourceReference} onChange={set("sourceReference")} placeholder="строка 12" /></Field>
      <AccessSelect value={v.accessLevel} onChange={set("accessLevel")} />
    </FormShell>
  );
}

// Связь с нашим товаром: вид связи и допустимое основание. Частичный аналог —
// только с различиями; решение сотрудника — только с обоснованием.
export function AnalogForm({ competitorProductId, onClose, onDone }) {
  const sources = useSources();
  const [ours, setOurs] = useState([]);
  useEffect(() => { api.get("/api/ai/products").then((d) => setOurs(d.items || [])).catch(() => {}); }, []);
  const [v, setV] = useState({ productId: "", relation: "analog", basis: "explicit_source_statement", sourceId: "", sourceReference: "", note: "", differences: "", accessLevel: "internal" });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, submit } = useSubmit(onDone, "Связь добавлена");
  const problems = [!v.productId && "товар Habez", v.basis === "explicit_source_statement" && !v.sourceId && "источник",
    v.basis === "user_decision" && !v.note.trim() && "обоснование решения", v.relation === "partial_analog" && !v.differences.trim() && "различия"].filter(Boolean);
  return (
    <FormShell title="Связь с товаром Habez" wide problems={problems} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => api.post("/api/ai/competitor-analogs", {
        productId: Number(v.productId), competitorProductId, relation: v.relation, basis: v.basis, sourceId: v.sourceId ? Number(v.sourceId) : null,
        sourceReference: opt(v.sourceReference.trim()) ?? null, note: opt(v.note.trim()) ?? null, differences: opt(v.differences.trim()) ?? null, accessLevel: v.accessLevel,
      }))}>
      <Field label="Товар Habez"><select className="input" value={v.productId} onChange={set("productId")}><option value="">— выберите —</option>{ours.map((p) => <option key={p.id} value={p.id}>{p.short_name || p.name}</option>)}</select></Field>
      <Row>
        <Field label="Вид связи" hint="«Аналог» не значит «одинаковый товар»."><select className="input" value={v.relation} onChange={set("relation")}>{Object.entries(RELATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Основание"><select className="input" value={v.basis} onChange={set("basis")}><option value="explicit_source_statement">указано в источнике</option><option value="user_decision">решение сотрудника</option></select></Field>
      </Row>
      {v.basis === "explicit_source_statement" ? (
        <Row>
          <SourceSelect value={v.sourceId} onChange={set("sourceId")} sources={sources} />
          <Field label="Где в источнике"><input className="input" value={v.sourceReference} onChange={set("sourceReference")} /></Field>
        </Row>
      ) : null}
      <Field label={v.basis === "user_decision" ? "Обоснование (обязательно)" : "Обоснование"}><input className="input" value={v.note} onChange={set("note")} placeholder="что сверено" /></Field>
      {v.relation === "partial_analog" && <Field label="Различия (обязательно)"><input className="input" value={v.differences} onChange={set("differences")} placeholder="чем товары отличаются" /></Field>}
      <AccessSelect value={v.accessLevel} onChange={set("accessLevel")} />
    </FormShell>
  );
}

// Снять запись (удаления нет): причина обязательна, запись остаётся в истории.
export function WithdrawForm({ title, url, onClose, onDone }) {
  const [reasonText, setReason] = useState("");
  const { busy, error, submit } = useSubmit(onDone, "Запись снята — она остаётся в истории");
  return (
    <FormShell title={title} problems={[!reasonText.trim() && "причина"].filter(Boolean)} error={error} busy={busy} onClose={onClose}
      onSave={() => submit(() => api.post(url, { reason: reasonText.trim() }))}>
      <p className="hint" style={{ margin: 0 }}>Запись не удаляется: она уходит из действующих и остаётся в истории с причиной.</p>
      <Field label="Причина"><input className="input" value={reasonText} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormShell>
  );
}
