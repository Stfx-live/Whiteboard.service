// Diagramm-Generator: erzeugt aus einer Konfiguration normale Board-Objekte (Linien, Pfeile, Texte, Striche, Rechtecke).
// Dadurch sind Diagramme live synchron, rückgängig-fähig, exportierbar und lassen sich wie alles andere auswählen/verschieben.
import { FONT_STACK, getMeasureCtx } from "./geometry";
import { simplifyPoints } from "./geometry";

export const DIAGRAM_KINDS = [
  { id: "coord", label: "Koordinatensystem" },
  { id: "table", label: "Tabelle" },
  { id: "numberline", label: "Zahlenstrahl" },
  { id: "bars", label: "Säulen" },
  { id: "lines", label: "Linien" },
  { id: "pie", label: "Kreis" },
];
export const DEFAULT_DIAGRAM = {
  kind: "coord",
  cellMul: 1,
  // Koordinatensystem
  form: "L", nx: 10, ny: 10, step: 1, xLabel: "x", yLabel: "y", arrows: true, gridLines: false, points: "", funcs: "",
  // Tabelle
  rows: 4, cols: 3, cellW: 4, cellH: 2, header: true, content: "",
  // Zahlenstrahl
  from: 0, to: 10, nlStep: 1, perStep: 2, marks: "",
  // Säulen
  data: "A: 4\nB: 7\nC: 5", title: "", barH: 10,
};
export const LIMITS = { nx: [1, 40], ny: [1, 40], rows: [1, 30], cols: [1, 12], cellW: [1, 20], cellH: [1, 8], perStep: [1, 10], barH: [3, 24] };

const clampN = (v, [a, b], d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
export const cleanConfig = c => {
  const o = { ...DEFAULT_DIAGRAM, ...c };
  for (const k of Object.keys(LIMITS)) o[k] = clampN(o[k], LIMITS[k], DEFAULT_DIAGRAM[k]);
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.max(0.0001, Math.min(1e7, n)) : d; };
  o.step = pos(o.step, 1);
  o.nlStep = pos(o.nlStep, 1);
  o.cellMul = [1, 2, 3, 4].includes(Number(o.cellMul)) ? Number(o.cellMul) : 1;
  const lim = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-1e9, Math.min(1e9, n)) : d; };
  o.from = lim(o.from, 0);
  o.to = lim(o.to, 10);
  if (o.to <= o.from) o.to = o.from + o.nlStep;
  if ((o.to - o.from) / o.nlStep > 60) o.to = o.from + o.nlStep * 60;
  return o;
};

function textWidth(t, fs) { const c = getMeasureCtx(); c.save(); c.font = `${fs}px ${FONT_STACK}`; const w = c.measureText(t).width; c.restore(); return w; }
export const fmt = v => { const r = Math.round(v * 1e6) / 1e6; return (Object.is(r, -0) ? "0" : String(r)).replace(".", ",").replace(/^-/, "−"); };
const parseNum = s => Number(String(s).trim().replace(",", ".").replace("−", "-"));

const line = (x1, y1, x2, y2, color, width = 2) => ({ type: "line", x1, y1, x2, y2, color, width });
const arrow = (x1, y1, x2, y2, color, width = 2) => ({ type: "arrow", x1, y1, x2, y2, color, width });
const dot = (x, y, color, d = 9) => ({ type: "stroke", points: [{ x, y }], color, width: d });
// x = linke Kante, y = Grundlinie. align: left | center | right (über gemessene Breite umgerechnet)
function text(t, x, y, color, fs, align = "left") {
  t = String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) return null; // leere Beschriftungen gar nicht erst erzeugen (der Server würde sie verwerfen)
  const w = align === "left" ? 0 : textWidth(t, fs);
  return { type: "text", text: t, x: Math.round((align === "center" ? x - w / 2 : align === "right" ? x - w : x) * 100) / 100, y: Math.round(y * 100) / 100, fontSize: fs, color, maxWidth: 600 };
}
const fontFor = U => Math.max(12, Math.min(22, Math.round(U * 0.6)));

