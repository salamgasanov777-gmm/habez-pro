// Habez AI (Phase 4.1): обработчик Factory Intelligence (3.4) для реестра —
// заводы, ассортимент, документы (правилами, до модели), завод в паспорте
// товара (3.3) и сводка для заглушки модели. Проверка ответа — check.js
// (factoryAnswerCheck, реестр checks/registry.js).
import { callTool } from "../tools/index.js";
import { FACTORY_INTENTS } from "../retrieval/router.js";
import { runFactory, renderProductFactory } from "./run.js";

export const factoryStage = {
  id: "factory",
  when: (t) => !t.mode && FACTORY_INTENTS.has(t.route.intent),
  run(t) {
    t.factory = runFactory({ route: t.route, q: t.q, ctx: t.ctx, bundle: t.bundle, calls: t.calls, allowed: t.allowed, state: t.state });
    t.mode = t.factory.mode; if (t.factory.fixed) t.fixed = t.factory.fixed;
  },
};

// Паспорт товара (3.3) + производитель и заводские документы (3.4) —
// только то, что есть в данных.
export const productFactoryStage = {
  id: "profile-factory",
  when: (t) => t.intel?.mode === "PRODUCT_PROFILE" && t.intel.products[0]?.p,
  run(t) {
    const { intel, ctx, calls, bundle, allowed, scope } = t;
    const t1 = Date.now();
    const pid = intel.products[0].p.id;
    const res = callTool("get_factory_documents", { productIds: [pid] }, ctx);
    calls.push({ name: "get_factory_documents", source: "plan", ms: Date.now() - t1, found: res.documents.length });
    bundle.note("\nПРОИЗВОДИТЕЛЬ / ЗАВОД (в паспорте — коротко, отдельным разделом; статус связи посчитала система):");
    t.profileFactory = renderProductFactory({ items: res.products, docs: res.documents, bundle, allowed, scope })[0] || null;
    if (intel.profile && t.profileFactory) intel.profile.factory = { status: t.profileFactory.status, label: t.profileFactory.label, factory: t.profileFactory.catalog.factory, documents: t.profileFactory.documents };
  },
};

// Вывод домена (handlers.js → OUTPUTS): завод, связи товар → завод,
// документы — в meta и ответ API; время этапов; ссылки таблиц (на них
// можно нажать); завод — в состояние беседы («этот завод»).
const productFactoryOf = (t) => t.factory?.productFactory || (t.profileFactory ? [t.profileFactory] : null);
export const factoryOutput = {
  id: "factory",
  meta: (t) => ({ factory: t.factory?.factory || null, productFactory: productFactoryOf(t), documents: t.factory?.documents || null }),
  result: (t) => ({ factory: t.factory?.factory || null, productFactory: productFactoryOf(t), documents: t.factory?.documents || null, factoryId: t.factory?.factoryId ?? null }),
  metrics: (t) => ({ factory_ms: t.factory?.timings?.factoryMs ?? 0, documents_ms: t.factory?.timings?.documentsMs ?? 0, graph_ms: t.factory?.timings?.graphMs ?? 0 }),
  refs: (t) => {
    const { factory } = t;
    return [...(factory?.productFactory || []).flatMap((x) => x.refs || []), ...(factory?.documents || []).flatMap((d) => d.refs || []).slice(0, 40),
      ...(factory?.factory?.items || []).flatMap((x) => x.refs || []).slice(0, 40), ...Object.values(factory?.factory?.refs || {}).flat()];
  },
  state: (t) => {
    const factoryId = t.factory?.factoryId ?? (t.profileFactory ? t.profileFactory.mainFactoryId : undefined);
    return { factoryId: factoryId === null ? undefined : factoryId };
  },
};

// Сводка для заглушки модели (тесты без сети): те же сведения, что в пакете,
// строками со ссылками.
export const factoryDigest = {
  id: "factory",
  lines(t) {
    const { factory, profileFactory } = t;
    const out = [];
    const b = (refs) => (refs?.length ? ` ${refs.map((r) => `[${r}]`).join("")}` : "");
    const f = factory?.factory;
    if (f?.refs) {
      out.push(`Завод: ${f.name}${b([f.refs.name])}`);
      if (f.location) out.push(`${f.location.label}: ${f.location.text}${b([f.refs.location])}`);
      for (const [i, g] of (f.groups || []).entries()) if (f.refs.groups?.[i]) out.push(`Раздел «${g.name}»: ${g.count} товаров${b([f.refs.groups[i]])}`);
    }
    for (const x of f?.items || []) out.push(`${x.short}: производство — ${x.label}${b(x.refs)}`);
    for (const x of [...(factory?.productFactory || []), ...(profileFactory ? [profileFactory] : [])]) out.push(`${x.short}: ${x.relations.map((r) => `${r.factory} — ${r.label}`).join("; ")}${b(x.refs)}`);
    for (const d of factory?.documents || []) out.push(`Документ: ${d.typeLabel} «${d.title}»${d.date ? `, дата ${d.date}` : ", дата не указана"}${b(d.refs.slice(0, 4))}`);
    return out;
  },
};
