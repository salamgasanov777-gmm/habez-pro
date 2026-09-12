import { useEffect, useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import { money, num, mediaUrl } from "../lib/format.js";
import ProductCard from "../components/ProductCard.jsx";
import LeadDialog from "../components/LeadDialog.jsx";
import { Star, Doc } from "../components/Icons.jsx";

// Расчёт расхода — то, ради чего каталогом пользуются прорабы. Считает сервер:
// одна формула на сайт, приложение и будущего бота.
function Calculator({ product }) {
  const [area, setArea] = useState("");
  const [mm, setMm] = useState("10");
  const [res, setRes] = useState(null);
  const thickness = product.calc.type === "thickness";

  useEffect(() => {
    const a = parseFloat(String(area).replace(",", "."));
    const t = parseFloat(String(mm).replace(",", "."));
    if (!a || a <= 0 || (thickness && (!t || t <= 0))) { setRes(null); return; }
    const timer = setTimeout(() => {
      api.post("/api/catalog/calc", { productId: product.id, area: a, thicknessMm: thickness ? t : undefined })
        .then(setRes).catch(() => setRes(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [area, mm, product.id, thickness]);

  return (
    <section className="calc">
      <h3>Сколько нужно материала</h3>
      <div className="calc-grid">
        <label className="field"><span>Площадь, м²</span>
          <input className="input" inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} placeholder="например, 24" /></label>
        {thickness && (
          <label className="field"><span>Толщина слоя, мм</span>
            <input className="input" inputMode="decimal" value={mm} onChange={(e) => setMm(e.target.value)} /></label>
        )}
      </div>
      <div className="calc-out">
        {res ? (
          <>Понадобится <b>{num(res.amount)} {res.unit}</b> — это {res.packs} уп. по {num(res.packSize)} {res.unit}</>
        ) : (
          <span className="muted">Введите площадь — посчитаем количество упаковок</span>
        )}
      </div>
      <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
        Расчёт ориентировочный: расход зависит от основания и способа нанесения.
      </p>
    </section>
  );
}

export default function Product(props) {
  const params = useParams();
  // Шторка передаёт товар пропом, страница берёт его из адреса.
  const slug = props.slug || params.slug;
  // Внутри шторки любая ссылка наружу заменяет её в истории: закрыл шторку
  // переходом в раздел — жест «назад» ведёт в каталог, а не к шторке.
  const inSheet = !!useLocation().state?.sheet;
  const { addToCart, isFavorite, toggleFavorite, meta } = useApp();
  const [data, setData] = useState(null);
  const [variantId, setVariantId] = useState(null);
  const [qty, setQty] = useState(1);
  const [lead, setLead] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null); setError(false);
    api.get(`/api/catalog/products/${slug}`)
      .then((d) => { setData(d); setVariantId(d.product.variants[0]?.id ?? null); setQty(1); })
      .catch(() => setError(true));
  }, [slug]);

  if (error) return <div className="empty"><h3>Товар не найден</h3><Link to="/" replace={inSheet} className="btn">В каталог</Link></div>;
  if (!data) return <div className="page"><div className="skeleton" style={{ height: 420, marginTop: 24 }} /></div>;

  const p = data.product;
  const variant = p.variants.find((v) => v.id === variantId) || p.variants[0];
  const fav = isFavorite(p.id);
  const showPrices = meta?.settings?.showPrices !== false;

  // Разметка для поисковиков: карточка попадает в выдачу с ценой и наличием.
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Product",
    name: p.name, description: p.summary, sku: variant?.sku,
    brand: { "@type": "Brand", name: meta?.tenant?.name },
    ...(variant && !variant.priceOnRequest ? {
      offers: {
        "@type": "Offer", price: (variant.price / 100).toFixed(2), priceCurrency: "RUB",
        availability: p.inStock ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
      },
    } : {}),
  };

  return (
    <main className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <nav className="crumbs">
        <Link to="/" replace={inSheet}>Каталог</Link><span>/</span>
        <Link to={`/?category=${p.categorySlug}`} replace={inSheet}>{p.category}</Link><span>/</span>
        <span className="dim">{p.shortName || p.name}</span>
      </nav>

      <div className="product">
        <div className="product-head">
          <div className="gallery">
            {p.photo && (
              <picture>
                {p.photoWebp && <source srcSet={mediaUrl(p.photoWebp)} type="image/webp" />}
                <img src={mediaUrl(p.photo)} alt={p.name} width="1000" height="520" />
              </picture>
            )}
          </div>

          <h1 style={{ marginTop: 20 }}>{p.name}</h1>
          {p.gost && <p className="label" style={{ marginTop: 8 }}>{p.gost}</p>}
          {p.summary && <p className="muted" style={{ marginTop: 12, fontSize: 15.5, lineHeight: 1.6 }}>{p.summary}</p>}

        </div>

        {p.calc && <Calculator product={p} />}

        <aside className="buybox">
          <div className="spread">
            {showPrices && variant && !variant.priceOnRequest
              ? <div className="price-main">{money(variant.price)}</div>
              : <div className="price-request">Цена по запросу</div>}
            <button className={`icon-btn ${fav ? "active" : ""}`} onClick={() => toggleFavorite(p.id)} aria-label="В избранное">
              <Star filled={fav} />
            </button>
          </div>

          {variant?.priceBreaks?.length > 0 && (
            <p className="hint" style={{ margin: 0 }}>
              От {variant.priceBreaks[0].minQty} шт — {money(variant.priceBreaks[0].amount)} за {variant.unit.replace(/\s*\d.*/, "")}
            </p>
          )}

          {p.variants.length > 1 && (
            <div className="variant-list">
              <span className="label">Фасовка</span>
              {p.variants.map((v) => (
                <button key={v.id} className={`variant ${v.id === variantId ? "on" : ""}`} onClick={() => setVariantId(v.id)}>
                  <span>{v.unit}</span>
                  <span className="num">{v.priceOnRequest ? "по запросу" : money(v.price)}</span>
                </button>
              ))}
            </div>
          )}

          {variant && (
            <>
              <div className="row">
                <div className="qty">
                  <button onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Меньше">−</button>
                  <input value={qty} onChange={(e) => setQty(Math.max(1, Math.min(999, Number(e.target.value.replace(/\D/g, "")) || 1)))} inputMode="numeric" aria-label="Количество" />
                  <button onClick={() => setQty((q) => Math.min(999, q + 1))} aria-label="Больше">+</button>
                </div>
                <span className="muted" style={{ fontSize: 13 }}>{variant.unit}</span>
                {!variant.priceOnRequest && (
                  <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>{money(variant.price * qty)}</span>
                )}
              </div>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => addToCart(variant.id, qty)}>
                {variant.priceOnRequest ? "Добавить в список" : "Добавить в корзину"}
              </button>
              {variant.perPallet && !variant.priceOnRequest && (
                <p className="hint" style={{ margin: 0 }}>На паллете {variant.perPallet} шт — {money(variant.price * variant.perPallet)}</p>
              )}
              {variant.perPallet && variant.priceOnRequest && (
                <p className="hint" style={{ margin: 0 }}>На паллете {variant.perPallet} шт</p>
              )}
            </>
          )}

          <button className="btn btn-block" onClick={() => setLead(true)}>
            {variant?.priceOnRequest ? "Запросить цену" : "Задать вопрос менеджеру"}
          </button>

          <div className="notice">
            {variant?.stock ? <><b>В наличии на складе</b> — {variant.stock} шт.</> : <>Отгрузка со склада завода, самовывоз и доставка по КЧР и краю.</>}
          </div>
        </aside>

        <div className="doc">
          {p.badges.length > 0 && (
            <div className="badges">
              {p.badges.map((b, i) => (
                <div className="badge-cell" key={i}><b>{b.value}</b><span>{b.label}</span></div>
              ))}
            </div>
          )}

            {p.sections.map((s, i) => (
              <section key={i}>
                <h3>{s.title}</h3>
                {String(s.text).split("\n").filter(Boolean).map((para, j) => <p key={j} style={{ marginTop: j ? 10 : 0 }}>{para}</p>)}
              </section>
            ))}

            {p.tables.map((t, i) => (
              <section key={i}>
                <h3>{t.title}</h3>
                <div className="spec">
                  {t.rows.map(([label, value], j) => (
                    <div className="spec-row" key={j}><div>{label}</div><div>{value}</div></div>
                  ))}
                </div>
              </section>
            ))}

            {p.docs?.length > 0 && (
              <section>
                <h3>Документы</h3>
                <div className="stack" style={{ gap: 8 }}>
                  {p.docs.map((d, i) => (
                    <a key={i} href={mediaUrl(d.url)} target="_blank" rel="noopener" className="row" style={{ color: "var(--accent)" }}>
                      <Doc width={17} height={17} /> {d.title}
                    </a>
                  ))}
                </div>
              </section>
          )}
        </div>

      </div>

      {data.related.length > 0 && (
        <section style={{ paddingBottom: 40 }}>
          <h2 style={{ marginBottom: 14 }}>Из этого же раздела</h2>
          <div className="grid">{data.related.map((r) => <ProductCard key={r.id} product={r} />)}</div>
        </section>
      )}

      {lead && <LeadDialog kind="quote" productId={p.id} onClose={() => setLead(false)} />}
    </main>
  );
}
