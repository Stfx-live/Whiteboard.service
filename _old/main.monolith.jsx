import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import { jsPDF } from "jspdf";
import "./style.css";
import Modal from "./components/Modal";
import { LoadingOverlay, SkeletonCard, Spinner } from "./components/Loading";
import { createHistory, pushHistory, redoHistory, undoHistory } from "./lib/undoRedo";

const API = window.__WHITEBOARD_API__ || "";
const SOCKET_ORIGIN = API || window.location.origin;
const socket = io(SOCKET_ORIGIN, {
  autoConnect: false,
  path: "/socket.io",
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 300,
});
const TOKEN_KEY = "whiteboard-auth-token";
const DEFAULT_BG = { color: "#ffffff", pattern: "grid", size: 24 };
const THEME_KEY = "whiteboard-theme";
const GUEST_SESSION_KEY = "whiteboard-guest-session";
const DISPLAY_NAME_MAX = 48;
const TEXT_MAX_LENGTH = 5000;
const TEXT_DEFAULT_WIDTH = 420;

function getTextWidth(s) {
  return Math.max(120, Number(s?.maxWidth || s?.textWidth || TEXT_DEFAULT_WIDTH) || TEXT_DEFAULT_WIDTH);
}

function wrapCanvasText(ctx, value, maxWidth) {
  const source = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = source.split("\n");
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { lines.push(""); continue; }
    const words = paragraph.split(/(\s+)/).filter(Boolean);
    let line = "";
    for (const token of words) {
      const candidate = line + token;
      if (!line || ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
      lines.push(line.trimEnd());
      if (ctx.measureText(token).width <= maxWidth) { line = token.trimStart(); continue; }
      let chunk = "";
      for (const ch of token) {
        const next = chunk + ch;
        if (chunk && ctx.measureText(next).width > maxWidth) { lines.push(chunk); chunk = ch; }
        else chunk = next;
      }
      line = chunk;
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}

function getCanvasTextLayout(ctx, s) {
  const fontSize = Math.max(12, Number(s?.fontSize || 28));
  const lineHeight = Math.round(fontSize * 1.25);
  const maxWidth = getTextWidth(s);
  ctx.font = `${fontSize}px sans-serif`;
  const lines = wrapCanvasText(ctx, s?.text, maxWidth);
  const measuredWidth = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
  return { fontSize, lineHeight, maxWidth, lines, width: Math.min(maxWidth, Math.max(36, measuredWidth)), height: Math.max(fontSize, fontSize + (lines.length - 1) * lineHeight) };
}
const TOOLS = [
  ["select", "↖", "Auswählen"], ["lasso", "⌁", "Lasso-Auswahl"], ["pen", "✎", "Stift"], ["eraser", "⌫", "Radierer"],
  ["line", "╱", "Linie"], ["rect", "□", "Rechteck"], ["circle", "○", "Kreis"], ["text", "T", "Text"],
];
const BGS = [
  ["Weiß", "#fff", "none", 24], ["Raster", "#fff", "grid", 24], ["Feines Raster", "#fff", "grid", 12],
  ["Punkte", "#fff", "dots", 22], ["Große Punkte", "#fff", "dots", 34], ["Linien", "#fff", "lines", 28],
  ["Creme", "#fffaf0", "none", 24], ["Blau", "#f2f7ff", "none", 24], ["Grün", "#f2fbf5", "none", 24],
  ["Lavendel", "#f7f3ff", "none", 24],
];
function uid() { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; } }
function structuredCloneSafe(value) { try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); } }
function getSavedToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function saveToken(token) { try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {} }
async function api(path, options = {}, token = "") {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

async function upload(path, file, token = "", field = "file", guestToken = "") {
  const form = new FormData();
  form.append(field, file);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (guestToken) headers["X-Guest-Token"] = guestToken;
  const response = await fetch(`${API}${path}`, { method: "POST", headers, body: form });
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function readGuestSession() { try { return JSON.parse(sessionStorage.getItem(GUEST_SESSION_KEY) || "null"); } catch { return null; } }
function saveGuestSession(value) { try { value ? sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(value)) : sessionStorage.removeItem(GUEST_SESSION_KEY); } catch {} }

function useBoardTimer(socket, boardId, canControl) {
  const [timer, setTimer] = useState({ status: "idle", durationMs: 5 * 60 * 1000, remainingMs: 5 * 60 * 1000, startedAt: null, endsAt: null, version: 0, serverNow: Date.now() });
  const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0);
  const previousStatus = useRef("idle");

  useEffect(() => {
    if (!boardId) return;
    const apply = payload => {
      if (!payload) return;
      clockOffset.current = Number(payload.serverNow || Date.now()) - Date.now();
      setTimer(payload);
      setNow(Date.now());
    };
    const names = ["timer:start", "timer:pause", "timer:reset", "timer:tick", "timer:sync", "timer:expired"];
    names.forEach(name => socket.on(name, apply));
    if (socket.connected) socket.emit("timer:sync");
    return () => names.forEach(name => socket.off(name, apply));
  }, [socket, boardId]);

  useEffect(() => {
    if (timer.status !== "running" || !timer.endsAt) return;
    const id = setInterval(() => {
      setNow(Date.now());
      const correctedNow = Date.now() + clockOffset.current;
      if (correctedNow >= timer.endsAt && previousStatus.current !== "expired") {
        previousStatus.current = "expired";
      }
    }, 200);
    return () => clearInterval(id);
  }, [timer.status, timer.endsAt]);

  useEffect(() => {
    if (timer.status !== previousStatus.current) previousStatus.current = timer.status;
    if (timer.status === "expired") {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = AudioCtx ? new AudioCtx() : null;
        if (ctx) { const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.frequency.value = 880; gain.gain.value = 0.05; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.18); }
      } catch {}
    }
  }, [timer.status]);

  const correctedNow = now + clockOffset.current;
  const remainingMs = timer.status === "running" && timer.endsAt ? Math.max(0, timer.endsAt - correctedNow) : Math.max(0, Number(timer.remainingMs || 0));
  const start = durationMs => { if (canControl) socket.emit("timer:start", { durationMs }); };
  const pause = () => { if (canControl) socket.emit("timer:pause"); };
  const reset = durationMs => { if (canControl) socket.emit("timer:reset", { durationMs }); };
  return { timer, remainingMs, start, pause, reset };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function TimerWidget({ timerApi, canControl }) {
  const { timer, remainingMs, start, pause, reset } = timerApi;
  const currentMinutes = Math.max(1, Math.round((timer.durationMs || 5 * 60 * 1000) / 60000));
  const [customMinutes, setCustomMinutes] = useState(currentMinutes);
  const [open, setOpen] = useState(false);
  const summaryRef = useRef(null);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 280 });
  useEffect(() => { setCustomMinutes(currentMinutes); }, [currentMinutes]);
  const expired = timer.status === "expired";
  const running = timer.status === "running";
  const safeMinutes = Math.max(1, Math.min(240, Number(customMinutes) || 1));
  const customDuration = safeMinutes * 60 * 1000;
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = summaryRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 280;
      const gap = 8;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
      const top = Math.max(8, Math.min(window.innerHeight - 8, rect.bottom + gap));
      setPanelPos({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  return <div className={`timerWidget ${expired ? "expired" : ""} ${open ? "open" : "compact"}`}>
    <button ref={summaryRef} className="timerSummary" onClick={() => setOpen(v => !v)} title="Timer öffnen/schließen" aria-expanded={open}>
      <span className="timerIcon">⏱</span>
      <span className="timerSummaryTime">{formatDuration(remainingMs)}</span>
      <span className="timerSummaryState">{expired ? "Abgelaufen" : running ? "Läuft" : "Timer"}</span>
      <span className="timerChevron">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && createPortal(<div className="timerPanel timerPanelPortal" style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}>
      <div className="timerTop"><span className="timerLabel">{expired ? "Zeit abgelaufen" : "Countdown"}</span><strong>{formatDuration(remainingMs)}</strong></div>
      <div className="timerBar"><span style={{ width: `${timer.durationMs ? Math.max(0, Math.min(100, remainingMs / timer.durationMs * 100)) : 0}%` }} /></div>
      {canControl && <div className="timerControls">
        <label className="timerCustom"><span>Minuten</span><input type="number" min="1" max="240" inputMode="numeric" value={customMinutes} onChange={e => setCustomMinutes(e.target.value)} /></label>
        <div className="timerActions">
          {running ? <button onClick={pause}>Pause</button> : <button className="primary" onClick={() => start(expired ? customDuration : (timer.remainingMs || customDuration))}>{expired ? "Neu starten" : "Start"}</button>}
          <button onClick={() => reset(customDuration)}>Setzen</button>
        </div>
        <div className="timerPresets">{[1,5,10,15].map(v => <button key={v} className={safeMinutes === v ? "selected" : ""} onClick={() => { setCustomMinutes(v); reset(v * 60 * 1000); }}>{v}m</button>)}</div>
      </div>}
      {!canControl && <div className="timerViewerHint">Nur Host kann den Timer steuern.</div>}
    </div>, document.body)}
  </div>;
}


function AuthShell({ children, loading = false }) {
  const ref = useRef(null);
  function move(e) {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 24;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 18;
    ref.current.style.setProperty("--mx", `${x}px`);
    ref.current.style.setProperty("--my", `${y}px`);
  }
  return <main ref={ref} className={`authPagePro ${loading ? "isLoading" : ""}`} onPointerMove={move}>
    <div className="authGridGlow" />
    <div className="authShape authShapeA" /><div className="authShape authShapeB" /><div className="authShape authShapeC" />
    <div className="authScene">{children}</div>
  </main>;
}

