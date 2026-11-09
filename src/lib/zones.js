// Bereiche (Zonen): gemeinsame Hilfsfunktionen. Die Box-Berechnung spiegelt bewusst die des Servers (itemBox),
// damit Client-Vorprüfung und Server-Durchsetzung identisch entscheiden.
export const ZONE_COLORS = ["#6366f1", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#ec4899", "#8b5cf6", "#84cc16"];
export const ZONE_MODES = {
  open: { label: "Sieht alles", short: "Alles sehen", desc: "Sieht das ganze Board, darf aber nur in diesem Bereich schreiben und zeichnen." },
  focus: { label: "Nur Bereich", short: "Fokus", desc: "Sieht ausschließlich diesen Bereich und darf nur dort schreiben und zeichnen." },
  view: { label: "Nur lesen", short: "Nur lesen", desc: "Sieht ausschließlich diesen Bereich und kann nichts verändern." },
};
export const inRect = (z, p, e = 0) => p.x >= z.x - e && p.y >= z.y - e && p.x <= z.x + z.w + e && p.y <= z.y + z.h + e;
export const boxInRect = (z, b, e = 1) => Boolean(b) && b.x >= z.x - e && b.y >= z.y - e && b.x + b.w <= z.x + z.w + e && b.y + b.h <= z.y + z.h + e;
export const clampTo = (z, p) => ({ x: Math.max(z.x, Math.min(z.x + z.w, p.x)), y: Math.max(z.y, Math.min(z.y + z.h, p.y)) });
export function zoneBox(item) {
  if (!item) return null;
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const fromPts = pts => { if (!pts.length) return null; let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (const p of pts) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); } return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; };
  if (item.type === "stroke") return fromPts((Array.isArray(item.points) ? item.points : []).filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).map(p => ({ x: Number(p.x), y: Number(p.y) })));
  if (item.type === "line" || item.type === "arrow") return fromPts([{ x: num(item.x1), y: num(item.y1) }, { x: num(item.x2), y: num(item.y2) }]);
  if (item.type === "rect" || item.type === "circle" || item.type === "image") {
    const x = num(item.x), y = num(item.y), w = num(item.w), h = num(item.h), r = num(item.rotation), cx = x + w / 2, cy = y + h / 2, c = Math.cos(r), s = Math.sin(r);
    return fromPts([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c })));
  }
  if (item.type === "text") return { x: num(item.x), y: num(item.y), w: 0, h: 0 };
  return null;
}
export function unionRect(list) {
  if (!list.length) return null;
  const x1 = Math.min(...list.map(z => z.x)), y1 = Math.min(...list.map(z => z.y)), x2 = Math.max(...list.map(z => z.x + z.w)), y2 = Math.max(...list.map(z => z.y + z.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
// Zeichnet Bereichsfüllung (unter den Objekten) bzw. Rahmen + Etikett (darüber).
export function drawZoneFills(x, zones) { for (const z of zones) { x.globalAlpha = 0.07; x.fillStyle = z.color; x.fillRect(z.x, z.y, z.w, z.h); } x.globalAlpha = 1; }
export function drawZoneFrames(x, zones, zoom, selectedId) {
  const px = 1 / zoom;
  for (const z of zones) {
    const sel = z.id === selectedId;
    x.save();
    x.strokeStyle = z.color; x.lineWidth = (sel ? 2.6 : 1.8) * px; x.setLineDash(z.locked ? [3 * px, 4 * px] : [9 * px, 6 * px]); x.globalAlpha = sel ? 1 : 0.85;
    x.strokeRect(z.x, z.y, z.w, z.h); x.setLineDash([]);
    const fs = 12 * px, label = `${z.name}${z.locked ? " · gesperrt" : ""}`;
    x.font = `600 ${fs}px Inter, system-ui, sans-serif`; x.textBaseline = "middle";
    const tw = x.measureText(label).width, pad = 8 * px, th = 21 * px, lx = z.x, ly = z.y - th - 2 * px;
    x.globalAlpha = 1; x.fillStyle = z.color;
    x.beginPath(); if (x.roundRect) x.roundRect(lx, ly, tw + pad * 2, th, 6 * px); else x.rect(lx, ly, tw + pad * 2, th); x.fill();
    x.fillStyle = "#fff"; x.fillText(label, lx + pad, ly + th / 2 + px * 0.5);
    x.restore();
  }
}
