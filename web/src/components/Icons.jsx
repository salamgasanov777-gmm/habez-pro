// Иконки инлайном: 12 штук весят меньше, чем любой шрифт иконок, и работают
// офлайн. Наследуют currentColor, поэтому подходят обеим темам.
const S = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };

export const Search = (p) => <svg {...S} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const Cart = (p) => <svg {...S} {...p}><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6" /><circle cx="10" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /></svg>;
export const Star = ({ filled, ...p }) => <svg {...S} fill={filled ? "currentColor" : "none"} {...p}><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
export const Sun = (p) => <svg {...S} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const Moon = (p) => <svg {...S} {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>;
export const User = (p) => <svg {...S} {...p}><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
export const Grid = (p) => <svg {...S} {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></svg>;
export const Back = (p) => <svg {...S} {...p}><path d="M15 5l-7 7 7 7" /></svg>;
export const Close = (p) => <svg {...S} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const Check = (p) => <svg {...S} {...p}><path d="m5 12.5 4.5 4.5L19 7" /></svg>;
export const Scale = (p) => <svg {...S} {...p}><path d="M12 4v16M7 8H3l2-4 2 4zM21 8h-4l2-4 2 4zM5 8l-2 6a3 3 0 0 0 6 0L7 8M19 8l-2 6a3 3 0 0 0 6 0l-2-6M8 20h8" /></svg>;
export const Doc = (p) => <svg {...S} {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
export const Phone = (p) => <svg {...S} {...p}><path d="M5 3h3.5l1.8 4.4-2.2 1.3a12 12 0 0 0 5.2 5.2l1.3-2.2L19 13.5V17a2 2 0 0 1-2.2 2A16 16 0 0 1 3 5.2 2 2 0 0 1 5 3z" /></svg>;
export const Box = (p) => <svg {...S} {...p}><path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5z" /><path d="M3 8.5 12 14l9-5.5M12 14v7" /></svg>;
export const Qr = (p) => <svg {...S} {...p}><rect x="3" y="3" width="7" height="7" rx="1.2" /><rect x="14" y="3" width="7" height="7" rx="1.2" /><rect x="3" y="14" width="7" height="7" rx="1.2" /><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1" /></svg>;
// Подбор по задаче — плитки на главной. Один стиль линий со всеми значками.
export const Bath = (p) => <svg {...S} {...p}><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3z" /><path d="M6 12V6a2 2 0 0 1 4 0" /><path d="M7 19v2M17 19v2" /></svg>;
export const Room = (p) => <svg {...S} {...p}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 15h18M9 4v11" /></svg>;
export const Facade = (p) => <svg {...S} {...p}><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /><rect x="10" y="14" width="4" height="6" /></svg>;
export const Floor = (p) => <svg {...S} {...p}><path d="M3 18h18M3 14h18" /><path d="M6 10c1-1.5 2-1.5 3 0s2 1.5 3 0 2-1.5 3-1.5 2 1.5 3 0" /></svg>;
export const Plinth = (p) => <svg {...S} {...p}><path d="M3 20h18M3 16h18M3 12h18" /><path d="M8 12v4M14 12v4M11 16v4M5 16v4M17 16v4" /></svg>;
export const Chart = (p) => <svg {...S} {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
export const Settings = (p) => <svg {...S} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z" /></svg>;