/* ───────── Funktionen (y = …) ───────── */
export function compileFunction(src) {
  const s = String(src || "").replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=\s*/i, "").replace(/,/g, ".").replace(/−/g, "-").replace(/π/g, "pi");
  const toks = []; const re = /\s*(\d+(?:\.\d+)?|\.\d+|[a-zA-Z]+|[-+*/^()])/y; let m; re.lastIndex = 0;
  let pos = 0;
  while (pos < s.length) { re.lastIndex = pos; m = re.exec(s); if (!m) { if (/^\s*$/.test(s.slice(pos))) break; return null; } toks.push(m[1]); pos = re.lastIndex; }
  if (!toks.length) return null;
  const FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, exp: Math.exp };
  let i = 0; let bad = false;
  const peek = () => toks[i], next = () => toks[i++];
  const isNum = t => t !== undefined && /^[\d.]/.test(t), isId = t => t !== undefined && /^[a-zA-Z]/.test(t);
  function expr() { let l = term(); while (peek() === "+" || peek() === "-") { const op = next(), r = term(), a = l; l = op === "+" ? x => a(x) + r(x) : x => a(x) - r(x); } return l; }
  function term() {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t === "*" || t === "/") { next(); const r = unary(), a = l; l = t === "*" ? x => a(x) * r(x) : x => a(x) / r(x); }
      else if (isNum(t) || isId(t) || t === "(") { const r = unary(), a = l; l = x => a(x) * r(x); } // implizit: 2x, 2(x+1)
      else break;
    }
    return l;
  }
  function unary() { if (peek() === "-") { next(); const a = unary(); return x => -a(x); } if (peek() === "+") { next(); return unary(); } return power(); }
  function power() { const b = atom(); if (peek() === "^") { next(); const e = unary(); return x => Math.pow(b(x), e(x)); } return b; }
  function atom() {
    const t = next();
    if (t === undefined) { bad = true; return () => NaN; }
    if (isNum(t)) { const n = Number(t); return () => n; }
    if (t === "(") { const e = expr(); if (next() !== ")") bad = true; return e; }
    if (isId(t)) {
      const id = t.toLowerCase();
      if (id === "x") return x => x;
      if (id === "pi") return () => Math.PI;
      if (id === "e") return () => Math.E;
      if (FUNCS[id]) { if (next() !== "(") { bad = true; return () => NaN; } const e = expr(); if (next() !== ")") bad = true; const f = FUNCS[id]; return x => f(e(x)); }
    }
    bad = true; return () => NaN;
  }
  const f = expr();
  if (bad || i < toks.length) return null;
  try { if (!Number.isFinite(f(1)) && !Number.isFinite(f(2)) && !Number.isFinite(f(0.5))) { /* kann z. B. 1/x oder ln(x) sein – trotzdem zulassen */ } } catch { return null; }
  return f;
}

export function parsePoints(src) {
  const out = []; const re = /([A-Za-zÄÖÜäöü][\wÄÖÜäöü]{0,3})?\s*\(\s*(-?[\d.,]+)\s*[|;/]\s*(-?[\d.,]+)\s*\)/g; let m;
  while ((m = re.exec(String(src || "").replace(/−/g, "-")))) { const x = parseNum(m[2]), y = parseNum(m[3]); if (Number.isFinite(x) && Number.isFinite(y)) out.push({ name: m[1] || "", x, y }); }
  return out.slice(0, 60);
}

