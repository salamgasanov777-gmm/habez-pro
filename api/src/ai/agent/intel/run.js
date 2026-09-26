// Habez AI Phase 3.3: пути Product Intelligence в конвейере ответа.
//
//   PRODUCT_PROFILE      «Расскажи про ШОВ», «Для чего ШОВ?» — паспорт
//   PRODUCT_SELECTION    «Что использовать для швов ГКЛ?» — подбор;
//                        «Подходит ли ШОВ для фасада?», «Почему?» — пригодность
//   PRODUCT_APPLICATION  «Как применять КОРОЕД?» — инструкция из данных
//   INSUFFICIENT_DATA    пригодность или совместимость не подтвердить —
//                        ответ без модели
//
// Всё детерминированно: кандидаты, статусы пригодности, инструкция и
// совместимость считаются здесь, модель получает готовую структуру
// (ProductAnswer) и только объясняет её. Статусы ей менять нельзя.
import { callTool } from "../tools/index.js";
import { fetchProduct, selectProperties } from "../runtime/plan.js";
import { matchVariant, specLabel } from "../retrieval/specs.js";
import { useCaseById, typeFromQuestion } from "./usecases.js";
import { evaluateSuitability, STATUS_LABEL } from "./suitability.js";
import { selectProducts, sizeFromQuestion } from "./select.js";
import { buildProfile, extractApplication, compatibilityBetween } from "./profile.js";
import { sourceLabel } from "../runtime/bundle.js";

const brackets = (ids) => (ids?.length ? ` [${ids.join("][")}]` : "");
const nameOf = (p) => p.short || p.short_name || p.name;

// Номера доказательств для пунктов объяснения пригодности.
function evidenceRefs(items, refs) {
  return items.map((it) => {
    if (it.kind === "prop") return { text: it.text, refs: it.prop._refs || [] };
    const id = it.where === "summary" ? refs.summary : refs.sections.get(it.title);
    return { text: it.label ? `${it.label}: «${it.text}»` : `«${it.text}»`, refs: id ? [id] : [] };
  });
}

// Подбор или пригодность: товары → статусы → контекст и сводка для интерфейса.
function renderSelection({ results, useCase, bundle, allowed, size, header }) {
  const out = [];
  for (const x of results) {
    const used = new Set([...x.r.supporting, ...x.r.against, ...x.r.conflicting].filter((i) => i.kind === "prop").map((i) => i.prop));
    const key = (x.sp.properties || []).filter((pr) => useCase.keySpecs.includes(pr.key) && !used.has(pr)).slice(0, x.r.status === "NOT_SUPPORTED" ? 0 : 4);
    const textTitles = new Set([...x.r.supporting, ...x.r.conflicting].filter((i) => i.kind === "text" && i.where === "section").map((i) => i.title));
    // Кандидат без признаков — одной строкой: описание модели не нужно.
    const brief = x.r.status === "INSUFFICIENT_DATA" || (x.r.status === "NOT_SUPPORTED" && !x.r.supporting.some((i) => i.where === "summary"));
    const p = { ...x.p, summary: brief ? null : x.p.summary, sections: (x.p.sections || []).filter((s) => textTitles.has(s.title)), variants: size ? x.p.variants : [] };
    const sp = { ...x.sp, properties: [...used, ...key] };
    const refs = bundle.product(p, sp, {});
    allowed.add(x.p.id);
    out.push({
      product: x.p.name, short: nameOf(x.p), slug: x.p.slug, status: x.r.status, label: STATUS_LABEL[x.r.status], reason: x.r.reason,
      supporting: evidenceRefs(x.r.supporting, refs), against: evidenceRefs(x.r.against, refs), conflicting: evidenceRefs(x.r.conflicting, refs),
      missing: x.r.missing, packaging: x.packaging, keyRefs: key.flatMap((k) => k._refs || []),
    });
  }
  bundle.note(`\n${header} (статусы посчитала система по данным Habez — НЕ меняй их, не ранжируй и не называй «лучший»; порядок — каталожный):`);
  for (const s of out) {
    const parts = [`${s.short}: ${s.label.toUpperCase()} — ${s.reason}`];
    if (s.supporting.length) parts.push(`основания: ${s.supporting.map((i) => `${i.text}${brackets(i.refs)}`).join("; ")}`);
    if (s.against.length) parts.push(`против: ${s.against.map((i) => `${i.text}${brackets(i.refs)}`).join("; ")}`);
    if (s.conflicting.length) parts.push(`расхождение: ${s.conflicting.map((i) => `${i.text}${brackets(i.refs)}`).join("; ")}`);
    if (s.missing.length && s.status !== "NOT_SUPPORTED") parts.push(`нет данных: ${s.missing.join("; ")}`);
    if (size) parts.push(s.packaging ? `фасовка ${size}: есть` : `фасовки ${size} в данных нет`);
    bundle.note(`- ${parts.join(" | ")}`);
  }
  return out.map(({ keyRefs, ...rest }) => ({ ...rest, refs: [...new Set([...rest.supporting, ...rest.against, ...rest.conflicting].flatMap((i) => i.refs))] }));
}

