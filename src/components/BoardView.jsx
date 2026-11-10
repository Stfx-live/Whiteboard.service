import React, { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { Spinner } from "./Loading";
import { Icon, Avatar } from "./Icons";
import { ParticipantsPanel, GuestShareModal } from "./Modals";
import { TimerWidget, useBoardTimer } from "./Timer";
import { toast, askConfirm } from "./Toast";
import { API, api, upload, uid } from "../lib/api";
import {
  ZOOM_MIN, ZOOM_MAX, TEXT_MAX_LENGTH, TEXT_DEFAULT_WIDTH, TEXT_BASELINE, FONT_STACK, colorFromId, hitObject, hitPoint, isLine,
  objectBounds, selectedBounds, shiftObject, rotateObject, scaleObject, bboxInLasso, rectsIntersect, simplifyPoints, compressImageFile } from "../lib/geometry";
import { drawObject, drawBackground, drawSelection, strokePath, preloadImages, isDarkColor, getImage } from "../lib/render";
import { createHistory, pushHistory, undoHistory, redoHistory } from "../lib/undoRedo";
import { contentBounds, exportPng, exportJson, buildPdf, renderExportCanvas } from "../lib/export";
import { inRect, boxInRect, clampTo, zoneBox, unionRect, drawZoneFills, drawZoneFrames, ZONE_MODES } from "../lib/zones";
import ZonesPanel from "./ZonesPanel";
import DiagramPanel from "./DiagramPanel";
import { buildDiagram, cleanConfig, DEFAULT_DIAGRAM, snapToGrid } from "../lib/diagram";

const DEFAULT_BG = { color: "#ffffff", pattern: "grid", size: 24 };
const TOOLS = [
  { id: "select", icon: "select", label: "Auswählen", key: "V" },
  { id: "hand", icon: "hand", label: "Ansicht verschieben", key: "H" },
  { id: "lasso", icon: "lasso", label: "Lasso-Auswahl", key: "L" },
  "sep",
  { id: "pen", icon: "pen", label: "Stift", key: "P" },
  { id: "marker", icon: "marker", label: "Textmarker", key: "M" },
  { id: "eraser", icon: "eraser", label: "Radierer", key: "E" },
  "sep",
  { id: "line", icon: "line", label: "Linie", key: "I" },
  { id: "arrow", icon: "arrow", label: "Pfeil", key: "A" },
  { id: "rect", icon: "rect", label: "Rechteck", key: "R" },
  { id: "circle", icon: "circle", label: "Kreis", key: "O" },
  { id: "text", icon: "text", label: "Text", key: "T" },
  { id: "diagram", icon: "chart", label: "Diagramm & Tabelle", key: "D" },
];
const TOOL_KEYS = Object.fromEntries(TOOLS.filter(t => t !== "sep").map(t => [t.key.toLowerCase(), t.id]));
const COLORS = ["#111827", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#ffffff"];
const BGS = [
  ["Weiß", "#ffffff", "none", 24], ["Raster", "#ffffff", "grid", 24], ["Feines Raster", "#ffffff", "grid", 12], ["Punkte", "#ffffff", "dots", 24], ["Linien", "#ffffff", "lines", 32],
  ["Creme", "#fffaf0", "grid", 24], ["Himmel", "#f2f7ff", "dots", 24], ["Mint", "#f2fbf5", "grid", 24], ["Lavendel", "#f7f3ff", "dots", 24],
  ["Nacht", "#151a2a", "grid", 24], ["Nacht Punkte", "#151a2a", "dots", 24], ["Tafel", "#1d3b34", "none", 24],
];
const fontFromWidth = w => Math.round(Math.max(16, Math.min(120, 12 + w * 5)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isTyping = t => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable;
const DRAW_TOOLS = new Set(["pen", "marker", "eraser", "line", "arrow", "rect", "circle", "text"]);
const ZONE_TOOL = { id: "zone", icon: "zone", label: "Bereich", key: "B" };
const NO_SCOPE = { restricted: false, seeAll: true, writableIds: [] };

// Entfernte Cursor: eigener kleiner Store, damit 25 Hz Cursor-Updates nicht die ganze Board-Ansicht neu rendern.
function useCursorStore() {
  const ref = useRef({ data: {}, listeners: new Set() });
  const api2 = useMemo(() => ({
    set(c) { ref.current.data = { ...ref.current.data, [c.userId]: { ...c, t: performance.now() } }; ref.current.listeners.forEach(f => f()); },
    keepOnly(ids) { const next = Object.fromEntries(Object.entries(ref.current.data).filter(([id]) => ids.has(id))); ref.current.data = next; ref.current.listeners.forEach(f => f()); },
    clear() { ref.current.data = {}; ref.current.listeners.forEach(f => f()); },
    subscribe(f) { ref.current.listeners.add(f); return () => ref.current.listeners.delete(f); },
    get: () => ref.current.data,
  }), []);
  return api2;
}
function CursorLayer({ store, view }) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force(n => n + 1)), [store]);
  useEffect(() => { const id = setInterval(() => force(n => n + 1), 2500); return () => clearInterval(id); }, []);
  const now = performance.now();
  return <>{Object.values(store.get()).filter(c => now - c.t < 20000).map(c => {
    const color = colorFromId(c.userId), idle = now - c.t > 6000;
    return <div key={c.userId} className={`remoteCursor ${idle ? "idle" : ""}`} style={{ transform: `translate(${c.x * view.zoom + view.pan.x}px, ${c.y * view.zoom + view.pan.y}px)`, "--cursor": color }}>
      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 3l16 7.5-6.8 2L10.5 20z" fill={color} stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      <span>{c.username}</span>
    </div>;
  })}</>;
}

export default function BoardView({ socket, board: boardProp, account, guest, token, theme, setTheme, onExit }) {
  const boardId = boardProp.id;
  const isGuest = Boolean(guest);
  const isAdmin = account?.role === "admin" && !isGuest;
  const identityId = account?.id || guest?.guest?.id || null;
  const selfName = guest?.guest?.displayName || account?.displayName || account?.username || "Du";

  const [boardName, setBoardName] = useState(boardProp.name);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(socket.connected);
  const [strokes, setStrokes] = useState([]);
  const [files, setFiles] = useState([]);
  const [bg, setBg] = useState(boardProp.background && typeof boardProp.background === "object" ? boardProp.background : DEFAULT_BG);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#111827");
  const [width, setWidth] = useState(4);
  const [fill, setFill] = useState(false);
  const [pencilMode, setPencilMode] = useState(false);
  const [selectedIds, setSelectedIdsState] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [view, setViewState] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const [participants, setParticipants] = useState([]);
  const [serverRO, setReadOnly] = useState(isGuest && guest?.guest?.mode === "view-only");
  const [propsHidden, setPropsHidden] = useState(false);
  const [diagCfg, setDiagCfg] = useState(() => { try { return { ...DEFAULT_DIAGRAM, ...JSON.parse(localStorage.getItem("wb-diagram") || "{}") }; } catch { return DEFAULT_DIAGRAM; } });
  const diagPrev = useRef({ key: "", items: [] });
  useEffect(() => { try { localStorage.setItem("wb-diagram", JSON.stringify(diagCfg)); } catch {} }, [diagCfg]);
  const [zones, setZones] = useState([]);
  const [zoneScope, setZoneScope] = useState(NO_SCOPE);
  const [selZone, setSelZoneState] = useState(null);
  const [zonePanel, setZonePanel] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [allowDeleteOthers, setAllowDeleteOthers] = useState(false);
  const [viewSyncEnabled, setViewSyncEnabled] = useState(false);
  const [popover, setPopover] = useState(null); // "bg" | "export" | "people" | null
  const [shareOpen, setShareOpen] = useState(false);
  const [invites, setInvites] = useState([]);
  const [shareError, setShareError] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [textEdit, setTextEditState] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfPreview, setPdfPreview] = useState("");
  const [pdfConfig, setPdfConfig] = useState({ area: "viewport", quality: 2, paper: "a4", orientation: "landscape", mode: "raster" });
  const [busy, setBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const baseRef = useRef(null), overlayRef = useRef(null), stackRef = useRef(null), textRef = useRef(null), fileInput = useRef(null);
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } });
  const viewSyncTimer = useRef(null), frame = useRef(null), anim = useRef(null), hostTimer = useRef(null);
  const sharedCenter = useRef(null), latestHostSeq = useRef(0);
  const act = useRef(null), touches = useRef(new Map()), gesture = useRef(null), spaceDown = useRef(false), hover = useRef(null), cursorSent = useRef(0);
  const override = useRef(new Map()), remoteLive = useRef(new Map());
  const committedIds = useRef(new Set()), pendingOps = useRef([]), historyRef = useRef(createHistory());
  const clipboard = useRef([]), pasteCount = useRef(0), localClear = useRef(false);
  const selectedRef = useRef([]), textEditRef = useRef(null), liveTimer = useRef(null);
  const cursors = useCursorStore();
  const baseState = useRef({ key: null, arr: null }), zoneOv = useRef(null), zoneToastAt = useRef(0), zoneSigRef = useRef("");
  const zoneRO = zoneScope.restricted && zoneScope.writableIds.length === 0;
  const readOnly = serverRO || zoneRO;
  const writableZones = zoneScope.restricted ? zones.filter(z => zoneScope.writableIds.includes(z.id)) : null;
  const exitRef = useRef(onExit); exitRef.current = onExit;
  const fns = useRef({});

  const viewLocked = viewSyncEnabled && !isAdmin;
  const canControlTimer = isAdmin;
  const timerApi = useBoardTimer(socket, boardId, canControlTimer);

  // Aktueller Stand für Event-Handler (wird bei jedem Render aktualisiert → keine veralteten Closures).
  const S = useRef({});
  S.current = { diagCfg, strokes, bg, tool, color, width, fill, pencilMode, readOnly, serverRO, zones, zoneScope, wz: writableZones, selZone, viewLocked, isAdmin, allowDeleteOthers, identityId, viewSyncEnabled, selectedIds, hiddenId: textEdit?.id || null, theme };

  /* ───────────── Zeichenfläche: Frame-Rendering ───────────── */
  function scheduleFrame() { if (frame.current) return; frame.current = requestAnimationFrame(renderFrame); }
  const eraserRadius = () => Math.max(10, S.current.width * 2.5) / viewRef.current.zoom;

  function renderFrame() {
    frame.current = null;
    const base = baseRef.current, ov = overlayRef.current, host = stackRef.current;
    if (!base || !ov || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const d = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [base, ov]) { const cw = Math.round(w * d), ch = Math.round(h * d); if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; } }
    const v = viewRef.current, st = S.current, over = override.current;
    const x = base.getContext("2d");
    const m = 8 / v.zoom;
    const vr = { left: -v.pan.x / v.zoom, top: -v.pan.y / v.zoom, right: (w - v.pan.x) / v.zoom, bottom: (h - v.pan.y) / v.zoom, zoom: v.zoom };
    const zov = zoneOv.current, zl = st.zones.length ? (zov ? st.zones.map(z => z.id === zov.id ? { ...z, ...zov.rect } : z) : st.zones) : st.zones;
    // Basis-Ebene (Hintergrund + Objekte) wird nur neu gezeichnet, wenn sich Ansicht/Objekte ändern; neue Striche werden
    // einfach oben drauf gezeichnet. Cursor, Live-Striche anderer, Auswahl & Bereichsrahmen liegen auf der Overlay-Ebene.
    const bs = baseState.current, arr = st.strokes;
    const zsig = zl.length ? zl.map(z => `${z.id}${z.x},${z.y},${z.w},${z.h},${z.color}`).join(";") : "";
    const key = `${w}|${h}|${d}|${v.pan.x}|${v.pan.y}|${v.zoom}|${st.bg.color}|${st.bg.pattern}|${st.bg.size}|${zsig}|${st.hiddenId || ""}`;
    let mode = "full";
    if (!over.size && bs.key === key && bs.arr) {
      if (bs.arr === arr) mode = "none";
      else if (arr.length > bs.arr.length) { mode = "append"; for (let i = 0; i < bs.arr.length; i++) if (arr[i] !== bs.arr[i]) { mode = "full"; break; } }
    }
    if (mode !== "none") {
      x.setTransform(d, 0, 0, d, 0, 0);
      if (mode === "full") { x.fillStyle = st.bg.color; x.fillRect(0, 0, w, h); }
      x.save(); x.translate(v.pan.x, v.pan.y); x.scale(v.zoom, v.zoom);
      if (mode === "full") { drawBackground(x, st.bg, vr); if (zl.length) drawZoneFills(x, zl); }
      const onImg = () => { baseState.current.key = null; scheduleFrame(); };
      const visible = s => { const b = objectBounds(s); return !b || !(b.x - m > vr.right || b.x + b.w + m < vr.left || b.y - m > vr.bottom || b.y + b.h + m < vr.top || (s.type !== "image" && Math.max(b.w, b.h) * v.zoom < 0.9)); };
      for (let i = mode === "append" ? bs.arr.length : 0; i < arr.length; i++) {
        const s0 = arr[i];
        if (s0._id === st.hiddenId) continue;
        const s = over.size ? (over.get(s0._id) || s0) : s0;
        if (visible(s)) drawObject(x, s, { onImageLoad: onImg });
      }
      x.restore();
      bs.key = over.size ? null : key; bs.arr = over.size ? null : arr;
    }

    const o = ov.getContext("2d");
    o.setTransform(d, 0, 0, d, 0, 0); o.clearRect(0, 0, w, h);
    o.save(); o.translate(v.pan.x, v.pan.y); o.scale(v.zoom, v.zoom);
    remoteLive.current.forEach(s => drawObject(o, s));
    if (st.zoneScope.restricted) { // Außerhalb der erlaubten Bereiche abdunkeln
      const keep = st.zoneScope.seeAll ? zl.filter(z => st.zoneScope.writableIds.includes(z.id)) : zl;
      o.save(); o.beginPath(); o.rect(vr.left - 20, vr.top - 20, vr.right - vr.left + 40, vr.bottom - vr.top + 40);
      keep.forEach(z => o.rect(z.x, z.y, z.w, z.h));
      if (st.zoneScope.seeAll) { o.globalAlpha = 0.24; o.fillStyle = isDarkColor(st.bg.color) ? "#000" : "#334155"; } else { o.globalAlpha = 0.94; o.fillStyle = st.bg.color; }
      o.fill("evenodd"); o.restore();
    }
    if (zl.length) drawZoneFrames(o, zl, v.zoom, st.isAdmin ? st.selZone : null);
    if (st.tool === "diagram" && !st.readOnly && hover.current && !act.current) { // Vorschau des Diagramms am Mauszeiger
      const bgs = Math.max(4, Number(st.bg.size) || 24), key = JSON.stringify([st.diagCfg, bgs, st.color]);
      if (diagPrev.current.key !== key) diagPrev.current = { key, items: buildDiagram(st.diagCfg, 0, 0, bgs, st.color) };
      const ox = snapToGrid(hover.current.x, bgs), oy = snapToGrid(hover.current.y, bgs);
      o.save(); o.translate(ox, oy); o.globalAlpha = 0.55; for (const it of diagPrev.current.items) drawObject(o, it); o.restore();
      o.save(); o.fillStyle = "#6366f1"; o.beginPath(); o.arc(ox, oy, 5 / v.zoom, 0, Math.PI * 2); o.fill(); o.restore();
    }
    o.restore();
    const a = act.current;
    if (selectedRef.current.length && !(a && (a.kind === "lasso" || a.kind === "marquee"))) {
      const ids = new Set(selectedRef.current);
      const items = st.strokes.filter(s => ids.has(s._id)).map(s => over.get(s._id) || s);
      if (items.length) drawSelection(o, items, v);
    }
    if (st.isAdmin && st.tool === "zone" && st.selZone) {
      const z = zl.find(q => q.id === st.selZone);
      if (z) { o.save(); o.fillStyle = "#fff"; o.strokeStyle = z.color; o.lineWidth = 2; for (const [hx, hy] of [[z.x, z.y], [z.x + z.w, z.y], [z.x, z.y + z.h], [z.x + z.w, z.y + z.h]]) { const sx = hx * v.zoom + v.pan.x, sy = hy * v.zoom + v.pan.y; o.beginPath(); o.rect(sx - 6, sy - 6, 12, 12); o.fill(); o.stroke(); } o.restore(); }
    }
    if (a) {
      o.save(); o.translate(v.pan.x, v.pan.y); o.scale(v.zoom, v.zoom);
      if (a.kind === "zonenew") {
        const r = { x: Math.min(a.a.x, a.p.x), y: Math.min(a.a.y, a.p.y), w: Math.abs(a.p.x - a.a.x), h: Math.abs(a.p.y - a.a.y) };
        o.fillStyle = "rgba(99,102,241,.12)"; o.strokeStyle = "#6366f1"; o.lineWidth = 2 / v.zoom; o.setLineDash([9 / v.zoom, 6 / v.zoom]); o.fillRect(r.x, r.y, r.w, r.h); o.strokeRect(r.x, r.y, r.w, r.h);
      } else if (a.kind === "draw") {
        o.strokeStyle = st.color; o.lineWidth = a.tool === "marker" ? markerWidth(st.width) : st.width; o.lineCap = "round"; o.lineJoin = "round"; o.fillStyle = st.color;
        if (a.tool === "marker") o.globalAlpha = 0.38;
        if (a.pts.length === 1) { o.beginPath(); o.arc(a.pts[0].x, a.pts[0].y, o.lineWidth / 2, 0, Math.PI * 2); o.fill(); } else { strokePath(o, a.pts); o.stroke(); }
      } else if (a.kind === "shape") {
        const sh = buildShape(a); if (sh) drawObject(o, sh);
      } else if (a.kind === "lasso" && a.pts.length > 1) {
        o.strokeStyle = "#6366f1"; o.lineWidth = 2 / v.zoom; o.setLineDash([8 / v.zoom, 5 / v.zoom]); o.fillStyle = "rgba(99,102,241,.07)";
        o.beginPath(); a.pts.forEach((q, i) => i ? o.lineTo(q.x, q.y) : o.moveTo(q.x, q.y)); o.fill(); o.stroke();
      } else if (a.kind === "marquee") {
        const rx = Math.min(a.a.x, a.p.x), ry = Math.min(a.a.y, a.p.y), rw = Math.abs(a.p.x - a.a.x), rh = Math.abs(a.p.y - a.a.y);
        o.fillStyle = "rgba(99,102,241,.08)"; o.strokeStyle = "#6366f1"; o.lineWidth = 1.2 / v.zoom; o.fillRect(rx, ry, rw, rh); o.strokeRect(rx, ry, rw, rh);
      }
      o.restore();
    }
    if ((st.tool === "eraser" || a?.kind === "erase") && hover.current && !(a && a.kind !== "erase")) {
      const r = eraserRadius() * v.zoom, hx = hover.current.x * v.zoom + v.pan.x, hy = hover.current.y * v.zoom + v.pan.y;
      o.beginPath(); o.arc(hx, hy, r, 0, Math.PI * 2); o.fillStyle = "rgba(239,68,68,.10)"; o.fill(); o.strokeStyle = "rgba(239,68,68,.75)"; o.lineWidth = 1.5; o.stroke();
    }
  }
  const markerWidth = w => Math.max(12, w * 3.2);

  function buildShape(a) {
    const st = S.current, p = a.p, q = a.a;
    let ex = p.x, ey = p.y;
    if (a.shift) {
      if (a.tool === "line" || a.tool === "arrow") { const ang = Math.round(Math.atan2(p.y - q.y, p.x - q.x) / (Math.PI / 12)) * (Math.PI / 12), len = Math.hypot(p.x - q.x, p.y - q.y); ex = q.x + Math.cos(ang) * len; ey = q.y + Math.sin(ang) * len; }
      else { const side = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)); ex = q.x + Math.sign(p.x - q.x || 1) * side; ey = q.y + Math.sign(p.y - q.y || 1) * side; }
    }
    if (a.zone) { const c = clampTo(a.zone, { x: ex, y: ey }); ex = c.x; ey = c.y; }
    if (Math.hypot(ex - q.x, ey - q.y) < 1.5 / viewRef.current.zoom) return null;
    if (a.tool === "line" || a.tool === "arrow") return { type: a.tool, x1: q.x, y1: q.y, x2: ex, y2: ey, color: st.color, width: st.width };
    return { type: a.tool, x: q.x, y: q.y, w: ex - q.x, h: ey - q.y, color: st.color, width: st.width, ...(st.fill ? { fill: true } : {}) };
  }

  /* ───────────── Ansicht (Pan/Zoom) ───────────── */
  function sharedViewPayload() {
    const r = stackRef.current?.getBoundingClientRect(), v = viewRef.current;
    if (!r) return { zoom: v.zoom, pan: { ...v.pan }, center: sharedCenter.current };
    return { zoom: v.zoom, pan: { ...v.pan }, center: { x: (r.width / 2 - v.pan.x) / v.zoom, y: (r.height / 2 - v.pan.y) / v.zoom } };
  }
  function notifyHost() {
    if (!S.current.isAdmin || !S.current.viewSyncEnabled || hostTimer.current) return;
    hostTimer.current = setTimeout(() => { hostTimer.current = null; if (socket.connected) socket.emit("host-view", { boardId, ...sharedViewPayload() }); }, 33);
  }
  function setView(next) {
    const z = clamp(next.zoom, ZOOM_MIN, ZOOM_MAX);
    viewRef.current = { zoom: z, pan: { x: next.pan.x, y: next.pan.y } };
    scheduleFrame(); notifyHost();
    if (!viewSyncTimer.current) viewSyncTimer.current = requestAnimationFrame(() => { viewSyncTimer.current = null; setViewState(viewRef.current); });
  }
  function animateView(target, ms = 260) {
    if (anim.current) cancelAnimationFrame(anim.current);
    const from = viewRef.current, start = performance.now();
    if (ms <= 0) { setView(target); return; }
    const step = now => {
      const p = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - p, 3);
      setView({ zoom: from.zoom + (target.zoom - from.zoom) * e, pan: { x: from.pan.x + (target.pan.x - from.pan.x) * e, y: from.pan.y + (target.pan.y - from.pan.y) * e } });
      anim.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  }
  function zoomAt(factor, cx, cy, animated = false) {
    const v = viewRef.current, z = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX), k = z / v.zoom;
    const next = { zoom: z, pan: { x: cx - (cx - v.pan.x) * k, y: cy - (cy - v.pan.y) * k } };
    animated ? animateView(next, 180) : setView(next);
  }
  function zoomButton(factor) {
    if (S.current.viewLocked) return;
    const r = stackRef.current.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2, true);
  }
  function resetView() { if (S.current.viewLocked) return; const r = stackRef.current.getBoundingClientRect(); animateView({ zoom: 1, pan: { x: 0, y: 0 } }); void r; }
  function fitContent() {
    if (S.current.viewLocked) return;
    const r = stackRef.current.getBoundingClientRect(), b = contentBounds(S.current.strokes, 70);
    if (!b) return animateView({ zoom: 1, pan: { x: 0, y: 0 } });
    const z = clamp(Math.min(r.width / b.w, r.height / b.h, 2), ZOOM_MIN, ZOOM_MAX);
    animateView({ zoom: z, pan: { x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z } });
  }
  function focusRect(r, ms = 340) {
    if (!r || S.current.viewLocked) return;
    const el = stackRef.current; if (!el) return;
    const b = el.getBoundingClientRect(); if (!b.width) return;
    const z = clamp(Math.min((b.width - 90) / r.w, (b.height - 190) / r.h, 2), ZOOM_MIN, ZOOM_MAX);
    animateView({ zoom: z, pan: { x: b.width / 2 - (r.x + r.w / 2) * z, y: b.height / 2 - (r.y + r.h / 2) * z + 10 } }, ms);
  }
  function applySharedView(payload, ms = 90) {
    const z = clamp(Number(payload?.zoom) || 1, ZOOM_MIN, ZOOM_MAX), r = stackRef.current?.getBoundingClientRect();
    const c = payload?.center && Number.isFinite(Number(payload.center.x)) && Number.isFinite(Number(payload.center.y)) ? { x: Number(payload.center.x), y: Number(payload.center.y) } : null;
    if (c) sharedCenter.current = c;
    const pan = c && r ? { x: r.width / 2 - c.x * z, y: r.height / 2 - c.y * z } : { x: Number(payload?.pan?.x) || 0, y: Number(payload?.pan?.y) || 0 };
    animateView({ zoom: z, pan }, ms);
  }
  const point = e => { const r = stackRef.current.getBoundingClientRect(), v = viewRef.current; return { x: (e.clientX - r.left - v.pan.x) / v.zoom, y: (e.clientY - r.top - v.pan.y) / v.zoom }; };

  /* ───────────── Senden / Objekte ändern ───────────── */
  function send(event, payload) { if (socket.connected) socket.emit(event, payload); else pendingOps.current.push([event, payload]); }
  function flushOps() { pendingOps.current.splice(0).forEach(([e, p]) => socket.emit(e, p)); }
  const syncUndo = () => { setCanUndo(historyRef.current.past.length > 0); setCanRedo(historyRef.current.future.length > 0); };
  function setSel(ids) { selectedRef.current = ids; setSelectedIdsState(ids); scheduleFrame(); }
  function setTextEdit(v) { textEditRef.current = v; setTextEditState(v); }
  const canWriteItem = s => { const wz = S.current.wz; if (!wz) return true; const b = zoneBox(s); return wz.some(z => boxInRect(z, b)); };
  const canDelete = a => (S.current.isAdmin || S.current.allowDeleteOthers || !a.ownerId || a.ownerId === S.current.identityId) && canWriteItem(a);
  const zoneAt = p => S.current.wz ? S.current.wz.find(z => inRect(z, p, 0.5)) || null : null;
  function denyZone(msg) { const n = performance.now(); if (n - zoneToastAt.current > 1800) { zoneToastAt.current = n; toast(msg || "Hier darfst du nicht schreiben – nur innerhalb deines Bereichs.", "error", 2300); } }
  const setSelZone = id => { setSelZoneState(id); scheduleFrame(); };

  function addObjects(items, { history = true, select = false, event = "draw-batch" } = {}) {
    if (!items.length || S.current.readOnly) return [];
    if (S.current.wz) { const okItems = items.filter(canWriteItem); if (okItems.length < items.length) denyZone("Das passt nicht in deinen Bereich – es muss komplett hineinpassen."); items = okItems; if (!items.length) return []; }
    const owned = items.map(it => ({ ...it, _id: it._id || uid(), ownerId: S.current.identityId }));
    owned.forEach(o => committedIds.current.add(o._id));
    setStrokes(v => [...v, ...owned]);
    if (history) { pushHistory(historyRef.current, { kind: "add", strokes: owned }); syncUndo(); }
    if (event === "stroke-commit") owned.forEach(o => send("stroke-commit", { boardId, stroke: o })); else send("draw-batch", { boardId, strokes: owned });
    if (select) setSel(owned.map(o => o._id));
    return owned;
  }
  function removeObjects(list, { history = true } = {}) {
    if (!list.length) return;
    const ids = list.map(a => a._id), set = new Set(ids);
    setStrokes(v => v.filter(s => !set.has(s._id)));
    setSel(selectedRef.current.filter(id => !set.has(id)));
    if (history) { pushHistory(historyRef.current, { kind: "erase", strokes: list }); syncUndo(); }
    send("erase", { boardId, ids });
  }
  function applyStates(list, { emit = true } = {}) {
    const map = new Map(list.map(i => [i.id, i.state]));
    setStrokes(v => v.map(s => map.has(s._id) ? { ...map.get(s._id), _id: s._id, ownerId: s.ownerId } : s));
    if (emit) send("transform-objects", { boardId, transforms: list.map(i => ({ id: i.id, state: i.state })), preview: false });
  }
  const getSelected = () => { const ids = new Set(selectedRef.current); return S.current.strokes.filter(s => ids.has(s._id)); };
  function changeStates(items, make) { // Änderung mit Undo-Eintrag
    const before = items.map(s => ({ id: s._id, state: s })), after = items.map(s => ({ id: s._id, state: make(s) }));
    if (S.current.wz && after.some(i => !canWriteItem(i.state))) { denyZone("Das würde den Bereich verlassen – verschieben ist nur innerhalb möglich."); return; }
    pushHistory(historyRef.current, { kind: "transform", before, after }); syncUndo(); applyStates(after);
  }
  function deleteSelection() { const sel = getSelected(); const del = sel.filter(canDelete); if (sel.length && !del.length) toast("Du darfst diese Objekte nicht löschen.", "error"); removeObjects(del); }
  function duplicateSelection(offset = 28) {
    const sel = getSelected(); if (!sel.length) return;
    const copies = sel.map(s => ({ ...shiftObject(s, offset, offset), _id: uid() }));
    addObjects(copies, { select: true });
  }
  function copySelection() { const sel = getSelected(); if (!sel.length) return false; clipboard.current = sel.map(s => ({ ...s })); pasteCount.current = 0; toast(`${sel.length} Objekt${sel.length > 1 ? "e" : ""} kopiert`, "success", 1400); return true; }
  function pasteObjects() {
    if (!clipboard.current.length) return false;
    pasteCount.current += 1; const off = 28 * pasteCount.current;
    addObjects(clipboard.current.map(s => ({ ...shiftObject(s, off, off), _id: uid() })), { select: true }); return true;
  }
  function undo() {
    if (S.current.readOnly) return;
    const action = undoHistory(historyRef.current); syncUndo(); if (!action) return;
    if (action.kind === "add") { const ids = new Set(action.strokes.map(s => s._id)); setStrokes(v => v.filter(s => !ids.has(s._id))); setSel(selectedRef.current.filter(i => !ids.has(i))); send("erase", { boardId, ids: [...ids] }); }
    else if (action.kind === "erase" || action.kind === "clear") { action.strokes.forEach(s => committedIds.current.add(s._id)); setStrokes(v => { const seen = new Set(v.map(s => s._id)); return [...v, ...action.strokes.filter(s => !seen.has(s._id))]; }); send("draw-batch", { boardId, strokes: action.strokes }); }
    else if (action.kind === "transform") applyStates(action.before);
  }
  function redo() {
    if (S.current.readOnly) return;
    const action = redoHistory(historyRef.current); syncUndo(); if (!action) return;
    if (action.kind === "add") { action.strokes.forEach(s => committedIds.current.add(s._id)); setStrokes(v => { const seen = new Set(v.map(s => s._id)); return [...v, ...action.strokes.filter(s => !seen.has(s._id))]; }); send("draw-batch", { boardId, strokes: action.strokes }); }
    else if (action.kind === "erase") { const ids = new Set(action.strokes.map(s => s._id)); setStrokes(v => v.filter(s => !ids.has(s._id))); setSel(selectedRef.current.filter(i => !ids.has(i))); send("erase", { boardId, ids: [...ids] }); }
    else if (action.kind === "clear") { localClear.current = true; setStrokes([]); setSel([]); send("clear-board", boardId); }
    else if (action.kind === "transform") applyStates(action.after);
  }
  async function clearBoard() {
    if (!isAdmin || S.current.readOnly) return;
    if (!await askConfirm({ title: "Whiteboard leeren?", message: "Alle Objekte werden für alle Teilnehmer entfernt. Du kannst das mit Rückgängig wiederherstellen.", confirmLabel: "Leeren", danger: true })) return;
    pushHistory(historyRef.current, { kind: "clear", strokes: S.current.strokes.slice() }); syncUndo();
    localClear.current = true; setStrokes([]); setSel([]); send("clear-board", boardId);
  }
  function chooseBg(item) { if (S.current.readOnly || S.current.zoneScope.restricted) return; const next = { color: item[1], pattern: item[2], size: item[3] }; setBg(next); send("set-background", { boardId, background: next }); }
  function updateBg(patch) { if (S.current.readOnly || S.current.zoneScope.restricted) return; const next = { ...S.current.bg, ...patch }; setBg(next); send("set-background", { boardId, background: next }); }
  function chooseTool(next) { if (S.current.readOnly && next !== "hand") return; if (next === "zone" && !S.current.isAdmin) return; cancelAct(); if (textEditRef.current) commitText(); setTool(next); if (next !== "select" && next !== "lasso" && next !== "hand") setSel([]); }

  /* ───────────── Text ───────────── */
  function openTextEditor(p, existing) {
    cancelAct();
    if (existing) setTextEdit({ id: existing._id, x: Number(existing.x) || 0, y: Number(existing.y) || 0, value: existing.text || "", fontSize: Number(existing.fontSize) || 28, color: existing.color, maxWidth: Number(existing.maxWidth) || TEXT_DEFAULT_WIDTH });
    else { const fs = fontFromWidth(S.current.width); setTextEdit({ id: null, x: p.x, y: p.y + fs * TEXT_BASELINE, value: "", fontSize: fs, color: S.current.color, maxWidth: TEXT_DEFAULT_WIDTH }); }
    setTimeout(() => textRef.current?.focus(), 30);
  }
  function commitText() {
    const te = textEditRef.current; if (!te) return;
    setTextEdit(null);
    const text = te.value.replace(/\r\n?/g, "\n").slice(0, TEXT_MAX_LENGTH);
    if (te.id) {
      const old = S.current.strokes.find(s => s._id === te.id);
      if (old && text.trim() && text !== old.text) changeStates([old], s => ({ ...s, text }));
      else if (old && !text.trim() && canDelete(old)) removeObjects([old]);
    } else if (text.trim() && !S.current.readOnly) {
      addObjects([{ type: "text", x: te.x, y: te.y, text, color: te.color, width: Math.max(2, S.current.width), fontSize: te.fontSize, maxWidth: te.maxWidth }], { select: false });
    }
  }
  function onDoubleClick(e) {
    if (S.current.readOnly) return;
    const p = point(e), hit = topHit(p, 8 / viewRef.current.zoom);
    if (hit?.type === "text") { setSel([hit._id]); openTextEditor(p, hit); }
  }

  /* ───────────── Zeiger-Interaktion ───────────── */
  function topHit(p, tol) {
    const list = S.current.strokes;
    for (let i = list.length - 1; i >= 0; i--) if (hitPoint(list[i], p, tol) && canWriteItem(list[i])) return list[i];
    return null;
  }
  function cancelAct() {
    const a = act.current; if (!a) return;
    if (a.kind === "draw" && a.tool !== "eraser") send("stroke-live-cancel", { boardId, _id: a.id });
    if (a.kind === "transform") { override.current.clear(); setDragging(false); }
    if (a.kind === "zonedrag") { zoneOv.current = null; }
    if (a.kind === "erase") flushErase(true);
    act.current = null; clearTimeout(liveTimer.current); liveTimer.current = null; scheduleFrame();
  }
  function flushLive(force = false) {
    const a = act.current; if (!a || a.kind !== "draw") return;
    const now = performance.now();
    if (!force && now - a.lastSent < 28) { if (!liveTimer.current) liveTimer.current = setTimeout(() => { liveTimer.current = null; flushLive(true); }, 30); return; }
    const chunk = a.pts.slice(a.sent); if (!chunk.length || !socket.connected) return;
    a.lastSent = now;
    socket.emit("stroke-live", { boardId, append: a.sent > 0, stroke: { _id: a.id, type: "stroke", points: chunk, color: S.current.color, width: a.tool === "marker" ? markerWidth(S.current.width) : S.current.width, ...(a.tool === "marker" ? { alpha: 0.38 } : {}) } });
    a.sent = a.pts.length;
  }
  function flushErase(final = false) {
    const a = act.current; if (!a || a.kind !== "erase") return;
    if (a.queue.length) { send("erase", { boardId, ids: a.queue.splice(0) }); }
    if (final && a.removed.length) { pushHistory(historyRef.current, { kind: "erase", strokes: a.removed }); syncUndo(); }
  }
  function eraseAt(a, points) {
    const radius = eraserRadius();
    const hits = S.current.strokes.filter(s => !a.removedIds.has(s._id) && canDelete(s) && hitObject(s, points, radius));
    if (!hits.length) return;
    hits.forEach(h => { a.removedIds.add(h._id); a.removed.push(h); a.queue.push(h._id); });
    const set = new Set(hits.map(h => h._id));
    S.current.strokes = S.current.strokes.filter(s => !set.has(s._id)); // sofort für Folgetreffer
    setStrokes(v => v.filter(s => !set.has(s._id)));
    if (selectedRef.current.some(id => set.has(id))) setSel(selectedRef.current.filter(id => !set.has(id)));
    if (!a.timer) a.timer = setTimeout(() => { a.timer = null; flushErase(); }, 90);
  }

  function selectionHandle(box, p, touch) {
    const pad = (touch ? 24 : 12) / viewRef.current.zoom, z = viewRef.current.zoom;
    for (const [n, hx, hy] of [["nw", box.x, box.y], ["ne", box.x + box.w, box.y], ["sw", box.x, box.y + box.h], ["se", box.x + box.w, box.y + box.h]]) if (Math.hypot(p.x - hx, p.y - hy) <= pad) return `resize-${n}`;
    if (Math.hypot(p.x - (box.x + box.w / 2), p.y - (box.y - 28 / z)) <= pad) return "rotate";
    return null;
  }
  function beginTransform(e, mode, chosen) {
    const p = point(e), box = selectedBounds(chosen); if (!box) return false;
    try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
    act.current = { kind: "transform", id: e.pointerId, mode, start: p, box, center: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, startAngle: Math.atan2(p.y - (box.y + box.h / 2), p.x - (box.x + box.w / 2)), originals: new Map(chosen.map(s => [s._id, s])), lastSent: 0, moved: false, startClient: { x: e.clientX, y: e.clientY } };
    setDragging(true);
    return true;
  }
  function computeTransform(a, p, shift) {
    const wz = S.current.wz;
    if (!wz) return computeTransformRaw(a, p, shift);
    const zoneFor = new Map(); a.originals.forEach((s, id) => { const b = zoneBox(s); zoneFor.set(id, wz.find(z => boxInRect(z, b)) || null); });
    if (a.mode === "move") {
      let dx = p.x - a.start.x, dy = p.y - a.start.y;
      if (shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity, free = false;
      a.originals.forEach((s, id) => { const z = zoneFor.get(id); if (!z) { free = true; return; } const b = zoneBox(s); loX = Math.max(loX, z.x - b.x); hiX = Math.min(hiX, z.x + z.w - (b.x + b.w)); loY = Math.max(loY, z.y - b.y); hiY = Math.min(hiY, z.y + z.h - (b.y + b.h)); });
      if (!free) { dx = loX <= hiX ? clamp(dx, loX, hiX) : 0; dy = loY <= hiY ? clamp(dy, loY, hiY) : 0; }
      return computeTransformRaw(a, { x: a.start.x + dx, y: a.start.y + dy }, false);
    }
    const out = computeTransformRaw(a, p, shift);
    if (out.every(i => { const z = zoneFor.get(i.id); return !z || boxInRect(z, zoneBox(i.state)); })) { a.lastOut = out; return out; }
    return a.lastOut || [...a.originals].map(([id, state]) => ({ id, state }));
  }
  function computeTransformRaw(a, p, shift) {
    const out = [];
    if (a.mode === "move") {
      let dx = p.x - a.start.x, dy = p.y - a.start.y;
      if (shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      a.originals.forEach((s, id) => out.push({ id, state: shiftObject(s, dx, dy) }));
    } else if (a.mode === "rotate") {
      let ang = Math.atan2(p.y - a.center.y, p.x - a.center.x) - a.startAngle;
      if (shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      a.originals.forEach((s, id) => out.push({ id, state: rotateObject(s, ang, a.center) }));
    } else {
      const corner = a.mode.slice(7), b = a.box;
      const ax = corner.includes("e") ? b.x : b.x + b.w, ay = corner.includes("s") ? b.y : b.y + b.h;
      const newW = Math.max(12, corner.includes("e") ? p.x - ax : ax - p.x), newH = Math.max(12, corner.includes("s") ? p.y - ay : ay - p.y);
      let sx = clamp(newW / Math.max(12, b.w), 0.05, 12), sy = clamp(newH / Math.max(12, b.h), 0.05, 12);
      const uniform = shift || [...a.originals.values()].every(s => s.type === "image" || s.type === "text");
      if (uniform) { const k = Math.max(sx, sy); sx = k; sy = k; }
      a.originals.forEach((s, id) => out.push({ id, state: scaleObject(s, sx, sy, { x: ax, y: ay }) }));
    }
    return out;
  }
  function startPan(e) {
    try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
    act.current = { kind: "pan", id: e.pointerId, sx: e.clientX, sy: e.clientY, pan0: { ...viewRef.current.pan } };
    stackRef.current?.classList.add("panning");
  }
  function startGesture() {
    const t = [...touches.current.values()]; if (t.length < 2) return;
    const r = stackRef.current.getBoundingClientRect(), v = viewRef.current;
    const m = { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2 };
    gesture.current = { dist: Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y)), zoom: v.zoom, world: { x: (m.x - r.left - v.pan.x) / v.zoom, y: (m.y - r.top - v.pan.y) / v.zoom } };
  }
  function updateGesture() {
    const t = [...touches.current.values()]; if (t.length < 2 || !gesture.current || S.current.viewLocked) return;
    const r = stackRef.current.getBoundingClientRect(), g = gesture.current;
    const d = Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y)), m = { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2 };
    const z = clamp(g.zoom * (d / g.dist), ZOOM_MIN, ZOOM_MAX);
    setView({ zoom: z, pan: { x: m.x - r.left - g.world.x * z, y: m.y - r.top - g.world.y * z } });
  }

  function onDown(e) {
    const st = S.current;
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size >= 2) { cancelAct(); startGesture(); e.preventDefault(); return; }
      if (gesture.current) return;
    }
    e.preventDefault();
    if (popover) setPopover(null);
    if (textEditRef.current) { commitText(); if (st.tool !== "text") return; }
    if (act.current) return;
    if (e.pointerType === "mouse" && e.button === 2) return;
    const panning = e.button === 1 || spaceDown.current || st.tool === "hand" || (e.pointerType === "touch" && st.pencilMode) || st.readOnly;
    if (panning) { if (!st.viewLocked) startPan(e); return; }
    const p = point(e), touch = e.pointerType === "touch";
    switch (st.tool) {
      case "diagram": {
        const bgs = Math.max(4, Number(st.bg.size) || 24), sx = snapToGrid(p.x, bgs), sy = snapToGrid(p.y, bgs);
        const items = buildDiagram(st.diagCfg, sx, sy, bgs, st.color);
        if (!items.length) { toast("Es gibt noch nichts zu zeichnen – prüfe die Einstellungen.", "info", 2200); return; }
        if (st.wz && items.some(it => !canWriteItem(it))) { denyZone("Das Diagramm passt hier nicht komplett in deinen Bereich."); return; }
        addObjects(items, { select: true }); setTool("select"); hover.current = null;
        toast(`${items.length} Objekte eingefügt – zum Verschieben ausgewählt`, "success", 2000); return;
      }
      case "zone": {
        if (!st.isAdmin) return;
        try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
        const sz = st.zones.find(z => z.id === st.selZone), pad = (touch ? 24 : 12) / viewRef.current.zoom;
        if (sz) for (const [n, hx, hy] of [["nw", sz.x, sz.y], ["ne", sz.x + sz.w, sz.y], ["sw", sz.x, sz.y + sz.h], ["se", sz.x + sz.w, sz.y + sz.h]]) if (Math.hypot(p.x - hx, p.y - hy) <= pad) { act.current = { kind: "zonedrag", id: e.pointerId, mode: `resize-${n}`, zone: sz, start: p, orig: { x: sz.x, y: sz.y, w: sz.w, h: sz.h }, moved: false }; return; }
        const hit = st.zones.filter(z => inRect(z, p)).sort((m, n) => m.w * m.h - n.w * n.h)[0];
        if (hit) { setSelZone(hit.id); act.current = { kind: "zonedrag", id: e.pointerId, mode: "move", zone: hit, start: p, orig: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, moved: false }; }
        else { setSelZone(null); act.current = { kind: "zonenew", id: e.pointerId, a: p, p }; }
        scheduleFrame(); return;
      }
      case "text": {
        if (st.wz && !zoneAt(p)) { denyZone(); return; }
        const hit = topHit(p, 6 / viewRef.current.zoom);
        if (hit?.type === "text") { setSel([hit._id]); openTextEditor(p, hit); } else openTextEditor(p, null);
        return;
      }
      case "select":
      case "lasso": {
        const sel = getSelected();
        if (sel.length) {
          const box = selectedBounds(sel), handle = box && selectionHandle(box, p, touch);
          if (handle) { beginTransform(e, handle, sel); return; }
        }
        const hit = st.tool === "select" ? topHit(p, (touch ? 14 : 6) / viewRef.current.zoom) : null;
        if (hit) {
          if (e.shiftKey) { setSel(selectedRef.current.includes(hit._id) ? selectedRef.current.filter(i => i !== hit._id) : [...selectedRef.current, hit._id]); return; }
          const keep = selectedRef.current.includes(hit._id);
          if (!keep) setSel([hit._id]);
          beginTransform(e, "move", keep ? sel : [hit]); return;
        }
        if (sel.length) { const box = selectedBounds(sel); if (box && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) { beginTransform(e, "move", sel); return; } }
        if (!e.shiftKey) setSel([]);
        try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
        act.current = st.tool === "lasso" ? { kind: "lasso", id: e.pointerId, pts: [p] } : { kind: "marquee", id: e.pointerId, a: p, p, add: e.shiftKey };
        scheduleFrame(); return;
      }
      case "eraser": {
        try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
        const a = { kind: "erase", id: e.pointerId, removed: [], removedIds: new Set(), queue: [], timer: null }; act.current = a; hover.current = p; eraseAt(a, [p]); scheduleFrame(); return;
      }
      case "pen": case "marker": {
        const zn = st.wz ? zoneAt(p) : null; if (st.wz && !zn) { denyZone(); return; }
        try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
        act.current = { kind: "draw", tool: st.tool, id: uid(), pointerId: e.pointerId, zone: zn, pts: [zn ? clampTo(zn, p) : p], sent: 0, lastSent: 0, pointer: e.pointerId };
        flushLive(true); scheduleFrame(); return;
      }
      default: {
        const zn = st.wz ? zoneAt(p) : null; if (st.wz && !zn) { denyZone(); return; }
        try { overlayRef.current.setPointerCapture(e.pointerId); } catch {}
        act.current = { kind: "shape", tool: st.tool, pointer: e.pointerId, zone: zn, a: p, p, shift: e.shiftKey }; scheduleFrame();
      }
    }
  }

  function onMove(e) {
    if (e.pointerType === "touch") { if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (touches.current.size >= 2) { e.preventDefault(); updateGesture(); return; } }
    const overCanvas = e.target === overlayRef.current || act.current;
    if (!overCanvas) return;
    const p = point(e);
    if (e.pointerType !== "touch") {
      hover.current = p;
      const now = performance.now();
      if (socket.connected && now - cursorSent.current >= 40) { cursorSent.current = now; socket.emit("cursor:move", { boardId, x: p.x, y: p.y }); }
      if ((S.current.tool === "eraser" || S.current.tool === "diagram") && !act.current) scheduleFrame();
    }
    const a = act.current;
    if (!a) return;
    if (a.kind === "pan") { if (e.pointerId !== a.id) return; e.preventDefault(); setView({ zoom: viewRef.current.zoom, pan: { x: a.pan0.x + e.clientX - a.sx, y: a.pan0.y + e.clientY - a.sy } }); return; }
    if ((a.pointer ?? a.id) !== e.pointerId) return;
    e.preventDefault();
    const evs = a.kind === "draw" || a.kind === "erase" || a.kind === "lasso" ? (e.getCoalescedEvents?.() || [e]) : [e];
    if (a.kind === "draw") {
      const minD = 1.1 / viewRef.current.zoom;
      for (const ev of evs) { const q0 = point(ev), q = a.zone ? clampTo(a.zone, q0) : q0, last = a.pts[a.pts.length - 1]; if (Math.hypot(q.x - last.x, q.y - last.y) >= minD) a.pts.push(q); }
      scheduleFrame(); flushLive();
    } else if (a.kind === "erase") {
      const qs = evs.map(point); let prev = a.last || qs[0];
      const dense = []; for (const q of qs) { const n = Math.ceil(Math.hypot(q.x - prev.x, q.y - prev.y) / Math.max(2 / viewRef.current.zoom, 1)); for (let i = 1; i <= n; i++) dense.push({ x: prev.x + (q.x - prev.x) * i / n, y: prev.y + (q.y - prev.y) * i / n }); prev = q; }
      a.last = prev; eraseAt(a, dense.length ? dense : qs); scheduleFrame();
    } else if (a.kind === "shape") { a.p = a.zone ? clampTo(a.zone, p) : p; a.shift = e.shiftKey; scheduleFrame(); }
    else if (a.kind === "zonenew") { a.p = p; scheduleFrame(); }
    else if (a.kind === "zonedrag") {
      const dx = p.x - a.start.x, dy = p.y - a.start.y, o = a.orig;
      if (!a.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
      a.moved = true;
      let rect;
      if (a.mode === "move") rect = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
      else { const c = a.mode.slice(7), ax = c.includes("e") ? o.x : o.x + o.w, ay = c.includes("s") ? o.y : o.y + o.h, bx = c.includes("e") ? o.x + o.w + dx : o.x + dx, by = c.includes("s") ? o.y + o.h + dy : o.y + dy; const w = Math.max(40, Math.abs(bx - ax)), h = Math.max(40, Math.abs(by - ay)); rect = { x: bx >= ax ? ax : ax - w, y: by >= ay ? ay : ay - h, w, h }; }
      zoneOv.current = { id: a.zone.id, rect }; scheduleFrame();
    }
    else if (a.kind === "marquee") { a.p = p; scheduleFrame(); }
    else if (a.kind === "lasso") { for (const ev of evs) { const q = point(ev), last = a.pts[a.pts.length - 1]; if (Math.hypot(q.x - last.x, q.y - last.y) >= Math.max(1.2, 2 / viewRef.current.zoom)) a.pts.push(q); } scheduleFrame(); }
    else if (a.kind === "transform") {
      if (!a.moved && Math.hypot(e.clientX - a.startClient.x, e.clientY - a.startClient.y) < 3) return;
      a.moved = true;
      const states = computeTransform(a, p, e.shiftKey);
      override.current = new Map(states.map(s => [s.id, s.state]));
      scheduleFrame();
      const now = performance.now();
      if (socket.connected && now - a.lastSent > 40) { a.lastSent = now; socket.emit("transform-objects", { boardId, transforms: states, preview: true }); }
    }
  }

  function onUp(e) {
    if (e.pointerType === "touch") { touches.current.delete(e.pointerId); if (touches.current.size < 2) gesture.current = null; if (touches.current.size === 0) gesture.current = null; }
    const a = act.current;
    if (!a || (a.pointer ?? a.id) !== e.pointerId) return;
    e.preventDefault();
    try { overlayRef.current.releasePointerCapture(e.pointerId); } catch {}
    act.current = null; stackRef.current?.classList.remove("panning");
    const p = point(e), st = S.current;
    if (a.kind === "draw") {
      clearTimeout(liveTimer.current); liveTimer.current = null;
      const pe = a.zone ? clampTo(a.zone, p) : p, last = a.pts[a.pts.length - 1]; if (Math.hypot(pe.x - last.x, pe.y - last.y) > 0.5 / viewRef.current.zoom) a.pts.push(pe);
      const marker = a.tool === "marker";
      const item = { _id: a.id, type: "stroke", points: simplifyPoints(a.pts, 0.3), color: st.color, width: marker ? markerWidth(st.width) : st.width, ...(marker ? { alpha: 0.38 } : {}) };
      addObjects([item], { event: "stroke-commit" });
    } else if (a.kind === "shape") {
      a.p = a.zone ? clampTo(a.zone, p) : p; a.shift = e.shiftKey; const sh = buildShape(a); if (sh) addObjects([sh]);
    } else if (a.kind === "zonenew") {
      const r = { x: Math.min(a.a.x, p.x), y: Math.min(a.a.y, p.y), w: Math.abs(p.x - a.a.x), h: Math.abs(p.y - a.a.y) };
      if (r.w >= 40 && r.h >= 40) zoneCreate(r); else if (r.w > 6 || r.h > 6) toast("Der Bereich ist zu klein – ziehe ihn größer auf.", "info", 1800);
    } else if (a.kind === "zonedrag") {
      const rect = zoneOv.current?.rect; zoneOv.current = null;
      if (a.moved && rect) zoneUpdate(a.zone.id, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
    } else if (a.kind === "erase") { clearTimeout(a.timer); a.timer = null; flushErase(true); }
    else if (a.kind === "marquee") {
      const box = { x: Math.min(a.a.x, p.x), y: Math.min(a.a.y, p.y), w: Math.abs(p.x - a.a.x), h: Math.abs(p.y - a.a.y) };
      if (box.w < 3 / viewRef.current.zoom && box.h < 3 / viewRef.current.zoom) { if (!a.add) setSel([]); }
      else { const ids = st.strokes.filter(s => canWriteItem(s) && rectsIntersect(objectBounds(s), box)).map(s => s._id); setSel(a.add ? [...new Set([...selectedRef.current, ...ids])] : ids); }
    } else if (a.kind === "lasso") {
      const poly = a.pts.slice(); if (poly.length >= 3) poly.push({ ...poly[0] });
      setSel(poly.length >= 4 ? st.strokes.filter(s => canWriteItem(s) && bboxInLasso(objectBounds(s), poly)).map(s => s._id) : []);
    } else if (a.kind === "transform") {
      const finals = a.moved ? computeTransform(a, p, e.shiftKey) : [];
      override.current.clear(); setDragging(false);
      if (finals.length) {
        const before = [...a.originals.entries()].map(([id, state]) => ({ id, state }));
        pushHistory(historyRef.current, { kind: "transform", before, after: finals }); syncUndo();
        applyStates(finals);
      }
    }
    scheduleFrame();
  }
  function onCancel(e) {
    if (e.pointerType === "touch") { touches.current.delete(e.pointerId); if (touches.current.size < 2) gesture.current = null; }
    if (act.current && (act.current.pointer ?? act.current.id) === e.pointerId) { cancelAct(); stackRef.current?.classList.remove("panning"); }
  }
  function onWheel(e) {
    e.preventDefault();
    if (S.current.viewLocked) return;
    const r = stackRef.current.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    if (e.ctrlKey || e.metaKey || (mouseWheel && !e.shiftKey)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), cx, cy);
    else { const v = viewRef.current; setView({ zoom: v.zoom, pan: { x: v.pan.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), y: v.pan.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) } }); }
  }

  // Ein einziger Satz Listener; die Handler lesen immer den aktuellen Stand über Refs/S.
  const handlers = useRef({});
  handlers.current = { onDown, onMove, onUp, onCancel, onWheel, onDoubleClick };
  useEffect(() => {
    const c = overlayRef.current, host = stackRef.current; if (!c || !host) return;
    const o = { passive: false };
    const down = e => handlers.current.onDown(e), move = e => handlers.current.onMove(e), up = e => handlers.current.onUp(e), cancel = e => handlers.current.onCancel(e), wheel = e => handlers.current.onWheel(e), dbl = e => handlers.current.onDoubleClick(e);
    c.addEventListener("pointerdown", down, o); window.addEventListener("pointermove", move, o); window.addEventListener("pointerup", up, o); window.addEventListener("pointercancel", cancel, o);
    host.addEventListener("wheel", wheel, o); c.addEventListener("dblclick", dbl);
    const blur = () => { cancelAct(); touches.current.clear(); gesture.current = null; spaceDown.current = false; };
    window.addEventListener("blur", blur);
    const ro = new ResizeObserver(() => { scheduleFrame(); if (S.current.viewLocked && sharedCenter.current) applySharedView({ zoom: viewRef.current.zoom, center: sharedCenter.current }, 0); });
    ro.observe(host);
    return () => { c.removeEventListener("pointerdown", down); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); host.removeEventListener("wheel", wheel); c.removeEventListener("dblclick", dbl); window.removeEventListener("blur", blur); ro.disconnect(); };
  }, []);

  // Neu zeichnen, sobald sich sichtbarer Zustand ändert.
  useEffect(() => { scheduleFrame(); }, [strokes, bg, selectedIds, textEdit?.id, theme, tool, color, width, zones, zoneScope, selZone]);
  useEffect(() => { setPropsHidden(false); }, [tool]);
  useEffect(() => { if (selZone && !zones.some(z => z.id === selZone)) setSelZoneState(null); }, [zones, selZone]);
  useEffect(() => { if (zonePanel && isAdmin) socket.emit("zone:candidates"); }, [zonePanel, zones.length]);
  useEffect(() => { if (zoneRO && (tool !== "hand")) { cancelAct(); } }, [zoneRO]);
  useEffect(() => () => { [frame, anim, viewSyncTimer].forEach(r => r.current && cancelAnimationFrame(r.current)); clearTimeout(hostTimer.current); clearTimeout(liveTimer.current); }, []);
  useEffect(() => { // Hängengebliebene Live-Striche anderer Teilnehmer aufräumen
    const id = setInterval(() => { const now = performance.now(); let changed = false; remoteLive.current.forEach((s, k) => { if (now - (s.t || 0) > 9000) { remoteLive.current.delete(k); changed = true; } }); if (changed) scheduleFrame(); }, 3000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { // Admin: Ansicht beim Umschalten sofort senden
    if (isAdmin && viewSyncEnabled) notifyHost();
  }, [viewSyncEnabled]);

  /* ───────────── Socket-Ereignisse ───────────── */
  useEffect(() => {
    const first = { current: true };
    const join = () => socket.emit("join-board", { boardId });
    const onConnect = () => { setConnected(true); join(); flushOps(); };
    const onDisconnect = () => { setConnected(false); };
    const state = s => {
      const wasFirst = first.current;
      const next = Array.isArray(s.strokes) ? s.strokes : [];
      committedIds.current = new Set(next.map(x => x?._id).filter(Boolean));
      remoteLive.current.clear(); override.current.clear();
      setStrokes(next); setSel(selectedRef.current.filter(id => committedIds.current.has(id)));
      setBg(s.background && typeof s.background === "object" ? s.background : DEFAULT_BG);
      setFiles(Array.isArray(s.files) ? s.files : []);
      if (first.current) { historyRef.current = createHistory(); syncUndo(); first.current = false; }
      setParticipants(Array.isArray(s.participants) ? s.participants : []);
      setReadOnly(Boolean(s.permissions?.readOnly)); setAllowDeleteOthers(Boolean(s.boardSettings?.allowUserDeleteOthers));
      const zs = Array.isArray(s.zones) ? s.zones : [], zsc = s.zoneScope?.restricted ? { restricted: true, seeAll: Boolean(s.zoneScope.seeAll), writableIds: Array.isArray(s.zoneScope.writableIds) ? s.zoneScope.writableIds : [] } : NO_SCOPE;
      setZones(zs); setZoneScope(zsc);
      const sig = zsc.restricted ? `${zsc.seeAll}|${zs.map(z => `${z.id}:${z.x},${z.y},${z.w},${z.h}`).join("|")}` : "";
      if (sig !== zoneSigRef.current) {
        zoneSigRef.current = sig;
        const focusList = zsc.seeAll ? zs.filter(z => zsc.writableIds.includes(z.id)) : zs, target = unionRect(focusList.length ? focusList : zs);
        if (zsc.restricted && target) setTimeout(() => fns.current.focusRect(target, wasFirst ? 0 : 380), 80);
        if (zsc.restricted && !wasFirst) toast("Dein Zugriff wurde vom Admin angepasst.", "info", 2600);
      }
      const vs = s.viewSync, enabled = Boolean(vs?.enabled); setViewSyncEnabled(enabled);
      if (enabled && !isAdmin) { latestHostSeq.current = Number(vs.seq) || 0; applySharedView(vs, 0); } else if (!enabled) sharedCenter.current = null;
      setLoaded(true);
    };
    const roomUsers = payload => {
      const next = Array.isArray(payload?.participants) ? payload.participants : []; setParticipants(next);
      const me = next.find(p => p.userId === S.current.identityId); if (me) setReadOnly(Boolean(me.readOnly));
      cursors.keepOnly(new Set(next.map(p => p.userId)));
    };
    const live = payload => {
      const st = payload?.stroke; if (!st?._id || committedIds.current.has(st._id) || !Array.isArray(st.points)) return;
      const prev = remoteLive.current.get(st._id);
      remoteLive.current.set(st._id, payload.append && prev ? { ...prev, points: prev.points.concat(st.points), t: performance.now() } : { ...st, t: performance.now() });
      scheduleFrame();
    };
    const cancelLive = p => { if (p?._id && remoteLive.current.delete(p._id)) scheduleFrame(); };
    const commitRemote = p => {
      const st = p?.stroke; if (!st?._id) return;
      committedIds.current.add(st._id); remoteLive.current.delete(st._id);
      setStrokes(v => v.some(i => i._id === st._id) ? v : [...v, st]);
    };
    const drawBatch = p => {
      const list = Array.isArray(p) ? p : p?.strokes; if (!Array.isArray(list)) return;
      list.forEach(i => { if (i?._id) { committedIds.current.add(i._id); remoteLive.current.delete(i._id); } });
      setStrokes(v => { const seen = new Set(v.map(i => i._id)); return [...v, ...list.filter(i => i?._id && !seen.has(i._id))]; });
    };
    const erase = p => { const ids = new Set(Array.isArray(p?.ids) ? p.ids : []); if (!ids.size) return; setStrokes(v => v.filter(i => !ids.has(i._id))); if (selectedRef.current.some(i => ids.has(i))) setSel(selectedRef.current.filter(i => !ids.has(i))); };
    const clear = () => { setStrokes([]); setSel([]); remoteLive.current.clear(); committedIds.current.clear(); if (localClear.current) localClear.current = false; else { historyRef.current = createHistory(); syncUndo(); } };
    const transformed = p => {
      const list = p?.transforms; if (!Array.isArray(list) || !list.length) return;
      const mine = act.current?.kind === "transform" ? act.current.originals : null;
      const byId = new Map(list.filter(t => !(mine && mine.has(t.id))).map(t => [t.id, t]));
      if (!byId.size) return;
      setStrokes(v => v.map(s => {
        const t = byId.get(s._id); if (!t) return s;
        if (t.state && typeof t.state === "object") return { ...t.state, _id: s._id };
        let n = s; const dx = Number(t.dx) || 0, dy = Number(t.dy) || 0;
        if (dx || dy) n = shiftObject(n, dx, dy);
        if (Number(t.sx) && Number(t.sy) && t.anchor && (t.sx !== 1 || t.sy !== 1)) n = scaleObject(n, Number(t.sx), Number(t.sy), t.anchor);
        if (Number(t.angle) && t.center) n = rotateObject(n, Number(t.angle), t.center);
        return n;
      }));
    };
    const permission = p => { setReadOnly(Boolean(p?.readOnly)); cancelAct(); if (p?.readOnly) setSel([]); };
    const hostView = p => { if (isAdmin) return; const seq = Number(p?.seq) || 0; if (seq && seq <= latestHostSeq.current) return; if (seq) latestHostSeq.current = seq; setViewSyncEnabled(true); applySharedView(p, 90); };
    const viewSyncState = p => { const en = Boolean(p?.enabled); setViewSyncEnabled(en); if (en && !isAdmin) hostView(p); else if (!en) { sharedCenter.current = null; if (!isAdmin) toast("Admin-Ansicht beendet – du kannst wieder frei navigieren.", "info", 2600); } };
    const meta = p => { if (p?.id === boardId && p.name) setBoardName(p.name); };
    const gone = p => { if (p?.boardId === boardId) exitRef.current("Dieses Whiteboard wurde gelöscht."); };
    const denied = p => { if (p?.boardId === boardId) exitRef.current(p.message || "Du hast keinen Zugriff auf dieses Whiteboard."); };
    const kicked = () => exitRef.current("Du wurdest vom Admin entfernt.");
    const cursor = p => { if (!p?.userId || p.userId === S.current.identityId) return; cursors.set(p); };
    const fileAdded = p => { if (p?.file) setFiles(v => v.some(f => f.id === p.file.id) ? v : [...v, p.file]); };
    const bgEv = v => setBg(v && typeof v === "object" ? v : DEFAULT_BG);
    const settings = p => setAllowDeleteOthers(Boolean(p?.allowUserDeleteOthers));
    const adminErr = p => toast(p?.message || "Serverfehler", "error");
    const zonesState = p => setZones(Array.isArray(p?.zones) ? p.zones : []);
    const zoneCreated = p => { if (p?.id) { setSelZoneState(p.id); setZonePanel(true); socket.emit("zone:candidates"); } };
    const zoneCands = p => setCandidates(Array.isArray(p?.candidates) ? p.candidates : []);
    const zoneDenied = p => { const ids = new Set(Array.isArray(p?.ids) ? p.ids : []); if (!ids.size) return; ids.forEach(id => committedIds.current.delete(id)); setStrokes(v => v.filter(x => !ids.has(x._id))); setSel(selectedRef.current.filter(i => !ids.has(i))); toast("Außerhalb deines Bereichs – Änderung abgelehnt.", "error", 2400); };
    const events = { connect: onConnect, disconnect: onDisconnect, "board-state": state, "room-users": roomUsers, "stroke-live": live, "stroke-live-cancel": cancelLive, "stroke-commit": commitRemote, "draw-batch": drawBatch, erase, "clear-board": clear, "objects-transformed": transformed, "set-background": bgEv, "permission-changed": permission, "board-settings": settings, "view-sync-state": viewSyncState, "host-view": hostView, kicked, "board-access-denied": denied, "board-access-revoked": denied, "board-meta": meta, "board-deleted": gone, "cursor:move": cursor, "file-added": fileAdded, "admin-error": adminErr, "zones-state": zonesState, "zone-created": zoneCreated, "zone-candidates": zoneCands, "zone-denied": zoneDenied };
    Object.entries(events).forEach(([k, f]) => socket.on(k, f));
    if (socket.connected) { setConnected(true); join(); }
    return () => { Object.entries(events).forEach(([k, f]) => socket.off(k, f)); if (socket.connected) socket.emit("leave-board"); };
  }, [boardId]);

  useEffect(() => { document.title = `${boardName} · Whiteboard`; return () => { document.title = "Whiteboard"; }; }, [boardName]);

  /* ───────────── Tastatur / Einfügen / Drop ───────────── */
  fns.current = { focusRect, undo, redo, copySelection, deleteSelection, duplicateSelection, changeStates, zoomButton, resetView, fitContent, chooseTool, pasteObjects, handleFile, getSelected };
  useEffect(() => {
    const F = new Proxy({}, { get: (_, k) => (...a) => fns.current[k](...a) });
    const onKey = e => {
      if (isTyping(e.target) || e.target.closest?.(".modalPanel")) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), st = S.current;
      if (e.key === "Escape" && (st.tool === "diagram" || st.tool === "zone")) { F.chooseTool("select"); return; }
      if (e.code === "Space") { if (!spaceDown.current) { spaceDown.current = true; stackRef.current?.classList.add("spaceHeld"); } e.preventDefault(); return; }
      if (mod) {
        if (k === "z") { e.preventDefault(); e.shiftKey ? F.redo() : F.undo(); }
        else if (k === "y") { e.preventDefault(); F.redo(); }
        else if (k === "a" && !st.readOnly) { e.preventDefault(); setTool(t => (t === "select" || t === "lasso") ? t : "select"); setSel(st.strokes.filter(canWriteItem).map(s => s._id)); }
        else if (k === "c") { if (F.copySelection()) e.preventDefault(); }
        else if (k === "x" && !st.readOnly) { if (F.copySelection()) { e.preventDefault(); F.deleteSelection(); } }
        else if (k === "d" && !st.readOnly) { e.preventDefault(); F.duplicateSelection(); }
        return;
      }
      if (e.altKey) return;
      if (k === "delete" || k === "backspace") { if (selectedRef.current.length && !st.readOnly) { e.preventDefault(); F.deleteSelection(); } return; }
      if (k === "escape") { setSel([]); setPopover(null); cancelAct(); if (textEditRef.current) setTextEdit(null); return; }
      if (k.startsWith("arrow") && selectedRef.current.length && !st.readOnly) {
        e.preventDefault(); const step = e.shiftKey ? 10 : 1, dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0, dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
        F.changeStates(F.getSelected(), s => shiftObject(s, dx, dy)); return;
      }
      if (k === "+" || k === "=") { F.zoomButton(1.25); return; }
      if (k === "-" || k === "_") { F.zoomButton(0.8); return; }
      if (k === "0") { F.resetView(); return; }
      if (k === "f" || k === "9") { F.fitContent(); return; }
      if (k === "?" || k === "/") { setShortcutsOpen(v => !v); return; }
      if (k === "b" && st.isAdmin && !st.readOnly) { F.chooseTool("zone"); return; }
      const t = TOOL_KEYS[k]; if (t && !(st.readOnly && t !== "hand")) F.chooseTool(t);
    };
    const onKeyUp = e => { if (e.code === "Space") { spaceDown.current = false; stackRef.current?.classList.remove("spaceHeld"); } };
    const onPaste = e => {
      if (isTyping(e.target)) return;
      const imgs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
      if (imgs.length) { e.preventDefault(); imgs.forEach(f => F.handleFile(f)); return; }
      if (clipboard.current.length && !S.current.readOnly) { e.preventDefault(); F.pasteObjects(); }
    };
    const onDocDown = e => { if (!e.target.closest?.("[data-pop]")) setPopover(null); };
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKeyUp); window.addEventListener("paste", onPaste); document.addEventListener("pointerdown", onDocDown);
    const stop = e => e.preventDefault();
    document.addEventListener("gesturestart", stop, { passive: false }); document.addEventListener("gesturechange", stop, { passive: false });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("paste", onPaste); document.removeEventListener("pointerdown", onDocDown); document.removeEventListener("gesturestart", stop); document.removeEventListener("gesturechange", stop); };
  }, []);

  /* ───────────── Dateien ───────────── */
  const fmtSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  async function handleFile(file, at) {
    if (!file || S.current.readOnly) return;
    const isImg = file.type.startsWith("image/");
    if (!isImg && !["application/pdf", "text/plain"].includes(file.type)) { toast("Dieser Dateityp wird nicht unterstützt (Bilder, PDF, Text).", "error"); return; }
    if (file.size > 20 * 1024 * 1024) { toast("Die Datei ist größer als 20 MB.", "error"); return; }
    setBusy(true);
    try {
      let send = file;
      if (isImg) { send = await compressImageFile(file); if (send !== file) toast(`Bild komprimiert: ${fmtSize(file.size)} → ${fmtSize(send.size)}`, "info", 2200); }
      const data = await upload(`/api/boards/${encodeURIComponent(boardId)}/files`, send, token, "file", guest?.token || "");
      setFiles(v => v.some(f => f.id === data.file.id) ? v : [...v, data.file]);
      if (isImg) {
        const localUrl = URL.createObjectURL(send);
        const dim = await new Promise(res => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 400, h: im.naturalHeight || 300 }); im.onerror = () => res(null); im.src = localUrl; });
        URL.revokeObjectURL(localUrl);
        if (!dim) throw new Error("Das Bild konnte nicht gelesen werden.");
        const k = Math.min(1, 720 / Math.max(dim.w, dim.h)), iw = Math.max(1, Math.round(dim.w * k)), ih = Math.max(1, Math.round(dim.h * k));
        const r = stackRef.current.getBoundingClientRect(), v = viewRef.current;
        const c = at || { x: (r.width / 2 - v.pan.x) / v.zoom, y: (r.height / 2 - v.pan.y) / v.zoom };
        getImage(data.file.url);
        let w2 = iw, h2 = ih, c2 = c; const wz = S.current.wz;
        if (wz) { const z = wz.find(q => inRect(q, c)) || wz[0], k2 = Math.min(1, (z.w - 16) / iw, (z.h - 16) / ih); w2 = Math.max(1, Math.round(iw * k2)); h2 = Math.max(1, Math.round(ih * k2)); c2 = { x: clamp(c.x, z.x + w2 / 2 + 4, z.x + z.w - w2 / 2 - 4), y: clamp(c.y, z.y + h2 / 2 + 4, z.y + z.h - h2 / 2 - 4) }; }
        addObjects([{ type: "image", src: data.file.url, x: c2.x - w2 / 2, y: c2.y - h2 / 2, w: w2, h: h2, rotation: 0 }], { select: true });
        setTool("select");
      } else toast(`„${file.name}“ hochgeladen`, "success", 1800);
    } catch (e) { toast(e.message || "Upload fehlgeschlagen", "error"); } finally { setBusy(false); }
  }
  const onDrop = e => { e.preventDefault(); setDropActive(false); const r = stackRef.current.getBoundingClientRect(), v = viewRef.current; const at = { x: (e.clientX - r.left - v.pan.x) / v.zoom, y: (e.clientY - r.top - v.pan.y) / v.zoom }; [...(e.dataTransfer?.files || [])].forEach((f, i) => handleFile(f, i ? { x: at.x + 30 * i, y: at.y + 30 * i } : at)); };

  /* ───────────── Export ───────────── */
  function exportBounds(area) {
    const r = stackRef.current.getBoundingClientRect(), v = viewRef.current;
    if (area === "content") { const b = contentBounds(S.current.strokes); if (b) return b; }
    return { x: -v.pan.x / v.zoom, y: -v.pan.y / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
  }
  async function doExport(kind) {
    setPopover(null);
    const name = boardName || "whiteboard";
    try {
      if (kind === "json") { exportJson({ version: 2, boardId, name, background: bg, strokes: S.current.strokes }, name); return; }
      setBusy(true);
      const area = kind === "png-all" ? "content" : "viewport", b = exportBounds(area);
      await exportPng(S.current.strokes, bg, b, name, area === "content" ? 2 : clamp((window.devicePixelRatio || 1) * Math.max(1, viewRef.current.zoom), 1.5, 4));
      toast("PNG exportiert", "success", 1600);
    } catch (e) { toast(e.message || "Export fehlgeschlagen", "error"); } finally { setBusy(false); }
  }
  async function refreshPdfPreview(cfg) {
    try {
      await preloadImages(S.current.strokes);
      const c = renderExportCanvas(S.current.strokes, S.current.bg, exportBounds(cfg.area), 0.9);
      setPdfPreview(c.toDataURL("image/jpeg", 0.8));
    } catch {}
  }
  function openPdf() { setPopover(null); const cfg = { ...pdfConfig, area: "viewport" }; setPdfConfig(cfg); setPdfPreview(""); setPdfProgress(0); setPdfOpen(true); setTimeout(() => refreshPdfPreview(cfg), 30); }
  async function runPdf() {
    setPdfBusy(true); setPdfProgress(8);
    try {
      const doc = await buildPdf({ strokes: S.current.strokes, bg: S.current.bg, bounds: exportBounds(pdfConfig.area), config: pdfConfig, name: boardName, onProgress: setPdfProgress });
      doc.save(`${(boardName || "whiteboard").replace(/[\\/:*?"<>|]+/g, "_")}.pdf`); setPdfProgress(100);
      setTimeout(() => setPdfOpen(false), 350); toast("PDF erstellt", "success", 1600);
    } catch (e) { toast(e.message || "PDF konnte nicht erstellt werden.", "error"); } finally { setPdfBusy(false); }
  }

  /* ───────────── Teilen / Admin ───────────── */
  async function openShare() { setShareOpen(true); setShareError(""); try { const d = await api(`/api/boards/${encodeURIComponent(boardId)}/guest-invites`, {}, token); setInvites(d.invites || []); } catch (e) { setShareError(e.message); } }
  async function createInvite(mode = "guest-edit") {
    setShareBusy(true); setShareError("");
    try { const d = await api(`/api/boards/${encodeURIComponent(boardId)}/guest-invites`, { method: "POST", body: JSON.stringify({ mode, expiresInMs: 24 * 3600 * 1000 }) }, token); setInvites(v => [{ ...d.invite, code: d.code }, ...v]); try { await navigator.clipboard?.writeText(d.code); toast("Code erstellt und kopiert", "success", 1800); } catch {} }
    catch (e) { setShareError(e.message); } finally { setShareBusy(false); }
  }
  async function revokeInvite(id) { try { await api(`/api/boards/${encodeURIComponent(boardId)}/guest-invites/${encodeURIComponent(id)}`, { method: "DELETE" }, token); setInvites(v => v.filter(i => i.id !== id)); } catch (e) { setShareError(e.message); } }
  const setUserReadOnly = (id, value) => { if (isAdmin && id !== identityId) socket.emit("set-readonly", { userId: id, readOnly: value }); };
  const setAllReadOnly = value => { if (isAdmin) socket.emit("set-all-readonly", { readOnly: value }); };
  const setDeleteOthers = value => { if (isAdmin) { setAllowDeleteOthers(value); socket.emit("set-delete-others", { enabled: value }); } };
  async function kickUser(id) { if (isAdmin && id !== identityId && await askConfirm({ title: "Teilnehmer entfernen?", message: "Die Person wird aus diesem Board geworfen.", confirmLabel: "Entfernen", danger: true })) socket.emit("kick-user", { userId: id }); }
  function toggleViewSync() { if (!isAdmin) return; const next = !viewSyncEnabled; setViewSyncEnabled(next); socket.emit("view-sync-toggle", { boardId, enabled: next, ...sharedViewPayload() }); toast(next ? "Alle Teilnehmer folgen jetzt deiner Ansicht." : "Ansicht-Teilen beendet.", "info", 2200); }
  /* ───────────── Bereiche (Admin) ───────────── */
  function zoneCreate(rect, name) { if (!isAdmin) return; socket.emit("zone:create", { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h), ...(name ? { name } : {}) }); }
  function zoneCreateInView() {
    const r = stackRef.current.getBoundingClientRect(), v = viewRef.current, w = Math.min(520, r.width * 0.6 / v.zoom), h = w * 0.66;
    zoneCreate({ x: (r.width / 2 - v.pan.x) / v.zoom - w / 2, y: (r.height / 2 - v.pan.y) / v.zoom - h / 2, w, h });
  }
  function zoneUpdate(id, patch) { if (!isAdmin) return; setZones(v => v.map(z => z.id === id ? { ...z, ...patch } : z)); socket.emit("zone:update", { id, patch }); scheduleFrame(); }
  async function zoneDelete(id) {
    const z = S.current.zones.find(q => q.id === id); if (!z) return;
    if (!await askConfirm({ title: `„${z.name}“ löschen?`, message: "Der Bereich verschwindet und alle zugewiesenen Personen verlieren ihre Einschränkung. Die Zeichnungen im Bereich bleiben erhalten.", confirmLabel: "Löschen", danger: true })) return;
    socket.emit("zone:delete", { id }); if (S.current.selZone === id) setSelZone(null);
  }
  function zoneAssign(id, keys, mode) {
    if (!isAdmin || !keys.length) return;
    setZones(v => v.map(z => { if (z.id !== id) return z; const as = { ...(z.assignments || {}) }; keys.forEach(k => { if (mode) as[k] = mode; else delete as[k]; }); return { ...z, assignments: as }; }));
    socket.emit("zone:assign", { id, userIds: keys, mode });
  }
  const zoneObjects = z => S.current.strokes.filter(s => boxInRect(z, zoneBox(s)));
  async function zoneExport(z) {
    try { setBusy(true); await preloadImages(S.current.strokes); await exportPng(S.current.strokes.filter(s => rectsIntersect(objectBounds(s), z)), S.current.bg, { x: z.x, y: z.y, w: z.w, h: z.h }, `${boardName || "board"}-${z.name}`, 2); toast("Bereich als PNG exportiert", "success", 1700); }
    catch (e) { toast(e.message || "Export fehlgeschlagen", "error"); } finally { setBusy(false); }
  }
  async function zoneClear(z) {
    const list = zoneObjects(z); if (!list.length) return;
    if (!await askConfirm({ title: `Inhalt von „${z.name}“ leeren?`, message: `${list.length} Objekt${list.length === 1 ? "" : "e"} werden entfernt. Mit Rückgängig kannst du das wiederherstellen.`, confirmLabel: "Leeren", danger: true })) return;
    removeObjects(list);
  }
  function openZonePanel() { setZonePanel(v => !v); socket.emit("zone:candidates"); }
  function recolorSelection(c) { const sel = getSelected().filter(s => s.type !== "image"); if (sel.length) changeStates(sel, s => ({ ...s, color: c })); }

  /* ───────────── Darstellung ───────────── */
  const selBox = useMemo(() => { const ids = new Set(selectedIds); return ids.size ? selectedBounds(strokes.filter(s => ids.has(s._id))) : null; }, [strokes, selectedIds]);
  const selScreen = selBox && !dragging ? (() => {
    const cx = (selBox.x + selBox.w / 2) * view.zoom + view.pan.x, top = selBox.y * view.zoom + view.pan.y, bottom = (selBox.y + selBox.h) * view.zoom + view.pan.y;
    return { left: cx, top: top - 64 > 70 ? top - 64 : bottom + 18 };
  })() : null;
  const others = participants.filter(p => p.userId !== identityId);
  const zoneCounts = useMemo(() => { if (!isAdmin || !zonePanel) return {}; const out = {}; for (const z of zones) out[z.id] = strokes.reduce((n, s) => n + (boxInRect(z, zoneBox(s)) ? 1 : 0), 0); return out; }, [zones, strokes, zonePanel, isAdmin]);
  const myZones = zoneScope.restricted ? zones : [];
  const myZoneInfo = zoneScope.restricted ? (zoneScope.writableIds.length ? (zoneScope.seeAll ? "open" : "focus") : "view") : null;
  const showProps = !readOnly && DRAW_TOOLS.has(tool) && !propsHidden;
  const toolLabel = TOOLS.find(t => t.id === tool)?.label;
  const hint = zoneRO && !serverRO ? "Nur lesen – du siehst nur deinen Bereich." : readOnly ? "Nur Ansicht – du kannst dich frei im Board bewegen." : tool === "diagram" ? "Diagramm: Einstellungen links, dann Punkt auf dem Board anklicken · Esc bricht ab" : tool === "zone" ? "Bereich aufziehen · Bereich anklicken zum Verschieben · Ecken ziehen zum Skalieren" : zoneScope.restricted ? "Du darfst nur in deinem Bereich schreiben · Leertaste halten zum Verschieben"  : viewLocked ? "Der Admin steuert gerade die Ansicht." : tool === "hand" ? "Ziehen zum Verschieben · Mausrad zum Zoomen" : pencilMode ? "Stift zeichnet · Finger verschiebt & zoomt" : `${toolLabel} · Leertaste halten zum Verschieben · Mausrad zoomt`;
  const guestBadge = isGuest ? (guest.guest.mode === "view-only" ? "Gast · Ansicht" : "Gast · Bearbeiten") : null;

  return <main className="boardApp" data-theme-dark={isDarkColor(bg.color) ? "1" : "0"} onDragOver={e => { if (!readOnly && e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDropActive(true); } }} onDragLeave={e => { if (e.currentTarget === e.target) setDropActive(false); }} onDrop={onDrop}>
    <div ref={stackRef} className={`canvasStack tool-${readOnly ? "hand" : tool} ${viewLocked ? "locked" : ""}`}>
      <canvas ref={baseRef} className="baseCanvas" />
      <canvas ref={overlayRef} className="previewCanvas" onContextMenu={e => e.preventDefault()} />
      <CursorLayer store={cursors} view={view} />
      {textEdit && <textarea ref={textRef} autoFocus className="inlineText" value={textEdit.value} maxLength={TEXT_MAX_LENGTH} spellCheck={false}
        style={{ left: textEdit.x * view.zoom + view.pan.x, top: (textEdit.y - textEdit.fontSize * TEXT_BASELINE) * view.zoom + view.pan.y, width: Math.max(160, textEdit.maxWidth * view.zoom), height: Math.max(1.3, (textEdit.value.split("\n").length + 0.6)) * textEdit.fontSize * 1.25 * view.zoom, fontSize: textEdit.fontSize * view.zoom, color: textEdit.color, fontFamily: FONT_STACK }}
        placeholder="Text eingeben …" onChange={e => setTextEdit({ ...textEditRef.current, value: e.target.value })} onBlur={commitText}
        onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); setTextEdit(null); } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); commitText(); } }} />}
      {selScreen && !readOnly && !textEdit && <div className="selectionBar glass" style={{ left: selScreen.left, top: selScreen.top }} onPointerDown={e => e.stopPropagation()}>
        <button className="iconButton" data-tip="Duplizieren (Strg+D)" onClick={() => duplicateSelection()}><Icon name="copy" size={17} /></button>
        <label className="swatchMini" data-tip="Farbe ändern"><input type="color" value={color} onChange={e => { setColor(e.target.value); recolorSelection(e.target.value); }} /><span style={{ background: color }} /></label>
        <button className="iconButton danger" data-tip="Löschen (Entf)" onClick={deleteSelection}><Icon name="trash" size={17} /></button>
      </div>}
    </div>

    {!loaded && <div className="boardLoading"><Spinner label="Board wird geladen …" /></div>}
    {dropActive && <div className="dropOverlay"><Icon name="upload" size={34} /><b>Datei hier ablegen</b><span>Bilder landen direkt im Board</span></div>}

    <header className="boardTop">
      <div className="glass topLeft">
        <button className="iconButton back" onClick={() => onExit()} data-tip="Zurück zu den Boards"><Icon name="back" size={19} /></button>
        <div className="boardTitle"><strong title={boardName}>{boardName}</strong><span className={`conn ${connected ? "on" : "off"}`}><i />{connected ? "Live" : "Verbinde …"}{guestBadge && ` · ${guestBadge}`}</span></div>
      </div>
      <div className="topCenter"><div className="glass timerPill"><TimerWidget timerApi={timerApi} canControl={canControlTimer} /></div></div>
      <div className="glass topRight">
        <div className="popWrap" data-pop>
          <button className={`peopleButton ${popover === "people" ? "active" : ""}`} onClick={() => setPopover(popover === "people" ? null : "people")} aria-expanded={popover === "people"}>
            <span className="avatarStack">{others.slice(0, 3).map(p => <Avatar key={p.userId} name={p.displayName} size={26} color={colorFromId(p.userId)} />)}{others.length === 0 && <Avatar name={selfName} size={26} color={colorFromId(identityId)} />}</span>
            <b>{participants.length || 1}</b>
          </button>
          {popover === "people" && <ParticipantsPanel participants={participants} currentId={identityId} selfName={selfName} isAdmin={isAdmin} allowUserDeleteOthers={allowDeleteOthers} setDeleteOthers={setDeleteOthers} setUserReadOnly={setUserReadOnly} setAllReadOnly={setAllReadOnly} kickUser={kickUser} onClose={() => setPopover(null)} />}
        </div>
        {isAdmin && <button className={`iconButton zonesBtn ${zonePanel ? "active" : ""}`} onClick={openZonePanel} data-tip="Bereiche verwalten" aria-label="Bereiche verwalten"><Icon name="zone" size={19} />{zones.length > 0 && <em className="badge">{zones.length}</em>}</button>}
        {isAdmin && <button className={`iconButton ${viewSyncEnabled ? "active" : ""}`} onClick={toggleViewSync} data-tip={viewSyncEnabled ? "Ansicht-Teilen beenden" : "Meine Ansicht mit allen teilen"}><Icon name="eye" size={19} /></button>}
        {viewLocked && <span className="viewSyncBadge"><Icon name="eye" size={14} /> Admin-Ansicht</span>}
        <div className="popWrap" data-pop>
          <button className={`iconButton ${popover === "export" ? "active" : ""}`} onClick={() => setPopover(popover === "export" ? null : "export")} data-tip="Exportieren"><Icon name="download" size={19} /></button>
          {popover === "export" && <div className="menuPop">
            <button onClick={() => doExport("png")}><Icon name="image" size={17} /><span><b>PNG · sichtbarer Bereich</b><small>Genau das, was du siehst</small></span></button>
            <button onClick={() => doExport("png-all")}><Icon name="layers" size={17} /><span><b>PNG · gesamter Inhalt</b><small>Alle Objekte auf einem Bild</small></span></button>
            <button onClick={openPdf}><Icon name="pdf" size={17} /><span><b>PDF …</b><small>Mit Vorschau & Optionen</small></span></button>
            <button onClick={() => doExport("json")}><Icon name="file" size={17} /><span><b>JSON-Sicherung</b><small>Alle Daten des Boards</small></span></button>
          </div>}
        </div>
        <button className="iconButton" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} data-tip={theme === "dark" ? "Heller Modus" : "Dunkler Modus"}><Icon name={theme === "dark" ? "sun" : "moon"} size={19} /></button>
        {isAdmin && <button className="shareButton" onClick={openShare}><Icon name="share" size={16} /> <span>Teilen</span></button>}
      </div>
    </header>

    {readOnly && <div className="readOnlyBar"><Icon name="lock" size={15} /> {zoneRO && !serverRO ? "Nur lesen" : "Nur Lesezugriff"} <span>{zoneRO && !serverRO ? "· du siehst nur deinen Bereich, Änderungen siehst du live" : "· Änderungen anderer siehst du live"}</span></div>}
    {zoneScope.restricted && <div className="zoneChip glass" style={{ "--zc": (writableZones?.[0] || myZones[0])?.color || "#6366f1" }}>
      <i />
      <span><b>{myZones.length === 1 ? myZones[0].name : `${myZones.length} Bereiche`}</b><small>{myZoneInfo === "open" ? "Du siehst alles · schreiben nur hier" : myZoneInfo === "focus" ? "Du siehst & schreibst nur hier" : "Nur lesen"}{myZones.some(z => z.locked) ? " · teils gesperrt" : ""}</small></span>
      <button className="iconButton" data-tip="Zu meinem Bereich springen" aria-label="Zu meinem Bereich springen" onClick={() => focusRect(unionRect((myZoneInfo === "open" ? writableZones : null)?.length ? writableZones : myZones))}><Icon name="target" size={18} /></button>
    </div>}
    {isAdmin && zonePanel && <ZonesPanel zones={zones} counts={zoneCounts} candidates={candidates} selectedId={selZone}
      onSelect={id => { setSelZone(id); const z = zones.find(q => q.id === id); if (z) focusRect(z, 300); }} onCreate={zoneCreateInView} onUpdate={zoneUpdate} onDelete={zoneDelete} onAssign={zoneAssign}
      onJump={z => focusRect(z)} onExport={zoneExport} onClear={zoneClear} onClose={() => setZonePanel(false)} />}

    {!readOnly && <nav className="dock glass" aria-label="Werkzeuge">
      {TOOLS.map((t, i) => t === "sep" ? <i key={i} className="sep" /> : <button key={t.id} className={`dockBtn ${tool === t.id ? "active" : ""}`} data-tip={`${t.label} · ${t.key}`} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => { if (tool === t.id && (DRAW_TOOLS.has(t.id) || t.id === "diagram")) setPropsHidden(v => !v); else { setPropsHidden(false); chooseTool(t.id); } }}><Icon name={t.icon} size={20} /></button>)}
      {isAdmin && <><i className="sep" /><button className={`dockBtn zoneTool ${tool === "zone" ? "active" : ""}`} data-tip={`${ZONE_TOOL.label} aufziehen · ${ZONE_TOOL.key}`} aria-label={ZONE_TOOL.label} aria-pressed={tool === "zone"} onClick={() => chooseTool("zone")}><Icon name="zone" size={20} /></button></>}
      <i className="sep" />
      <button className="dockBtn" data-tip="Bild oder Datei hochladen" aria-label="Datei hochladen" onClick={() => fileInput.current?.click()}><Icon name="image" size={20} /></button>
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain" onChange={e => { [...(e.target.files || [])].forEach(f => handleFile(f)); e.target.value = ""; }} />
    </nav>}

    {tool === "diagram" && !readOnly && !propsHidden && <DiagramPanel cfg={diagCfg} setCfg={setDiagCfg} count={diagPrev.current.items.length} onClose={() => setPropsHidden(true)} />}
    {showProps && <div className="propPanel glass" key={tool}>
      {tool !== "eraser" && <div className="swatches">{COLORS.map(c => <button key={c} className={`swatch ${color.toLowerCase() === c ? "active" : ""} ${c === "#ffffff" ? "white" : ""}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />)}
        <label className={`swatch custom ${COLORS.includes(color.toLowerCase()) ? "" : "active"}`} style={!COLORS.includes(color.toLowerCase()) ? { background: color } : undefined}><input type="color" value={color} onChange={e => setColor(e.target.value)} /><Icon name="plus" size={13} /></label></div>}
      <div className="sizeRow"><span>{tool === "text" ? "Größe" : tool === "eraser" ? "Radierer" : "Stärke"}</span><input type="range" min="1" max="30" value={width} style={{ "--fill": `${(width - 1) / 29 * 100}%` }} onChange={e => setWidth(+e.target.value)} /><b>{tool === "text" ? fontFromWidth(width) : width}</b></div>
      <div className="sizePreview"><i style={{ width: tool === "text" ? 4 : Math.min(36, tool === "marker" ? markerWidth(width) : Math.max(2, width * (tool === "eraser" ? 2.5 : 1))), height: tool === "text" ? 4 : Math.min(36, tool === "marker" ? markerWidth(width) : Math.max(2, width * (tool === "eraser" ? 2.5 : 1))), background: tool === "eraser" ? "var(--danger)" : color, opacity: tool === "marker" ? .45 : 1 }} />{tool === "text" && <span style={{ color, fontSize: Math.min(40, fontFromWidth(width)) }}>Aa</span>}</div>
      {(tool === "rect" || tool === "circle") && <label className="toggleRow"><span>Füllung</span><span className={`switch ${fill ? "on" : ""}`}><input type="checkbox" checked={fill} onChange={e => setFill(e.target.checked)} /><span /></span></label>}
    </div>}

    <div className="bottomLeft glass">
      <button className="iconButton" disabled={readOnly || !canUndo} onClick={undo} data-tip="Rückgängig · Strg+Z"><Icon name="undo" size={19} /></button>
      <button className="iconButton" disabled={readOnly || !canRedo} onClick={redo} data-tip="Wiederholen · Strg+Y"><Icon name="redo" size={19} /></button>
      {isAdmin && <button className="iconButton danger" disabled={readOnly || !strokes.length} onClick={clearBoard} data-tip="Board leeren"><Icon name="trash" size={18} /></button>}
    </div>

    <div className="bottomRight">
      <div className="popWrap" data-pop>
        {popover === "bg" && !readOnly && !zoneScope.restricted && <div className="bgPop glass">
          <b>Hintergrund</b>
          <div className="bgGrid">{BGS.map(b => <button key={b[0]} className={`bgChip ${bg.color === b[1] && bg.pattern === b[2] && (b[2] === "none" || Number(bg.size) === b[3]) ? "active" : ""}`} onClick={() => chooseBg(b)}><span className={`bgSample p-${b[2]}`} style={{ background: b[1], color: isDarkColor(b[1]) ? "rgba(255,255,255,.35)" : "rgba(60,72,100,.35)" }} />{b[0]}</button>)}</div>
          <div className="bgRow"><label>Farbe<input type="color" value={bg.color} onChange={e => updateBg({ color: e.target.value })} /></label><label className="grow">Rastergröße<input type="range" min="8" max="60" value={bg.size || 24} style={{ "--fill": `${((bg.size || 24) - 8) / 52 * 100}%` }} onChange={e => updateBg({ size: +e.target.value })} /></label></div>
        </div>}
        <div className="glass pill">
          {!readOnly && !zoneScope.restricted && <button className={`iconButton ${popover === "bg" ? "active" : ""}`} onClick={() => setPopover(popover === "bg" ? null : "bg")} data-tip="Hintergrund"><Icon name="palette" size={19} /></button>}
          {!readOnly && <button className={`iconButton ${pencilMode ? "active" : ""}`} onClick={() => { cancelAct(); setPencilMode(v => !v); toast(pencilMode ? "Stiftmodus aus – Finger zeichnen wieder." : "Stiftmodus an – nur der Stift zeichnet, Finger verschieben & zoomen.", "info", 2400); }} data-tip="Stiftmodus (iPad)"><Icon name="touch" size={19} /></button>}
          <button className="iconButton" onClick={() => setShortcutsOpen(true)} data-tip="Tastenkürzel · ?"><Icon name="keyboard" size={19} /></button>
        </div>
      </div>
      <div className="glass pill zoomPill">
        <button className="iconButton" disabled={viewLocked} onClick={() => zoomButton(0.8)} data-tip="Verkleinern · −"><Icon name="minus" size={18} /></button>
        <button className="zoomValue" disabled={viewLocked} onClick={resetView} data-tip="Auf 100 % zurücksetzen">{Math.round(view.zoom * 100)}%</button>
        <button className="iconButton" disabled={viewLocked} onClick={() => zoomButton(1.25)} data-tip="Vergrößern · +"><Icon name="plus" size={18} /></button>
        <button className="iconButton" disabled={viewLocked} onClick={fitContent} data-tip="Alles anzeigen · F"><Icon name="fit" size={18} /></button>
      </div>
    </div>

    <div className="boardHint" key={hint}>{hint}</div>
    {files.some(f => !f.mimeType?.startsWith("image/")) && <div className="fileTray glass">{files.filter(f => !f.mimeType?.startsWith("image/")).slice(-5).map(f => <a className="fileCard" key={f.id} href={`${API}${f.url}`} target="_blank" rel="noreferrer"><Icon name={f.mimeType === "application/pdf" ? "pdf" : "file"} size={17} /><span>{f.originalName}</span></a>)}</div>}
    {busy && <div className="busyPill glass"><Spinner label="Wird verarbeitet …" /></div>}

    {shareOpen && <GuestShareModal invites={invites} error={shareError} busy={shareBusy} onCreate={createInvite} onRevoke={revokeInvite} onClose={() => setShareOpen(false)} />}
    <Modal open={shortcutsOpen} title="Tastenkürzel & Gesten" onClose={() => setShortcutsOpen(false)} className="shortcutsPanel">
      <div className="shortcutGrid">
        {[["V", "Auswählen"], ["H", "Ansicht verschieben"], ["L", "Lasso"], ["P", "Stift"], ["M", "Textmarker"], ["E", "Radierer"], ["I", "Linie"], ["A", "Pfeil"], ["R", "Rechteck"], ["O", "Kreis"], ["T", "Text"], ["B", "Bereich aufziehen (Admin)"], ["Strg + Z / Y", "Rückgängig / Wiederholen"], ["Strg + A", "Alles auswählen"], ["Strg + C / V", "Kopieren / Einfügen"], ["Strg + D", "Duplizieren"], ["Entf", "Auswahl löschen"], ["Pfeiltasten", "Auswahl verschieben (Shift = 10 px)"], ["Leertaste + Ziehen", "Ansicht verschieben"], ["Mausrad / Strg + Rad", "Zoomen"], ["+ / − / 0 / F", "Zoom · 100 % · Alles anzeigen"], ["Shift beim Zeichnen", "Gerade Linie / Quadrat / Kreis"], ["Doppelklick auf Text", "Text bearbeiten"], ["2 Finger", "Zoomen & verschieben (Touch)"], ["Bild einfügen", "Strg + V oder Drag & Drop"]].map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}
      </div>
    </Modal>
    <Modal open={pdfOpen} title="PDF exportieren" onClose={() => !pdfBusy && setPdfOpen(false)} className="pdfExportPanel">
      <div className="pdfExportGrid">
        <div className="pdfPreviewPane">{pdfPreview ? <img src={pdfPreview} alt="PDF Vorschau" /> : <Spinner label="Vorschau …" />}</div>
        <div className="pdfControls">
          <label>Bereich<select value={pdfConfig.area} onChange={e => { const c = { ...pdfConfig, area: e.target.value }; setPdfConfig(c); refreshPdfPreview(c); }}><option value="viewport">Sichtbarer Bereich</option><option value="content">Alle Inhalte</option></select></label>
          <label>Papier<select value={pdfConfig.paper} onChange={e => setPdfConfig(v => ({ ...v, paper: e.target.value }))}><option value="a4">A4</option><option value="letter">Letter</option></select></label>
          <label>Ausrichtung<select value={pdfConfig.orientation} onChange={e => setPdfConfig(v => ({ ...v, orientation: e.target.value }))}><option value="landscape">Querformat</option><option value="portrait">Hochformat</option></select></label>
          <label>Qualität<select value={pdfConfig.quality} onChange={e => setPdfConfig(v => ({ ...v, quality: Number(e.target.value) }))}><option value="1">Standard</option><option value="2">Hoch</option><option value="3">Sehr hoch</option></select></label>
          <label>Modus<select value={pdfConfig.mode} onChange={e => setPdfConfig(v => ({ ...v, mode: e.target.value }))}><option value="raster">Raster · originalgetreu</option><option value="vector">Vektor · Formen &amp; Text</option></select></label>
          {pdfBusy && <div className="pdfProgress"><span style={{ width: `${pdfProgress}%` }} /></div>}
          <div className="actions"><button className="primary" onClick={runPdf} disabled={pdfBusy}>{pdfBusy ? `Erstelle ${pdfProgress}%…` : "PDF erstellen"}</button><button onClick={() => setPdfOpen(false)} disabled={pdfBusy}>Abbrechen</button></div>
        </div>
      </div>
    </Modal>
  </main>;
}