/* ───────── Koordinatensystem ───────── */
function buildCoord(c, ox, oy, U, color) {
  const out = [], fs = fontFor(U), plus = c.form === "+", nx = c.nx, ny = c.ny, step = c.step;
  const X = v => ox + (v / step) * U, Y = v => oy - (v / step) * U;
  const x0 = plus ? -nx : 0, y0 = plus ? -ny : 0, ext = U * 0.9;
  if (c.gridLines) { const g = "#b6bfd3"; for (let i = x0; i <= nx; i++) if (i) out.push(line(X(i * step), Y(y0 * step), X(i * step), Y(ny * step), g, 1)); for (let j = y0; j <= ny; j++) if (j) out.push(line(X(x0 * step), Y(j * step), X(nx * step), Y(j * step), g, 1)); }
  // Achsen (Pfeile an den positiven Enden)
  const xs = plus ? X(x0 * step) : ox, ys = plus ? Y(y0 * step) : oy;
  const ax = c.arrows ? arrow : line;
  out.push(ax(xs, oy, X(nx * step) + ext, oy, color, 2.5), ax(ox, ys, ox, Y(ny * step) - ext, color, 2.5));
  const every = nx > 24 ? 2 : 1, everyY = ny > 24 ? 2 : 1;
  for (let i = x0; i <= nx; i++) {
    if (!i) continue; out.push(line(X(i * step), oy - 4, X(i * step), oy + 4, color, 2));
    if (i % every === 0) out.push(text(fmt(i * step), X(i * step), oy + 7 + fs, color, fs, "center"));
  }
  for (let j = y0; j <= ny; j++) {
    if (!j) continue; out.push(line(ox - 4, Y(j * step), ox + 4, Y(j * step), color, 2));
    if (j % everyY === 0) out.push(text(fmt(j * step), ox - 9, Y(j * step) + fs * 0.35, color, fs, "right"));
  }
  out.push(plus ? text("0", ox + 6, oy + 7 + fs, color, fs, "left") : text("0", ox - 7, oy + 7 + fs, color, fs, "right")); // bei „+“ rechts unten, damit „−1“ nicht überlappt
  if (c.xLabel) out.push(text(c.xLabel, X(nx * step) + ext + 8, oy + fs * 0.35, color, fs + 2, "left"));
  if (c.yLabel) out.push(text(c.yLabel, ox, Y(ny * step) - ext - 8, color, fs + 2, "center"));
  // Funktionen
  const PAL = ["#ef4444", "#3b82f6", "#22c55e", "#f97316", "#8b5cf6"];
  String(c.funcs || "").split(/\n/).map(s => s.trim()).filter(Boolean).slice(0, 5).forEach((src, k) => {
    const f = compileFunction(src); if (!f) return;
    const xmin = x0 * step, xmax = nx * step, ymin = y0 * step, ymax = ny * step, N = Math.max(200, nx * 40);
    let seg = []; const flush = () => { if (seg.length >= 2) out.push({ type: "stroke", points: simplifyPoints(seg, 0.25), color: PAL[k % PAL.length], width: 3 }); seg = []; };
    for (let s = 0; s <= N; s++) {
      const xv = xmin + (xmax - xmin) * s / N; let yv; try { yv = f(xv); } catch { yv = NaN; }
      if (!Number.isFinite(yv) || yv < ymin - 1e-9 || yv > ymax + 1e-9) { flush(); continue; }
      seg.push({ x: X(xv), y: Y(yv) });
    }
    flush();
  });
  // Punkte
  parsePoints(c.points).forEach((p, k) => {
    if (p.x < x0 * step - 1e-9 || p.x > nx * step + 1e-9 || p.y < y0 * step - 1e-9 || p.y > ny * step + 1e-9) return;
    out.push(dot(X(p.x), Y(p.y), PAL[(k + 1) % PAL.length], 10));
    if (p.name) out.push(text(p.name, X(p.x) + 8, Y(p.y) - 8, color, fs, "left"));
  });
  return out;
}

/* ───────── Tabelle ───────── */
export function parseTable(src) { return String(src || "").replace(/\r/g, "").split("\n").map(r => r.split(/\t|;/).map(s => s.trim())); }
function buildTable(c, ox, oy, U, color) {
  const out = [], grid = parseTable(c.content), hasContent = grid.some(r => r.some(Boolean));
  const rows = Math.min(30, Math.max(c.rows, hasContent ? grid.length : 0)), cols = Math.min(12, Math.max(c.cols, hasContent ? Math.max(...grid.map(r => r.length)) : 0));
  const rh = c.cellH * U, fs = Math.max(12, Math.min(24, Math.round(rh * 0.42)));
  const widths = Array.from({ length: cols }, (_, ci) => Math.max(c.cellW * U, hasContent ? Math.ceil(Math.max(0, ...grid.map(r => r[ci] ? textWidth(r[ci], fs) : 0)) + 20) : 0));
  const xs = [ox]; widths.forEach(w => xs.push(xs[xs.length - 1] + w));
  const W = xs[cols] - ox, H = rows * rh;
  if (c.header) out.push({ type: "rect", x: ox, y: oy, w: W, h: rh, color, width: 2, fill: true });
  for (let r = 0; r <= rows; r++) out.push(line(ox, oy + r * rh, ox + W, oy + r * rh, color, r === 0 || r === rows || (c.header && r === 1) ? 3 : 2));
  for (let ci = 0; ci <= cols; ci++) out.push(line(xs[ci], oy, xs[ci], oy + H, color, ci === 0 || ci === cols ? 3 : 2));
  for (let r = 0; r < rows; r++) for (let ci = 0; ci < cols; ci++) {
    const t = grid[r]?.[ci]; if (!t) continue;
    const head = c.header && r === 0;
    out.push(text(t, head ? (xs[ci] + xs[ci + 1]) / 2 : xs[ci] + 10, oy + r * rh + rh / 2 + fs * 0.35, color, fs, head ? "center" : "left"));
  }
  return out;
}