function OtpInput({ value, onChange, disabled = false }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || "");
  function focusAt(index) { if (index >= 0 && index < 6) refs.current[index]?.focus(); }
  function applyDigits(raw) {
    const clean = String(raw || "").replace(/\D/g, "").slice(0, 6);
    onChange(clean);
    focusAt(Math.min(clean.length, 5));
  }
  return <div className="otpBoxes" onPaste={e => { e.preventDefault(); applyDigits(e.clipboardData.getData("text")); }}>
    {digits.map((digit, index) => <input
      key={index}
      ref={el => { refs.current[index] = el; }}
      value={digit}
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={1}
      disabled={disabled}
      aria-label={`Code Stelle ${index + 1}`}
      onFocus={e => e.currentTarget.select()}
      onChange={e => {
        const n = e.target.value.replace(/\D/g, "").slice(-1);
        const next = digits.slice(); next[index] = n; onChange(next.join("").slice(0, 6));
        if (n) focusAt(Math.min(index + 1, 5));
      }}
      onKeyDown={e => {
        if (e.key === "Backspace" && !digits[index]) { onChange(digits.slice(0, Math.max(0, index)).join("")); focusAt(index - 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); focusAt(index - 1); }
        if (e.key === "ArrowRight") { e.preventDefault(); focusAt(index + 1); }
      }}
    />)}
  </div>;
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [token, setToken] = useState(() => getSavedToken());
  const [account, setAccount] = useState(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [guestInviteToken] = useState(() => { const q = new URLSearchParams(window.location.search).get("guest"); const h = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("guest"); return q || h || ""; });
  const [guestSession, setGuestSession] = useState(() => readGuestSession());
  const [guestJoinName, setGuestJoinName] = useState("");
  const [guestCode, setGuestCode] = useState("");
  const [guestError, setGuestError] = useState("");
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestShareOpen, setGuestShareOpen] = useState(false);
  const [guestInvites, setGuestInvites] = useState([]);
  const [guestShareError, setGuestShareError] = useState("");
  const [guestShareBusy, setGuestShareBusy] = useState(false);
  const [changeCurrent, setChangeCurrent] = useState("");
  const [changeNew, setChangeNew] = useState("");
  const [changeNew2, setChangeNew2] = useState("");
  const [changeError, setChangeError] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem(THEME_KEY) || "light"; } catch { return "light"; } });

  const [cards, setCards] = useState([]);
  const [folders, setFolders] = useState([]);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [dragBoardId, setDragBoardId] = useState(null);
  const [sortBy, setSortBy] = useState("updated");
  const [loading, setLoading] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [profileNewPassword, setProfileNewPassword] = useState("");
  const [profileNewPassword2, setProfileNewPassword2] = useState("");
  const [profileError, setProfileError] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileFile, setProfileFile] = useState(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [files, setFiles] = useState([]);
  const [cursors, setCursors] = useState({});
  const [board, setBoard] = useState(null);
  const [newBoardName, setNewBoardName] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [tool, setTool] = useState("pen");
  const [selectedIds, setSelectedIds] = useState([]);
  const [textEditorOpen, setTextEditorOpen] = useState(false);
  const [textEditorValue, setTextEditorValue] = useState("");
  const [textEditorPoint, setTextEditorPoint] = useState(null);
  const [textEditorSize, setTextEditorSize] = useState(28);
  const [color, setColor] = useState("#111827");
  const [width, setWidth] = useState(3);
  const [bg, setBg] = useState(DEFAULT_BG);
  const [bgOpen, setBgOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPosition, setExportPosition] = useState({ top: 0, left: 0 });
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState("");
  const [pdfConfig, setPdfConfig] = useState({ area: "viewport", quality: 2, paper: "a4", orientation: "landscape", mode: "raster" });
  const [strokes, setStrokes] = useState([]);
  const [remoteStrokes, setRemoteStrokes] = useState({});
  const [zoom, setZoom] = useState(1);
  const [pencilMode, setPencilMode] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [participants, setParticipants] = useState([]);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [connected, setConnected] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminError, setAdminError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [tempPasswordReveal, setTempPasswordReveal] = useState(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessTarget, setAccessTarget] = useState(null);
  const [accessMode, setAccessMode] = useState("all");
  const [accessUserIds, setAccessUserIds] = useState([]);
  const [accessError, setAccessError] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [viewSyncEnabled, setViewSyncEnabled] = useState(false);
  const [allowUserDeleteOthers, setAllowUserDeleteOthers] = useState(false);
  const hostViewTimer = useRef(null);
  const hostViewFrame = useRef(null);
  const pendingHostView = useRef(null);
  const latestHostViewSeq = useRef(0);
  const sharedHostCenterRef = useRef(null);
  const sharedViewAnimFrame = useRef(null);

  const base = useRef(null), preview = useRef(null), stack = useRef(null), exportButton = useRef(null);
  const active = useRef(false), activePointer = useRef(null), current = useRef(null), points = useRef([]);
  const previewFrame = useRef(null), liveStrokeId = useRef(null), liveStrokeFrame = useRef(null), liveStrokeLastSent = useRef(0);
  const activeTouches = useRef(new Map()), gesture = useRef(null);
  const lassoPoints = useRef([]), movingSelection = useRef(false), moveLastSent = useRef(0), moveLastSentPoint = useRef(null), selectionTransform = useRef(null);
  const boardRef = useRef(board), pencilModeRef = useRef(pencilMode), panRef = useRef(pan), zoomRef = useRef(zoom);
  const readOnlyRef = useRef(readOnly), accountRef = useRef(account), guestRef = useRef(guestSession), identityIdRef = useRef(account?.id || guestSession?.guest?.id || null), strokesRef = useRef(strokes);
  const committedIds = useRef(new Set()), pendingCommits = useRef([]);
  const imageCache = useRef(new Map());
  const measureCanvas = useRef(null);
  const paintFrame = useRef(null);
  const history = useRef(createHistory());
  const cursorLastSent = useRef(0);
  const selectedIdsRef = useRef([]);

  function sharedViewPayload(nextZoom = zoomRef.current, nextPan = panRef.current) {
    const rect = stack.current?.getBoundingClientRect();
    if (!rect) return { zoom: nextZoom, pan: { ...nextPan }, center: sharedHostCenterRef.current };
    return {
      zoom: nextZoom,
      center: {
        x: (rect.width / 2 - nextPan.x) / nextZoom,
        y: (rect.height / 2 - nextPan.y) / nextZoom,
      },
      pan: { ...nextPan },
    };
  }

  function animateSharedView(payload) {
    const nextZoom = Math.max(0.25, Math.min(5, Number(payload?.zoom) || 1));
    const rect = stack.current?.getBoundingClientRect();
    const center = payload?.center && Number.isFinite(Number(payload.center.x)) && Number.isFinite(Number(payload.center.y))
      ? { x: Number(payload.center.x), y: Number(payload.center.y) }
      : null;
    const nextPan = center && rect
      ? { x: rect.width / 2 - center.x * nextZoom, y: rect.height / 2 - center.y * nextZoom }
      : (payload?.pan && typeof payload.pan === "object" ? { x: Number(payload.pan.x) || 0, y: Number(payload.pan.y) || 0 } : { x: 0, y: 0 });
    if (center) sharedHostCenterRef.current = center;
    if (sharedViewAnimFrame.current) cancelAnimationFrame(sharedViewAnimFrame.current);
    const startZoom = zoomRef.current;
    const startPan = { ...panRef.current };
    const started = performance.now();
    const duration = 70;
    const step = now => {
      const p = Math.min(1, (now - started) / duration);
      const eased = p * p * (3 - 2 * p);
      setZoom(startZoom + (nextZoom - startZoom) * eased);
      setPan({ x: startPan.x + (nextPan.x - startPan.x) * eased, y: startPan.y + (nextPan.y - startPan.y) * eased });
      if (p < 1) sharedViewAnimFrame.current = requestAnimationFrame(step);
      else sharedViewAnimFrame.current = null;
    };
    sharedViewAnimFrame.current = requestAnimationFrame(step);
  }

  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { pencilModeRef.current = pencilMode; }, [pencilMode]);
  useEffect(() => { panRef.current = pan; }, [pan]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => {
    if (!viewSyncEnabled || account?.role !== "admin" || !boardRef.current?.id || !socket.connected) return;
    const shared = sharedViewPayload(zoom, pan);
    pendingHostView.current = { boardId: boardRef.current.id, ...shared };
    if (hostViewTimer.current) return;
    hostViewTimer.current = setTimeout(() => {
      hostViewTimer.current = null;
      const next = pendingHostView.current;
      pendingHostView.current = null;
      if (next && socket.connected) socket.emit("host-view", next);
    }, 33);
  }, [zoom, pan, viewSyncEnabled, account]);
  useEffect(() => {
    if (!viewSyncEnabled) return;
    const onResize = () => {
      if (account?.role === "admin") {
        const shared = sharedViewPayload();
        if (boardRef.current?.id && socket.connected) {
          pendingHostView.current = { boardId: boardRef.current.id, ...shared };
        }
      } else if (sharedHostCenterRef.current) {
        animateSharedView({ zoom: zoomRef.current, center: sharedHostCenterRef.current });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [viewSyncEnabled, account]);
  useEffect(() => () => {
    if (hostViewTimer.current) clearTimeout(hostViewTimer.current);
    if (hostViewFrame.current) cancelAnimationFrame(hostViewFrame.current);
    if (sharedViewAnimFrame.current) cancelAnimationFrame(sharedViewAnimFrame.current);
  }, []);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { accountRef.current = account; guestRef.current = guestSession; identityIdRef.current = account?.id || guestSession?.guest?.id || null; }, [account, guestSession]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1720" : "#eef1f4");
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);
  useEffect(() => { if (account) { setProfileName(account.displayName || account.username); } }, [account]);
  useEffect(() => { if (!exportOpen) return; const close = () => setExportOpen(false); window.addEventListener("resize", close); window.addEventListener("scroll", close, true); return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); }; }, [exportOpen]);
  useEffect(() => {
    if (!participantsOpen) return;
    const updateParticipantsPosition = () => {
      const header = document.querySelector(".boardHeader");
      const toolbar = document.querySelector(".boardToolbar");
      const headerBottom = header?.getBoundingClientRect().bottom || 0;
      const toolbarBottom = toolbar?.getBoundingClientRect().bottom || headerBottom;
      document.documentElement.style.setProperty("--participants-top", `${Math.max(headerBottom, toolbarBottom) + 8}px`);
    };
    updateParticipantsPosition();
    window.addEventListener("resize", updateParticipantsPosition);
    return () => { window.removeEventListener("resize", updateParticipantsPosition); document.documentElement.style.removeProperty("--participants-top"); };
  }, [participantsOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (guestInviteToken || guestSession) { setAuthReady(true); return; }
      const saved = getSavedToken();
      if (!saved) { setAuthReady(true); return; }
      try {
        const data = await api("/api/auth/me", {}, saved);
        if (!cancelled) { setToken(saved); setAccount(data.account); }
      } catch {
        saveToken(""); if (!cancelled) { setToken(""); setAccount(null); }
      } finally { if (!cancelled) setAuthReady(true); }
    })();
    return () => { cancelled = true; };
  }, [guestInviteToken, guestSession]);

  useEffect(() => {
    if (guestSession?.board && !boardRef.current) setBoard(guestSession.board);
  }, [guestSession]);

  useEffect(() => {
    if (!guestInviteToken || guestSession) return;
    const savedName = sessionStorage.getItem("whiteboard-guest-name") || "";
    setGuestJoinName(savedName);
  }, [guestInviteToken, guestSession]);

  useEffect(() => {
    if (guestSession?.token) {
      socket.auth = { guestToken: guestSession.token };
      if (!socket.connected) socket.connect();
      return () => {};
    }
    if (!token || !account || account.mustChangePassword) { setConnected(false); socket.disconnect(); return; }
    socket.auth = { token };
    if (!socket.connected) socket.connect();
  }, [token, account, guestSession]);

  useEffect(() => {
    const onConnect = () => { setConnected(true); if (boardRef.current?.id) socket.emit("join-board", { boardId: boardRef.current.id }); flushPendingCommits(); };
    const onDisconnect = () => setConnected(false);
    const onConnectError = err => { setConnected(false); if (err?.message === "PASSWORD_CHANGE_REQUIRED") setAccount(v => v ? { ...v, mustChangePassword: true } : v); if (guestRef.current && err?.message === "AUTH_REQUIRED") { saveGuestSession(null); setGuestSession(null); setGuestError("Der Gastzugang ist abgelaufen oder wurde widerrufen."); } };
    socket.on("connect", onConnect); socket.on("disconnect", onDisconnect); socket.on("connect_error", onConnectError);
    return () => { socket.off("connect", onConnect); socket.off("disconnect", onDisconnect); socket.off("connect_error", onConnectError); };
  }, []);

  useEffect(() => {
    if (!authReady || !token || !account || account.mustChangePassword || guestSession) return;
    setLoading(true);
    Promise.all([
      api(`/api/boards?sort=${encodeURIComponent(sortBy)}`, {}, token),
      api("/api/folders", {}, token)
    ])
      .then(([boardData, folderData]) => { setCards(boardData || []); setFolders(folderData?.folders || []); })
      .catch(e => setAuthError(e.message))
      .finally(() => setLoading(false));
  }, [authReady, token, account, sortBy]);

  useEffect(() => {
    const state = s => {
      const next = Array.isArray(s.strokes) ? s.strokes : [];
      committedIds.current = new Set(next.map(x => x?._id).filter(Boolean));
      setStrokes(next); setSelectedIds([]); setRemoteStrokes({}); setBg(s.background && typeof s.background === "object" ? s.background : DEFAULT_BG);
      setFiles(Array.isArray(s.files) ? s.files : []);
      history.current = createHistory();
      setParticipants(Array.isArray(s.participants) ? s.participants : []); setReadOnly(Boolean(s.permissions?.readOnly)); setAllowUserDeleteOthers(Boolean(s.boardSettings?.allowUserDeleteOthers)); setViewSyncEnabled(Boolean(s.viewSync?.enabled)); if (s.viewSync?.enabled && account?.role !== "admin") { latestHostViewSeq.current = Number(s.viewSync?.seq) || 0; animateSharedView(s.viewSync); } else if (!s.viewSync?.enabled || account?.role === "admin") { sharedHostCenterRef.current = null; setZoom(Number(s.viewSync?.zoom) || 1); setPan(s.viewSync.pan && typeof s.viewSync.pan === "object" ? s.viewSync.pan : { x: 0, y: 0 }); }
    };
    const roomUsers = payload => {
      const next = Array.isArray(payload?.participants) ? payload.participants : [];
      setParticipants(next);
      const me = next.find(p => p.userId === identityIdRef.current);
      if (me) setReadOnly(Boolean(me.readOnly));
      const online = new Set(next.map(p => p.userId));
      setCursors(current => Object.fromEntries(Object.entries(current).filter(([id]) => online.has(id))));
      setCards(items => items.map(card => card.id === boardRef.current?.id ? { ...card, members: next.length } : card));
    };
    const live = payload => { const stroke = payload?.stroke; if (!stroke?._id || committedIds.current.has(stroke._id) || !Array.isArray(stroke.points)) return; setRemoteStrokes(v => ({ ...v, [stroke._id]: stroke })); };
    const commitRemote = payload => {
      const stroke = payload?.stroke; if (!stroke?._id) return;
      committedIds.current.add(stroke._id);
      setRemoteStrokes(v => { if (!(stroke._id in v)) return v; const next = { ...v }; delete next[stroke._id]; return next; });
      setStrokes(v => v.some(item => item?._id === stroke._id) ? v : [...v, stroke]);
    };
    const cancelLive = payload => { if (!payload?._id) return; setRemoteStrokes(v => { if (!(payload._id in v)) return v; const next = { ...v }; delete next[payload._id]; return next; }); };
    const drawBatch = payload => {
      const incoming = Array.isArray(payload) ? payload : payload?.strokes; if (!Array.isArray(incoming)) return;
      incoming.forEach(item => item?._id && committedIds.current.add(item._id));
      setStrokes(v => { const seen = new Set(v.map(item => item?._id)); return [...v, ...incoming.filter(item => item?._id && !seen.has(item._id))]; });
    };
    const erase = payload => { const ids = new Set(Array.isArray(payload?.ids) ? payload.ids : []); setStrokes(v => v.filter(item => !ids.has(item._id))); };
    const clearBoard = () => { setStrokes([]); setRemoteStrokes({}); committedIds.current.clear(); history.current = createHistory(); };
    const background = value => setBg(value && typeof value === "object" ? value : DEFAULT_BG);
    const permissionChanged = payload => { setReadOnly(Boolean(payload?.readOnly)); resetPointerState(); };
    const applyHostView = payload => {
      if (accountRef.current?.role === "admin") return;
      const seq = Number(payload?.seq) || 0;
      if (seq && seq <= latestHostViewSeq.current) return;
      if (seq) latestHostViewSeq.current = seq;
      setViewSyncEnabled(true);
      animateSharedView(payload);
    };
    const viewSyncState = payload => {
      const enabled = Boolean(payload?.enabled);
      setViewSyncEnabled(enabled);
      if (enabled && accountRef.current?.role !== "admin") {
        applyHostView(payload);
      } else if (!enabled) {
        sharedHostCenterRef.current = null;
        if (sharedViewAnimFrame.current) cancelAnimationFrame(sharedViewAnimFrame.current);
      }
    };
    const hostView = payload => {
      if (accountRef.current?.role === "admin") return;
      pendingHostView.current = payload;
      if (hostViewFrame.current) return;
      hostViewFrame.current = requestAnimationFrame(() => {
        hostViewFrame.current = null;
        const next = pendingHostView.current;
        pendingHostView.current = null;
        if (next) applyHostView(next);
      });
    };
    const boardSettings = payload => setAllowUserDeleteOthers(Boolean(payload?.allowUserDeleteOthers));
    const boardMeta = payload => { if (!payload?.id) return; setBoard(current => current?.id === payload.id ? { ...current, name: payload.name || current.name, updatedAt: payload.updatedAt || current.updatedAt } : current); setCards(items => items.map(card => card.id === payload.id ? { ...card, name: payload.name || card.name, updatedAt: payload.updatedAt || card.updatedAt } : card)); };
    const boardDeleted = payload => { if (payload?.boardId !== boardRef.current?.id) return; resetPointerState(); setBoard(null); setStrokes([]); setParticipants([]); alert("Dieses Whiteboard wurde gelöscht."); };
    const cursorMove = payload => { if (!payload?.userId || payload.userId === identityIdRef.current) return; setCursors(v => ({ ...v, [payload.userId]: payload })); };
    const fileAdded = payload => { if (!payload?.file) return; setFiles(v => v.some(f => f.id === payload.file.id) ? v : [...v, payload.file]); };
    const kicked = () => { resetPointerState(); socket.emit("leave-board"); setBoard(null); setParticipants([]); setParticipantsOpen(false); setBg(DEFAULT_BG); setViewSyncEnabled(false); alert("Du wurdest vom Admin entfernt."); };
    const boardAccessDenied = payload => { if (payload?.boardId && boardRef.current?.id === payload.boardId) { resetPointerState(); socket.emit("leave-board"); setBoard(null); setParticipants([]); setParticipantsOpen(false); setBg(DEFAULT_BG); setViewSyncEnabled(false); alert(payload.message || "Du hast keinen Zugriff auf dieses Whiteboard."); } };
    const boardAccessRevoked = payload => boardAccessDenied(payload);
    const adminError = payload => setAdminError(payload?.message || "Serverfehler");
    socket.on("board-state", state); socket.on("room-users", roomUsers); socket.on("stroke-live", live); socket.on("stroke-live-cancel", cancelLive);
    const remoteMoves = payload => applyRemoteTransforms((payload?.moves || []).map(m => ({ id: m.id, dx: m.dx, dy: m.dy })));
    const remoteTransforms = payload => applyRemoteTransforms(payload?.transforms);
    socket.on("stroke-commit", commitRemote); socket.on("draw-batch", drawBatch); socket.on("objects-moved", remoteMoves); socket.on("objects-transformed", remoteTransforms); socket.on("erase", erase); socket.on("clear-board", clearBoard); socket.on("set-background", background);
    socket.on("permission-changed", permissionChanged); socket.on("board-settings", boardSettings); socket.on("view-sync-state", viewSyncState); socket.on("host-view", hostView); socket.on("kicked", kicked); socket.on("board-access-denied", boardAccessDenied); socket.on("board-access-revoked", boardAccessRevoked); socket.on("admin-error", adminError); socket.on("board-meta", boardMeta); socket.on("board-deleted", boardDeleted);
    socket.on("cursor:move", cursorMove); socket.on("file-added", fileAdded);
    return () => {
      socket.off("board-state", state); socket.off("room-users", roomUsers); socket.off("stroke-live", live); socket.off("stroke-live-cancel", cancelLive); socket.off("stroke-commit", commitRemote);
      socket.off("draw-batch", drawBatch); socket.off("objects-moved", remoteMoves); socket.off("objects-transformed", remoteTransforms); socket.off("erase", erase); socket.off("clear-board", clearBoard); socket.off("set-background", background); socket.off("permission-changed", permissionChanged); socket.off("board-settings", boardSettings); socket.off("view-sync-state", viewSyncState); socket.off("host-view", hostView);
      socket.off("kicked", kicked); socket.off("board-access-denied", boardAccessDenied); socket.off("board-access-revoked", boardAccessRevoked); socket.off("admin-error", adminError); socket.off("board-meta", boardMeta); socket.off("board-deleted", boardDeleted); socket.off("cursor:move", cursorMove); socket.off("file-added", fileAdded);
    };
  }, []);

  useEffect(() => {
    if (!board?.id || ((!token || !account || account.mustChangePassword) && !guestSession)) return;
    resetPointerState(); setRemoteStrokes({}); setStrokes([]); setFiles([]); history.current = createHistory(); setBg(board.background || DEFAULT_BG); setPan({ x: 0, y: 0 }); setZoom(1); setCursors({}); setAllowUserDeleteOthers(Boolean(board.settings?.allowUserDeleteOthers));
    if (guestSession) {
      if (socket.connected) socket.emit("join-board", { boardId: board.id });
      return () => { if (socket.connected) socket.emit("leave-board"); };
    }
    api(`/api/boards/${board.id}`, {}, token).then(fresh => {
      if (!boardRef.current || boardRef.current.id !== fresh.id) return;
      setBoard(fresh); setStrokes(Array.isArray(fresh.strokes) ? fresh.strokes : []); setSelectedIds([]); committedIds.current = new Set((fresh.strokes || []).map(x => x?._id).filter(Boolean));
      setBg(fresh.background && typeof fresh.background === "object" ? fresh.background : DEFAULT_BG);
      setFiles(Array.isArray(fresh.files) ? fresh.files : []);
      setAllowUserDeleteOthers(Boolean(fresh.settings?.allowUserDeleteOthers));
      setViewSyncEnabled(Boolean(fresh.viewSync?.enabled));
      if (fresh.viewSync?.enabled && account?.role !== "admin") { setZoom(Number(fresh.viewSync.zoom) || 1); setPan(fresh.viewSync.pan && typeof fresh.viewSync.pan === "object" ? fresh.viewSync.pan : { x: 0, y: 0 }); }
      if (socket.connected) socket.emit("join-board", { boardId: fresh.id });
    }).catch(() => { if (socket.connected) socket.emit("join-board", { boardId: board.id }); });
    return () => { if (socket.connected) socket.emit("leave-board"); };
  }, [board?.id, token, account?.id, guestSession]);

  useEffect(() => { paintBase(); clearPreview(); }, [strokes, remoteStrokes, bg, zoom, pan]);
  useEffect(() => () => { if (paintFrame.current) cancelAnimationFrame(paintFrame.current); if (previewFrame.current) cancelAnimationFrame(previewFrame.current); if (hostViewFrame.current) cancelAnimationFrame(hostViewFrame.current); }, []);
  useEffect(() => { const fn = () => { paintBase(); clearPreview(); }; window.addEventListener("resize", fn); return () => window.removeEventListener("resize", fn); });
  useEffect(() => { if (base.current) paintBase(); }, [selectedIds, strokes.length, zoom, pan]);
  useEffect(() => {
    const stop = e => e.preventDefault();
    document.addEventListener("selectstart", stop, { passive: false }); document.addEventListener("dragstart", stop, { passive: false });
    document.addEventListener("gesturestart", stop, { passive: false }); document.addEventListener("gesturechange", stop, { passive: false }); document.addEventListener("gestureend", stop, { passive: false });
    return () => { document.removeEventListener("selectstart", stop); document.removeEventListener("dragstart", stop); document.removeEventListener("gesturestart", stop); document.removeEventListener("gesturechange", stop); document.removeEventListener("gestureend", stop); };
  }, []);

  function emitLiveStroke(force = false) {
    const currentBoard = boardRef.current, strokeId = liveStrokeId.current;
    if (!currentBoard?.id || !strokeId || !points.current.length || !socket.connected || readOnlyRef.current) return;
    const now = performance.now(); if (!force && now - liveStrokeLastSent.current < 25) return; liveStrokeLastSent.current = now;
    socket.emit("stroke-live", { boardId: currentBoard.id, stroke: { _id: strokeId, type: "stroke", points: points.current.slice(), color, width } });
  }
  function flushPendingCommits() { if (!socket.connected) return; const items = pendingCommits.current.splice(0); items.forEach(item => socket.emit("stroke-commit", { boardId: item.boardId, stroke: item.stroke })); }
  function stopLiveStroke() { liveStrokeId.current = null; liveStrokeLastSent.current = 0; if (liveStrokeFrame.current) cancelAnimationFrame(liveStrokeFrame.current); liveStrokeFrame.current = null; }
  function resizeCanvas(c) { const host = stack.current; if (!c || !host) return null; const r = host.getBoundingClientRect(); const d = window.devicePixelRatio || 1; const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return [d, r]; }
  function setup(c, d) { const x = c.getContext("2d"); x.setTransform(d, 0, 0, d, 0, 0); x.imageSmoothingEnabled = true; return x; }
  function paintBackground(x, r) {
    x.clearRect(0, 0, r.width, r.height); x.fillStyle = bg.color; x.fillRect(0, 0, r.width, r.height); x.save(); x.translate(pan.x, pan.y); x.scale(zoom, zoom);
    const s = bg.size || 24; x.strokeStyle = "#d5dbe5"; x.lineWidth = 1 / zoom;
    if (bg.pattern === "grid") { const left = -pan.x / zoom, right = r.width / zoom - pan.x / zoom, top = -pan.y / zoom, bottom = r.height / zoom - pan.y / zoom; const sx = Math.floor(left / s) * s, sy = Math.floor(top / s) * s; for (let i = sx; i <= right + s; i += s) { x.beginPath(); x.moveTo(i, top); x.lineTo(i, bottom); x.stroke(); } for (let y = sy; y <= bottom + s; y += s) { x.beginPath(); x.moveTo(left, y); x.lineTo(right, y); x.stroke(); } }
    else if (bg.pattern === "lines") { const top = -pan.y / zoom, bottom = r.height / zoom - pan.y / zoom; for (let y = Math.floor(top / s) * s; y <= bottom + s; y += s) { x.beginPath(); x.moveTo(-pan.x / zoom, y); x.lineTo(r.width / zoom - pan.x / zoom, y); x.stroke(); } }
    else if (bg.pattern === "dots") { const left = -pan.x / zoom, right = r.width / zoom - pan.x / zoom, top = -pan.y / zoom, bottom = r.height / zoom - pan.y / zoom; x.fillStyle = "#b9c2d0"; for (let y = Math.floor(top / s) * s + s / 2; y <= bottom + s; y += s) for (let xx = Math.floor(left / s) * s + s / 2; xx <= right + s; xx += s) { x.beginPath(); x.arc(xx, y, 1.5 / zoom, 0, Math.PI * 2); x.fill(); } }
    x.restore();
  }
  function normalizeRotation(value) {
    let r = Number(value) || 0;
    while (r > Math.PI) r -= Math.PI * 2;
    while (r < -Math.PI) r += Math.PI * 2;
    return r;
  }
  function render(x, s) {
    if (!s) return;
    x.save();
    x.strokeStyle = s.color;
    x.fillStyle = s.color;
    x.lineWidth = s.width || 1;
    x.lineCap = "round";
    x.lineJoin = "round";
    if (s.type === "stroke") {
      const pts = s.points || [];
      if (!pts.length) return x.restore();
      x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y));
      if (pts.length === 1) x.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
      x.stroke();
    } else if (s.type === "line") {
      x.beginPath(); x.moveTo(s.x1, s.y1); x.lineTo(s.x2, s.y2); x.stroke();
    } else if (["rect", "circle", "image", "text"].includes(s.type)) {
      const rotation = normalizeRotation(s.rotation);
      const box = objectBaseBox(s);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      x.translate(cx, cy);
      if (rotation) x.rotate(rotation);
      x.translate(-cx, -cy);
      if (s.type === "rect") x.strokeRect(s.x, s.y, s.w, s.h);
      else if (s.type === "circle") {
        x.beginPath();
        x.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
        x.stroke();
      } else if (s.type === "image") {
        const src = String(s.src || "");
        let img = imageCache.current.get(src);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => paintBase();
          img.src = src.startsWith("http") ? src : `${API}${src}`;
          imageCache.current.set(src, img);
        }
        if (img.complete && img.naturalWidth) {
          const w = Number(s.w) > 0 ? Number(s.w) : img.naturalWidth;
          const h = Number(s.h) > 0 ? Number(s.h) : img.naturalHeight;
          x.drawImage(img, Number(s.x) || 0, Number(s.y) || 0, w, h);
        }
      } else if (s.type === "text") {
        const layout = getCanvasTextLayout(x, s);
        x.font = `${layout.fontSize}px sans-serif`;
        layout.lines.forEach((line, index) => x.fillText(line, Number(s.x) || 0, (Number(s.y) || 0) + index * layout.lineHeight));
      }
    }
    x.restore();
  }
  function objectBaseBox(s) {
    if (!s) return { x: 0, y: 0, w: 0, h: 0 };
    if (["rect", "circle", "image"].includes(s.type)) return { x: Number(s.x) || 0, y: Number(s.y) || 0, w: Number(s.w) || 0, h: Number(s.h) || 0 };
    if (s.type === "text") {
      if (!measureCanvas.current) measureCanvas.current = document.createElement("canvas").getContext("2d");
      const layout = getCanvasTextLayout(measureCanvas.current, s);
      return { x: Number(s.x) || 0, y: (Number(s.y) || 0) - layout.fontSize, w: layout.width, h: layout.height };
    }
    if (s.type === "line") return { x: Math.min(Number(s.x1)||0, Number(s.x2)||0), y: Math.min(Number(s.y1)||0, Number(s.y2)||0), w: Math.abs((Number(s.x2)||0)-(Number(s.x1)||0)), h: Math.abs((Number(s.y2)||0)-(Number(s.y1)||0)) };
    return null;
  }
  function rotatePoint(p, center, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), dx = p.x - center.x, dy = p.y - center.y;
    return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
  }
  function shiftObject(s, dx, dy) {
    if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => ({ x: p.x + dx, y: p.y + dy })) };
    if (s.type === "line") return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    if (["rect", "circle", "image", "text"].includes(s.type)) return { ...s, x: (Number(s.x) || 0) + dx, y: (Number(s.y) || 0) + dy };
    return s;
  }
  function rotateObject(s, angle, center) {
    if (!angle) return s;
    if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => rotatePoint(p, center, angle)) };
    if (s.type === "line") {
      const a = rotatePoint({ x: s.x1, y: s.y1 }, center, angle), b = rotatePoint({ x: s.x2, y: s.y2 }, center, angle);
      return { ...s, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    if (["rect", "circle", "image"].includes(s.type)) {
      const box = objectBaseBox(s), c = rotatePoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, center, angle);
      return { ...s, x: c.x - box.w / 2, y: c.y - box.h / 2, rotation: normalizeRotation((Number(s.rotation) || 0) + angle) };
    }
    if (s.type === "text") {
      const box = objectBaseBox(s), c = rotatePoint({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, center, angle);
      return { ...s, x: c.x - box.w / 2, y: c.y + box.h / 2, rotation: normalizeRotation((Number(s.rotation) || 0) + angle) };
    }
    return s;
  }
  function scaleObject(s, sx, sy, anchor) {
    const ax = Number(anchor?.x) || 0, ay = Number(anchor?.y) || 0;
    if (s.type === "stroke") return { ...s, points: (s.points || []).map(p => ({ x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy })) };
    if (s.type === "line") return { ...s, x1: ax + (s.x1 - ax) * sx, y1: ay + (s.y1 - ay) * sy, x2: ax + (s.x2 - ax) * sx, y2: ay + (s.y2 - ay) * sy };
    if (["rect","circle","image"].includes(s.type)) {
      const x = ax + ((Number(s.x) || 0) - ax) * sx;
      const y = ay + ((Number(s.y) || 0) - ay) * sy;
      return { ...s, x, y, w: Math.max(4, (Number(s.w) || 4) * sx), h: Math.max(4, (Number(s.h) || 4) * sy) };
    }
    if (s.type === "text") {
      const x = ax + ((Number(s.x) || 0) - ax) * sx;
      const y = ay + ((Number(s.y) || 0) - ay) * sy;
      return { ...s, x, y, maxWidth: Math.max(40, (Number(s.maxWidth) || TEXT_DEFAULT_WIDTH) * sx), fontSize: Math.max(12, Math.min(160, (Number(s.fontSize) || 28) * Math.max(.1, (sx + sy) / 2))) };
    }
    return s;
  }
  function rotatedBounds(box, rotation = 0) {
    if (!box) return null;
    const angle = normalizeRotation(rotation);
    if (!angle) return box;
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x,y]) => rotatePoint({x,y}, center, angle));
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) };
  }
  function objectBounds(s) {
    if (!s) return null;
    if (s.type === "stroke") {
      const pts = Array.isArray(s.points) ? s.points : []; if (!pts.length) return null;
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity; pts.forEach(p=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});
      const pad = Math.max(4, Number(s.width)||1); return {x:minX-pad,y:minY-pad,w:maxX-minX+pad*2,h:maxY-minY+pad*2};
    }
    if (["rect","circle","image","text"].includes(s.type)) {
      const b = objectBaseBox(s);
      return rotatedBounds(b, s.rotation || 0);
    }
    if (s.type === "line") return objectBaseBox(s);
    return null;
  }
  function pointInPolygon(p, poly) { let inside=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y; const hit=((yi>p.y)!==(yj>p.y)) && (p.x < (xj-xi)*(p.y-yi)/(yj-yi || 1e-9)+xi); if(hit) inside=!inside; } return inside; }
  function segmentIntersects(a,b,c,d) {
    const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    const on=(p,q,r)=>Math.min(p.x,r.x)-1e-7<=q.x&&q.x<=Math.max(p.x,r.x)+1e-7&&Math.min(p.y,r.y)-1e-7<=q.y&&q.y<=Math.max(p.y,r.y)+1e-7;
    const c1=cross(a,b,c), c2=cross(a,b,d), c3=cross(c,d,a), c4=cross(c,d,b);
    if (((c1>0&&c2<0)||(c1<0&&c2>0)) && ((c3>0&&c4<0)||(c3<0&&c4>0))) return true;
    return Math.abs(c1)<1e-7 && on(a,c,b) || Math.abs(c2)<1e-7 && on(a,d,b) || Math.abs(c3)<1e-7 && on(c,a,d) || Math.abs(c4)<1e-7 && on(c,b,d);
  }
  function bboxInLasso(box, poly) {
    if (!box || poly.length < 3) return false;
    const corners=[{x:box.x,y:box.y},{x:box.x+box.w,y:box.y},{x:box.x+box.w,y:box.y+box.h},{x:box.x,y:box.y+box.h}];
    if (corners.some(p=>pointInPolygon(p,poly))) return true;
    if (poly.some(p=>p.x>=box.x && p.x<=box.x+box.w && p.y>=box.y && p.y<=box.y+box.h)) return true;
    const edges=[[corners[0],corners[1]],[corners[1],corners[2]],[corners[2],corners[3]],[corners[3],corners[0]]];
    for(let i=0;i<poly.length;i++){ const a=poly[i], b=poly[(i+1)%poly.length]; if(edges.some(([c,d])=>segmentIntersects(a,b,c,d))) return true; }
    return false;
  }
  function selectedBounds(items) { const boxes=items.map(objectBounds).filter(Boolean); if(!boxes.length) return null; const minX=Math.min(...boxes.map(b=>b.x)),minY=Math.min(...boxes.map(b=>b.y)),maxX=Math.max(...boxes.map(b=>b.x+b.w)),maxY=Math.max(...boxes.map(b=>b.y+b.h)); return {x:minX,y:minY,w:maxX-minX,h:maxY-minY}; }
  function applyRemoteTransforms(transforms) {
    if (!Array.isArray(transforms) || !transforms.length) return;
    const byId = new Map(transforms.map(t => [t.id, t]));
    setStrokes(v => v.map(s => {
      const t = byId.get(s._id);
      if (!t) return s;
      if (t.state && typeof t.state === "object") return { ...t.state, _id: s._id };
      let next = s;
      const dx = Number(t.dx) || 0, dy = Number(t.dy) || 0;
      if (dx || dy) next = shiftObject(next, dx, dy);
      if (Number(t.angle) && t.center) next = rotateObject(next, Number(t.angle), t.center);
      if (Number(t.sx) && Number(t.sy) && t.anchor) next = scaleObject(next, Number(t.sx), Number(t.sy), t.anchor);
      return next;
    }));
  }
  function emitTransforms(transforms, final=false) {
    const b = boardRef.current;
    if (!b?.id || !transforms?.length || !socket.connected || readOnlyRef.current) return;
    const now = performance.now();
    if (!final && now - moveLastSent.current < 40) return;
    moveLastSent.current = now;
    socket.emit("transform-objects", { boardId: b.id, transforms, preview: !final });
  }
  function drawSelectionOverlay(x) {
    const selected=strokes.filter(s=>selectedIdsRef.current.includes(s._id)); const box=selectedBounds(selected); if(!box) return;
    x.save(); x.translate(pan.x,pan.y); x.scale(zoom,zoom); x.strokeStyle="#6366f1"; x.lineWidth=1.5/zoom; x.setLineDash([7/zoom,5/zoom]); x.strokeRect(box.x,box.y,box.w,box.h); x.setLineDash([]);
    const handle=7/zoom; x.fillStyle="#fff"; x.strokeStyle="#6366f1";
    [[box.x,box.y],[box.x+box.w,box.y],[box.x,box.y+box.h],[box.x+box.w,box.y+box.h]].forEach(([hx,hy])=>{x.beginPath();x.rect(hx-handle/2,hy-handle/2,handle,handle);x.fill();x.stroke();});
    const rx=box.x+box.w/2, ry=box.y-26/zoom; x.beginPath(); x.moveTo(rx,box.y); x.lineTo(rx,ry); x.stroke(); x.beginPath(); x.arc(rx,ry,5/zoom,0,Math.PI*2); x.fill(); x.stroke(); x.restore();
  }
  function renderBoardFrame() {
    const c = base.current;
    const info = resizeCanvas(c);
    if (!info) return;
    const [d, r] = info;
    const x = setup(c, d);
    paintBackground(x, r);
    x.save();
    x.translate(pan.x, pan.y);
    x.scale(zoom, zoom);
    for (const item of strokes) render(x, item);
    for (const item of Object.values(remoteStrokes)) render(x, item);
    x.restore();
    drawSelectionOverlay(x);
  }
  function paintBase() {
    if (paintFrame.current) return;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      renderBoardFrame();
    });
  }
  function clearPreview() { const c = preview.current, info = resizeCanvas(c); if (!info) return; const [d] = info; const x = setup(c, d); x.clearRect(0, 0, c.width / d, c.height / d); }
  function point(e) { const r = stack.current.getBoundingClientRect(); return { x: (e.clientX - r.left - panRef.current.x) / zoomRef.current, y: (e.clientY - r.top - panRef.current.y) / zoomRef.current }; }
  function drawPreview() {
    const c = preview.current, info = resizeCanvas(c); if (!info) return; const [d] = info; const x = setup(c, d); x.clearRect(0, 0, c.width / d, c.height / d);
    if (selectedIdsRef.current.length && !active.current) drawSelectionOverlay(x);
    if (!active.current || !current.current) return;
    const a = current.current, p = points.current.at(-1) || a; x.save(); x.translate(panRef.current.x, panRef.current.y); x.scale(zoomRef.current, zoomRef.current); x.strokeStyle = tool === "eraser" ? bg.color : color; x.lineWidth = tool === "eraser" ? Math.max(width, 14) : width; x.lineCap = "round"; x.lineJoin = "round";
    if (tool === "pen" || tool === "eraser") { x.beginPath(); points.current.forEach((q, i) => i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y)); x.stroke(); }
    else if (tool === "line") { x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(p.x, p.y); x.stroke(); }
    else if (tool === "rect") x.strokeRect(a.x, a.y, p.x - a.x, p.y - a.y);
    else if (tool === "circle") { x.beginPath(); x.ellipse(a.x + (p.x - a.x) / 2, a.y + (p.y - a.y) / 2, Math.abs(p.x - a.x) / 2, Math.abs(p.y - a.y) / 2, 0, 0, Math.PI * 2); x.stroke(); }
    else if (tool === "lasso") { const pts=lassoPoints.current; x.strokeStyle="#6366f1"; x.lineWidth=2/zoomRef.current; x.setLineDash([8/zoomRef.current,5/zoomRef.current]); if (pts.length>1) { x.beginPath(); x.moveTo(pts[0].x,pts[0].y); for (let i=1;i<pts.length-1;i++){ const m={x:(pts[i].x+pts[i+1].x)/2,y:(pts[i].y+pts[i+1].y)/2}; x.quadraticCurveTo(pts[i].x,pts[i].y,m.x,m.y); } const last=pts[pts.length-1]; x.lineTo(last.x,last.y); x.stroke(); } x.setLineDash([]); }
    x.restore();
  }
  function schedulePreview() { if (previewFrame.current) return; previewFrame.current = requestAnimationFrame(() => { previewFrame.current = null; drawPreview(); }); }
  function resetPointerState() {
    const b = boardRef.current, liveId = liveStrokeId.current; if (active.current && b?.id && liveId && socket.connected) socket.emit("stroke-live-cancel", { boardId: b.id, _id: liveId });
    active.current = false; activePointer.current = null; current.current = null; points.current = []; lassoPoints.current = []; movingSelection.current = false; selectionTransform.current = null; moveLastSentPoint.current = null; activeTouches.current.clear(); gesture.current = null; if (previewFrame.current) cancelAnimationFrame(previewFrame.current); previewFrame.current = null; stopLiveStroke(); clearPreview();
  }
  function queueOrSendCommit(item) { pendingCommits.current.push(item); flushPendingCommits(); }
  function finishPointer(e) {
    if (!active.current || activePointer.current !== e.pointerId) return;
    const p = point(e), a = current.current, b = boardRef.current, last = points.current.at(-1);
    const finalPoints = last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01 ? [...points.current] : [...points.current, p];
    if (b?.id && a && !readOnlyRef.current) {
      if (tool === "pen") {
        const item = { type: "stroke", points: finalPoints, color, width, ownerId: identityIdRef.current || null, _id: liveStrokeId.current || uid() }; committedIds.current.add(item._id); setStrokes(v => v.some(s => s._id === item._id) ? v : [...v, item]); pushHistory(history.current, { kind: "add", strokes: [item] }); queueOrSendCommit({ boardId: b.id, stroke: item });
      } else if (tool === "eraser") commit({ type: "erase", points: finalPoints, radius: Math.max(12, width * 3) });
      else if (tool === "line") commit({ type: "line", x1: a.x, y1: a.y, x2: p.x, y2: p.y, color, width });
      else if (tool === "rect") commit({ type: "rect", x: a.x, y: a.y, w: p.x - a.x, h: p.y - a.y, color, width });
      else if (tool === "circle") commit({ type: "circle", x: a.x, y: a.y, w: p.x - a.x, h: p.y - a.y, color, width });
    }
    try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {}
    active.current = false; activePointer.current = null; current.current = null; points.current = []; stopLiveStroke(); clearPreview();
  }
  function cancelActivePointer(e) {
    if (!active.current) return; const b = boardRef.current, liveId = liveStrokeId.current; if (tool === "pen" && b?.id && liveId && socket.connected) socket.emit("stroke-live-cancel", { boardId: b.id, _id: liveId });
    try { e?.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {} active.current = false; activePointer.current = null; current.current = null; points.current = []; stopLiveStroke(); clearPreview();
  }
  function beginStroke(e) { try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {} active.current = true; activePointer.current = e.pointerId; current.current = point(e); points.current = [current.current]; liveStrokeId.current = uid(); drawPreview(); if (tool === "pen") emitLiveStroke(true); }
  function beginLasso(e) { try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {} active.current=true; activePointer.current=e.pointerId; current.current=point(e); lassoPoints.current=[current.current]; points.current=[current.current]; drawPreview(); }
  function selectionHandle(box, p) {
    if (!box) return null;
    const pad = 14 / zoomRef.current;
    const handles = [
      ["nw", box.x, box.y], ["ne", box.x + box.w, box.y],
      ["sw", box.x, box.y + box.h], ["se", box.x + box.w, box.y + box.h]
    ];
    const resize = handles.find(([,hx,hy]) => Math.hypot(p.x-hx,p.y-hy) <= pad);
    if (resize) return `resize-${resize[0]}`;
    const rotate = { x: box.x + box.w / 2, y: box.y - 26 / zoomRef.current };
    if (Math.hypot(p.x-rotate.x,p.y-rotate.y) <= pad) return "rotate";
    if (p.x >= box.x - pad && p.x <= box.x + box.w + pad && p.y >= box.y - pad && p.y <= box.y + box.h + pad) return "move";
    return null;
  }
  function beginSelectionTransform(e) {
    const p = point(e);
    const chosen = strokesRef.current.filter(s => selectedIdsRef.current.includes(s._id));
    const box = selectedBounds(chosen);
    if (!chosen.length || !box) return false;
    const mode = selectionHandle(box, p);
    if (!mode) return false;
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
    movingSelection.current = true;
    active.current = true;
    activePointer.current = e.pointerId;
    selectionTransform.current = { mode, startPoint: p, box, center: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, startAngle: Math.atan2(p.y-(box.y+box.h/2), p.x-(box.x+box.w/2)), originals: new Map(chosen.map(s => [s._id, structuredCloneSafe(s)])), lastScaleX: 1, lastScaleY: 1 };
    moveLastSentPoint.current = p;
    current.current = p;
    return true;
  }
  function updateTouch(e) { const prev = activeTouches.current.get(e.pointerId); if (!prev) return; activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (!pencilModeRef.current || activeTouches.current.size < 2 || (viewSyncEnabled && accountRef.current?.role !== "admin")) return; const touches = [...activeTouches.current.values()], a = touches[0], b = touches[1], d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)); const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rect = stack.current.getBoundingClientRect(); if (!gesture.current) { const startZoom = zoomRef.current, startPan = { ...panRef.current }; gesture.current = { distance: d, zoom: startZoom, world: { x: (m.x - rect.left - startPan.x) / startZoom, y: (m.y - rect.top - startPan.y) / startZoom } }; return; } const g = gesture.current, nextZoom = Math.max(0.25, Math.min(5, g.zoom * (d / g.distance))); setZoom(nextZoom); setPan({ x: m.x - rect.left - g.world.x * nextZoom, y: m.y - rect.top - g.world.y * nextZoom }); }
  function down(e) {
    if (e.pointerType === "touch") { e.preventDefault(); activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pencilModeRef.current && activeTouches.current.size >= 2) gesture.current = null; return; }
    e.preventDefault(); if (readOnlyRef.current || active.current) return; if (pencilModeRef.current && e.pointerType !== "pen") return;
    if (tool === "text") {
      setTextEditorPoint(point(e));
      setTextEditorValue("");
      setTextEditorSize(Math.max(14, Math.min(72, width * 7)));
      setTextEditorOpen(true);
      return;
    }
    if (tool === "lasso") {
      if (selectedIdsRef.current.length && beginSelectionTransform(e)) return;
      setSelectedIds([]);
      beginLasso(e);
      return;
    }
    if (tool === "select") {
      const p=point(e);
      const hit=strokesRef.current.find(s=>{const b=objectBounds(s); return b && p.x>=b.x && p.x<=b.x+b.w && p.y>=b.y && p.y<=b.y+b.h;});
      setSelectedIds(hit ? [hit._id] : []);
      if (hit) beginSelectionTransform(e);
      return;
    }
    beginStroke(e);
  }
  function move(e) {
    if (e.pointerType === "touch") { e.preventDefault(); updateTouch(e); return; }
    if (socket.connected && boardRef.current?.id) {
      const now = performance.now();
      if (now - cursorLastSent.current >= 40) {
        cursorLastSent.current = now;
        const p = point(e);
        socket.emit("cursor:move", { boardId: boardRef.current.id, x: p.x, y: p.y });
      }
    }
    if (!active.current || e.pointerId !== activePointer.current) return;
    e.preventDefault();
    const p=point(e);
    if (tool === "lasso" && !movingSelection.current) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) { const q=point(ev); const last=lassoPoints.current.at(-1); if (!last || Math.hypot(q.x-last.x,q.y-last.y) >= Math.max(1.2, 2/zoomRef.current)) lassoPoints.current.push(q); }
      current.current=lassoPoints.current.at(-1)||p; schedulePreview(); return;
    }
    if ((tool === "lasso" || tool === "select") && movingSelection.current && selectionTransform.current) {
      const t = selectionTransform.current;
      if (t.mode === "rotate") {
        const angle = Math.atan2(p.y - t.center.y, p.x - t.center.x) - t.startAngle;
        const previewStates = selectedIdsRef.current.map(id => ({ id, state: rotateObject(t.originals.get(id), angle, t.center) }));
        const previewMap = new Map(previewStates.map(item => [item.id, item.state]));
        setStrokes(v => v.map(s => previewMap.get(s._id) || s));
        current.current = p; schedulePreview();
        emitTransforms(previewStates, false);
      } else if (t.mode === "move") {
        const dx = p.x - t.startPoint.x, dy = p.y - t.startPoint.y;
        const previewStates = selectedIdsRef.current.map(id => ({ id, state: shiftObject(t.originals.get(id), dx, dy) }));
        const previewMap = new Map(previewStates.map(item => [item.id, item.state]));
        setStrokes(v => v.map(s => previewMap.get(s._id) || s));
        current.current = p; schedulePreview();
        emitTransforms(previewStates, false);
      } else if (t.mode.startsWith("resize-")) {
        const corner = t.mode.slice(7), box = t.box;
        const ax = corner.includes("e") ? box.x : box.x + box.w;
        const ay = corner.includes("s") ? box.y : box.y + box.h;
        const baseW = Math.max(20, box.w), baseH = Math.max(20, box.h);
        const newW = corner.includes("e") ? Math.max(20, p.x - ax) : Math.max(20, ax - p.x);
        const newH = corner.includes("s") ? Math.max(20, p.y - ay) : Math.max(20, ay - p.y);
        const sx = Math.min(8, Math.max(0.1, newW / baseW));
        const sy = Math.min(8, Math.max(0.1, newH / baseH));
        const anchor = { x: corner.includes("e") ? box.x : box.x + box.w, y: corner.includes("s") ? box.y : box.y + box.h };
        const previewStates = selectedIdsRef.current.map(id => ({ id, state: scaleObject(t.originals.get(id), sx, sy, anchor) }));
        const previewMap = new Map(previewStates.map(item => [item.id, item.state]));
        setStrokes(v => v.map(s => previewMap.get(s._id) || s));
        current.current = p; schedulePreview();
        emitTransforms(previewStates, false);
      }
      return;
    }
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; for (const ev of pts) { current.current = point(ev); points.current.push(current.current); } schedulePreview(); if (tool === "pen") { if (liveStrokeFrame.current) cancelAnimationFrame(liveStrokeFrame.current); liveStrokeFrame.current = requestAnimationFrame(() => { liveStrokeFrame.current = null; emitLiveStroke(); }); }
  }
  function up(e) { e.preventDefault(); if (e.pointerType === "touch") { activeTouches.current.delete(e.pointerId); if (activeTouches.current.size < 2) gesture.current = null; return; }
    if (tool === "lasso" && active.current && activePointer.current === e.pointerId && !movingSelection.current) {
      const endPoint = point(e); const lastPoint = lassoPoints.current.at(-1); if (!lastPoint || Math.hypot(endPoint.x-lastPoint.x,endPoint.y-lastPoint.y) >= 0.5/zoomRef.current) lassoPoints.current.push(endPoint);
      const poly = lassoPoints.current.slice();
      if (poly.length >= 3) {
        const first = poly[0];
        const last = poly[poly.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) > 0.001) poly.push({ ...first });
      }
      const ids = poly.length >= 4
        ? strokesRef.current.filter(s => bboxInLasso(objectBounds(s), poly)).map(s => s._id).filter(Boolean)
        : [];
      selectedIdsRef.current = ids;
      setSelectedIds(ids);
      try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {}
      active.current = false;
      activePointer.current = null;
      current.current = null;
      lassoPoints.current = [];
      points.current = [];
      clearPreview();
      paintBase();
      return;
    }
    if ((tool === "lasso" || tool === "select") && movingSelection.current && selectionTransform.current) {
      const t=selectionTransform.current; const p=point(e);
      let finalItems = [];
      if (t.mode === "rotate") {
        const angle = Math.atan2(p.y-t.center.y,p.x-t.center.x)-t.startAngle;
        finalItems = selectedIdsRef.current.map(id => ({ id, state: rotateObject(t.originals.get(id), angle, t.center) }));
      } else if (t.mode === "move") {
        const dx=p.x-t.startPoint.x, dy=p.y-t.startPoint.y;
        finalItems = selectedIdsRef.current.map(id => ({ id, state: shiftObject(t.originals.get(id), dx, dy) }));
      } else if (t.mode.startsWith("resize-")) {
        const corner=t.mode.slice(7), box=t.box;
        const ax = corner.includes("e") ? box.x : box.x + box.w;
        const ay = corner.includes("s") ? box.y : box.y + box.h;
        let newW = corner.includes("e") ? Math.max(20, p.x - ax) : Math.max(20, ax - p.x);
        let newH = corner.includes("s") ? Math.max(20, p.y - ay) : Math.max(20, ay - p.y);
        const sx=Math.min(8,Math.max(0.1,newW/Math.max(20,box.w))), sy=Math.min(8,Math.max(0.1,newH/Math.max(20,box.h)));
        const anchor={x:corner.includes("e")?box.x:box.x+box.w,y:corner.includes("s")?box.y:box.y+box.h};
        finalItems=selectedIdsRef.current.map(id=>({id,state:scaleObject(t.originals.get(id),sx,sy,anchor)}));
      }
      if (finalItems.length) {
        setStrokes(v => v.map(s => finalItems.find(f=>f.id===s._id)?.state || s));
        emitTransforms(finalItems, true);
      }
      movingSelection.current=false; selectionTransform.current=null; active.current=false; activePointer.current=null; current.current=null; moveLastSentPoint.current=null; try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch {} paintBase(); return;
    }
    finishPointer(e);
  }
  function cancel(e) { e.preventDefault(); if (e.pointerType === "touch") { activeTouches.current.delete(e.pointerId); if (activeTouches.current.size < 2) gesture.current = null; return; } cancelActivePointer(e); }
  useEffect(() => {
    const c = preview.current; if (!c) return; const opts = { passive: false }; c.addEventListener("pointerdown", down, opts); window.addEventListener("pointermove", move, opts); window.addEventListener("pointerup", up, opts); window.addEventListener("pointercancel", cancel, opts);
    const blur = () => { if (active.current) cancelActivePointer(); activeTouches.current.clear(); gesture.current = null; }; window.addEventListener("blur", blur);
    return () => { c.removeEventListener("pointerdown", down, opts); window.removeEventListener("pointermove", move, opts); window.removeEventListener("pointerup", up, opts); window.removeEventListener("pointercancel", cancel, opts); window.removeEventListener("blur", blur); };
  }, [board?.id, tool, color, width, bg, token, readOnly, pencilMode]);

  function submitText() {
    if (!textEditorPoint || readOnlyRef.current) return;
    const text = textEditorValue.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!text) { setTextEditorOpen(false); return; }
    commit({ type: "text", x: textEditorPoint.x, y: textEditorPoint.y, text: text.slice(0, TEXT_MAX_LENGTH), color, width: Math.max(2, width), fontSize: Math.max(12, Math.min(96, Number(textEditorSize) || 28)), maxWidth: TEXT_DEFAULT_WIDTH });
    setTextEditorOpen(false);
    setTextEditorValue("");
    setTextEditorPoint(null);
  }

  function commit(s, { historyAction = true } = {}) {
    const b = boardRef.current; if (!b?.id || readOnlyRef.current || !socket.connected) return;
    if (s.type === "erase") { const removed = strokesRef.current.filter(a => hitStroke(a, s.points, s.radius) && (accountRef.current?.role === "admin" || allowUserDeleteOthers || !a.ownerId || a.ownerId === identityIdRef.current)); if (!removed.length) return; const ids = removed.map(x => x._id); setStrokes(v => v.filter(x => !ids.includes(x._id))); if (historyAction) pushHistory(history.current, { kind: "erase", strokes: removed }); socket.emit("erase", { boardId: b.id, ids }); return; }
    const item = { ...s, ownerId: identityIdRef.current || null, _id: uid() }; committedIds.current.add(item._id); setStrokes(v => [...v, item]); if (historyAction) pushHistory(history.current, { kind: "add", strokes: [item] }); socket.emit("draw-batch", { boardId: b.id, strokes: [item] });
  }
  function hitStroke(a, pts, radius) { let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity; if (a.type === "stroke") for (const p of a.points || []) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); } else if (a.type === "line") { minX = Math.min(a.x1, a.x2); maxX = Math.max(a.x1, a.x2); minY = Math.min(a.y1, a.y2); maxY = Math.max(a.y1, a.y2); } else if (["rect", "circle"].includes(a.type)) { minX = Math.min(a.x, a.x + a.w); maxX = Math.max(a.x, a.x + a.w); minY = Math.min(a.y, a.y + a.h); maxY = Math.max(a.y, a.y + a.h); } else if (a.type === "text") { minX = a.x; maxX = a.x + Math.max(30, a.text.length * 10); minY = a.y - 25; maxY = a.y + 10; } return (pts || []).some(p => maxX >= p.x - radius && minX <= p.x + radius && maxY >= p.y - radius && minY <= p.y + radius); }

  async function joinAsGuest(e) {
    e?.preventDefault();
    setGuestBusy(true); setGuestError("");
    try {
      const name = (guestJoinName || "").trim().slice(0, 32);
      const body = guestInviteToken ? { token: guestInviteToken, displayName: name } : { code: guestCode.trim(), displayName: name };
      const data = await api("/api/guest/resolve", { method: "POST", body: JSON.stringify(body) });
      const session = { token: data.sessionToken, guest: data.guest, board: data.board };
      saveGuestSession(session); sessionStorage.setItem("whiteboard-guest-name", data.guest.displayName);
      setGuestSession(session); setBoard(data.board); setGuestCode("");
      if (guestInviteToken) window.history.replaceState({}, "", window.location.pathname);
    } catch (e2) { setGuestError(e2.message); } finally { setGuestBusy(false); }
  }
  function leaveGuest() { saveGuestSession(null); sessionStorage.removeItem("whiteboard-guest-name"); socket.disconnect(); window.location.href = window.location.pathname; }

  async function submitLogin(e) {
    e.preventDefault(); setAuthError(""); setAuthBusy(true);
    try { const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: authUsername, password: authPassword }) }); saveToken(data.token); setToken(data.token); setAccount(data.account); setAuthPassword(""); }
    catch (e2) { setAuthError(e2.message); } finally { setAuthBusy(false); }
  }
  async function submitPasswordChange(e) {
    e.preventDefault(); setChangeError(""); setChangeBusy(true);
    try {
      if (changeNew !== changeNew2) throw new Error("Die neuen Passwörter stimmen nicht überein.");
      const data = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: changeCurrent, newPassword: changeNew, forced: Boolean(account?.mustChangePassword) }) }, token);
      saveToken(data.token); setToken(data.token); setAccount(data.account); setChangeCurrent(""); setChangeNew(""); setChangeNew2("");
    } catch (e2) { setChangeError(e2.message); } finally { setChangeBusy(false); }
  }
  async function logout() { const oldToken = token; saveToken(""); socket.disconnect(); setToken(""); setAccount(null); setBoard(null); setCards([]); setFiles([]); setCursors({}); setAccountOpen(false); setAdminOpen(false); setProfileOpen(false); try { await api("/api/auth/logout", { method: "POST" }, oldToken); } catch {} }
  async function createBoard() {
    if (!newBoardName.trim()) return;
    setLoading(true);
    try {
      const b = await api("/api/boards", { method: "POST", body: JSON.stringify({ name: newBoardName.trim(), folderId: activeFolderId }) }, token);
      setCards(v => [b, ...v]); setNewOpen(false); setNewBoardName(""); setBg(b.background || DEFAULT_BG); setBoard(b);
    } catch (e) { alert(e.message); } finally { setLoading(false); }
  }
  async function createFolder(e) {
    e?.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    setFolderBusy(true);
    try {
      const data = await api("/api/folders", { method: "POST", body: JSON.stringify({ name }) }, token);
      setFolders(v => [...v, data.folder]); setFolderName(""); setFolderOpen(false); setActiveFolderId(data.folder.id);
    } catch (e2) { alert(e2.message); } finally { setFolderBusy(false); }
  }
  async function renameFolder(folder) {
    const name = prompt("Neuer Ordnername", folder.name);
    if (!name?.trim()) return;
    try {
      const data = await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }, token);
      setFolders(v => v.map(f => f.id === folder.id ? data.folder : f));
    } catch (e) { alert(e.message); }
  }
  async function deleteFolder(folder) {
    if (!confirm(`Ordner „${folder.name}“ löschen? Die Boards bleiben erhalten und werden in „Alle“ verschoben.`)) return;
    try {
      await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }, token);
      setFolders(v => v.filter(f => f.id !== folder.id));
      setCards(v => v.map(c => c.folderId === folder.id ? { ...c, folderId: null } : c));
      if (activeFolderId === folder.id) setActiveFolderId(null);
    } catch (e) { alert(e.message); }
  }
  async function moveBoardToFolder(boardId, folderId) {
    if (!boardId) return;
    try {
      const data = await api(`/api/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", body: JSON.stringify({ folderId: folderId || null }) }, token);
      setCards(v => v.map(c => c.id === boardId ? { ...c, folderId: data.folderId || null, updatedAt: data.updatedAt } : c));
    } catch (e) { alert(e.message); }
    finally { setDragBoardId(null); }
  }
  function openBoard(b) { setBg(b.background || DEFAULT_BG); setBoard(b); setAccountOpen(false); }
  function chooseBg(item) { if (readOnly) return; const next = { color: item[1], pattern: item[2], size: item[3] }; setBg(next); if (socket.connected) socket.emit("set-background", { boardId: board.id, background: next }); }
  function updateBgSize(value) { if (readOnly || !board?.id) return; const next = { ...bg, size: +value }; setBg(next); if (socket.connected) socket.emit("set-background", { boardId: board.id, background: next }); }
  function clearBoard() { if (account?.role !== "admin" || readOnly || !confirm("Whiteboard leeren?")) return; const snapshot = strokesRef.current.slice(); pushHistory(history.current, { kind: "clear", strokes: snapshot }); socket.emit("clear-board", board.id); }
  function changeZoom(delta) { if (viewSyncEnabled && account?.role !== "admin") return; setZoom(Math.max(0.5, Math.min(3, Math.round((zoomRef.current + delta) * 10) / 10))); }
  function resetView() { if (viewSyncEnabled && account?.role !== "admin") return; setZoom(1); setPan({ x: 0, y: 0 }); }
  function chooseTool(next) { if (readOnly) return; resetPointerState(); setTool(next); }
  function setUserReadOnly(id, value) { if (account?.role === "admin" && id !== account.id) socket.emit("set-readonly", { userId: id, readOnly: value }); }
  function setAllReadOnly(value) { if (account?.role === "admin") socket.emit("set-all-readonly", { readOnly: value }); }
  function setDeleteOthers(value) { if (account?.role === "admin") { setAllowUserDeleteOthers(value); socket.emit("set-delete-others", { enabled: value }); } }
  function toggleViewSync() { if (account?.role !== "admin" || !boardRef.current?.id) return; const next = !viewSyncEnabled; setViewSyncEnabled(next); if (next) { const shared = sharedViewPayload(); socket.emit("view-sync-toggle", { boardId: boardRef.current.id, enabled: true, ...shared }); } else { socket.emit("view-sync-toggle", { boardId: boardRef.current.id, enabled: false, zoom: zoomRef.current, pan: panRef.current }); } }
  function kickUser(id) { if (account?.role === "admin" && id !== account.id && confirm("Diesen Teilnehmer wirklich entfernen?")) socket.emit("kick-user", { userId: id }); }

  function undo() {
    if (!board?.id || readOnly) return;
    const action = undoHistory(history.current);
    if (!action) return;
    if (action.kind === "add") socket.emit("erase", { boardId: board.id, ids: action.strokes.map(s => s._id) });
    else if (action.kind === "erase") { committedIds.current = new Set([...committedIds.current, ...action.strokes.map(s => s._id)]); socket.emit("draw-batch", { boardId: board.id, strokes: action.strokes }); }
    else if (action.kind === "clear" && account?.role === "admin") socket.emit("draw-batch", { boardId: board.id, strokes: action.strokes });
    setStrokes(current => {
      if (action.kind === "add") { const ids = new Set(action.strokes.map(s => s._id)); return current.filter(s => !ids.has(s._id)); }
      if (action.kind === "erase" || action.kind === "clear") { const seen = new Set(current.map(s => s._id)); return [...current, ...action.strokes.filter(s => !seen.has(s._id))]; }
      return current;
    });
  }
  function redo() {
    if (!board?.id || readOnly) return;
    const action = redoHistory(history.current);
    if (!action) return;
    if (action.kind === "add" || action.kind === "erase") {
      if (action.kind === "add") socket.emit("draw-batch", { boardId: board.id, strokes: action.strokes });
      else socket.emit("erase", { boardId: board.id, ids: action.strokes.map(s => s._id) });
    } else if (action.kind === "clear" && account?.role === "admin") socket.emit("clear-board", board.id);
    setStrokes(current => {
      if (action.kind === "add" || action.kind === "clear") { const seen = new Set(action.strokes.map(s => s._id)); return [...current, ...action.strokes.filter(s => !current.some(s2 => s2._id === s._id))]; }
      const ids = new Set(action.strokes.map(s => s._id)); return current.filter(s => !ids.has(s._id));
    });
  }
  useEffect(() => {
    const onKey = (e) => {
      if (!boardRef.current || readOnlyRef.current || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board?.id, readOnly, account?.role]);

  async function saveProfile() {
    setProfileBusy(true); setProfileError("");
    try {
      if (profileNewPassword && profileNewPassword !== profileNewPassword2) throw new Error("Die neuen Passwörter stimmen nicht überein.");
      const profile = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: profileName.trim().slice(0, DISPLAY_NAME_MAX) }) }, token);
      let nextAccount = profile.account;
      if (profileFile) {
        const uploaded = await upload("/api/profile/avatar", profileFile, token);
        nextAccount = uploaded.account;
        setProfileFile(null);
      }
      if (profileNewPassword) {
        const changed = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: profileCurrentPassword, newPassword: profileNewPassword }) }, token);
        saveToken(changed.token); setToken(changed.token); nextAccount = changed.account;
        setProfileCurrentPassword(""); setProfileNewPassword(""); setProfileNewPassword2("");
      }
      setAccount(nextAccount); setProfileOpen(false);
    } catch (e) { setProfileError(e.message); } finally { setProfileBusy(false); }
  }
  function getExportBounds(area = "viewport") {
    const host = stack.current?.getBoundingClientRect();
    if (area === "viewport" || !strokesRef.current.length) {
      return { x: 0, y: 0, w: Math.max(900, Math.round((host?.width || 1200) / Math.max(zoomRef.current, 0.1))), h: Math.max(600, Math.round((host?.height || 800) / Math.max(zoomRef.current, 0.1))) };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokesRef.current) {
      if (s.type === "stroke") for (const p of s.points || []) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
      else if (s.type === "line") { minX=Math.min(minX,s.x1,s.x2); minY=Math.min(minY,s.y1,s.y2); maxX=Math.max(maxX,s.x1,s.x2); maxY=Math.max(maxY,s.y1,s.y2); }
      else if (["rect","circle","image"].includes(s.type)) { minX=Math.min(minX,s.x); minY=Math.min(minY,s.y); maxX=Math.max(maxX,s.x+(s.w||0)); maxY=Math.max(maxY,s.y+(s.h||0)); }
      else if (s.type === "text") { const measure=document.createElement("canvas").getContext("2d"); const layout=getCanvasTextLayout(measure,s); minX=Math.min(minX,s.x); minY=Math.min(minY,s.y-layout.fontSize); maxX=Math.max(maxX,s.x+layout.width); maxY=Math.max(maxY,s.y+layout.height); }
    }
    if (!Number.isFinite(minX)) return getExportBounds("viewport");
    const pad = 48;
    return { x:minX-pad, y:minY-pad, w:Math.max(200,maxX-minX+pad*2), h:Math.max(150,maxY-minY+pad*2) };
  }
  async function preloadExportImages() {
    const images = strokesRef.current.filter(s => s.type === "image" && s.src);
    await Promise.all(images.map(s => new Promise(resolve => {
      const src = s.src.startsWith("http") ? s.src : `${API}${s.src}`;
      let img = imageCache.current.get(src);
      if (img?.complete && img.naturalWidth) return resolve();
      img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => { imageCache.current.set(src, img); resolve(); }; img.onerror = resolve; img.src = src; imageCache.current.set(src, img);
    })));
  }
  function renderExportCanvas(bounds, scale) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bounds.w * scale)); canvas.height = Math.max(1, Math.round(bounds.h * scale));
    const ctx = canvas.getContext("2d");
    ctx.save(); ctx.scale(scale, scale); ctx.fillStyle = bg.color || "#fff"; ctx.fillRect(0,0,bounds.w,bounds.h);
    const size = bg.size || 24; const color = theme === "dark" ? "rgba(140,150,165,.18)" : "rgba(100,110,125,.14)";
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    if (bg.pattern === "grid") { for (let x=Math.floor(bounds.x/size)*size; x<bounds.x+bounds.w+size; x+=size) { ctx.beginPath(); ctx.moveTo(x-bounds.x,0); ctx.lineTo(x-bounds.x,bounds.h); ctx.stroke(); } for (let y=Math.floor(bounds.y/size)*size; y<bounds.y+bounds.h+size; y+=size) { ctx.beginPath(); ctx.moveTo(0,y-bounds.y); ctx.lineTo(bounds.w,y-bounds.y); ctx.stroke(); } }
    else if (bg.pattern === "lines") { for (let y=Math.floor(bounds.y/size)*size; y<bounds.y+bounds.h+size; y+=size) { ctx.beginPath(); ctx.moveTo(0,y-bounds.y); ctx.lineTo(bounds.w,y-bounds.y); ctx.stroke(); } }
    else if (bg.pattern === "dots") { for (let y=Math.floor(bounds.y/size)*size; y<bounds.y+bounds.h+size; y+=size) for (let x=Math.floor(bounds.x/size)*size; x<bounds.x+bounds.w+size; x+=size) { ctx.beginPath(); ctx.arc(x-bounds.x+size/2,y-bounds.y+size/2,1.2,0,Math.PI*2); ctx.fill(); } }
    ctx.translate(-bounds.x,-bounds.y);
    strokesRef.current.forEach(item => render(ctx,item));
    ctx.restore();
    return canvas;
  }
  function exportBoard(format = "png") {
    if (!board?.id) return;
    if (format === "json") {
      const payload = { version: 2, boardId: board.id, name: board.name, folderId: board.folderId || null, background: bg, strokes: strokesRef.current };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`${board.name||"whiteboard"}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500); return;
    }
    if (format === "png") {
      const canvas=renderExportCanvas(getExportBounds("viewport"), Math.max(1, Math.min(3, window.devicePixelRatio || 2))); const a=document.createElement("a"); a.href=canvas.toDataURL("image/png"); a.download=`${board.name||"whiteboard"}.png`; a.click();
    }
  }
  function openPdfExport() {
    if (!board?.id) return;
    setPdfConfig({ area:"viewport", quality:2, paper:"a4", orientation:"landscape", mode:"raster" });
    setPdfPreviewUrl(""); setPdfProgress(0); setPdfOpen(true);
    requestAnimationFrame(async () => { try { await updatePdfPreview({ area:"viewport", quality:2 }); } catch {} });
  }
  async function updatePdfPreview(config) {
    await preloadExportImages();
    const canvas = renderExportCanvas(getExportBounds(config.area), Number(config.quality || 2));
    setPdfPreviewUrl(canvas.toDataURL("image/jpeg", .82));
  }
  async function exportPdf() {
    if (!board?.id) return;
    setPdfBusy(true); setPdfProgress(8);
    try {
      await preloadExportImages(); setPdfProgress(25);
      const bounds = getExportBounds(pdfConfig.area); const scale = Math.max(1, Math.min(4, Number(pdfConfig.quality)||2)); const canvas = renderExportCanvas(bounds, scale); setPdfProgress(50);
      const format = pdfConfig.paper === "letter" ? "letter" : "a4";
      const doc = new jsPDF({ orientation: pdfConfig.orientation === "portrait" ? "portrait" : "landscape", unit:"mm", format, compress:true });
      const pageW = doc.internal.pageSize.getWidth() - 16; const pageH = doc.internal.pageSize.getHeight() - 16;
      const ratio = canvas.width / canvas.height; let w=pageW, h=w/ratio; if (h>pageH) { h=pageH; w=h*ratio; }
      const x=(doc.internal.pageSize.getWidth()-w)/2, y=(doc.internal.pageSize.getHeight()-h)/2;
      if (pdfConfig.mode === "vector") {
        const fitX = w/bounds.w, fitY=h/bounds.h; const fit=Math.min(fitX,fitY);
        for (const item of strokesRef.current) {
          const ox=(n)=>x+(n-bounds.x)*fit, oy=(n)=>y+(n-bounds.y)*fit;
          const hex=(item.color||"#111827").replace("#",""); const rgb=hex.length===6?[parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16)]:[17,24,39]; doc.setDrawColor(...rgb); doc.setTextColor(...rgb); doc.setLineWidth(Math.max(.2,(Number(item.width)||1)*fit*.35));
          if (item.type === "stroke") { const pts=item.points||[]; for(let i=1;i<pts.length;i++) doc.line(ox(pts[i-1].x),oy(pts[i-1].y),ox(pts[i].x),oy(pts[i].y)); }
          else if (item.type === "line") doc.line(ox(item.x1),oy(item.y1),ox(item.x2),oy(item.y2));
          else if (item.type === "rect") doc.rect(ox(item.x),oy(item.y),item.w*fit,item.h*fit);
          else if (item.type === "circle") doc.ellipse(ox(item.x+item.w/2),oy(item.y+item.h/2),Math.abs(item.w/2)*fit,Math.abs(item.h/2)*fit);
          else if (item.type === "text") { const fs=Math.max(8,Number(item.fontSize||28)*fit*0.7); doc.setFontSize(fs); const maxLineWidth=Math.max(30,Number(item.maxWidth||item.textWidth||TEXT_DEFAULT_WIDTH))*fit; const lines=doc.splitTextToSize(String(item.text||""),maxLineWidth); const lineGap=Math.max(4,(Number(item.fontSize||28)*1.25)*fit); lines.forEach((line,i)=>doc.text(line,ox(item.x),oy(item.y)+i*lineGap)); }
          else if (item.type === "image") { const src=item.src?.startsWith("http")?item.src:`${API}${item.src||""}`; const img=imageCache.current.get(src); if (img?.naturalWidth) { try { const dataCanvas=document.createElement("canvas"); dataCanvas.width=img.naturalWidth; dataCanvas.height=img.naturalHeight; dataCanvas.getContext("2d").drawImage(img,0,0); const data=dataCanvas.toDataURL("image/jpeg",.92); doc.addImage(data,"JPEG",ox(item.x),oy(item.y),item.w*fit,item.h*fit); } catch {} } }
        }
      } else { doc.addImage(canvas.toDataURL("image/jpeg",.94), "JPEG", x,y,w,h, undefined, "FAST"); }
      setPdfProgress(92); doc.save(`${board.name||"whiteboard"}.pdf`); setPdfProgress(100);
      setTimeout(()=>setPdfOpen(false),350);
    } catch (e) { alert(e.message || "PDF konnte nicht erstellt werden."); } finally { setPdfBusy(false); }
  }
  async function handleBoardFile(file) {
    if (!board?.id || !file || readOnly) return;
    setLoading(true);
    try {
      const data = await upload(`/api/boards/${encodeURIComponent(board.id)}/files`, file, token, "file", guestSession?.token || "");
      setFiles(v => v.some(f => f.id === data.file.id) ? v : [...v, data.file]);
      if (file.type.startsWith("image/")) {
        const src = data.file?.url || `/uploads/${data.file.path}`;
        const localUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(localUrl);
          const max = 720;
          const scale = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
          const rect = stack.current?.getBoundingClientRect();
          const vw = rect?.width || stack.current?.clientWidth || window.innerWidth || 1200;
          const vh = rect?.height || stack.current?.clientHeight || window.innerHeight || 800;
          const currentZoom = Math.max(0.01, zoomRef.current || 1);
          const currentPan = panRef.current || { x: 0, y: 0 };
          const viewCenter = { x: (vw / 2 - currentPan.x) / currentZoom, y: (vh / 2 - currentPan.y) / currentZoom };
          const iw = Math.max(1, Math.round((image.naturalWidth || 400) * scale)); const ih = Math.max(1, Math.round((image.naturalHeight || 300) * scale));
          const item = { _id: uid(), type: "image", src, x: viewCenter.x - iw / 2, y: viewCenter.y - ih / 2, w: iw, h: ih, rotation: 0, ownerId: accountRef.current?.id || identityIdRef.current || null };
          imageCache.current.delete(src);
          committedIds.current.add(item._id);
          setStrokes(v => [...v, item]); setSelectedIds([item._id]); selectedIdsRef.current = [item._id]; setTool("select");
          pushHistory(history.current, { kind: "add", strokes: [item] });
          socket.emit("draw-batch", { boardId: board.id, strokes: [item] });
        };
        image.onerror = () => { URL.revokeObjectURL(localUrl); alert("Das Bild konnte nicht geladen werden."); };
        image.src = localUrl;
      }
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  }
  async function renameBoard() {
    const targetId = renameTarget?.id || board?.id;
    if (!targetId || !renameValue.trim()) return;
    setLoading(true);
    try { const data = await api(`/api/boards/${encodeURIComponent(targetId)}`, { method: "PATCH", body: JSON.stringify({ name: renameValue.trim() }) }, token); setBoard(v => v?.id === targetId ? { ...v, name: data.name } : v); setCards(v => v.map(c => c.id === targetId ? { ...c, name: data.name, updatedAt: data.updatedAt } : c)); setRenameOpen(false); setRenameTarget(null); }
    catch (e) { alert(e.message); }
    finally { setLoading(false); }
  }
  async function deleteBoard(item = board) {
    if (!item?.id || !confirm(`Whiteboard „${item.name}“ wirklich löschen?`)) return;
    setLoading(true);
    try { await api(`/api/boards/${encodeURIComponent(item.id)}`, { method: "DELETE" }, token); if (board?.id === item.id) { socket.emit("leave-board"); setBoard(null); } setCards(v => v.filter(c => c.id !== item.id)); }
    catch (e) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function createGuestInvite() {
    if (!board?.id || account?.role !== "admin") return;
    setGuestShareBusy(true); setGuestShareError("");
    try {
      const data = await api(`/api/boards/${encodeURIComponent(board.id)}/guest-invites`, { method: "POST", body: JSON.stringify({ mode: "guest-edit", expiresInMs: 24 * 60 * 60 * 1000 }) }, token);
      setGuestInvites(v => [{ ...data.invite, code: data.code }, ...v]);
      try { await navigator.clipboard?.writeText(data.code); } catch {}
    } catch (e) { setGuestShareError(e.message); } finally { setGuestShareBusy(false); }
  }
  async function loadGuestInvites() {
    if (!board?.id || account?.role !== "admin") return;
    try {
      const data = await api(`/api/boards/${encodeURIComponent(board.id)}/guest-invites`, {}, token);
      setGuestInvites(data.invites || []);
    } catch (e) { setGuestShareError(e.message); }
  }
  async function revokeGuestInvite(id) {
    if (!board?.id || account?.role !== "admin") return;
    try { await api(`/api/boards/${encodeURIComponent(board.id)}/guest-invites/${encodeURIComponent(id)}`, { method: "DELETE" }, token); setGuestInvites(v => v.filter(i => i.id !== id)); } catch (e) { setGuestShareError(e.message); }
  }
  async function openGuestShare() { setGuestShareOpen(true); setGuestShareError(""); await loadGuestInvites(); }

  async function loadAdminUsers() { if (account?.role !== "admin") return; setAdminError(""); try { const data = await api("/api/admin/users", {}, token); setAdminUsers(data.users || []); } catch (e) { setAdminError(e.message); } }
  async function openAdmin() { setAdminOpen(true); setAccountOpen(false); await loadAdminUsers(); }
  async function openBoardAccess(item) {
    if (account?.role !== "admin" || !item?.id) return;
    setAccessTarget(item); setAccessOpen(true); setAccessError(""); setAccessBusy(true);
    try {
      const [accessData] = await Promise.all([api(`/api/boards/${encodeURIComponent(item.id)}/access`, {}, token), loadAdminUsers()]);
      const access = accessData.access || { mode: "all", userIds: [] };
      setAccessMode(access.mode === "selected" ? "selected" : "all");
      setAccessUserIds(Array.isArray(access.userIds) ? access.userIds : []);
    } catch (e) { setAccessError(e.message); } finally { setAccessBusy(false); }
  }
  async function saveBoardAccess() {
    if (!accessTarget?.id || account?.role !== "admin") return;
    setAccessBusy(true); setAccessError("");
    try {
      await api(`/api/boards/${encodeURIComponent(accessTarget.id)}/access`, { method: "PATCH", body: JSON.stringify({ mode: accessMode, userIds: accessUserIds }) }, token);
      setCards(v => v.map(c => c.id === accessTarget.id ? { ...c, accessMode } : c));
      setAccessOpen(false); setAccessTarget(null);
    } catch (e) { setAccessError(e.message); } finally { setAccessBusy(false); }
  }
  async function createAdminUser(e) {
    e?.preventDefault(); if (!newUsername.trim()) return; setAdminBusy(true); setAdminError(""); setTempPasswordReveal(null);
    try { const data = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: newUsername.trim() }) }, token); setNewUsername(""); setTempPasswordReveal({ username: data.account.username, password: data.temporaryPassword }); await loadAdminUsers(); }
    catch (e2) { setAdminError(e2.message); } finally { setAdminBusy(false); }
  }
  async function resetUserPassword(user) {
    if (!confirm(`Passwort für ${user.username} wirklich zurücksetzen?`)) return; setAdminBusy(true); setAdminError(""); setTempPasswordReveal(null);
    try { const data = await api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST" }, token); setTempPasswordReveal({ username: data.account.username, password: data.temporaryPassword }); await loadAdminUsers(); }
    catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); }
  }
  async function unlockUser(user) {
    setAdminBusy(true); setAdminError(""); try { await api(`/api/admin/users/${encodeURIComponent(user.id)}/unlock`, { method: "POST" }, token); await loadAdminUsers(); } catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); }
  }
  async function lockUser(user) {
    if (!confirm(`Konto ${user.username} wirklich sperren? Der Benutzer wird sofort abgemeldet.`)) return;
    setAdminBusy(true); setAdminError(""); try { await api(`/api/admin/users/${encodeURIComponent(user.id)}/lock`, { method: "POST" }, token); await loadAdminUsers(); } catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); }
  }

  const isGuest = Boolean(guestSession);
  const guestReadOnly = isGuest && guestSession.guest?.mode === "view-only";
  const isAdmin = Boolean(account?.role === "admin");
  const canControlTimer = isAdmin && !guestSession;
  const timerApi = useBoardTimer(socket, board?.id, canControlTimer);

  if (!authReady) return <AuthShell loading><section className="authCard authCardGlass"><div className="authBrand"><div className="brandMark">WB</div><span>Collaborative Whiteboard</span></div><div className="authHeading"><h1>Whiteboard</h1><p>Verbindung wird hergestellt…</p></div><Spinner label="Laden…" /></section></AuthShell>;
  if (guestInviteToken && !guestSession) return <GuestJoinScreen name={guestJoinName} setName={setGuestJoinName} error={guestError} busy={guestBusy} onJoin={joinAsGuest} />;
  if (!account && !guestSession) return <AuthShell loading={authBusy || guestBusy}>
    <section className="authCard authCardGlass">
      <div className="authBrand"><div className="brandMark">WB</div><span>Collaborative Whiteboard</span></div>
      <div className="authHeading"><h1>Willkommen zurück!</h1><p>Melde dich an oder betrete ein freigegebenes Board als Gast.</p></div>
      <div className="authTabs" role="tablist" aria-label="Anmeldung">
        <button type="button" role="tab" aria-selected={authMode === "login"} className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setGuestError(""); }}>Anmelden</button>
        <button type="button" role="tab" aria-selected={authMode === "guest"} className={authMode === "guest" ? "active" : ""} onClick={() => { setAuthMode("guest"); setAuthError(""); }}>Gastzugang</button>
      </div>
      <div className="authTabViewport">
        <div className={`authTabContent ${authMode === "guest" ? "showGuest" : "showLogin"}`}>
          {authMode === "login" ? <form className="authFormPro" onSubmit={submitLogin}>
            <label className="floatingField"><input autoFocus autoComplete="username" value={authUsername} onChange={e => { setAuthUsername(e.target.value); setAuthError(""); }} placeholder=" " required minLength={3} maxLength={64} /><span className="floatingLabel">E-Mail oder Benutzername</span></label>
            <label className="floatingField"><input autoComplete="current-password" type="password" minLength={4} value={authPassword} onChange={e => { setAuthPassword(e.target.value); setAuthError(""); }} placeholder=" " required /><span className="floatingLabel">Passwort</span></label>
            <div className="authMetaRow"><button type="button" className="linkButton proLink" onClick={() => setAuthError("Bitte den Administrator um einen Passwort-Reset bitten.")}>Passwort vergessen?</button></div>
            {authError && <div className="errorBox authErrorPro">{authError}</div>}
            <button className="primary full proPrimary" disabled={authBusy}>{authBusy ? <Spinner label="Synchronisiere…" /> : "Anmelden →"}</button>
          </form> : <form className="authFormPro guestFormPro" onSubmit={joinAsGuest}>
            <div className={`otpWrap ${guestError ? "shake" : ""} ${guestCode.length === 6 && !guestError ? "valid" : ""}`}>
              <div className="otpLabel"><span>Board Code</span>{guestCode.length === 6 && !guestError && <span className="otpValid">✓ Gültig</span>}</div>
              <OtpInput value={guestCode} onChange={v => { setGuestCode(v); setGuestError(""); }} disabled={guestBusy} />
            </div>
            <label className="floatingField guestNameField"><input autoComplete="name" maxLength={32} value={guestJoinName} onChange={e => { setGuestJoinName(e.target.value); setGuestError(""); }} placeholder=" " required /><span className="floatingLabel">Dein Name</span></label>
            {guestError && <div className="errorBox authErrorPro">{guestError}</div>}
            <button className={`primary full proPrimary ${guestCode.length === 6 && guestJoinName.trim().length >= 2 ? "readyPulse" : ""}`} disabled={guestBusy || guestCode.length !== 6 || guestJoinName.trim().length < 2}>{guestBusy ? <Spinner label="Board öffnen…" /> : "Beitreten →"}</button>
          </form>}
        </div>
      </div>
      <div className="authFooterHint">Sicher verbunden · Board-Zugriff wird serverseitig geprüft</div>
    </section>
  </AuthShell>;
  if (account?.mustChangePassword) return <AuthShell loading={changeBusy}><form className="authCard authCardGlass" onSubmit={submitPasswordChange}><div className="authBrand"><div className="brandMark">!</div><span>Account-Sicherheit</span></div><div className="authHeading"><h1>Passwort ändern</h1><p>Dein temporäres Passwort wird nur einmal verwendet. Lege jetzt dein persönliches Passwort fest.</p></div><div className="authFormPro"><input autoFocus type="password" autoComplete="current-password" value={changeCurrent} onChange={e => setChangeCurrent(e.target.value)} placeholder="Temporäres Passwort" required /><input type="password" autoComplete="new-password" minLength={4} value={changeNew} onChange={e => setChangeNew(e.target.value)} placeholder="Neues Passwort" required /><input type="password" autoComplete="new-password" minLength={4} value={changeNew2} onChange={e => setChangeNew2(e.target.value)} placeholder="Neues Passwort wiederholen" required />{changeError && <div className="errorBox">{changeError}</div>}<button className="primary full proPrimary" disabled={changeBusy}>{changeBusy ? <Spinner label="Speichern…" /> : "Passwort setzen"}</button></div></form></AuthShell>;

  if (!board && guestSession) return <AuthShell loading><section className="authCard authCardGlass"><div className="authBrand"><div className="brandMark">WB</div><span>Gastzugang</span></div><div className="authHeading"><h1>Board wird geladen</h1><p>Verbindung zum Gastbereich wird hergestellt…</p></div><Spinner label="Verbinden…" /></section></AuthShell>;

  if (!board && !guestSession) return <main className="menu managerPage">
    <div className="menuHead">
      <div><p className="eyebrow">Whiteboard Workspace</p><h1>Boards</h1><p>{account.displayName || account.username} · {cards.length} Boards</p></div>
      <div className="menuActions">
        <button className="ghostButton" onClick={() => { setTheme(theme === "dark" ? "light" : "dark"); }}>{theme === "dark" ? "☀" : "☾"}</button>
        <button className="primary" onClick={() => setNewOpen(true)}>＋ Neues Board</button>
        <AccountMenu account={account} theme={theme} setTheme={setTheme} onProfile={() => { setProfileName(account.displayName || account.username); setProfileError(""); setProfileOpen(true); setAccountOpen(false); }} isOpen={accountOpen} setOpen={setAccountOpen} isAdmin={account.role === "admin"} onAdmin={openAdmin} onLogout={logout} />
      </div>
    </div>
    <div className="managerShell">
      <aside className="folderSidebar">
        <div className="sidebarTop"><b>Ordner</b><button title="Ordner erstellen" onClick={() => setFolderOpen(true)}>＋</button></div>
        <button className={`folderItem ${activeFolderId === null ? "active" : ""}`} onClick={() => setActiveFolderId(null)}><span>⌂</span><span>Alle Boards</span><strong>{cards.length}</strong></button>
        {folders.map(folder => <div className="folderRow" key={folder.id} draggable onDragStart={() => setDragBoardId(`folder:${folder.id}`)} onDragEnd={() => setDragBoardId(null)} onDoubleClick={() => renameFolder(folder)} onDrop={e => { e.preventDefault(); if (dragBoardId && !String(dragBoardId).startsWith("folder:")) moveBoardToFolder(dragBoardId, folder.id); }} onDragOver={e => e.preventDefault()}>
          <button className={`folderItem ${activeFolderId === folder.id ? "active" : ""}`} onClick={() => setActiveFolderId(folder.id)}><span>▱</span><span>{folder.name}</span><strong>{cards.filter(c=>c.folderId===folder.id).length}</strong></button>
          <button className="folderMore" onClick={(e)=>{e.stopPropagation(); const action=prompt(`Ordner „${folder.name}“\n1 = Umbenennen\n2 = Löschen`); if(action==="1") renameFolder(folder); if(action==="2") deleteFolder(folder);}}>⋯</button>
        </div>)}
        <div className="sidebarHint">Boards per Drag & Drop in Ordner ziehen.</div>
      </aside>
      <section className="managerContent">
        <div className="managerToolbar"><div><h2>{activeFolderId ? folders.find(f=>f.id===activeFolderId)?.name || "Ordner" : "Alle Boards"}</h2><span>{activeFolderId ? cards.filter(c=>c.folderId===activeFolderId).length : cards.length} Boards</span></div><div className="managerFilters"><label className="sortControl">Sortieren <select value={sortBy} onChange={e => setSortBy(e.target.value)}><option value="updated">Zuletzt geändert</option><option value="name">Name</option></select></label></div></div>
        {loading && cards.length === 0 ? <div className="cards">{[1,2,3].map(i => <SkeletonCard key={i} />)}</div> : <div className="cards">{cards.filter(b => !activeFolderId || b.folderId === activeFolderId).map(b => { const canManage = account.role === "admin" || b.createdBy === account.id; return <article key={b.id} draggable onDragStart={() => setDragBoardId(b.id)} onDragEnd={() => setDragBoardId(null)} onClick={() => openBoard(b)} className="boardCard"><BoardThumbnail board={b} /><div className="cardTitleLine"><b>{b.name}</b>{account.role === "admin" && <span className="accessBadge">{b.accessMode === "selected" ? "Privat" : "Geteilt"}</span>}</div><span>{b.members || 0} online · {new Date(b.updatedAt || Date.now()).toLocaleDateString("de-DE")}</span>{canManage && <div className="cardActions" onClick={e => e.stopPropagation()}><button onClick={() => { setRenameValue(b.name); setRenameTarget(b); setRenameOpen(true); }}>Umbenennen</button>{account.role === "admin" && <button onClick={() => openBoardAccess(b)}>Zugriff</button>}<button className="danger" onClick={() => deleteBoard(b)}>Löschen</button></div>}</article>; })}</div>}
        {cards.filter(b => !activeFolderId || b.folderId === activeFolderId).length === 0 && !loading && <div className="emptyManager"><div>✦</div><h3>Noch kein Board hier</h3><p>Erstelle ein Board oder ziehe eines aus „Alle Boards“ in diesen Ordner.</p><button className="primary" onClick={() => setNewOpen(true)}>＋ Board erstellen</button></div>}
      </section>
    </div>
    <Modal open={newOpen} title="Neues Whiteboard" onClose={() => setNewOpen(false)}><input autoFocus value={newBoardName} onChange={e => setNewBoardName(e.target.value)} onKeyDown={e => e.key === "Enter" && createBoard()} placeholder="Whiteboard-Name" /><p className="muted">Ordner: {activeFolderId ? folders.find(f=>f.id===activeFolderId)?.name : "Alle Boards"}</p><div className="actions"><button className="primary" onClick={createBoard} disabled={loading}>{loading ? <Spinner label="Erstellen…" /> : "Erstellen"}</button><button onClick={() => setNewOpen(false)}>Abbrechen</button></div></Modal>
    <Modal open={folderOpen} title="Neuer Ordner" onClose={() => setFolderOpen(false)}><form onSubmit={createFolder}><input autoFocus value={folderName} onChange={e => setFolderName(e.target.value)} maxLength={64} placeholder="Ordnername"/><div className="actions"><button className="primary" disabled={folderBusy}>{folderBusy ? <Spinner label="Erstellen…" /> : "Ordner erstellen"}</button><button type="button" onClick={() => setFolderOpen(false)}>Abbrechen</button></div></form></Modal>
    <Modal open={renameOpen} title="Whiteboard umbenennen" onClose={() => { setRenameOpen(false); setRenameTarget(null); }}><input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => e.key === "Enter" && renameBoard()} placeholder="Name" /><div className="actions"><button className="primary" onClick={renameBoard}>Speichern</button><button onClick={() => setRenameOpen(false)}>Abbrechen</button></div></Modal>
    {accessOpen && <BoardAccessModal board={accessTarget} users={adminUsers.filter(u => u.role !== "admin")} mode={accessMode} setMode={setAccessMode} userIds={accessUserIds} setUserIds={setAccessUserIds} error={accessError} busy={accessBusy} onSave={saveBoardAccess} onClose={() => { setAccessOpen(false); setAccessTarget(null); }} />}
    {profileOpen && <ProfileModal account={account} profileName={profileName} setProfileName={setProfileName} currentPassword={profileCurrentPassword} setCurrentPassword={setProfileCurrentPassword} newPassword={profileNewPassword} setNewPassword={setProfileNewPassword} newPassword2={profileNewPassword2} setNewPassword2={setProfileNewPassword2} file={profileFile} setFile={setProfileFile} error={profileError} busy={profileBusy} onSave={saveProfile} onClose={() => setProfileOpen(false)} />}
    {adminOpen && <AdminModal users={adminUsers} error={adminError} busy={adminBusy} newUsername={newUsername} setNewUsername={setNewUsername} onClose={() => { setAdminOpen(false); setTempPasswordReveal(null); }} onRefresh={loadAdminUsers} onCreate={createAdminUser} onReset={resetUserPassword} onUnlock={unlockUser} onLock={lockUser} reveal={tempPasswordReveal} />}
    {loading && <LoadingOverlay visible label="Serveranfrage läuft…" />}
  </main>;

  return <main className="app"><header className="boardHeader"><button className="backButton" onClick={() => { if (isGuest) { leaveGuest(); return; } socket.emit("leave-board"); setBoard(null); setParticipantsOpen(false); setBg(DEFAULT_BG); setCursors({}); }}>← <span>Boards</span></button><div className="boardTitle"><strong>{board.name}</strong>{isGuest && <span className="guestModeBadge">{guestSession.guest.mode === "view-only" ? "Gast · Ansicht" : "Gast · Bearbeiten"}</span>}</div><div className="headerActions"><span className={`connectionBadge ${connected ? "online" : "offline"}`}>{connected ? "● Live" : "○ Offline"}</span><button className="peopleButton" onClick={() => setParticipantsOpen(v => !v)} title={participantsOpen ? "Teilnehmer schließen" : "Teilnehmer"} aria-expanded={participantsOpen}>👥 <span>{participants.length}</span></button>{isAdmin && <button className="shareButton" onClick={openGuestShare}>Teilen</button>}</div></header>

    <nav className="boardToolbar">
      {!readOnly && <><div className="toolbarGroup primaryTools">{TOOLS.map(t => <button key={t[0]} disabled={readOnly} className={tool === t[0] ? "active" : ""} title={t[2]} onClick={() => chooseTool(t[0])}>{t[1]}</button>)}</div><div className="toolbarGroup"><input disabled={readOnly} type="color" value={color} title="Farbe" onChange={e => setColor(e.target.value)} /><label className="rangeLabel"><span>Stärke</span><input disabled={readOnly} type="range" min="1" max="30" value={width} onChange={e => setWidth(+e.target.value)} /></label></div><div className="toolbarGroup toolbarSecondary"><button className="toolbarTextButton toolbarBgButton" disabled={readOnly} onClick={() => setBgOpen(v => !v)}><span className="toolbarLabel">Hintergrund</span><span className="toolbarIconOnly">🎨</span></button><label className="uploadButton toolbarTextButton"><span className="toolbarLabel">🖼 Bild</span><span className="toolbarIconOnly">🖼</span><input type="file" hidden accept="image/*" disabled={readOnly} onChange={e => { const f = e.target.files?.[0]; if (f) handleBoardFile(f); e.target.value = ""; }} /></label><div className="exportWrap"><button className="toolbarTextButton toolbarExportButton" ref={exportButton} onClick={() => { const rect = exportButton.current?.getBoundingClientRect(); if (rect) { const spaceBelow = window.innerHeight - rect.bottom; const menuHeight = 100; const top = spaceBelow < menuHeight ? Math.max(8, rect.top - menuHeight - 8) : rect.bottom + 8; setExportPosition({ top, left: Math.max(8, Math.min(window.innerWidth - 170, rect.right - 150)) }); } setExportOpen(v => !v); }}><span className="toolbarLabel">Export</span><span className="toolbarIconOnly">⇩</span></button></div><button onClick={undo} disabled={readOnly} title="Rückgängig">↶</button><button onClick={redo} disabled={readOnly} title="Wiederholen">↷</button><button className={pencilMode ? "active" : ""} onClick={() => { resetPointerState(); setPencilMode(v => !v); }} title="Stiftmodus">✍</button><div className="zoom"><button disabled={viewSyncEnabled && !isAdmin} onClick={() => changeZoom(-0.1)}>−</button><button className="zoomValue" disabled={viewSyncEnabled && !isAdmin} onClick={resetView}>{Math.round(zoom * 100)}%</button><button disabled={viewSyncEnabled && !isAdmin} onClick={() => changeZoom(0.1)}>＋</button></div>{isAdmin ? <button className={`${viewSyncEnabled ? "active " : ""}hostViewButton toolbarTextButton`} onClick={toggleViewSync} title="Admin-Ansicht für alle synchronisieren"><span className="toolbarLabel">👁 {viewSyncEnabled ? "Alle sehen" : "Ansicht teilen"}</span><span className="toolbarIconOnly">👁</span></button> : viewSyncEnabled ? <span className="viewSyncBadge">👁 Admin-Ansicht</span> : null}</div></>}
      <div className="toolbarTimer"><TimerWidget timerApi={timerApi} canControl={canControlTimer} /></div>
    </nav>
    {exportOpen && createPortal(<div className="exportMenu exportMenuPortal" style={{ top: exportPosition.top, left: exportPosition.left }}><button onClick={() => { exportBoard("png"); setExportOpen(false); }}>PNG</button><button onClick={() => { exportBoard("json"); setExportOpen(false); }}>JSON</button><button onClick={() => { setExportOpen(false); openPdfExport(); }}>PDF</button></div>, document.body)}
    {readOnly && <div className="readOnlyBar"><span>👀 Nur Lesezugriff</span><span>Änderungen werden live angezeigt</span></div>}
    {bgOpen && !readOnly && <div className="bgmenu">{BGS.map(b => <button key={b[0]} disabled={readOnly} onClick={() => chooseBg(b)}>{b[0]}</button>)}<label>Eigene Farbe <input disabled={readOnly} type="color" value={bg.color} onChange={e => chooseBg(["Eigene", e.target.value, "none", bg.size || 24])} /></label><label>Größe <input disabled={readOnly} type="range" min="8" max="60" value={bg.size || 24} onChange={e => updateBgSize(e.target.value)} /></label></div>}
    <div className="canvasStack" ref={stack}><canvas ref={base} /><canvas ref={preview} className="previewCanvas" onContextMenu={e => e.preventDefault()} />{Object.values(cursors).map(c => <div key={c.userId} className="remoteCursor" style={{ left: c.x * zoom + pan.x, top: c.y * zoom + pan.y }}><span>{c.username}</span></div>)}</div>
    {participantsOpen && <ParticipantsModal participants={participants} currentId={identityIdRef.current} selfName={guestSession?.guest?.displayName || account?.displayName || account?.username || "Du"} isAdmin={isAdmin} allowUserDeleteOthers={allowUserDeleteOthers} setDeleteOthers={setDeleteOthers} setUserReadOnly={setUserReadOnly} setAllReadOnly={setAllReadOnly} kickUser={kickUser} onClose={() => setParticipantsOpen(false)} />}
    {guestShareOpen && <GuestShareModal invites={guestInvites} error={guestShareError} busy={guestShareBusy} onCreate={createGuestInvite} onRevoke={revokeGuestInvite} onClose={() => setGuestShareOpen(false)} />}
    {adminOpen && <AdminModal users={adminUsers} error={adminError} busy={adminBusy} newUsername={newUsername} setNewUsername={setNewUsername} onClose={() => { setAdminOpen(false); setTempPasswordReveal(null); }} onRefresh={loadAdminUsers} onCreate={createAdminUser} onReset={resetUserPassword} onUnlock={unlockUser} onLock={lockUser} reveal={tempPasswordReveal} />}
    {profileOpen && <ProfileModal account={account} profileName={profileName} setProfileName={setProfileName} currentPassword={profileCurrentPassword} setCurrentPassword={setProfileCurrentPassword} newPassword={profileNewPassword} setNewPassword={setProfileNewPassword} newPassword2={profileNewPassword2} setNewPassword2={setProfileNewPassword2} file={profileFile} setFile={setProfileFile} error={profileError} busy={profileBusy} onSave={saveProfile} onClose={() => setProfileOpen(false)} />}
    {files.some(file => !file.mimeType?.startsWith("image/")) && <div className="fileTray">{files.filter(file => !file.mimeType?.startsWith("image/")).slice(-6).map(file => <a className="fileCard" key={file.id} href={`${API}${file.url}`} target="_blank" rel="noreferrer"><span className="fileIcon">📄</span><span>{file.originalName}</span></a>)}</div>}
    <Modal open={pdfOpen} title="PDF exportieren" onClose={() => !pdfBusy && setPdfOpen(false)} className="pdfExportPanel">
      <div className="pdfExportGrid"><div className="pdfPreviewPane">{pdfPreviewUrl ? <img src={pdfPreviewUrl} alt="PDF Vorschau" /> : <div className="pdfPreviewEmpty"><Spinner label="Vorschau wird erstellt…" /></div>}</div><div className="pdfControls">
        <label>Bereich<select value={pdfConfig.area} onChange={async e=>{const next={...pdfConfig,area:e.target.value};setPdfConfig(next);try{await updatePdfPreview(next);}catch{}}}><option value="viewport">Sichtbarer Bereich</option><option value="content">Alle Inhalte</option></select></label>
        <label>Papier<select value={pdfConfig.paper} onChange={e=>setPdfConfig(v=>({...v,paper:e.target.value}))}><option value="a4">A4</option><option value="letter">Letter</option></select></label>
        <label>Ausrichtung<select value={pdfConfig.orientation} onChange={e=>setPdfConfig(v=>({...v,orientation:e.target.value}))}><option value="landscape">Querformat</option><option value="portrait">Hochformat</option></select></label>
        <label>Qualität<select value={pdfConfig.quality} onChange={async e=>{const next={...pdfConfig,quality:Number(e.target.value)};setPdfConfig(next);try{await updatePdfPreview(next);}catch{}}}><option value="1">Standard</option><option value="2">Hoch</option><option value="3">Sehr hoch</option></select></label>
        <label>Render-Modus<select value={pdfConfig.mode} onChange={e=>setPdfConfig(v=>({...v,mode:e.target.value}))}><option value="raster">Raster · originalgetreu</option><option value="vector">Vektor · Formen & Text</option></select></label>
        {pdfBusy && <div className="pdfProgress"><span style={{width:`${pdfProgress}%`}}/></div>}
        <div className="actions"><button className="primary" onClick={exportPdf} disabled={pdfBusy}>{pdfBusy ? `Erstelle ${pdfProgress}%…` : "PDF erstellen"}</button><button onClick={()=>setPdfOpen(false)} disabled={pdfBusy}>Abbrechen</button></div>
      </div></div>
    </Modal>
    <Modal open={textEditorOpen} title="Text hinzufügen" onClose={() => { setTextEditorOpen(false); setTextEditorValue(""); setTextEditorPoint(null); }} className="textEditorPanel"><div className="textEditorHelp">Schreibe deinen Text hier. Zeilenumbrüche werden im Whiteboard übernommen.</div><textarea autoFocus value={textEditorValue} maxLength={TEXT_MAX_LENGTH} rows={8} placeholder="Dein Text…" onChange={e => setTextEditorValue(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submitText(); } }} /><div className="textEditorMeta"><span>{textEditorValue.length.toLocaleString("de-DE")} / {TEXT_MAX_LENGTH.toLocaleString("de-DE")} Zeichen</span><label>Größe <input type="range" min="12" max="96" value={textEditorSize} onChange={e => setTextEditorSize(+e.target.value)} /><b>{textEditorSize}px</b></label></div><div className="textEditorPreview"><span style={{fontSize: Math.min(textEditorSize, 42), color}}>Aa</span><span>Vorschau</span></div><div className="actions"><button className="primary" onClick={submitText} disabled={!textEditorValue.trim()}>Text einfügen</button><button onClick={() => { setTextEditorOpen(false); setTextEditorValue(""); setTextEditorPoint(null); }}>Abbrechen</button></div></Modal>
    <div className="boardFooterHint">{readOnly ? "Nur Ansicht" : pencilMode ? "Pencil zeichnet · 2 Finger zoomt & verschiebt" : "Maus / Stift zeichnet · Lasso wählt und verschiebt Objekte"}</div>
  </main>;
}


