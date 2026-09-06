import { useEffect, useState } from "react";
import { store } from "../lib/storage.js";
import { Close, Box } from "./Icons.jsx";

const HIDDEN_KEY = "install-hint-hidden";

// Каталог уже стоит иконкой — предлагать установку второй раз незачем.
function alreadyInstalled() {
  try {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch {
    return false;
  }
}

// На айфоне системной кнопки установки не существует: Apple её не даёт.
// Там остаётся объяснить путь руками, поэтому айфон определяем отдельно.
function isIPhone() {
  const ua = navigator.userAgent || "";
  const ipad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iphone|ipod|ipad/i.test(ua) || ipad;
}

export default function InstallHint() {
  // Событие от браузера: «это приложение можно установить». Приходит на
  // Андроиде и в настольном Chrome. Его нужно поймать и придержать —
  // показать окно установки можно только в ответ на нажатие человека.
  const [prompt, setPrompt] = useState(null);
  const [steps, setSteps] = useState(false);
  const [hidden, setHidden] = useState(() => store.get(HIDDEN_KEY, false) || alreadyInstalled());

  useEffect(() => {
    if (hidden) return;
    const onPrompt = (e) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => { setHidden(true); store.set(HIDDEN_KEY, true); };
    addEventListener("beforeinstallprompt", onPrompt);
    addEventListener("appinstalled", onInstalled);
    return () => {
      removeEventListener("beforeinstallprompt", onPrompt);
      removeEventListener("appinstalled", onInstalled);
    };
  }, [hidden]);

  const iphone = isIPhone();
  // Показываем только когда есть что предложить: либо браузер сам сказал,
  // что установка возможна, либо это айфон, где кнопки не будет никогда.
  if (hidden || (!prompt && !iphone)) return null;

  const close = () => { setHidden(true); store.set(HIDDEN_KEY, true); };

  const install = async () => {
    if (!prompt) { setSteps(true); return; }
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    setPrompt(null);
    if (outcome === "accepted") close();
  };

  return (
    <>
      <div className="install-hint" role="complementary">
        <span className="install-icon" aria-hidden="true"><Box width={19} height={19} /></span>
        <div className="install-text">
          <b>Сохраните каталог на телефон</b>
          <span>Откроется с иконки, как обычное приложение — и без интернета</span>
        </div>
        <button className="btn btn-sm btn-dark" onClick={install}>
          {prompt ? "Установить" : "Как сохранить"}
        </button>
        <button className="icon-btn install-close" onClick={close} aria-label="Скрыть подсказку">
          <Close width={17} height={17} />
        </button>
      </div>

      {steps && (
        <>
          <div className="backdrop" onClick={() => setSteps(false)} />
          <div className="modal" role="dialog" aria-modal="true" aria-label="Как сохранить каталог">
            <div className="spread" style={{ marginBottom: 16 }}>
              <h2>Как сохранить каталог</h2>
              <button className="icon-btn" onClick={() => setSteps(false)} aria-label="Закрыть"><Close /></button>
            </div>
            <ol className="install-steps">
              <li>Нажмите <b>«Поделиться»</b> — квадрат со стрелкой вверх, внизу экрана.</li>
              <li>Пролистайте список вниз до пункта <b>«На экран „Домой“»</b>.</li>
              <li>Нажмите <b>«Добавить»</b> в правом верхнем углу.</li>
            </ol>
            <p className="dim" style={{ fontSize: 13.5, marginTop: 14 }}>
              Каталог появится иконкой рядом с остальными приложениями.
              Открывается с неё — и работает даже там, где нет связи.
            </p>
            <button className="btn btn-block" style={{ marginTop: 18 }} onClick={() => { setSteps(false); close(); }}>
              Понятно
            </button>
          </div>
        </>
      )}
    </>
  );
}
