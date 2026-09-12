import { useEffect, useState } from "react";
import * as api from "../lib/api.js";

// Уведомления о заказах на это устройство. Включается один раз —
// дальше каждый заказ и заявка приходят на телефон как обычное
// уведомление, даже когда приложение закрыто.

const toBytes = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

// На айфоне push работает только у каталога, установленного иконкой,
// и только в Safari 16.4+. Из обычной вкладки — нет, так решила Apple.
function why() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (ios && !installed) return "На айфоне уведомления работают, только если каталог установлен иконкой на экран «Домой». Установите — и кнопка появится.";
    return "Этот браузер не умеет показывать уведомления.";
  }
  if (Notification.permission === "denied") return "Уведомления запрещены в настройках браузера для этого сайта. Разрешите их там — и включите здесь.";
  return null;
}

export default function PushCard() {
  const [state, setState] = useState("checking"); // checking | off | on | busy
  const [devices, setDevices] = useState(0);
  const [note, setNote] = useState("");
  const blocked = why();

  const refresh = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
      const d = await api.get("/api/push/devices");
      setDevices(d.devices);
    } catch {
      setState("off");
    }
  };

  useEffect(() => { if (!blocked) refresh(); else setState("off"); }, []); // eslint-disable-line

  const enable = async () => {
    setState("busy"); setNote("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setNote("Вы не разрешили уведомления."); setState("off"); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.get("/api/push/key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
      await api.post("/api/push/subscribe", sub.toJSON());
      setNote("Включено. Нажмите «Проверить», чтобы получить пробное уведомление.");
      await refresh();
    } catch (e) {
      setNote("Не получилось включить: " + (e.message || "неизвестная ошибка"));
      setState("off");
    }
  };

  const disable = async () => {
    setState("busy"); setNote("");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.del("/api/push/subscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setNote("Выключено на этом устройстве.");
    } finally {
      await refresh();
    }
  };

  const test = async () => {
    setNote("");
    const r = await api.post("/api/push/test", {});
    setNote(r.sent > 0 ? "Отправлено — посмотрите на экран телефона." : "Ни одно устройство не приняло сообщение.");
  };

  return (
    <section className="panel">
      <div className="spread">
        <h3>Уведомления о заказах</h3>
        {state === "on" && <span className="tag stock" style={{ position: "static" }}>включены</span>}
      </div>
      <p className="dim" style={{ fontSize: 13.5, margin: "6px 0 12px" }}>
        Новый заказ или заявка придут на этот телефон уведомлением — даже когда приложение закрыто.
        {devices > 0 && <> Сейчас подписано устройств: <b>{devices}</b>.</>}
      </p>

      {blocked ? (
        <p className="notice" style={{ margin: 0 }}>{blocked}</p>
      ) : (
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {state === "on"
            ? <>
                <button className="btn btn-sm" onClick={test}>Проверить</button>
                <button className="btn btn-sm btn-ghost" onClick={disable}>Выключить здесь</button>
              </>
            : <button className="btn btn-sm btn-dark" onClick={enable} disabled={state !== "off"}>
                {state === "checking" ? "Проверяю…" : state === "busy" ? "Включаю…" : "Включить на этом устройстве"}
              </button>}
        </div>
      )}
      {note && <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>{note}</p>}
    </section>
  );
}