function BoardThumbnail({ board }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const d = window.devicePixelRatio || 1; const w = Math.max(1, Math.round(c.clientWidth*d)); const h=Math.max(1,Math.round(c.clientHeight*d)); c.width=w;c.height=h;
    const ctx=c.getContext("2d"); ctx.setTransform(d,0,0,d,0,0); ctx.clearRect(0,0,c.clientWidth,c.clientHeight);
    ctx.fillStyle=board.background?.color||"#fff"; ctx.fillRect(0,0,c.clientWidth,c.clientHeight);
    const size=Math.max(10,Math.min(32,Number(board.background?.size)||22)); ctx.strokeStyle="rgba(100,110,125,.13)";ctx.fillStyle="rgba(100,110,125,.18)";ctx.lineWidth=1;
    if(board.background?.pattern==="grid"){for(let x=0;x<c.clientWidth;x+=size){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,c.clientHeight);ctx.stroke()}for(let y=0;y<c.clientHeight;y+=size){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.clientWidth,y);ctx.stroke()}}
    if(board.background?.pattern==="dots"){for(let y=size/2;y<c.clientHeight;y+=size)for(let x=size/2;x<c.clientWidth;x+=size){ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill()}}
    if(board.background?.pattern==="lines"){for(let y=0;y<c.clientHeight;y+=size){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.clientWidth,y);ctx.stroke()}}
    const objects=Array.isArray(board.preview)?board.preview:[]; let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const o of objects){if(o.type==="stroke"){for(const p of o.points||[]){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y)}}else if(["line","rect","circle","image"].includes(o.type)){minX=Math.min(minX,o.x||0);minY=Math.min(minY,o.y||0);maxX=Math.max(maxX,(o.x||0)+(o.w||o.x2||0));maxY=Math.max(maxY,(o.y||0)+(o.h||o.y2||0))}else if(o.type==="text"){const measure=document.createElement("canvas").getContext("2d");const layout=getCanvasTextLayout(measure,o);minX=Math.min(minX,o.x||0);minY=Math.min(minY,(o.y||0)-layout.fontSize);maxX=Math.max(maxX,(o.x||0)+layout.width);maxY=Math.max(maxY,(o.y||0)+layout.height)}}
    if(!Number.isFinite(minX)){ctx.fillStyle="rgba(70,85,111,.28)";ctx.font="700 28px Inter,system-ui,sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("WB",c.clientWidth/2,c.clientHeight/2);return}
    const pad=24;minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;const scale=Math.min(c.clientWidth/(maxX-minX),c.clientHeight/(maxY-minY));const ox=(c.clientWidth-(maxX-minX)*scale)/2-minX*scale;const oy=(c.clientHeight-(maxY-minY)*scale)/2-minY*scale;
    ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);for(const o of objects){ctx.strokeStyle=o.color||"#334155";ctx.fillStyle=o.color||"#334155";ctx.lineWidth=Math.max(.8,(o.width||2)/scale);ctx.lineCap="round";ctx.lineJoin="round";if(o.type==="stroke"){ctx.beginPath();(o.points||[]).forEach((q,i)=>i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));ctx.stroke()}else if(o.type==="line"){ctx.beginPath();ctx.moveTo(o.x1,o.y1);ctx.lineTo(o.x2,o.y2);ctx.stroke()}else if(o.type==="rect"){ctx.strokeRect(o.x,o.y,o.w,o.h)}else if(o.type==="circle"){ctx.beginPath();ctx.ellipse(o.x+o.w/2,o.y+o.h/2,Math.abs(o.w/2),Math.abs(o.h/2),0,0,Math.PI*2);ctx.stroke()}else if(o.type==="text"){const layout=getCanvasTextLayout(ctx,o);ctx.font=`${layout.fontSize}px Inter,system-ui,sans-serif`;layout.lines.forEach((line,i)=>ctx.fillText(line,o.x,o.y+i*layout.lineHeight))}}
    ctx.restore();
  }, [board]);
  return <div className="thumb boardThumb"><canvas ref={ref} /><span className="thumbOverlay" /></div>;
}

