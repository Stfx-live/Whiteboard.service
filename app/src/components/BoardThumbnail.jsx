import React, { useEffect, useRef } from "react";
import { getCanvasTextLayout, getMeasureCtx, FONT_STACK } from "../lib/geometry";

export default function BoardThumbnail({ board }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const d = window.devicePixelRatio || 1;
    const W = c.clientWidth || 320, H = c.clientHeight || 180;
    c.width = Math.max(1, Math.round(W * d)); c.height = Math.max(1, Math.round(H * d));
    const ctx = c.getContext("2d"); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = board.background?.color || "#fff"; ctx.fillRect(0, 0, W, H);
    const size = Math.max(10, Math.min(32, Number(board.background?.size) || 22));
    ctx.strokeStyle = "rgba(100,110,125,.13)"; ctx.fillStyle = "rgba(100,110,125,.2)"; ctx.lineWidth = 1;
    const pattern = board.background?.pattern;
    if (pattern === "grid") { for (let x = 0; x < W; x += size) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = 0; y < H; y += size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } }
    if (pattern === "dots") { for (let y = size / 2; y < H; y += size) for (let x = size / 2; x < W; x += size) { ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill(); } }
    if (pattern === "lines") { for (let y = 0; y < H; y += size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } }
    const objects = Array.isArray(board.preview) ? board.preview : [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    const measure = getMeasureCtx();
    for (const o of objects) {
      if (o.type === "stroke") for (const p of o.points || []) grow(p.x, p.y);
      else if (o.type === "line") { grow(o.x1 || 0, o.y1 || 0); grow(o.x2 || 0, o.y2 || 0); }
      else if (["rect", "circle", "image"].includes(o.type)) { grow(o.x || 0, o.y || 0); grow((o.x || 0) + (o.w || 0), (o.y || 0) + (o.h || 0)); }
      else if (o.type === "text") { const l = getCanvasTextLayout(measure, o); grow(o.x || 0, (o.y || 0) - l.fontSize); grow((o.x || 0) + l.width, (o.y || 0) + l.height); }
    }
    if (!Number.isFinite(minX)) return;
    const pad = 28; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const scale = Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY), 1.4);
    const ox = (W - (maxX - minX) * scale) / 2 - minX * scale, oy = (H - (maxY - minY) * scale) / 2 - minY * scale;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale);
    for (const o of objects) {
      ctx.strokeStyle = o.color || "#334155"; ctx.fillStyle = o.color || "#334155"; ctx.lineWidth = Math.max(.9, (o.width || 2) / Math.max(.4, scale) * .6); ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (o.type === "stroke") { ctx.beginPath(); (o.points || []).forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke(); }
      else if (o.type === "line") { ctx.beginPath(); ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); ctx.stroke(); }
      else if (o.type === "rect") ctx.strokeRect(o.x, o.y, o.w, o.h);
      else if (o.type === "circle") { ctx.beginPath(); ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
      else if (o.type === "image") { ctx.globalAlpha = .18; ctx.fillRect(o.x, o.y, o.w, o.h); ctx.globalAlpha = 1; }
      else if (o.type === "text") { const l = getCanvasTextLayout(measure, o); ctx.font = `${l.fontSize}px ${FONT_STACK}`; l.lines.forEach((line, i) => ctx.fillText(line, o.x, o.y + i * l.lineHeight)); }
    }
    ctx.restore();
  }, [board]);
  const empty = !(Array.isArray(board.preview) && board.preview.length);
  return <div className="thumb boardThumb"><canvas ref={ref} />{empty && <span className="thumbEmpty">Leeres Board</span>}</div>;
}
