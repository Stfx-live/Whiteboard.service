// Export (PNG/JSON/PDF) – nutzt dieselben Zeichenroutinen wie das Board.
import { jsPDF } from "jspdf";
import { drawBackground, drawObject, getImage, isDarkColor, preloadImages } from "./render";
import { getCanvasTextLayout, getMeasureCtx, objectBounds, rotatePoint, isLine } from "./geometry";

export function contentBounds(strokes, pad = 48) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const b = objectBounds(s); if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - pad, y: minY - pad, w: Math.max(200, maxX - minX + pad * 2), h: Math.max(150, maxY - minY + pad * 2) };
}

export function renderExportCanvas(strokes, bg, bounds, scale, { transparent = false } = {}) {
  const maxSide = 8192;
  const k = Math.min(scale, maxSide / Math.max(bounds.w, bounds.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bounds.w * k)); canvas.height = Math.max(1, Math.round(bounds.h * k));
  const ctx = canvas.getContext("2d");
  ctx.scale(k, k);
  if (!transparent) { ctx.fillStyle = bg.color || "#fff"; ctx.fillRect(0, 0, bounds.w, bounds.h); }
  ctx.translate(-bounds.x, -bounds.y);
  drawBackground(ctx, bg, { left: bounds.x, top: bounds.y, right: bounds.x + bounds.w, bottom: bounds.y + bounds.h, zoom: 1 });
  for (const s of strokes) { const b = objectBounds(s); if (b && (b.x > bounds.x + bounds.w || b.y > bounds.y + bounds.h || b.x + b.w < bounds.x || b.y + b.h < bounds.y)) continue; drawObject(ctx, s); }
  return canvas;
}

export async function exportPng(strokes, bg, bounds, name, scale = 2) {
  await preloadImages(strokes);
  const canvas = renderExportCanvas(strokes, bg, bounds, scale);
  await new Promise(resolve => canvas.toBlob(blob => { if (blob) download(blob, `${name}.png`); resolve(); }, "image/png"));
}

export function exportJson(payload, name) { download(new Blob([JSON.stringify(payload)], { type: "application/json" }), `${name}.json`); }

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename.replace(/[\\/:*?"<>|]+/g, "_"); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const hexRgb = hex => { const h = String(hex || "#111827").replace("#", ""); const f = h.length === 3 ? h.split("").map(c => c + c).join("") : h; return f.length >= 6 ? [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) || 0) : [17, 24, 39]; };

export async function buildPdf({ strokes, bg, bounds, config, name, onProgress }) {
  await preloadImages(strokes); onProgress?.(25);
  const doc = new jsPDF({ orientation: config.orientation === "portrait" ? "portrait" : "landscape", unit: "mm", format: config.paper === "letter" ? "letter" : "a4", compress: true });
  const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), margin = 8;
  const ratio = bounds.w / bounds.h; let w = pw - margin * 2, h = w / ratio; if (h > ph - margin * 2) { h = ph - margin * 2; w = h * ratio; }
  const x0 = (pw - w) / 2, y0 = (ph - h) / 2;
  if (config.mode === "vector") {
    const fit = w / bounds.w;
    if (bg.color && bg.color.toLowerCase() !== "#ffffff" && bg.color.toLowerCase() !== "#fff") { doc.setFillColor(...hexRgb(bg.color)); doc.rect(x0, y0, w, h, "F"); }
    const ox = n => x0 + (n - bounds.x) * fit, oy = n => y0 + (n - bounds.y) * fit;
    const poly = pts => { for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; doc.line(ox(a.x), oy(a.y), ox(b.x), oy(b.y)); } };
    for (const item of strokes) {
      const rgb = hexRgb(item.color); doc.setDrawColor(...rgb); doc.setTextColor(...rgb); doc.setFillColor(...rgb); doc.setLineWidth(Math.max(.15, (Number(item.width) || 1) * fit));
      const rot = Number(item.rotation) || 0, b = objectBounds(item);
      if (item.type === "stroke") { const pts = item.points || []; for (let i = 1; i < pts.length; i++) doc.line(ox(pts[i - 1].x), oy(pts[i - 1].y), ox(pts[i].x), oy(pts[i].y)); }
      else if (isLine(item)) { doc.line(ox(item.x1), oy(item.y1), ox(item.x2), oy(item.y2)); if (item.type === "arrow") { const a = Math.atan2(item.y2 - item.y1, item.x2 - item.x1), L = Math.max(12, (item.width || 1) * 4.2); for (const d of [-1, 1]) doc.line(ox(item.x2), oy(item.y2), ox(item.x2 - L * Math.cos(a + d * Math.PI / 7)), oy(item.y2 - L * Math.sin(a + d * Math.PI / 7))); } }
      else if (item.type === "rect" || item.type === "circle") {
        const c = { x: item.x + item.w / 2, y: item.y + item.h / 2 };
        if (item.type === "rect") poly([{ x: item.x, y: item.y }, { x: item.x + item.w, y: item.y }, { x: item.x + item.w, y: item.y + item.h }, { x: item.x, y: item.y + item.h }].map(p => rot ? rotatePoint(p, c, rot) : p));
        else poly(Array.from({ length: 64 }, (_, i) => { const t = i / 64 * Math.PI * 2; const p = { x: c.x + Math.cos(t) * item.w / 2, y: c.y + Math.sin(t) * item.h / 2 }; return rot ? rotatePoint(p, c, rot) : p; }));
      } else if (item.type === "text") {
        const layout = getCanvasTextLayout(getMeasureCtx(), item); doc.setFontSize(Math.max(4, layout.fontSize * fit * 2.835));
        const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        layout.lines.forEach((line, i) => { let p = { x: item.x, y: item.y + i * layout.lineHeight }; if (rot) p = rotatePoint(p, { x: c.x, y: c.y }, rot); doc.text(line, ox(p.x), oy(p.y), rot ? { angle: -rot * 180 / Math.PI } : undefined); });
      } else if (item.type === "image") {
        const img = getImage(item.src);
        if (img.naturalWidth) { try {
          const rb = objectBounds(item), cv = document.createElement("canvas"); cv.width = Math.min(2400, Math.round(rb.w * 2)); cv.height = Math.round(cv.width * rb.h / rb.w);
          const cx = cv.getContext("2d"); cx.scale(cv.width / rb.w, cv.width / rb.w); cx.translate(-rb.x, -rb.y); drawObject(cx, item);
          doc.addImage(cv.toDataURL("image/png"), "PNG", ox(rb.x), oy(rb.y), rb.w * fit, rb.h * fit);
        } catch {} }
      }
    }
  } else {
    onProgress?.(50);
    const canvas = renderExportCanvas(strokes, bg, bounds, Math.max(1, Math.min(4, Number(config.quality) || 2)));
    doc.addImage(canvas.toDataURL("image/jpeg", .94), "JPEG", x0, y0, w, h, undefined, "FAST");
  }
  onProgress?.(92);
  return doc;
}
export { isDarkColor };
