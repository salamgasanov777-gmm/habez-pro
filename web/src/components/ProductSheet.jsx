import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Product from "../pages/Product.jsx";
import { Close } from "./Icons.jsx";

// Карточка товара шторкой. Закрывается смахиванием вниз, нажатием на фон,
// крестиком и клавишей Esc — чтобы не приходилось лезть в нижнюю панель.
//
// Тянем не перерисовкой, а прямой записью в стиль: в карточке много всего,
// и перерисовывать её на каждое движение пальца — заведомо рвано.
export default function ProductSheet({ slug }) {
  const nav = useNavigate();
  const sheet = useRef(null);
  const backdrop = useRef(null);
  const scroller = useRef(null);
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = sheet.current;
    if (el) {
      el.style.transition = "transform .22s cubic-bezier(.4,0,1,1)";
      el.style.transform = "translateY(100%)";
      if (backdrop.current) {
        backdrop.current.style.transition = "opacity .22s";
        backdrop.current.style.opacity = "0";
      }
      setTimeout(() => nav(-1), 200);
    } else {
      nav(-1);
    }
  }, [nav]);

  // Esc и запрет прокрутки страницы под шторкой.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [close]);

  // Смахивание. Слушателей вешаем руками, а не через React: движению пальца
  // нужно уметь отменять прокрутку, а React вешает touchmove «пассивно»,
  // где отменить уже нельзя.
  useEffect(() => {
    const el = sheet.current;
    const sc = scroller.current;
    if (!el || !sc) return;

    let startY = null;
    let dragging = false;
    let shift = 0;
    let lastY = 0;
    let lastAt = 0;
    let speed = 0;

    const paint = (y) => {
      el.style.transform = y ? `translateY(${y}px)` : "";
      if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0, 1 - y / 420));
    };

    const onStart = (e) => {
      if (closing.current || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      lastY = startY;
      lastAt = e.timeStamp;
      speed = 0;
      shift = 0;
      // Тянуть шторку можно за верхнюю полоску всегда, а за содержимое —
      // только когда оно прокручено в самое начало. Иначе смахивание
      // перебивало бы обычное чтение карточки.
      dragging = el.dataset.grip === "1" || sc.scrollTop <= 0;
      el.style.transition = "";
    };

    const onMove = (e) => {
      if (!dragging || startY === null) return;
      const y = e.touches[0].clientY;
      const d = y - startY;
      if (d <= 0) { shift = 0; paint(0); return; }
      e.preventDefault();
      if (e.timeStamp > lastAt) speed = (y - lastY) / (e.timeStamp - lastAt);
      lastY = y;
      lastAt = e.timeStamp;
      shift = d;
      paint(d);
    };

    const onEnd = () => {
      el.dataset.grip = "0";
      if (!dragging) return;
      dragging = false;
      startY = null;
      // Либо утянули заметно вниз, либо смахнули резко — закрываем.
      if (shift > Math.min(150, el.offsetHeight * 0.22) || speed > 0.6) {
        close();
      } else {
        el.style.transition = "transform .2s cubic-bezier(.2,.8,.3,1)";
        paint(0);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [close]);

  return (
    <>
      <div className="sheet-backdrop" ref={backdrop} onClick={close} />
      <div className="sheet" ref={sheet} role="dialog" aria-modal="true" aria-label="Карточка товара">
        <div
          className="sheet-grip"
          onTouchStart={() => { if (sheet.current) sheet.current.dataset.grip = "1"; }}
          aria-hidden="true"
        >
          <i />
        </div>
        <button className="icon-btn sheet-close" onClick={close} aria-label="Закрыть карточку">
          <Close />
        </button>
        <div className="sheet-scroll" ref={scroller}>
          <Product slug={slug} />
        </div>
      </div>
    </>
  );
}
