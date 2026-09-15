import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../lib/api.js";

// Юридический документ завода (оферта, доставка, возврат). Текст вставляет
// владелец в панели; страница только показывает его абзацами. Пока текста
// нет — честное «документ готовится», а не выдуманные условия.
export default function LegalDoc() {
  const { kind } = useParams();
  const [doc, setDoc] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setDoc(null); setMissing(false);
    api.get(`/api/catalog/legal/${encodeURIComponent(kind)}`).then(setDoc).catch(() => setMissing(true));
  }, [kind]);

  if (missing) return <div className="empty"><h3>Документ готовится</h3><p>Текст ещё не опубликован. По вопросам — в отдел продаж.</p><Link to="/" className="btn">В каталог</Link></div>;
  if (!doc) return <div className="page"><div className="skeleton" style={{ height: 320, marginTop: 24 }} /></div>;

  return (
    <main className="page prose" style={{ maxWidth: 760, padding: "28px 20px 60px" }}>
      <h1>{doc.title}</h1>
      {doc.updatedAt && <p className="muted">Редакция от {new Date(doc.updatedAt).toLocaleDateString("ru-RU")}</p>}
      {doc.text.split(/\n{2,}/).map((para, i) => <p key={i} style={{ whiteSpace: "pre-line" }}>{para}</p>)}
      <p style={{ marginTop: 28 }}><Link to="/" className="btn">В каталог</Link></p>
    </main>
  );
}
