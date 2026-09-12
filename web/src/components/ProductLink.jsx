import { Link, useLocation, useNavigate } from "react-router-dom";

// Ссылка на товар.
//
// На телефоне карточка выходит шторкой, и адрес страницы при этом НЕ
// меняется: шторка живёт в состоянии записи истории, как в приложении №1.
// Так системный жест «назад» от края экрана показывает тот же самый экран
// (каталог) и просто закрывает шторку — без мелькания чужих страниц.
//
// На широком экране это обычная ссылка на страницу товара. И в любом
// случае href настоящий: долгое нажатие даёт ссылку, которую можно переслать.
const narrow = () => matchMedia("(max-width: 760px)").matches;

export default function ProductLink({ slug, children, onClick, ...rest }) {
  const location = useLocation();
  const nav = useNavigate();
  const inSheet = !!location.state?.sheet;

  const open = (e) => {
    onClick?.(e);
    if (e.defaultPrevented || !narrow() || e.metaKey || e.ctrlKey || e.button === 1) return;
    e.preventDefault();
    // Из открытой шторки — подменяем её, а не кладём вторую сверху:
    // «назад» должен вести в каталог, а не к предыдущему товару.
    nav(location.pathname + location.search, { state: { sheet: slug }, replace: inSheet });
  };

  return (
    <Link to={`/p/${slug}`} onClick={open} {...rest}>
      {children}
    </Link>
  );
}