/* ───────── Zahlenstrahl ───────── */
function buildNumberLine(c, ox, oy, U, color) {
  const out = [], fs = fontFor(U), n = Math.round((c.to - c.from) / c.nlStep), per = c.perStep * U, L = n * per;
  out.push(arrow(ox - U * 0.6, oy, ox + L + U * 1.1, oy, color, 2.5));
  for (let i = 0; i <= n; i++) { const x = ox + i * per; out.push(line(x, oy - 6, x, oy + 6, color, 2)); out.push(text(fmt(c.from + i * c.nlStep), x, oy + 12 + fs, color, fs, "center")); }
  String(c.marks || "").split(/[;\s]+/).map(parseNum).filter(Number.isFinite).slice(0, 30).forEach(v => { if (v >= c.from - 1e-9 && v <= c.to + 1e-9) out.push(dot(ox + (v - c.from) / c.nlStep * per, oy, "#ef4444", 12)); });
  return out;
}

/* ───────── Säulendiagramm ───────── */
function niceStep(max, boxes) { const raw = Math.max(max, 1e-9) / boxes; const p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw - 1e-12) return m * p; return 10 * p; }
export function parseBars(src) { return String(src || "").split(/\n/).map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.*?)[:;=\t]\s*(-?[\d.,]+)\s*$/); if (!m) return null; const v = parseNum(m[2]); return Number.isFinite(v) ? { name: m[1].trim(), value: Math.max(0, v) } : null; }).filter(Boolean).slice(0, 16); }
function buildBars(c, ox, oy, U, color) {
  const out = [], fs = fontFor(U), data = parseBars(c.data); if (!data.length) return out;
  const max = Math.max(1e-9, ...data.map(d => d.value)) < 1e-6 ? 1 : Math.max(...data.map(d => d.value)), s = niceStep(max, c.barH), boxes = Math.max(1, Math.ceil(max / s - 1e-9)), H = boxes * U;
  const barW = 2 * U, gap = U, W = data.length * (barW + gap) + gap;
  const PAL = ["#6366f1", "#ef4444", "#22c55e", "#f97316", "#06b6d4", "#ec4899", "#eab308", "#8b5cf6"];
  out.push(arrow(ox, oy, ox + W + U * 0.8, oy, color, 2.5), arrow(ox, oy, ox, oy - H - U * 0.8, color, 2.5));
  for (let j = 0; j <= boxes; j++) { const y = oy - j * U; if (j) out.push(line(ox - 4, y, ox + 4, y, color, 2)); out.push(text(fmt(j * s), ox - 9, y + fs * 0.35, color, fs, "right")); }
  data.forEach((d, i) => {
    const x = ox + gap + i * (barW + gap), h = Math.max(1, d.value / s * U), col = PAL[i % PAL.length];
    out.push({ type: "rect", x, y: oy - h, w: barW, h, color: col, width: 2.5, fill: true });
    out.push(text(fmt(d.value), x + barW / 2, oy - h - 6, color, fs, "center"));
    out.push(text(d.name, x + barW / 2, oy + 8 + fs, color, fs, "center"));
  });
  if (c.title) out.push(text(c.title, ox + W / 2, oy - H - U * 0.8 - 12, color, fs + 4, "center"));
  return out;
}

/* ───────── Liniendiagramm ───────── */
function buildLines(c, ox, oy, U, color) {
  const out = [], fs = fontFor(U), data = parseBars(c.data); if (!data.length) return out;
  const max = Math.max(...data.map(d => d.value)), s = niceStep(max < 1e-6 ? 1 : max, c.barH), boxes = Math.max(1, Math.ceil((max < 1e-6 ? 1 : max) / s - 1e-9)), H = boxes * U;
  const dx = 2 * U, W = (data.length + 1) * dx;
  out.push(arrow(ox, oy, ox + W + U * 0.8, oy, color, 2.5), arrow(ox, oy, ox, oy - H - U * 0.8, color, 2.5));
  for (let j = 0; j <= boxes; j++) { const y = oy - j * U; if (j) out.push(line(ox - 4, y, ox + 4, y, color, 2), line(ox, y, ox + W, y, "#d5dbe8", 1)); out.push(text(fmt(j * s), ox - 9, y + fs * 0.35, color, fs, "right")); }
  const pts = data.map((d, i) => ({ x: ox + (i + 1) * dx, y: oy - Math.max(0, d.value) / s * U }));
  if (pts.length >= 2) out.push({ type: "stroke", points: sharpCorners(pts), color: "#6366f1", width: 3.5 });
  data.forEach((d, i) => {
    out.push(dot(pts[i].x, pts[i].y, "#6366f1", 11));
    out.push(line(pts[i].x, oy - 4, pts[i].x, oy + 4, color, 2));
    out.push(text(fmt(d.value), pts[i].x, pts[i].y - 12, color, fs, "center"));
    out.push(text(d.name, pts[i].x, oy + 8 + fs, color, fs, "center"));
  });
  if (c.title) out.push(text(c.title, ox + W / 2, oy - H - U * 0.8 - 12, color, fs + 4, "center"));
  return out;
}

