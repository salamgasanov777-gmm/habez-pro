import { Link, useLocation } from "react-router-dom";

// Ссылка на товар. Помечает переход так, чтобы на телефоне карточка вышла
// шторкой поверх каталога, а не увела человека на отдельную страницу.
//
// Адрес при этом настоящий: ссылку можно переслать в WhatsApp, и у получателя
// она откроется обычной страницей — метка живёт только внутри приложения.
export default function ProductLink({ slug, children, ...rest }) {
  const location = useLocation();
  // Если карточку открывают из уже открытой шторки, за спиной остаётся всё тот
  // же каталог. Иначе метка вложилась бы сама в себя и росла без предела.
  const background = location.state?.background || location;
  return (
    <Link to={`/p/${slug}`} state={{ background }} {...rest}>
      {children}
    </Link>
  );
}
