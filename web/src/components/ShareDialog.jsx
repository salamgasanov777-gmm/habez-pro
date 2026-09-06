import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import Modal from "./Modal.jsx";
import { useApp } from "../store.jsx";
import { PUBLIC_URL, PUBLIC_URL_SHORT } from "../lib/site.js";

// Код всегда чёрный на белом, независимо от темы приложения. Инверсию читают
// не все камеры, а этот код показывают с экрана на экран — надёжность здесь
// важнее единства оформления.
function QrCode({ text, size = 236 }) {
  const { count, dark } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const cells = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push([c, r]);
    }
    return { count: n, dark: cells };
  }, [text]);

  // Тихая зона по стандарту — четыре модуля. Без неё камера не находит
  // границы кода, если рядом оказался текст или рамка.
  const quiet = 4;
  const side = count + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR-код на каталог продукции"
    >
      <rect width={side} height={side} fill="#ffffff" />
      <g fill="#000000">
        {dark.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width="1" height="1" />
        ))}
      </g>
    </svg>
  );
}

export default function ShareDialog({ onClose }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(PUBLIC_URL);
      setCopied(true);
      toast("Ссылка скопирована");
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Буфер обмена закрыт браузером — адрес есть на экране, его видно.
      toast("Скопировать не вышло — адрес на экране", "err");
    }
  };

  return (
    <Modal title="Показать клиенту" onClose={onClose}>
      <div className="share">
        <div className="share-code">
          <QrCode text={PUBLIC_URL} />
        </div>

        <p className="share-lead">
          Клиент наводит камеру телефона — и каталог открывается у него.
          Как сохранить его иконкой, приложение подскажет ему само.
        </p>

        <div className="share-url">
          <span className="num">{PUBLIC_URL_SHORT}</span>
          <button className="btn btn-sm" onClick={copy}>
            {copied ? "Скопировано" : "Скопировать"}
          </button>
        </div>

      </div>
    </Modal>
  );
}