export function runIntel({ route, q, ctx, catalog, bundle, calls, allowed }) {
  const useCase = route.useCase ? useCaseById(route.useCase) : null;

  // Паспорт товара.
  if (route.intent === "product_lookup" && route.products.length === 1 && !route.specs.keys.length) {
    const got = fetchProduct(ctx, route.products[0].id, route, calls);
    if (!got) return null;
    const { p, sp } = got;
    // «Что у ГКЛ 12,5 мм?» — паспорт одной фасовки.
    const variant = matchVariant(q, p.variants || []);
    if (variant) { selectProperties(sp, p, { variant }); p.variants = p.variants.filter((v) => v.id === variant.id); }
    const prof = buildProfile(p, sp, { catalog });
    // Толщина одной фасовки видна по самой фасовке — это не пробел.
    if (variant) prof.gaps = prof.gaps.filter((k) => !["thickness", "sheet_size"].includes(k));
    const pp = { ...p, sections: (p.sections || []).filter((s) => !/хранен|транспорт|гарант|безопасн|предосторож|утилиз/i.test(s.title)) };
    const refs = bundle.product(pp, { ...sp, properties: prof.properties }, {});
    allowed.add(p.id);
    const r = (props) => props.map((x) => `${x.label}${brackets(x._refs)}`).join("; ");
    bundle.note("\nПАСПОРТ ТОВАРА (отвечай разделами в этом порядке; не перечисляй все характеристики подряд):");
    bundle.note(`- назначение:${brackets([refs.summary, ...prof.purpose.sections.map((t) => refs.sections.get(t))].filter(Boolean))}`);
    if (prof.keySpecs.length) bundle.note(`- основные свойства: ${r(prof.keySpecs)}`);
    if (prof.conditions.length) bundle.note(`- условия: ${r(prof.conditions)}`);
    if (prof.applicability.yes.length) bundle.note(`- применимость, указано ДА: ${r(prof.applicability.yes)}`);
    if (prof.applicability.no.length) bundle.note(`- применимость, указано НЕТ: ${r(prof.applicability.no)}`);
    if (prof.variants.length) bundle.note(`- фасовки:${brackets(refs.variants)}`);
    if (prof.identifiers.length) bundle.note(`- коды: ${r(prof.identifiers)}`);
    bundle.note(`- известные расхождения: ${prof.conflicts.length ? r(prof.conflicts) : "нет"}`);
    if (prof.gaps.length) bundle.note(`- в данных нет: ${prof.gaps.map(specLabel).join(", ")} — так и сказать, не заполнять`);
    if (prof.compatibility.relations.length) bundle.note(`- карточка называет другие товары: ${prof.compatibility.relations.map((x) => `${x.toName} (раздел «${x.section}»)${brackets([refs.sections.get(x.section)].filter(Boolean))}`).join("; ")}`);
    bundle.note(`- источники: ${prof.sources.map(sourceLabel).join(", ") || "карточка товара"}`);
    return {
      mode: "PRODUCT_PROFILE", products: [{ p, sp, sel: { missing: [], otherConditions: [] } }],
      variant: variant ? { product: p.slug, unit: variant.unit } : null,
      profile: { product: p.name, variant: variant?.unit ?? null, keySpecs: prof.keySpecs.length, yes: prof.applicability.yes.length, no: prof.applicability.no.length,
        conflicts: [...new Set(prof.conflicts.map((x) => x.label))], gaps: prof.gaps.map(specLabel), variants: prof.variants.map((v) => v.unit), mentions: prof.compatibility.relations.map((x) => x.toName) },
    };
  }

  // Подбор под задачу.
  if (route.intent === "application" && useCase) {
    const size = /фасовк|мешк|упаков|канистр|ведр|кг|литр/.test(q.toLowerCase()) ? sizeFromQuestion(q) : null;
    const exclude = route.baseOnly ? [...new Set(route.products.map((p) => p.category).filter(Boolean))] : [];
    const results = selectProducts({ ctx, useCase, typeFilter: typeFromQuestion(q), excludeCategories: exclude, size, calls });
    if (!results.length) return { mode: "NOT_FOUND", fixed: `В каталоге Habez нет товаров того вида, что нужен для задачи «${useCase.label}».`, products: [] };
    const suit = renderSelection({ results, useCase, bundle, allowed, size, header: `ПОДБОР ДЛЯ ЗАДАЧИ «${useCase.label}»` });
    const supported = suit.filter((s) => s.status === "SUPPORTED" && (!size || s.packaging));
    const focus = supported.length ? supported : suit.filter((s) => s.status === "PARTIALLY_SUPPORTED");
    return { mode: "PRODUCT_SELECTION", products: [], suitability: suit, useCase, size, focus: { products: focus.map((s) => s.slug), product: focus[0]?.slug ?? null } };
  }

  // Пригодность названных товаров.
  if (route.intent === "suitability" && useCase) {
    const ids = route.products.map((p) => p.id);
    const results = selectProducts({ ctx, useCase, only: ids, calls });
    if (results.length && results.every((x) => x.r.status === "INSUFFICIENT_DATA")) {
      const x = results[0];
      return { mode: "INSUFFICIENT_DATA", products: results.map((y) => ({ p: y.p, sp: y.sp, sel: { missing: [], otherConditions: [] } })), useCase,
        fixed: `В имеющихся данных Habez недостаточно информации, чтобы подтвердить применение ${results.map((y) => nameOf(y.p)).join(" и ")} для задачи «${useCase.label}». Нужных признаков нет: ${x.r.missing.join("; ")}. Это не значит «не подходит» — данных нет ни за, ни против.`,
        suitability: results.map((y) => ({ product: y.p.name, short: nameOf(y.p), slug: y.p.slug, status: y.r.status, label: STATUS_LABEL[y.r.status], reason: y.r.reason, supporting: [], against: [], conflicting: [], missing: y.r.missing, refs: [] })) };
    }
    const suit = renderSelection({ results, useCase, bundle, allowed, size: null, header: `ПРИГОДНОСТЬ ДЛЯ ЗАДАЧИ «${useCase.label}»` });
    return { mode: "PRODUCT_SELECTION", products: results.map((y) => ({ p: y.p, sp: y.sp, sel: { missing: [], otherConditions: [] } })), suitability: suit, useCase,
      focus: { products: suit.map((s) => s.slug), product: suit.length === 1 ? suit[0].slug : null } };
  }

  // Как применять.
  if (route.intent === "usage" && route.products.length) {
    const got = fetchProduct(ctx, route.products[0].id, route, calls);
    if (!got) return null;
    const { p, sp } = got;
    const app = extractApplication(p, sp);
    const structured = [...new Set(app.items.flatMap((i) => i.structured))];
    const pp = { ...p, sections: (p.sections || []).filter((s) => app.items.some((i) => i.text.some((t) => t.section === s.title))) };
    const refs = bundle.product(pp, { ...sp, properties: structured }, {});
    allowed.add(p.id);
    bundle.note("\nПРИМЕНЕНИЕ ПО ДАННЫМ HABEZ (раздели: что указано в разделе карточки, что — структурированное значение, чего в данных нет; общие строительные знания НЕ добавлять и не выдавать за инструкцию завода; «на мешок» не пересчитывать в «на кг»):");
    for (const it of app.items) {
      const parts = [];
      if (it.structured.length) parts.push(`значение: ${it.structured.map((x) => `${x.label} — ${x.values.map((v) => v.display).join(" / ")}${brackets(x._refs)}`).join("; ")}`);
      for (const t of it.text) parts.push(`в разделе «${t.section}»${brackets([refs.sections.get(t.section)].filter(Boolean))}${t.whole ? "" : `: «${t.text}»`}`);
      bundle.note(`- ${it.label}: ${parts.join(" | ")}`);
    }
    if (app.missing.length) bundle.note(`- в данных нет: ${app.missing.join(", ")}`);
    return { mode: "PRODUCT_APPLICATION", products: [{ p, sp, sel: { missing: [], otherConditions: [] } }], application: { product: p.name, kinds: app.items.map((i) => i.label), missing: app.missing } };
  }

  // Совместимость двух товаров: только прямое упоминание.
  if (route.intent === "compatibility" && route.products.length >= 2) {
    const [a, b] = route.products.slice(0, 2).map((x) => callTool("get_product", { productId: x.id }, ctx));
    calls.push({ name: "get_product", source: "plan", ms: 0, found: a ? 1 : 0 }, { name: "get_product", source: "plan", ms: 0, found: b ? 1 : 0 });
    if (!a || !b) return null;
    const c = compatibilityBetween(a, b, catalog);
    if (c.status === "UNKNOWN") {
      return { mode: "INSUFFICIENT_DATA", products: [{ p: a, sp: null }, { p: b, sp: null }],
        fixed: `В данных Habez нет сведений о совместимости ${nameOf(a)} и ${nameOf(b)}: ни одна карточка не упоминает другой товар. Это не значит «несовместимы» — такой информации просто нет.`,
        compatibility: { status: "UNKNOWN" } };
    }
    for (const x of [a, b]) {
      const titles = new Set(c.relations.filter((r) => r.from === x.slug).map((r) => r.section));
      bundle.product({ ...x, sections: (x.sections || []).filter((s) => titles.has(s.title)), variants: [] }, null, {});
      allowed.add(x.id);
    }
    bundle.note(`\nСОВМЕСТИМОСТЬ: указано в карточке (только это, без обобщений): ${c.relations.map((r) => `${r.from === a.slug ? nameOf(a) : nameOf(b)} → «${r.text}»`).join("; ")}`);
    return { mode: "FACT", products: [{ p: a, sp: null }, { p: b, sp: null }], compatibility: { status: "STATED", relations: c.relations.map((r) => ({ from: r.from, to: r.to, section: r.section })) } };
  }
  return null;
}

