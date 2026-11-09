import React from "react";

// Schlanke Outline-Icons (24×24, stroke = currentColor).
const P = {
  select: <path d="M5 3.5l13.5 6.4-5.7 1.9-1.9 5.8z" />,
  hand: <><path d="M8 13V6.5a1.5 1.5 0 013 0V12" /><path d="M11 11V4.5a1.5 1.5 0 013 0V12" /><path d="M14 11.5V6a1.5 1.5 0 013 0v7" /><path d="M8 13.5l-1.6-2.2a1.5 1.5 0 00-2.4 1.8L7 18a5.5 5.5 0 004.6 3h1.6a5 5 0 005-5v-3" /></>,
  lasso: <><ellipse cx="12" cy="9" rx="8" ry="5.5" strokeDasharray="3 2.4" /><path d="M8.5 13.5c-1 2.6.2 5 2.5 5.5" /><circle cx="11.6" cy="19.2" r="1.4" /></>,
  pen: <><path d="M4 20l1-4.2L16.6 4.2a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.2 19z" /><path d="M14.5 6.3l3.2 3.2" /></>,
  eraser: <><path d="M8.5 19.5H20" /><path d="M5.3 16.2l9.9-9.9a2 2 0 012.8 0l1.7 1.7a2 2 0 010 2.8l-7.6 7.6H8.2a1 1 0 01-.7-.3l-2.2-2.2a1 1 0 010-1.7z" /><path d="M9 9.5l5.5 5.5" /></>,
  line: <path d="M5 19L19 5" />,
  marker: <><path d="M14.2 4.8l5 5-8.7 8.7-4.6 1 1-4.6z" /><path d="M4 20.5h7" /></>,
  keyboard: <><rect x="3" y="6.5" width="18" height="11" rx="2.5" /><path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M8 14h8" /></>,
  upload: <><path d="M12 16V5" /><path d="M7.5 9L12 4.5 16.5 9" /><path d="M5 19.5h14" /></>,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  layers: <><path d="M12 4l8.5 4.5L12 13 3.5 8.5z" /><path d="M3.5 12.5L12 17l8.5-4.5" /><path d="M3.5 16.5L12 21l8.5-4.5" /></>,
  touch: <><path d="M9 11V5.5a1.5 1.5 0 013 0V10" /><path d="M12 10V8.5a1.5 1.5 0 013 0V11" /><path d="M15 11a1.5 1.5 0 013 0v4.5a5.5 5.5 0 01-5.5 5.5H12a5 5 0 01-4.3-2.5L5 14a1.4 1.4 0 012.3-1.5L9 14" /></>,
  arrow: <><path d="M5 19L19 5" /><path d="M9 5h10v10" /></>,
  rect: <rect x="4" y="5.5" width="16" height="13" rx="2" />,
  circle: <circle cx="12" cy="12" r="8" />,
  text: <><path d="M5 6.5V5h14v1.5" /><path d="M12 5v14" /><path d="M9.5 19h5" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 000 11H13" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <><path d="M4 9V5a1 1 0 011-1h4" /><path d="M20 9V5a1 1 0 00-1-1h-4" /><path d="M4 15v4a1 1 0 001 1h4" /><path d="M20 15v4a1 1 0 01-1 1h-4" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-4.8-4.8L7 19.5" /></>,
  download: <><path d="M12 4v11" /><path d="M7.5 11L12 15.5 16.5 11" /><path d="M5 19.5h14" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 100 17c1.2 0 1.8-.8 1.8-1.7 0-.5-.3-1-.5-1.4-.3-.5-.1-1.4 1-1.4h2.1a3.6 3.6 0 003.6-3.6C20 7 16.5 3.5 12 3.5z" /><circle cx="7.8" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="7.8" r="1" /></>,
  users: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0111 0" /><path d="M16 5.5a3 3 0 010 6" /><path d="M17.5 14.2A5.5 5.5 0 0120.5 19" /></>,
  share: <><circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M8.1 10.9l7.8-3.8M8.1 13.1l7.8 3.8" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  timer: <><circle cx="12" cy="13.5" r="7.5" /><path d="M12 9.5v4l2.5 1.5" /><path d="M9.5 3h5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  moon: <path d="M20 14.2A8.2 8.2 0 019.8 4a8.2 8.2 0 1010.2 10.2z" />,
  back: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  trash: <><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.8 12.2a1.5 1.5 0 001.5 1.3h6.4a1.5 1.5 0 001.5-1.3L17.5 7" /><path d="M10 11v5.5M14 11v5.5" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" /></>,
  folder: <path d="M3.5 7.5a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />,
  home: <path d="M4 11l8-6.5 8 6.5v8a1 1 0 01-1 1h-4.5v-5.5h-5V20H5a1 1 0 01-1-1z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  more: <><circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></>,
  user: <><circle cx="12" cy="8.5" r="3.7" /><path d="M4.5 20a7.5 7.5 0 0115 0" /></>,
  shield: <path d="M12 3.5l7 2.8v5.4c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6.3z" />,
  logout: <><path d="M10 4.5H6a1.5 1.5 0 00-1.5 1.5v12A1.5 1.5 0 006 19.5h4" /><path d="M15 8l4 4-4 4M19 12H9.5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 017.5-1.9" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L19 4M16 7l2.5 2.5" /></>,
  file: <><path d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 014.9 19V5a1.5 1.5 0 011.6-1.5z" /><path d="M13.5 3.5V8H18" /></>,
  pencil: <><path d="M4.5 19.5l.8-3.6L16.6 4.6a1.8 1.8 0 012.5 0l.3.3a1.8 1.8 0 010 2.5L8.1 18.7z" /></>,
  fill: <><rect x="4" y="5.5" width="16" height="13" rx="2" fill="currentColor" fillOpacity=".28" /></>,
  front: <><rect x="4" y="4" width="10" height="10" rx="1.5" /><path d="M10 10h10v10H10z" fill="currentColor" fillOpacity=".25" /></>,
  grid: <><path d="M4 9h16M4 15h16M9 4v16M15 4v16" /></>,
  sparkle: <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9zM18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.01" /></>,
  warn: <><path d="M12 4l9 15.5H3z" /><path d="M12 10v4.5M12 17.2v.01" /></>,
  pdf: <><path d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 014.9 19V5a1.5 1.5 0 011.6-1.5z" /><path d="M13.5 3.5V8H18" /><path d="M8.5 15h1.6a1.2 1.2 0 000-2.4H8.5V17" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  pause: <><rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" /><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" /></>,
  zone: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" strokeDasharray="3.4 2.6" /><path d="M12 9.2v5.6M9.2 12h5.6" /></>,
  target: <><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.6" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" /></>,
  reset: <><path d="M4.5 12a7.5 7.5 0 112.4 5.5" /><path d="M4.5 18v-5h5" /></>,
};

export function Icon({ name, size = 20, strokeWidth = 1.8, className = "", style }) {
  return <svg className={`icon ${className}`} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{P[name] || null}</svg>;
}

export function Avatar({ name = "?", url = null, size = 32, color, className = "" }) {
  const initial = String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
  return <span className={`avatar ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * .42), ...(color && !url ? { background: color } : {}) }}>{url ? <img src={url} alt="" draggable="false" /> : initial}</span>;
}
