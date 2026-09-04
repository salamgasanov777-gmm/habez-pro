import { useEffect } from "react";
import { Close } from "./Icons.jsx";

// Модальное окно: Esc закрывает, фон не прокручивается, на телефоне окно
// выезжает снизу — привычная для мобильных шторка вместо окна по центру.
export default function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: "min(860px, calc(100vw - 32px))" } : undefined}>
        <div className="spread" style={{ marginBottom: 16 }}>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><Close /></button>
        </div>
        {children}
      </div>
    </>
  );
}
