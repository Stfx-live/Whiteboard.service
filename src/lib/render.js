// Zeichenroutinen für Board-Objekte und Hintergrund (keine React-Abhängigkeit).
import { FONT_STACK, getCanvasTextLayout, getMeasureCtx, isLine, normalizeRotation, objectBaseBox, objectBounds, selectedBounds } from "./geometry";
import { API } from "./api";

const imageCache = new Map();
export function getImage(src, onLoad) {
  const key = String(src || "");
  let img = imageCache.get(key);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    if (onLoad) img.addEventListener("load", onLoad, { once: true });
    img.src = key.startsWith("http") ? key : `${API}${key}`;
    imageCache.set(key, img);
  } else if (onLoad && !img.complete) img.addEventListener("load", onLoad, { once: true });
  return img;
}
// Mip-Stufen: Große Bilder werden bei kleiner Darstellung aus einer vorverkleinerten Kopie gezeichnet,
// statt jedes Frame das Original (z. B. 4000 px) zu skalieren. Das spart viel GPU/CPU-Zeit beim Verschieben/Zoomen.
const lodCache = new WeakMap();
export function pickImageSource(img, drawW) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh || !(drawW > 0) || nw < 700) return img;
  let level = 0, cw = nw;
  while (cw / 2 >= drawW * 1.1 && level < 6) { level++; cw /= 2; }
  if (!level) return img;
  let levels = lodCache.get(img); if (!levels) { levels = []; lodCache.set(img, levels); }
  for (let l = 1; l <= level; l++) {
    if (levels[l]) continue;
    const src = l === 1 ? img : levels[l - 1], c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(nw / 2 ** l)); c.height = Math.max(1, Math.round(nh / 2 ** l));
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height);
    levels[l] = c;
  }
  return levels[level];
}
export function preloadImages(items) {
  const list = items.filter(s => s.type === "image" && s.src);
  return Promise.all(list.map(s => new Promise(resolve => { const img = getImage(s.src, resolve); if (img.complete) resolve(); img.addEventListener("error", resolve, { once: true }); })));
}

export function drawArrowHead(x, x1, y1, x2, y2, width) {
  const angle = Math.atan2(y2 - y1, x2 - x1), len = Math.max(12, width * 4.2), spread = Math.PI / 7;
  x.beginPath();
  x.moveTo(x2, y2);
  x.lineTo(x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread));
  x.lineTo(x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread));
  x.closePath();
  x.fill();
}

export function strokePath(x, pts) {
  x.beginPath();
  if (pts.length < 3) { pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); return; }
  x.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) x.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  const last = pts[pts.length - 1];
  x.lineTo(last.x, last.y);
}

// Striche: Bei starkem Herauszoomen werden Punkte ausgedünnt (unsichtbar, aber viel schneller); sonst wird der Pfad
// pro Strich als Path2D gecacht und nur noch gezeichnet, nicht jedes Frame neu aus den Punkten aufgebaut.
const pathCache = new WeakMap();
function drawStrokeFast(x, pts) {
  const sc = x.getTransform ? x.getTransform().a || 1 : 1, minD = 0.75 / sc;
  if (minD > 0.35 && pts.length > 8) {
    const out = [pts[0]]; let last = pts[0], m2 = minD * minD;
    for (let i = 1; i < pts.length - 1; i++) { const dx = pts[i].x - last.x, dy = pts[i].y - last.y; if (dx * dx + dy * dy >= m2) { out.push(pts[i]); last = pts[i]; } }
    out.push(pts[pts.length - 1]);
    x.beginPath(); x.moveTo(out[0].x, out[0].y); for (let i = 1; i < out.length; i++) x.lineTo(out[i].x, out[i].y); x.stroke(); return;
  }
  if (typeof Path2D === "undefined") { strokePath(x, pts); x.stroke(); return; }
  let path = pathCache.get(pts);
  if (!path) {
    path = new Path2D(); path.moveTo(pts[0].x, pts[0].y);
    if (pts.length < 3) pts.forEach((q, i) => i && path.lineTo(q.x, q.y));
    else { for (let i = 1; i < pts.length - 1; i++) path.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2); path.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); }
    pathCache.set(pts, path);
  }
  x.stroke(path);
}