/* ───────── Kreisdiagramm (Sektoren als Umriss, Beschriftung mit Prozent) ───────── */
// Der Strich-Renderer glättet Ecken; mit zwei winzig versetzten Zusatzpunkten pro Ecke bleiben sie scharf.
function sharpCorners(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], n = pts[i + 1], l1 = Math.hypot(b.x - a.x, b.y - a.y) || 1, l2 = Math.hypot(n.x - b.x, n.y - b.y) || 1;
    out.push({ x: b.x - (b.x - a.x) / l1 * 0.05, y: b.y - (b.y - a.y) / l1 * 0.05 }, b, { x: b.x + (n.x - b.x) / l2 * 0.05, y: b.y + (n.y - b.y) / l2 * 0.05 });
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function buildPie(c, cx, cy, U, color) {
  const out = [], fs = fontFor(U), data = parseBars(c.data).filter(d => d.value > 0); if (!data.length) return out;
  const total = data.reduce((a, d) => a + d.value, 0), R = 5 * U, PAL = ["#6366f1", "#ef4444", "#22c55e", "#f97316", "#06b6d4", "#ec4899", "#eab308", "#8b5cf6"];
  let a0 = -Math.PI / 2;
  data.forEach((d, i) => {
    const sweep = d.value / total * Math.PI * 2, a1 = a0 + sweep, col = PAL[i % PAL.length], n = Math.max(3, Math.ceil(sweep / (Math.PI / 36)));
    const pts = data.length === 1 ? [] : [{ x: cx, y: cy }];
    for (let k = 0; k <= n; k++) { const a = a0 + sweep * k / n; pts.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R }); }
    if (data.length === 1) pts.push(pts[0]); else pts.push({ x: cx, y: cy });
    out.push({ type: "stroke", points: sharpCorners(pts), color: col, width: 4 });
    const am = a0 + sweep / 2, lx = cx + Math.cos(am) * (R + U * 0.6), right = Math.cos(am) >= 0;
    out.push(text(`${d.name} ${fmt(Math.round(d.value / total * 1000) / 10)} %`, lx, cy + Math.sin(am) * (R + U * 0.6) + fs * 0.35, color, fs, right ? "left" : "right"));
    a0 = a1;
  });
  if (c.title) out.push(text(c.title, cx, cy - R - U * 0.9, color, fs + 4, "center"));
  return out;
}

/** Erzeugt alle Objekte. (ox, oy) ist der Ankerpunkt: Nullpunkt (Koordinatensystem, Zahlenstrahl, Säulen) bzw. linke obere Ecke (Tabelle). */
export function buildDiagram(cfg, ox, oy, bgSize = 24, color = "#111827") {
  const c = cleanConfig(cfg), U = Math.max(8, Number(bgSize) || 24) * c.cellMul;
  ox = Number.isFinite(Number(ox)) ? Number(ox) : 0; oy = Number.isFinite(Number(oy)) ? Number(oy) : 0;
  const make = c.kind === "table" ? buildTable : c.kind === "numberline" ? buildNumberLine : c.kind === "bars" ? buildBars : c.kind === "lines" ? buildLines : c.kind === "pie" ? buildPie : buildCoord;
  return make(c, ox, oy, U, color).filter(Boolean);
}
export const snapToGrid = (v, size) => Math.round(v / Math.max(4, Number(size) || 24)) * Math.max(4, Number(size) || 24);
export const anchorHint = kind => kind === "table" ? "linke obere Ecke der Tabelle" : kind === "numberline" ? "Startpunkt des Zahlenstrahls" : (kind === "bars" || kind === "lines") ? "Nullpunkt (unten links)" : kind === "pie" ? "Mittelpunkt des Kreises" : "Nullpunkt";
