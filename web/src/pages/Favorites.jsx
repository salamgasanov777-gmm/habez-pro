import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../store.jsx";
import * as api from "../lib/api.js";
import ProductCard from "../components/ProductCard.jsx";

export default function Favorites() {
  const { favorites } = useApp();
  const [items, setItems] = useState(null);

  // Избранное хранится списком id, поэтому карточки добираем одним запросом
  // и фильтруем на клиенте — отдельный маршрут ради этого не нужен.
  useEffect(() => {
    api.get("/api/catalog/products?limit=100")
      .then((d) => setItems(d.items.filter((p) => favorites.has(p.id))))
      .catch(() => setItems([]));
  }, [favorites]);

  if (items && !items.length) {
    return (
      <div className="empty">
        <h3>В избранном пусто</h3>
        <p>Нажмите звёздочку на карточке товара — он появится здесь и сохранится в вашем аккаунте.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 14 }}>В каталог</Link>
      </div>
    );
  }

  return (
    <main className="page" style={{ padding: "24px 20px 60px" }}>
      <h1 style={{ marginBottom: 18 }}>Избранное</h1>
      <div className="grid">
        {(items || []).map((p) => <ProductCard key={p.id} product={p} />)}
      </div>
    </main>
  );
}
