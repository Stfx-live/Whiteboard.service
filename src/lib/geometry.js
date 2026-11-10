// Reine Geometrie-/Layout-Funktionen (keine React-Abhängigkeit).
export const TEXT_DEFAULT_WIDTH = 420;
export const TEXT_MAX_LENGTH = 5000;
export const ZOOM_MIN = 0.1;
export const TEXT_BASELINE = 0.95; // Verhältnis Baseline/Schriftgröße für neu platzierte Texte
export const isLine = s => Boolean(s) && (s.type === "line" || s.type === "arrow");
export const ZOOM_MAX = 5;
export const FONT_STACK = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';

let measureCtx = null;
export function getMeasureCtx() {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

export function getTextWidth(s) {
  return Math.max(120, Number(s?.maxWidth || s?.textWidth || TEXT_DEFAULT_WIDTH) || TEXT_DEFAULT_WIDTH);
}

function wrapCanvasText(ctx, value, maxWidth) {
  const source = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = [];
  for (const paragraph of source.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    const tokens = paragraph.split(/(\s+)/).filter(Boolean);
    let line = "";
    for (const token of tokens) {
      const candidate = line + token;
      if (!line || ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
      lines.push(line.trimEnd());
      if (ctx.measureText(token).width <= maxWidth) { line = token.trimStart(); continue; }
      let chunk = "";
      for (const ch of token) {
        const next = chunk + ch;
        if (chunk && ctx.measureText(next).width > maxWidth) { lines.push(chunk); chunk = ch; } else chunk = next;
      }
      line = chunk;
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}

const layoutCache = new WeakMap();
export function getCanvasTextLayout(ctx, s) {
  const cached = layoutCache.get(s);
  if (cached) return cached;
  const fontSize = Math.max(12, Number(s?.fontSize || 28));
  const lineHeight = Math.round(fontSize * 1.25);
  const maxWidth = getTextWidth(s);
  ctx.save();
  ctx.font = `${fontSize}px ${FONT_STACK}`;
  const lines = wrapCanvasText(ctx, s?.text, maxWidth);
  const measuredWidth = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
  ctx.restore();
  const layout = { fontSize, lineHeight, maxWidth, lines, width: Math.min(maxWidth, Math.max(36, measuredWidth)), height: Math.max(fontSize, fontSize + (lines.length - 1) * lineHeight) };
  if (s && typeof s === "object") layoutCache.set(s, layout);
  return layout;
}

export function normalizeRotation(value) {
  let r = Number(value) || 0;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

export function rotatePoint(p, center, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), dx = p.x - center.x, dy = p.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

const BOXED = new Set(["rect", "circle", "image"]);
export function objectBaseBox(s) {
  if (!s) return { x: 0, y: 0, w: 0, h: 0 };
  if (BOXED.has(s.type)) {
    const x = Number(s.x) || 0, y = Number(s.y) || 0, w = Number(s.w) || 0, h = Number(s.h) || 0;
    return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
  }
  if (s.type === "text") {
    const layout = getCanvasTextLayout(getMeasureCtx(), s);
    return { x: Number(s.x) || 0, y: (Number(s.y) || 0) - layout.fontSize, w: layout.width, h: layout.height };
  }
  if (isLine(s)) {
    const x1 = Number(s.x1) || 0, y1 = Number(s.y1) || 0, x2 = Number(s.x2) || 0, y2 = Number(s.y2) || 0;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function rotatedBounds(box, rotation = 0) {
  if (!box) return null;
  const angle = normalizeRotation(rotation);
  if (!angle) return box;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => rotatePoint({ x, y }, center, angle));
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

const boundsCache = new WeakMap();
export function objectBounds(s) {
  if (!s) return null;
  if (boundsCache.has(s)) return boundsCache.get(s);
  let result = null;
  if (s.type === "stroke") {
    const pts = Array.isArray(s.points) ? s.points : [];
    if (pts.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
      const pad = Math.max(4, Number(s.width) || 1);
      result = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
  } else if (s.type === "rect" || s.type === "circle" || s.type === "image" || s.type === "text") {
    result = rotatedBounds(objectBaseBox(s), s.rotation || 0);
  } else if (isLine(s)) {
    const b = objectBaseBox(s), pad = Math.max(4, Number(s.width) || 1);
    result = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  boundsCache.set(s, result);
  return result;
}

export function selectedBounds(items) {
  const boxes = items.map(objectBounds).filter(Boolean);
  if (!boxes.length) return null;
  const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w)), maxY = Math.max(...boxes.map(b => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function shiftObject(s, dx, dy) {
  if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => ({ x: p.x + dx, y: p.y + dy })) };
  if (isLine(s)) return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  if (s.type === "rect" || s.type === "circle" || s.type === "image" || s.type === "text") return { ...s, x: (Number(s.x) || 0) + dx, y: (Number(s.y) || 0) + dy };
  return s;
}

export function rotateObject(s, angle, center) {
  if (!angle) return s;
  if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => rotatePoint(p, center, angle)) };
  if (isLine(s)) {
    const a = rotatePoint({ x: s.x1, y: s.y1 }, center, angle), b = rotatePoint({ x: s.x2, y: s.y2 }, center, angle);
    return { ...s, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  if (BOXED.has(s.type)) {
    // x/y/w/h bleiben unverändert orientiert (ggf. negative w/h); nur der Mittelpunkt wandert.
    const box = objectBaseBox(s), c = rotatePoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, center, angle);
    const w = Number(s.w) || 0, h = Number(s.h) || 0;
    return { ...s, x: c.x - w / 2, y: c.y - h / 2, rotation: normalizeRotation((Number(s.rotation) || 0) + angle) };
  }
  if (s.type === "text") {
    const box = objectBaseBox(s), layout = getCanvasTextLayout(getMeasureCtx(), s);
    const c = rotatePoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, center, angle);
    return { ...s, x: c.x - box.w / 2, y: c.y - box.h / 2 + layout.fontSize, rotation: normalizeRotation((Number(s.rotation) || 0) + angle) };
  }
  return s;
}

export function scaleObject(s, sx, sy, anchor) {
  const ax = Number(anchor?.x) || 0, ay = Number(anchor?.y) || 0;
  if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy })) };
  if (isLine(s)) return { ...s, x1: ax + (s.x1 - ax) * sx, y1: ay + (s.y1 - ay) * sy, x2: ax + (s.x2 - ax) * sx, y2: ay + (s.y2 - ay) * sy };
  if (BOXED.has(s.type)) {
    const w = Number(s.w) || 0, h = Number(s.h) || 0;
    const x1 = ax + ((Number(s.x) || 0) - ax) * sx, y1 = ay + ((Number(s.y) || 0) - ay) * sy;
    const x2 = ax + ((Number(s.x) || 0) + w - ax) * sx, y2 = ay + ((Number(s.y) || 0) + h - ay) * sy;
    return { ...s, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  if (s.type === "text") {
    const factor = Math.max(.1, (sx + sy) / 2);
    return { ...s, x: ax + ((Number(s.x) || 0) - ax) * sx, y: ay + ((Number(s.y) || 0) - ay) * sy, maxWidth: Math.max(40, (Number(s.maxWidth) || TEXT_DEFAULT_WIDTH) * sx), fontSize: Math.max(12, Math.min(200, (Number(s.fontSize) || 28) * factor)) };
  }
  return s;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}
function segmentIntersects(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p, q, r) => Math.min(p.x, r.x) - 1e-7 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-7 && Math.min(p.y, r.y) - 1e-7 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-7;
  const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
  if (((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) && ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0))) return true;
  return (Math.abs(c1) < 1e-7 && on(a, c, b)) || (Math.abs(c2) < 1e-7 && on(a, d, b)) || (Math.abs(c3) < 1e-7 && on(c, a, d)) || (Math.abs(c4) < 1e-7 && on(c, b, d));
}
export function bboxInLasso(box, poly) {
  if (!box || poly.length < 3) return false;
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
  if (corners.some(p => pointInPolygon(p, poly))) return true;
  if (poly.some(p => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h)) return true;
  const edges = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (edges.some(([c, d]) => segmentIntersects(a, b, c, d))) return true;
  }
  return false;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function toLocal(s, p) {
  const rot = normalizeRotation(s.rotation);
  if (!rot) return p;
  const box = objectBaseBox(s);
  return rotatePoint(p, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, -rot);
}

// Geometrischer Treffertest für einen Weltpunkt. `interior`: Innenfläche zählt (Auswahl), sonst nur Kontur (Radierer).
function hitGeometry(s, p, reach, interior) {
  if (s.type === "stroke") {
    const sp = s.points || [];
    if (sp.length === 1) return Math.hypot(p.x - sp[0].x, p.y - sp[0].y) <= reach;
    for (let i = 1; i < sp.length; i++) if (distToSegment(p, sp[i - 1], sp[i]) <= reach) return true;
    return false;
  }
  if (isLine(s)) return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= reach;
  const q = toLocal(s, p), b = objectBaseBox(s);
  const inside = (pad) => q.x >= b.x - pad && q.x <= b.x + b.w + pad && q.y >= b.y - pad && q.y <= b.y + b.h + pad;
  if (s.type === "rect") {
    if (!inside(reach)) return false;
    if (interior || s.fill) return true;
    return !(q.x > b.x + reach && q.x < b.x + b.w - reach && q.y > b.y + reach && q.y < b.y + b.h - reach);
  }
  if (s.type === "circle") {
    const rx = Math.max(1, b.w / 2), ry = Math.max(1, b.h / 2), nx = (q.x - (b.x + rx)) / rx, ny = (q.y - (b.y + ry)) / ry, r = Math.hypot(nx, ny), m = Math.min(rx, ry);
    if (interior || s.fill) return r <= 1 + reach / m;
    return Math.abs(r - 1) * m <= reach;
  }
  return inside(reach); // image, text
}

// Trifft der Radierer (Punkte + Radius) das Objekt?
export function hitObject(s, pts, radius) {
  if (!pts?.length) return false;
  const bounds = objectBounds(s);
  if (!bounds) return false;
  const reach = radius + Math.max(1, Number(s.width) || 1) / 2;
  return pts.some(p => p.x >= bounds.x - reach && p.x <= bounds.x + bounds.w + reach && p.y >= bounds.y - reach && p.y <= bounds.y + bounds.h + reach && hitGeometry(s, p, reach, false));
}

// Treffer für Auswahl per Klick (Innenfläche zählt, Toleranz in Weltkoordinaten).
export function hitPoint(s, p, tol = 0) {
  const bounds = objectBounds(s);
  if (!bounds || !pointInBounds(bounds, p, tol)) return false;
  return hitGeometry(s, p, tol + (s.type === "stroke" || isLine(s) ? Math.max(1, Number(s.width) || 1) / 2 : 0), true);
}

export function rectsIntersect(a, b) { return Boolean(a && b) && a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y; }

export function pointInBounds(b, p, pad = 0) {
  return Boolean(b) && p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

export function colorFromId(id) {
  let h = 0; const str = String(id || "");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 78% 52%)`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Ramer-Douglas-Peucker (iterativ): entfernt Punkte, die weniger als eps von der Linie abweichen. Bewahrt Anfang/Ende.
export function simplifyPoints(pts, eps = 0.35) {
  const n = pts.length;
  if (n < 4) return pts;
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]], e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const ax = pts[a].x, ay = pts[a].y, dx = pts[b].x - ax, dy = pts[b].y - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d2;
      if (len2 === 0) { const ex = pts[i].x - ax, ey = pts[i].y - ay; d2 = ex * ex + ey * ey; }
      else { const t = Math.max(0, Math.min(1, ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / len2)), ex = pts[i].x - (ax + t * dx), ey = pts[i].y - (ay + t * dy); d2 = ex * ex + ey * ey; }
      if (d2 > max) { max = d2; idx = i; }
    }
    if (idx > -1 && max > e2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
// Verkleinert ein Bild vor dem Upload (Canvas → WebP/JPEG). Gibt das Original zurück, wenn es nicht kleiner wird.
export async function compressImageFile(file, { maxSide = 2400, quality = 0.82 } = {}) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { return file; }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 300 * 1024) { bmp.close?.(); return file; }
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const blob = await new Promise(res => c.toBlob(res, "image/webp", quality));
  c.width = c.height = 0;
  if (!blob || blob.type !== "image/webp" || (blob.size >= file.size && k === 1)) return file;
  return new File([blob], (file.name || "bild").replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp", lastModified: Date.now() });
}