function AccountMenu({ account, theme, setTheme, onProfile, isOpen, setOpen, isAdmin, onAdmin, onLogout }) {
  return <div className="accountWrap"><button className="accountButton" onClick={() => setOpen(v => !v)}><span className="avatarMini">{account.avatarUrl ? <img src={`${API}${account.avatarUrl}`} alt="" /> : (account.displayName || account.username).slice(0, 1).toUpperCase()}</span>{account.displayName || account.username}</button>{isOpen && <div className="accountMenu"><b>{account.displayName || account.username}</b><span>@{account.username} · {isAdmin ? "Administrator" : "Benutzer"}</span><button onClick={onProfile}>Profil</button>{isAdmin && <button onClick={onAdmin}>Admin-Einstellungen</button>}<button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀ Light Mode" : "🌙 Dark Mode"}</button><button onClick={onLogout}>Abmelden</button></div>}</div>;
}

function ParticipantsModal({ participants, currentId, selfName, isAdmin, allowUserDeleteOthers, setDeleteOthers, setUserReadOnly, setAllReadOnly, kickUser, onClose }) {
  const others = participants.filter(p => p.userId !== currentId);
  return <Modal open title="Teilnehmer" onClose={onClose} className="participantsPanel" overlayClassName="participantsModal">
    <div className="participantSummary"><span><b>{participants.length}</b> online</span><span className="liveDot"><i /> Live</span></div>
    {isAdmin && <><div className="adminSettingRow"><div><b>Fremde Objekte löschen</b><span>Benutzer dürfen damit auch Objekte anderer Teilnehmer löschen.</span></div><label className={`switch ${allowUserDeleteOthers ? "on" : ""}`}><input type="checkbox" checked={allowUserDeleteOthers} onChange={e => setDeleteOthers(e.target.checked)} /><span /></label></div><div className="adminBulkActions compact"><button onClick={() => setAllReadOnly(true)}>Alle sperren</button><button onClick={() => setAllReadOnly(false)}>Alle freigeben</button></div></>}
    <div className="participantList">
      <div className="participantRow selfRow"><div className="participantMain"><span className="statusDot active" /><div><b>{selfName}</b><span className="participantSub">Du</span></div></div><span className="status active">Online</span></div>
      {others.map(p => <div className="participantRow" key={p.userId}><div className="participantMain"><span className={`statusDot ${p.readOnly ? "readonly" : "active"}`} /><div><b>{p.displayName}</b><span className="participantSub">{p.kind === "guest" ? (p.guestMode === "guest-edit" ? "Gast · Bearbeiten" : "Gast · Ansicht") : p.isHost ? "Host" : (p.devices > 1 ? `${p.devices} Geräte` : "1 Gerät")}</span></div></div><div className="participantEnd"><span className={p.readOnly ? "status readonly" : "status active"}>{p.readOnly ? "Ansicht" : "Aktiv"}</span>{isAdmin && p.kind === "account" && !p.isHost && <div className="participantActions"><button onClick={() => setUserReadOnly(p.userId, !p.readOnly)}>{p.readOnly ? "Freigeben" : "Schreibsperre"}</button><button className="danger" onClick={() => kickUser(p.userId)}>Kicken</button></div>}</div></div>)}
      {participants.length === 1 && <div className="emptyParticipants">Noch niemand sonst ist hier.</div>}
    </div>
  </Modal>;
}

function GuestJoinScreen({ name, setName, error, busy, onJoin }) {
  return <AuthShell loading={busy}><form className="authCard authCardGlass guestJoinCard" onSubmit={onJoin}><div className="authBrand"><div className="brandMark">↗</div><span>Gastzugang</span></div><div className="authHeading"><h1>Board beitreten</h1><p>Gib einen Namen ein, damit die anderen Teilnehmer wissen, wer im Board arbeitet.</p></div><div className="authFormPro"><input autoFocus value={name} maxLength={32} onChange={e => setName(e.target.value)} placeholder="Dein Name" required /><button className="primary full proPrimary" disabled={busy}>{busy ? <Spinner label="Beitreten…" /> : "Board öffnen"}</button>{error && <div className="errorBox">{error}</div>}</div></form></AuthShell>;
}

function GuestShareModal({ invites, error, busy, onCreate, onRevoke, onClose }) {
  return <Modal open title="Gast-Code" onClose={onClose} className="guestSharePanel"><p className="muted">Erstelle einen temporären 6-stelligen Code. Er öffnet dieses Board mit Bearbeitungsrechten. Der Gast muss beim Beitritt einen Namen eingeben.</p><div className="guestCreateButtons"><button className="primary" disabled={busy} onClick={onCreate}>{busy ? <Spinner label="Code wird erstellt…" /> : "＋ Neuen Gast-Code erstellen"}</button></div>{error && <div className="errorBox">{error}</div>}<div className="inviteList">{invites.map(inv => <div className="inviteRow" key={inv.id}><div><b>Gast-Code</b><span>{inv.expiresAt ? `bis ${new Date(inv.expiresAt).toLocaleString()}` : "ohne Ablauf"}</span>{inv.code && <code className="guestCodeReveal">{inv.code}</code>}{!inv.code && <span>Code nur bei Erstellung sichtbar</span>}</div><div className="inviteActions">{inv.code && <button onClick={() => navigator.clipboard?.writeText(inv.code)}>Kopieren</button>}<button className="danger" onClick={() => onRevoke(inv.id)}>Widerrufen</button></div></div>)}{invites.length === 0 && <div className="emptyParticipants">Noch keine Gast-Codes erstellt.</div>}</div></Modal>;
}

function BoardAccessModal({ board, users, mode, setMode, userIds, setUserIds, error, busy, onSave, onClose }) {
  const toggleUser = id => setUserIds(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  return <Modal open title={`Zugriff · ${board?.name || "Whiteboard"}`} onClose={onClose} className="boardAccessPanel">
    <p className="muted">Lege fest, welche normalen Benutzer dieses Board öffnen dürfen. Der Administrator hat immer Zugriff.</p>
    <div className="accessModes">
      <button className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}>Alle Benutzer</button>
      <button className={mode === "selected" ? "active" : ""} onClick={() => setMode("selected")}>Nur ausgewählte</button>
    </div>
    {mode === "selected" && <div className="accessUserList">{users.map(user => <label className="accessUserRow" key={user.id}><input type="checkbox" checked={userIds.includes(user.id)} onChange={() => toggleUser(user.id)} /><span className="avatarMini">{user.avatarUrl ? <img src={`${API}${user.avatarUrl}?v=${encodeURIComponent(user.updatedAt || "1")}`} alt="" /> : (user.displayName || user.username).slice(0, 1).toUpperCase()}</span><span><b>{user.displayName || user.username}</b><small>@{user.username}</small></span></label>)}{users.length === 0 && <div className="emptyParticipants">Keine normalen Benutzer vorhanden.</div>}</div>}
    {error && <div className="errorBox">{error}</div>}
    <div className="actions"><button className="primary" disabled={busy} onClick={onSave}>{busy ? <Spinner label="Speichern…" /> : "Zugriff speichern"}</button><button onClick={onClose}>Abbrechen</button></div>
  </Modal>;
}

function ProfileModal({ account, profileName, setProfileName, currentPassword, setCurrentPassword, newPassword, setNewPassword, newPassword2, setNewPassword2, file, setFile, error, busy, onSave, onClose }) {
  const preview = useMemo(() => file ? URL.createObjectURL(file) : (account.avatarUrl ? `${API}${account.avatarUrl}?v=${encodeURIComponent(account.updatedAt || "1")}` : null), [file, account.avatarUrl, account.updatedAt]);
  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  return <Modal open title="Mein Profil" onClose={onClose} className="profilePanel">
    <div className="profileHero"><div className="profileAvatar"><span className="avatar big">{preview ? <img src={preview} alt="Profilbild" /> : (account.displayName || account.username).slice(0, 1).toUpperCase()}</span><div><b>{account.displayName || account.username}</b><span>@{account.username}</span></div></div><label className="uploadButton">Bild auswählen<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => setFile(e.target.files?.[0] || null)} /></label>{file && <small className="fileSelected">{file.name}</small>}</div>
    <label className="fieldLabel">Anzeigename<input value={profileName} maxLength={DISPLAY_NAME_MAX} onChange={e => setProfileName(e.target.value)} /></label><div className="sectionDivider" /><h3>Passwort ändern</h3><p className="muted">Nur ausfüllen, wenn du dein Passwort ebenfalls ändern möchtest.</p><input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Aktuelles Passwort" /><input type="password" minLength={4} autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Neues Passwort" /><input type="password" minLength={4} autoComplete="new-password" value={newPassword2} onChange={e => setNewPassword2(e.target.value)} placeholder="Neues Passwort wiederholen" />{error && <div className="errorBox">{error}</div>}<div className="actions"><button className="primary" onClick={onSave} disabled={busy}>{busy ? <Spinner label="Speichern…" /> : "Speichern"}</button><button onClick={onClose}>Abbrechen</button></div></Modal>;
}

