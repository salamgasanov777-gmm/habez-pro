import { Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import { money, mediaUrl } from "../lib/format.js";
import { Star } from "./Icons.jsx";

export default function ProductCard({ product, onCompare, comparing }) {
  const { isFavorite, toggleFavorite, addToCart, meta } = useApp();
  const fav = isFavorite(product.id);
  const variant = product.variants.find((v) => v.isDefault) || product.variants[0];
  const showPrices = meta?.settings?.showPrices !== false;

  return (
    <article className="card">
      <button
        className={`fav ${fav ? "on" : ""}`}
        onClick={(e) => { e.preventDefault(); toggleFavorite(product.id); }}
        aria-label={fav ? "Убрать из избранного" : "В избранное"}
      >
        <Star filled={fav} width={16} height={16} />
      </button>

      {variant?.stock !== null && variant?.stock !== undefined && (
        <span className={`tag ${product.inStock ? "stock" : "out"}`}>
          {product.inStock ? "в наличии" : "под заказ"}
        </span>
      )}

      <Link to={`/p/${product.slug}`} className="card-photo">
        {product.photo && (
          <picture>
            {product.photoWebp && <source srcSet={mediaUrl(product.photoWebp)} type="image/webp" />}
            {/* loading=lazy + размеры: страница не «прыгает» при подгрузке фото */}
            <img src={mediaUrl(product.photo)} alt={product.name} loading="lazy" decoding="async" width="320" height="240" />
          </picture>
        )}
      </Link>

      <div className="card-body">
        <div className="card-cat">{product.category}</div>
        <Link to={`/p/${product.slug}`} className="card-name">{product.name}</Link>

        <div className="card-foot">
          {showPrices && variant && !variant.priceOnRequest ? (
            <div className="card-price">
              {money(variant.price)}
              <small>{variant.unit}</small>
            </div>
          ) : (
            /* Каталог без опубликованных цен остаётся рабочим: покупатель
               собирает список, менеджер считает его и отвечает ценой. */
            <div className="card-price request">
              Цена по запросу
              <small style={{ color: "var(--ink-3)" }}>{variant?.unit}</small>
            </div>
          )}

          {variant && (
            <button className="btn btn-primary btn-sm" onClick={() => addToCart(variant.id, 1)}>
              {variant.priceOnRequest ? "В список" : "В корзину"}
            </button>
          )}
        </div>

        {onCompare && (
          <button className={`btn btn-ghost btn-sm ${comparing ? "" : ""}`} style={{ justifyContent: "flex-start", padding: "4px 0", color: comparing ? "var(--accent)" : "var(--ink-3)" }}
            onClick={() => onCompare(product.id)}>
            {comparing ? "✓ В сравнении" : "Сравнить"}
          </button>
        )}
      </div>
    </article>
  );
}