// Пригодность для сравнения по задаче (Comparison 2.0): статусы по каждому
// товару сравнения; рисуются после таблицы.
export function comparisonSuitability({ products, useCase, ctx, bundle, calls }) {
  const out = [];
  for (const x of products) {
    const t0 = Date.now();
    const full = callTool("get_product_specs", { productId: x.p.id }, ctx);
    calls.push({ name: "get_product_specs", source: "plan", ms: Date.now() - t0, found: full?.properties.length ?? 0 });
    const prod = callTool("get_product", { productId: x.p.id }, ctx);
    const r = evaluateSuitability({ product: prod, sp: full, useCase });
    const shown = new Map((x.sp.properties || []).map((pr) => [`${pr.key}|${pr.conditionKey}`, pr]));
    const refsOf = (items) => items.map((i) => (i.kind === "prop" ? { text: i.text, refs: shown.get(`${i.prop.key}|${i.prop.conditionKey}`)?._refs || [] } : { text: `${i.label || "описание"}: «${i.text}»`, refs: [] }));
    out.push({ product: x.p.name, short: nameOf(x.p), slug: x.p.slug, status: r.status, label: STATUS_LABEL[r.status], reason: r.reason,
      supporting: refsOf(r.supporting), against: refsOf(r.against), conflicting: refsOf(r.conflicting), missing: r.missing });
  }
  bundle.note(`\nПРИГОДНОСТЬ ДЛЯ ЗАДАЧИ «${useCase.label}» (посчитано системой; победителя нет — «окончательный выбор зависит от…», и назови, от чего: условия, основание, фасовка, открытые вопросы):`);
  for (const s of out) bundle.note(`- ${s.short}: ${s.label.toUpperCase()} — ${s.reason}${s.supporting.length ? ` | основания: ${s.supporting.map((i) => `${i.text}${brackets(i.refs)}`).join("; ")}` : ""}${s.against.length ? ` | против: ${s.against.map((i) => `${i.text}${brackets(i.refs)}`).join("; ")}` : ""}`);
  return out.map((s) => ({ ...s, refs: [...new Set([...s.supporting, ...s.against, ...s.conflicting].flatMap((i) => i.refs))] }));
}