export function drawObject(x, s, { onImageLoad } = {}) {
  if (!s) return;
  x.save();
  x.strokeStyle = s.color || "#111827";
  x.fillStyle = s.color || "#111827";
  x.lineWidth = s.width || 1;
  x.lineCap = "round";
  x.lineJoin = "round";
  if (s.alpha && s.alpha < 1) x.globalAlpha = s.alpha;
  if (s.type === "stroke") {
    const pts = s.points || [];
    if (pts.length) {
      if (pts.length === 1) { x.beginPath(); x.arc(pts[0].x, pts[0].y, (s.width || 1) / 2, 0, Math.PI * 2); x.fill(); }
      else drawStrokeFast(x, pts);
    }
  } else if (isLine(s)) {
    let { x1, y1, x2, y2 } = s;
    if (s.type === "arrow") {
      const len = Math.hypot(x2 - x1, y2 - y1), head = Math.max(12, (s.width || 1) * 4.2);
      if (len > head * 0.6) { const k = (len - head * 0.7) / len; x.beginPath(); x.moveTo(x1, y1); x.lineTo(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k); x.stroke(); }
      drawArrowHead(x, x1, y1, x2, y2, s.width || 1);
    } else { x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke(); }
  } else if (s.type === "rect" || s.type === "circle" || s.type === "image" || s.type === "text") {
    const rotation = normalizeRotation(s.rotation);
    if (rotation) { const box = objectBaseBox(s), cx = box.x + box.w / 2, cy = box.y + box.h / 2; x.translate(cx, cy); x.rotate(rotation); x.translate(-cx, -cy); }
    if (s.type === "rect") {
      if (s.fill) { x.save(); x.globalAlpha *= 0.16; x.fillRect(s.x, s.y, s.w, s.h); x.restore(); }
      x.lineJoin = "miter"; x.strokeRect(s.x, s.y, s.w, s.h);
    } else if (s.type === "circle") {
      x.beginPath(); x.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(0.1, Math.abs(s.w / 2)), Math.max(0.1, Math.abs(s.h / 2)), 0, 0, Math.PI * 2);
      if (s.fill) { x.save(); x.globalAlpha *= 0.16; x.fill(); x.restore(); }
      x.stroke();
    } else if (s.type === "image") {
      const img = getImage(s.src, onImageLoad);
      const w = Number(s.w) > 0 ? Number(s.w) : img.naturalWidth, h = Number(s.h) > 0 ? Number(s.h) : img.naturalHeight;
      if (img.complete && img.naturalWidth) x.drawImage(pickImageSource(img, w * (x.getTransform?.().a || 1)), Number(s.x) || 0, Number(s.y) || 0, w, h);
      else { x.fillStyle = "rgba(120,130,160,.14)"; x.fillRect(Number(s.x) || 0, Number(s.y) || 0, w, h); }
    } else {
      const layout = getCanvasTextLayout(getMeasureCtx(), s);
      x.font = `${layout.fontSize}px ${FONT_STACK}`;
      layout.lines.forEach((line, i) => x.fillText(line, Number(s.x) || 0, (Number(s.y) || 0) + i * layout.lineHeight));
    }
  }
  x.restore();
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return 1;
  let h = m[1]; if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const isDarkColor = hex => luminance(hex) < 0.42;

// Zeichnet Hintergrundfarbe + Muster für den Weltausschnitt (left/top/right/bottom in Weltkoordinaten).
export function drawBackground(x, bg, { left, top, right, bottom, zoom }) {
  const s = Math.max(4, Number(bg.size) || 24);
  const dark = isDarkColor(bg.color);
  if (s * zoom < 5 || bg.pattern === "none") return;
  x.save();
  x.lineWidth = 1 / zoom;
  x.strokeStyle = dark ? "rgba(255,255,255,.09)" : "rgba(60,72,100,.16)";
  x.fillStyle = dark ? "rgba(255,255,255,.22)" : "rgba(60,72,100,.30)";
  if (bg.pattern === "grid") {
    x.beginPath();
    for (let i = Math.floor(left / s) * s; i <= right + s; i += s) { x.moveTo(i, top); x.lineTo(i, bottom); }
    for (let y = Math.floor(top / s) * s; y <= bottom + s; y += s) { x.moveTo(left, y); x.lineTo(right, y); }
    x.stroke();
  } else if (bg.pattern === "lines") {
    x.beginPath();
    for (let y = Math.floor(top / s) * s; y <= bottom + s; y += s) { x.moveTo(left, y); x.lineTo(right, y); }
    x.stroke();
  } else if (bg.pattern === "dots") {
    const r = Math.max(1, 1.6 / zoom);
    x.beginPath();
    for (let y = Math.floor(top / s) * s; y <= bottom + s; y += s) for (let xx = Math.floor(left / s) * s; xx <= right + s; xx += s) { x.moveTo(xx + r, y); x.arc(xx, y, r, 0, Math.PI * 2); }
    x.fill();
  }
  x.restore();
}

export const ACCENT = "#6366f1";

export function drawSelection(x, items, view) {
  const box = selectedBounds(items);
  if (!box) return null;
  const z = view.zoom;
  x.save(); x.translate(view.pan.x, view.pan.y); x.scale(z, z);
  x.strokeStyle = ACCENT; x.fillStyle = "rgba(99,102,241,.06)";
  x.lineWidth = 1.5 / z;
  x.fillRect(box.x, box.y, box.w, box.h);
  if (items.length > 1) { x.save(); x.lineWidth = 1 / z; x.globalAlpha = .55; for (const it of items) { const b = objectBounds(it); if (b) x.strokeRect(b.x, b.y, b.w, b.h); } x.restore(); }
  x.setLineDash([6 / z, 4 / z]); x.strokeRect(box.x, box.y, box.w, box.h); x.setLineDash([]);
  const h = 9 / z; x.fillStyle = "#fff";
  [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].forEach(([hx, hy]) => { x.beginPath(); (x.roundRect ? x.roundRect(hx - h / 2, hy - h / 2, h, h, 2.5 / z) : x.rect(hx - h / 2, hy - h / 2, h, h)); x.fill(); x.stroke(); });
  const rx = box.x + box.w / 2, ry = box.y - 28 / z;
  x.beginPath(); x.moveTo(rx, box.y); x.lineTo(rx, ry); x.stroke();
  x.beginPath(); x.arc(rx, ry, 6 / z, 0, Math.PI * 2); x.fill(); x.stroke();
  x.restore();
  return box;
}