function AdminModal({ users, error, busy, newUsername, setNewUsername, onClose, onRefresh, onCreate, onReset, onUnlock, onLock, reveal }) {
  return <Modal open title="Admin-Einstellungen" onClose={onClose} className="adminPanel"><p>Benutzer werden ausschließlich hier oder per Terminal erstellt.</p><form className="adminCreate" onSubmit={onCreate}><input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="Neuer Benutzername" required minLength={3} maxLength={24} /><button className="primary" disabled={busy}>{busy ? <Spinner label="Erstellen…" /> : "Benutzer anlegen"}</button></form>{reveal && <div className="tempPasswordBox"><b>Temporärcode für {reveal.username}</b><code>{reveal.password}</code><p>Nur jetzt sichtbar. Der Benutzer muss ihn beim ersten Login durch ein eigenes Passwort ersetzen.</p></div>}{error && <div className="errorBox">{error}</div>}<div className="adminToolbar"><b>{users.length} Benutzer</b><button onClick={onRefresh} disabled={busy}>Aktualisieren</button></div><div className="adminUserList">{users.map(user => <div className="adminUserRow" key={user.id}><div className="adminUserIdentity"><span className="avatar smallAvatar">{user.avatarUrl ? <img src={`${API}${user.avatarUrl}?v=${encodeURIComponent(user.updatedAt || "1")}`} alt="" /> : (user.displayName || user.username).slice(0, 1).toUpperCase()}</span><div><b>{user.displayName || user.username}{user.role === "admin" ? " · Admin" : ""}</b><span className="participantId">@{user.username} · {user.locked ? "Konto gesperrt" : user.mustChangePassword ? "Passwortwechsel erforderlich" : "Aktiv"}</span></div></div>{user.role !== "admin" && <div className="participantActions"><button onClick={() => onReset(user)} disabled={busy}>Temporärcode zurücksetzen</button>{user.locked ? <button onClick={() => onUnlock(user)} disabled={busy}>Konto entsperren</button> : <button className="danger" onClick={() => onLock(user)} disabled={busy}>Konto sperren</button>}</div>}</div>)}</div></Modal>;
}

createRoot(document.getElementById("root")).render(<App />);
