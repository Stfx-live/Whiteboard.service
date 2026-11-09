const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const express = require("express");
const multer = require("multer");
let Server;

const PORT = Number(process.env.PORT || 3002);
const DATA_DIR = path.join(__dirname, "data");
const BOARDS_DIR = path.join(DATA_DIR, "boards");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");
const FOLDERS_FILE = path.join(DATA_DIR, "folders.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const AVATARS_DIR = path.join(UPLOADS_DIR, "avatars");
const BOARD_FILES_DIR = path.join(UPLOADS_DIR, "board-files");
const MAX_LOGIN_FAILURES = 5;
const PASSWORD_MIN = 4;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKGROUND = { color: "#ffffff", pattern: "grid", size: 24 };

fs.mkdirSync(BOARDS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });
fs.mkdirSync(BOARD_FILES_DIR, { recursive: true });
const sessions = new Map(); // token -> { accountId, createdAt }
const accounts = new Map(); // accountId -> account
const boards = new Map();
const folders = new Map();
const participants = new Map(); // boardId -> Map(accountId, participant)
const liveStrokes = new Map(); // boardId -> Map(strokeId, socketId)
const guestSessions = new Map(); // sessionToken -> { guestId, boardId, mode, displayName, inviteId, createdAt }
const timerIntervals = new Map(); // boardId -> interval
const viewSyncPersistTimers = new Map(); // boardId -> throttled persistence timer
const GUEST_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const GUEST_INVITE_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}
function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.slice(0, 120) || fallback;
}
function boardFile(id) { return path.join(BOARDS_DIR, `${safeId(id)}.json`); }
function hashGuestToken(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex"); }
function newGuestToken() { return crypto.randomBytes(32).toString("base64url"); }
function newGuestId() { return `guest-${crypto.randomBytes(8).toString("hex")}`; }
function guestInvitePublic(invite, boardId) {
  return {
    id: invite.id,
    boardId,
    mode: invite.mode,
    type: invite.type || (invite.codeHash ? "code" : "link"),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt || null,
    hasCode: Boolean(invite.codeHash),
  };
}
function newGuestCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function findGuestInviteById(boardId, inviteId) {
  const b = loadBoard(boardId);
  return (b.guestInvites || []).find(i => i.id === inviteId && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now())) || null;
}
function findGuestInviteByCode(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) return null;
  const hash = hashGuestToken(normalized);
  for (const file of fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith(".json"))) {
    const id = path.basename(file, ".json");
    const b = loadBoard(id);
    const invite = (b.guestInvites || []).find(i => i.codeHash === hash && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now()));
    if (invite) return { invite, boardId: id };
  }
  return null;
}
function findGuestInvite(boardId, token) {
  const b = loadBoard(boardId);
  const hash = hashGuestToken(token);
  const invite = (b.guestInvites || []).find(i => i.tokenHash === hash && !i.revokedAt && (!i.expiresAt || i.expiresAt > Date.now()));
  return invite || null;
}
function getGuestSession(token) {
  const key = String(token || "");
  const entry = guestSessions.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > GUEST_SESSION_TTL_MS) { guestSessions.delete(key); return null; }
  const invite = findGuestInviteById(entry.boardId, entry.inviteId);
  if (!invite) { guestSessions.delete(key); return null; }
  entry.mode = invite.mode;
  return entry;
}
function guestFromRequest(req) {
  const header = String(req.headers["x-guest-token"] || "");
  return getGuestSession(header);
}
function principalFromRequest(req) {
  const account = accountFromRequest(req);
  if (account && !account.mustChangePassword) return { kind: "account", account };
  const guest = guestFromRequest(req);
  if (guest) return { kind: "guest", guest };
  return null;
}
function guestCanEdit(guest) { return guest?.mode === "guest-edit"; }
function normalizeTimer(value) {
  const raw = value && typeof value === "object" ? value : {};
  const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(raw.durationMs) || 0));
  const remainingMs = Math.max(0, Math.min(durationMs || Number(raw.remainingMs) || 0, Number(raw.remainingMs) || 0));
  const status = ["idle", "running", "paused", "expired"].includes(raw.status) ? raw.status : "idle";
  const timer = { status, durationMs, remainingMs, startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : null, endsAt: Number.isFinite(Number(raw.endsAt)) ? Number(raw.endsAt) : null, version: Number(raw.version) || 0, updatedAt: Number(raw.updatedAt) || Date.now() };
  if (timer.status === "running" && (!timer.endsAt || timer.endsAt <= Date.now())) { timer.status = "expired"; timer.remainingMs = 0; timer.startedAt = null; timer.endsAt = null; }
  return timer;
}
function getTimerState(boardId) {
  const b = loadBoard(boardId);
  b.timer = normalizeTimer(b.timer);
  if (b.timer.status === "running") {
    const remainingMs = Math.max(0, b.timer.endsAt - Date.now());
    if (remainingMs <= 0) {
      b.timer.status = "expired"; b.timer.remainingMs = 0; b.timer.startedAt = null; b.timer.endsAt = null; b.timer.version += 1; b.timer.updatedAt = Date.now(); persistBoard(boardId, b);
      stopTimerLoop(boardId);
      return { ...b.timer };
    }
    return { ...b.timer, remainingMs };
  }
  return { ...b.timer };
}
function timerPayload(boardId) { return { ...getTimerState(boardId), serverNow: Date.now() }; }
function broadcastTimer(boardId, event = "timer:tick") { io?.to(boardId).emit(event, timerPayload(boardId)); }
function ensureTimerLoop(boardId) {
  const id = safeId(boardId);
  if (timerIntervals.has(id)) return;
  const handle = setInterval(() => {
    const state = getTimerState(id);
    if (state.status === "running") broadcastTimer(id, "timer:tick");
    else if (state.status === "expired") { broadcastTimer(id, "timer:expired"); stopTimerLoop(id); }
  }, 250);
  timerIntervals.set(id, handle);
}
function stopTimerLoop(boardId) { const id = safeId(boardId); const handle = timerIntervals.get(id); if (handle) clearInterval(handle); timerIntervals.delete(id); }
function timerControlAllowed(socket) { return Boolean(currentAccount(socket)?.role === "admin"); }
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function audit(event, details = {}) {
  const entry = { time: new Date().toISOString(), event, ...details };
  const line = JSON.stringify(entry);
  try { fs.appendFileSync(AUDIT_FILE, line + "\n", { mode: 0o600 }); } catch (e) { console.error("Audit-Log konnte nicht geschrieben werden:", e.message); }
  console.log(`[AUDIT] ${entry.time} ${event}`, details);
}
function loadAccounts() {
  try {
    const raw = fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")) : [];
    for (const account of Array.isArray(raw) ? raw : []) {
      if (!account?.id || !account?.username || !account?.salt || !account?.passwordHash) continue;
      account.role = account.role === "admin" ? "admin" : "user";
      account.failedLoginAttempts = Number(account.failedLoginAttempts || 0);
      account.locked = Boolean(account.locked);
      account.mustChangePassword = Boolean(account.mustChangePassword);
      account.displayName = cleanText(account.displayName, account.username);
      account.avatarPath = typeof account.avatarPath === 'string' ? account.avatarPath : null;
      accounts.set(account.id, account);
    }
  } catch (e) {
    console.error("accounts.json konnte nicht gelesen werden:", e.message);
  }
}
function persistAccounts() { writeJsonAtomic(ACCOUNTS_FILE, [...accounts.values()]); }
loadAccounts();
loadFolders();


function loadFolders() {
  try {
    const raw = fs.existsSync(FOLDERS_FILE) ? JSON.parse(fs.readFileSync(FOLDERS_FILE, "utf8")) : [];
    for (const folder of Array.isArray(raw) ? raw : []) {
      if (!folder?.id || !folder?.name || !folder?.ownerId) continue;
      folders.set(folder.id, {
        id: safeId(folder.id),
        name: cleanText(folder.name, "Ordner").slice(0, 64),
        ownerId: String(folder.ownerId),
        parentId: folder.parentId ? safeId(folder.parentId) : null,
        order: Number.isFinite(Number(folder.order)) ? Number(folder.order) : 0,
        createdAt: Number(folder.createdAt || Date.now()),
        updatedAt: Number(folder.updatedAt || folder.createdAt || Date.now())
      });
    }
  } catch (e) {
    console.error("folders.json konnte nicht gelesen werden:", e.message);
  }
}
function persistFolders() { writeJsonAtomic(FOLDERS_FILE, [...folders.values()]); }
function folderPublic(folder) {
  return { id: folder.id, name: folder.name, ownerId: folder.ownerId, parentId: folder.parentId || null, order: folder.order || 0, createdAt: folder.createdAt, updatedAt: folder.updatedAt };
}
function getFoldersForAccount(account) {
  if (!account) return [];
  return [...folders.values()]
    .filter(folder => folder.ownerId === account.id || account.role === "admin")
    .sort((a,b) => (a.order - b.order) || a.name.localeCompare(b.name))
    .map(folderPublic);
}
function canManageFolder(account, folder) {
  return Boolean(account && folder && (account.role === "admin" || folder.ownerId === account.id));
}
function canUseFolder(account, folderId) {
  if (!folderId) return true;
  const folder = folders.get(safeId(folderId));
  return canManageFolder(account, folder);
}

function loadBoard(id) {
  id = safeId(id);
  if (!boards.has(id)) {
    let b = { id, name: id, strokes: [], background: { ...DEFAULT_BACKGROUND }, updatedAt: Date.now(), createdAt: Date.now(), hostUserId: null, permissions: {}, settings: { allowUserDeleteOthers: false }, createdBy: null, guestInvites: [], timer: { status: "idle", durationMs: 5 * 60 * 1000, remainingMs: 5 * 60 * 1000, startedAt: null, endsAt: null, version: 0, updatedAt: Date.now() } };
    try {
      if (fs.existsSync(boardFile(id))) b = JSON.parse(fs.readFileSync(boardFile(id), "utf8"));
    } catch (e) {
      console.error("Board konnte nicht geladen werden:", e.message);
    }
    if (!Array.isArray(b.strokes)) b.strokes = [];
    if (!Array.isArray(b.files)) b.files = [];
    if (!b.permissions || typeof b.permissions !== "object") b.permissions = {};
    b.settings = normalizeBoardSettings(b.settings);
    if (!("hostUserId" in b)) b.hostUserId = null;
    b.access = normalizeBoardAccess(b.access);
    b.viewSync = normalizeViewSync(b.viewSync);
    if (!b.background || typeof b.background !== "object") b.background = { ...DEFAULT_BACKGROUND };
    if (!Array.isArray(b.guestInvites)) b.guestInvites = [];
    b.timer = normalizeTimer(b.timer);
    b.zones = normalizeZones(b.zones);
    boards.set(id, b);
  }
  const cached = boards.get(id);
  if (!Array.isArray(cached.zones)) cached.zones = normalizeZones(cached.zones);
  return cached;
}
function persistBoard(id, board) { writeJsonAtomic(boardFile(id), board); }
function normalizeBoardSettings(settings) {
  const raw = settings && typeof settings === "object" ? settings : {};
  return {
    allowUserDeleteOthers: Boolean(raw.allowUserDeleteOthers),
  };
}
function persistViewSyncThrottled(boardId, board) {
  const id = safeId(boardId);
  if (viewSyncPersistTimers.has(id)) return;
  const handle = setTimeout(() => {
    viewSyncPersistTimers.delete(id);
    try { persistBoard(id, board); } catch (e) { console.error("viewSync konnte nicht gespeichert werden:", e.message); }
  }, 180);
  viewSyncPersistTimers.set(id, handle);
}
function flushViewSyncPersistence(boardId, board) {
  const id = safeId(boardId);
  const handle = viewSyncPersistTimers.get(id);
  if (handle) clearTimeout(handle);
  viewSyncPersistTimers.delete(id);
  persistBoard(id, board);
}
function normalizeViewSync(viewSync) {
  if (!viewSync || typeof viewSync !== "object") return { enabled: false, zoom: 1, pan: { x: 0, y: 0 }, center: null, updatedAt: 0, seq: 0 };
  const center = viewSync.center && Number.isFinite(Number(viewSync.center.x)) && Number.isFinite(Number(viewSync.center.y))
    ? { x: Math.max(-100000, Math.min(100000, Number(viewSync.center.x))), y: Math.max(-100000, Math.min(100000, Number(viewSync.center.y))) }
    : null;
  return {
    enabled: Boolean(viewSync.enabled),
    zoom: Math.max(0.25, Math.min(5, Number(viewSync.zoom) || 1)),
    pan: {
      x: Math.max(-20000, Math.min(20000, Number(viewSync.pan?.x) || 0)),
      y: Math.max(-20000, Math.min(20000, Number(viewSync.pan?.y) || 0)),
    },
    center,
    updatedAt: Number(viewSync.updatedAt) || 0,
    seq: Number(viewSync.seq) || 0,
  };
}
function normalizeBoardAccess(access) {
  if (!access || typeof access !== "object") return { mode: "all", userIds: [] };
  return {
    mode: access.mode === "selected" ? "selected" : "all",
    userIds: Array.isArray(access.userIds) ? [...new Set(access.userIds.map(String).filter(Boolean))] : [],
  };
}
function canAccountAccessBoard(account, board) {
  if (!account || !board) return false;
  if (account.role === "admin") return true;
  const access = normalizeBoardAccess(board.access);
  if (board.createdBy === account.id) return true;
  return access.mode !== "selected" || access.userIds.includes(account.id);
}

/* ───────────── Bereiche (Zones) ─────────────
   Admins ziehen Bereiche auf das Board und weisen Nutzern/Gast-Einladungen Modi zu:
   open  = sieht alles, schreibt nur im Bereich
   focus = sieht nur den Bereich, schreibt im Bereich
   view  = sieht nur den Bereich, nur lesen
   Die Durchsetzung passiert hier auf dem Server (Filter für Zustand, Live-Events, Vorschau, Uploads). */
const ZONE_MODES = ["open", "focus", "view"];
const ZONE_COLORS = ["#6366f1", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#ec4899", "#8b5cf6", "#84cc16"];
const MAX_ZONES = 24;
function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(String(c || "")) ? String(c).toLowerCase() : null; }
function cleanZoneRect(raw, fallback = {}) {
  const n = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
  const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    x: lim(n(raw?.x, fallback.x ?? 0), -100000, 100000),
    y: lim(n(raw?.y, fallback.y ?? 0), -100000, 100000),
    w: lim(n(raw?.w, fallback.w ?? 400), 40, 50000),
    h: lim(n(raw?.h, fallback.h ?? 300), 40, 50000),
  };
}
function normalizeZones(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ZONES).map((z, i) => {
    if (!z || typeof z !== "object") return null;
    const assignments = {};
    if (z.assignments && typeof z.assignments === "object") for (const [k, v] of Object.entries(z.assignments)) if (ZONE_MODES.includes(v)) assignments[String(k).slice(0, 80)] = v;
    return { id: cleanText(z.id) || crypto.randomUUID().slice(0, 8), name: cleanText(z.name, `Bereich ${i + 1}`).slice(0, 40), color: validColor(z.color) || ZONE_COLORS[i % ZONE_COLORS.length], ...cleanZoneRect(z), locked: Boolean(z.locked), assignments, createdAt: Number(z.createdAt) || Date.now() };
  }).filter(Boolean);
}
function itemBox(item) {
  if (!item || typeof item !== "object") return null;
  const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
  const fromPts = pts => { if (!pts.length) return null; let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (const p of pts) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); } return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; };
  if (item.type === "stroke") return fromPts((Array.isArray(item.points) ? item.points : []).filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).map(p => ({ x: Number(p.x), y: Number(p.y) })));
  if (item.type === "line" || item.type === "arrow") return fromPts([{ x: num(item.x1), y: num(item.y1) }, { x: num(item.x2), y: num(item.y2) }]);
  if (item.type === "rect" || item.type === "circle" || item.type === "image") {
    const x = num(item.x), y = num(item.y), w = num(item.w), h = num(item.h), r = num(item.rotation);
    const cx = x + w / 2, cy = y + h / 2, c = Math.cos(r), s = Math.sin(r);
    return fromPts([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c })));
  }
  if (item.type === "text") return { x: num(item.x), y: num(item.y), w: 0, h: 0 };
  return null;
}
const rectContains = (r, b, eps = 1) => b.x >= r.x - eps && b.y >= r.y - eps && b.x + b.w <= r.x + r.w + eps && b.y + b.h <= r.y + r.h + eps;
const pointInRect = (r, p, eps = 1) => p.x >= r.x - eps && p.y >= r.y - eps && p.x <= r.x + r.w + eps && p.y <= r.y + r.h + eps;
function scopeKeyFor(account, guest) { return account ? account.id : guest ? `invite:${guest.inviteId}` : null; }
function computeScope(board, key, isAdmin) {
  if (isAdmin || !key) return null;
  const mine = (board.zones || []).filter(z => z.assignments && z.assignments[key]);
  if (!mine.length) return null;
  return {
    key,
    seeAll: mine.some(z => z.assignments[key] === "open"),
    zones: mine,
    writable: mine.filter(z => !z.locked && (z.assignments[key] === "open" || z.assignments[key] === "focus")),
  };
}
function scopeSees(scope, item) {
  if (!scope || scope.seeAll) return true;
  const box = itemBox(item); if (!box) return false;
  return scope.zones.some(z => rectContains(z, box));
}
function scopeSeesPoint(scope, p) { return !scope || scope.seeAll || scope.zones.some(z => pointInRect(z, p)); }
function scopeCanWrite(scope, item) {
  if (!scope) return true;
  const box = itemBox(item); if (!box) return false;
  return scope.writable.some(z => rectContains(z, box));
}
// Freihand-Striche werden an die Bereichsgrenze geklemmt, alle anderen Objekte müssen komplett hineinpassen.
function enforceWrite(scope, item) {
  if (!scope) return item;
  if (item.type === "stroke") {
    const pts = Array.isArray(item.points) ? item.points : []; if (!pts.length) return null;
    const zone = scope.writable.find(z => pointInRect(z, pts[0]));
    if (!zone) return null;
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return { ...item, points: pts.map(p => ({ ...p, x: cl(Number(p.x), zone.x, zone.x + zone.w), y: cl(Number(p.y), zone.y, zone.y + zone.h) })) };
  }
  return scopeCanWrite(scope, item) ? item : null;
}
function filterStrokesFor(scope, strokes) { return scope && !scope.seeAll ? strokes.filter(s => scopeSees(scope, s)) : strokes; }
function zonePublic(z, scope) { return { id: z.id, name: z.name, color: z.color, x: z.x, y: z.y, w: z.w, h: z.h, locked: Boolean(z.locked), ...(scope ? { mode: z.assignments?.[scope.key] || null } : {}) }; }
function zonesFor(board, scope, admin) {
  const list = board.zones || [];
  if (admin) return list.map(z => ({ ...zonePublic(z, null), assignments: { ...z.assignments } }));
  if (scope && !scope.seeAll) return scope.zones.map(z => zonePublic(z, scope));
  return list.map(z => zonePublic(z, scope));
}
function scopePublic(scope) { return scope ? { restricted: true, seeAll: scope.seeAll, writableIds: scope.writable.map(z => z.id) } : { restricted: false, seeAll: true, writableIds: [] }; }
function socketScope(socket, board) {
  if (isHost(socket)) return null;
  return computeScope(board, scopeKeyFor(currentAccount(socket), currentGuest(socket)), false);
}
function socketsOfBoard(id) {
  const room = io?.sockets.adapter.rooms.get(id); const out = [];
  if (room) for (const sid of room) { const s = io.sockets.sockets.get(sid); if (s) out.push(s); }
  return out;
}
// Sendet ein Ereignis pro Empfänger; build(scope, socket) liefert Payload oder null (= nicht senden).
function emitBoard(id, event, build, exceptSocketId = null) {
  const b = loadBoard(id);
  for (const s of socketsOfBoard(id)) {
    if (exceptSocketId && s.id === exceptSocketId) continue;
    const payload = build(socketScope(s, b), s);
    if (payload !== null && payload !== undefined) s.emit(event, payload);
  }
}
function emitBoardMulti(id, build, exceptSocketId = null) {
  const b = loadBoard(id);
  for (const s of socketsOfBoard(id)) {
    if (exceptSocketId && s.id === exceptSocketId) continue;
    for (const [event, payload] of build(socketScope(s, b), s) || []) s.emit(event, payload);
  }
}
function zoneSignature(b, scope, admin) { return JSON.stringify([scopePublic(scope), zonesFor(b, scope, admin)]); }
function broadcastZones(id) {
  const b = loadBoard(id);
  for (const s of socketsOfBoard(id)) {
    if (isHost(s)) { s.emit("zones-state", { zones: zonesFor(b, null, true) }); continue; }
    const scope = socketScope(s, b), sig = zoneSignature(b, scope, false);
    if (s.data.zoneSig === sig) continue;
    s.emit("board-state", getRoomState(s, id));
  }
}
function zoneCandidates(b) {
  const out = [...accounts.values()].filter(a => a.role !== "admin" && !a.locked && canAccountAccessBoard(a, b)).map(a => ({ key: a.id, type: "account", name: a.displayName || a.username, username: a.username, avatarUrl: a.avatarPath ? `/uploads/${a.avatarPath}` : null }));
  for (const i of b.guestInvites || []) {
    if (i.revokedAt || (i.expiresAt && i.expiresAt < Date.now())) continue;
    out.push({ key: `invite:${i.id}`, type: "guest", name: `Gast-${i.codeHash ? "Code" : "Link"} · ${i.mode === "view-only" ? "nur ansehen" : "darf zeichnen"}`, username: new Date(i.createdAt || Date.now()).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) });
  }
  return out;
}

function compactBoardPreview(board, scope = null) {
  return (Array.isArray(board.strokes) ? filterStrokesFor(scope, board.strokes).slice(-14) : []).map(item => {
    if (!item || !item.type) return null;
    if (item.type === "stroke") return { type: "stroke", color: item.color || "#111827", width: Math.min(6, Number(item.width) || 2), points: (item.points || []).filter(Boolean).filter((_, i, arr) => i === 0 || i === arr.length - 1 || i % Math.max(1, Math.ceil(arr.length / 14)) === 0).slice(0, 18) };
    if (item.type === "line") return { type:"line", color:item.color||"#111827", width:Math.min(6,Number(item.width)||2), x1:item.x1,y1:item.y1,x2:item.x2,y2:item.y2 };
    if (["rect","circle","image"].includes(item.type)) return { type:item.type, color:item.color||"#111827", x:item.x,y:item.y,w:item.w,h:item.h };
    if (item.type === "text") return { type:"text", color:item.color||"#111827", x:item.x,y:item.y,fontSize:Math.min(32,Number(item.fontSize)||20), text:String(item.text||"").slice(0,60) };
    return null;
  }).filter(Boolean);
}

function allBoards(sort = 'updated', account = null) {
  const list = fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith(".json")).map(f => {
    const id = path.basename(f, ".json");
    const b = loadBoard(id);
    return { id: b.id, name: b.name || b.id, members: getParticipants(id).size, updatedAt: b.updatedAt || 0, createdAt: b.createdAt || b.updatedAt || 0, background: b.background || { ...DEFAULT_BACKGROUND }, createdBy: b.createdBy || null, accessMode: normalizeBoardAccess(b.access).mode, folderId: b.folderId || null, preview: compactBoardPreview(b, account ? computeScope(b, account.id, account.role === "admin") : null) };
  }).filter(item => {
    if (!account) return true;
    const b = loadBoard(item.id);
    return canAccountAccessBoard(account, b);
  });
  return list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt - a.updatedAt));
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", chunk => {
      s += chunk;
      if (s.length > 2_000_000) { reject(new Error("Payload zu groß")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { reject(new Error("Ungültiges JSON")); }
    });
    req.on("error", reject);
  });
}

function passwordPolicy(password) {
  const value = String(password || "");
  const checks = [
    [value.length >= PASSWORD_MIN, `Mindestens ${PASSWORD_MIN} Zeichen.`],
    [value.length <= 200, "Maximal 200 Zeichen."],
  ];
  return checks.filter(([ok]) => !ok).map(([, message]) => message);
}
function validUsername(username) { return /^[a-zA-Z0-9_.-]{3,24}$/.test(username); }
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}
function verifyPassword(password, salt, passwordHash) {
  try {
    const expected = Buffer.from(passwordHash, "hex");
    const actual = Buffer.from(hashPassword(password, salt), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function secureTempPassword() {
  return String(crypto.randomInt(100000, 1000000));
}
function newAccountId() { return crypto.randomUUID(); }
function newSessionToken() { return crypto.randomBytes(32).toString("base64url"); }
function accountPublic(account) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    avatarUrl: account.avatarPath ? `/uploads/${account.avatarPath}` : null,
    role: account.role,
    mustChangePassword: Boolean(account.mustChangePassword),
    locked: Boolean(account.locked),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt || account.createdAt,
  };
}
function createAccount({ username, password, role = "user", mustChangePassword = false }) {
  const normalized = cleanText(username).toLowerCase();
  if (!validUsername(normalized)) throw new Error("Benutzername: 3–24 Zeichen, Buchstaben/Zahlen/._-");
  if (passwordPolicy(password).length) throw new Error(passwordPolicy(password).join(" "));
  if ([...accounts.values()].some(a => a.username === normalized)) throw new Error("Benutzername ist bereits vergeben.");
  if (role === "admin" && [...accounts.values()].some(a => a.role === "admin")) throw new Error("Es gibt bereits einen Administrator.");
  const salt = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const account = {
    id: newAccountId(),
    username: normalized,
    salt,
    passwordHash: hashPassword(password, salt),
    role: role === "admin" ? "admin" : "user",
    mustChangePassword: Boolean(mustChangePassword),
    failedLoginAttempts: 0,
    locked: false,
    createdAt: now,
    updatedAt: now,
    displayName: normalized,
    avatarPath: null,
  };
  accounts.set(account.id, account);
  persistAccounts();
  return account;
}
function getAdmin() { return [...accounts.values()].find(a => a.role === "admin") || null; }
function getToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
function getAccountByToken(token) {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  const account = accounts.get(entry.accountId) || null;
  if (!account || account.locked) return null;
  return account;
}
function accountFromRequest(req) { return getAccountByToken(getToken(req)); }
function requireAccount(req, res, { allowPendingPassword = true } = {}) {
  const account = accountFromRequest(req);
  if (!account) { json(res, 401, { error: "Nicht angemeldet." }); return null; }
  if (!allowPendingPassword && account.mustChangePassword) { json(res, 403, { error: "Passwort muss vor der Nutzung geändert werden.", code: "PASSWORD_CHANGE_REQUIRED" }); return null; }
  return account;
}
function requireAdmin(req, res) {
  const account = requireAccount(req, res, { allowPendingPassword: false });
  if (!account) return null;
  if (account.role !== "admin") { json(res, 403, { error: "Nur der Administrator darf diese Aktion ausführen." }); return null; }
  return account;
}
function createSession(accountId) {
  const token = newSessionToken();
  sessions.set(token, { accountId, createdAt: Date.now() });
  return token;
}
function invalidateAccountSessions(accountId) {
  for (const [token, entry] of sessions) if (entry.accountId === accountId) sessions.delete(token);
}
function getParticipants(boardId) {
  const id = safeId(boardId);
  if (!participants.has(id)) participants.set(id, new Map());
  return participants.get(id);
}
function getLiveStrokes(boardId) {
  const id = safeId(boardId);
  if (!liveStrokes.has(id)) liveStrokes.set(id, new Map());
  return liveStrokes.get(id);
}
function publicParticipants(boardId) {
  const b = loadBoard(boardId);
  return [...getParticipants(boardId).values()].map(p => {
    const account = p.accountId ? accounts.get(p.accountId) : null;
    const readOnly = p.kind === "guest" ? p.guestMode === "view-only" : Boolean(b.permissions[p.participantId]?.readOnly);
    return {
      userId: p.participantId,
      username: p.username || (p.kind === "guest" ? "Gast" : account?.username || "Benutzer"),
      displayName: p.displayName || account?.displayName || p.username || "Gast",
      shortId: String(p.participantId).slice(-6),
      isHost: Boolean(account?.role === "admin"),
      readOnly,
      devices: p.sockets.size,
      kind: p.kind || "account",
      guestMode: p.guestMode || null,
    };
  });
}
function broadcastParticipants(boardId) {
  const id = safeId(boardId);
  io.to(id).emit("room-users", { hostUserId: loadBoard(id).hostUserId || null, participants: publicParticipants(id) });
}
function currentAccount(socket) { return socket.data.accountId ? accounts.get(socket.data.accountId) || null : null; }
function currentGuest(socket) { return socket.data.kind === "guest" ? getGuestSession(socket.data.guestToken) : null; }
function currentParticipant(socket) {
  const id = safeId(socket.data.boardId);
  const participantId = socket.data.participantId;
  return id && participantId ? getParticipants(id).get(participantId) || null : null;
}
function isHost(socket) { return Boolean(currentAccount(socket)?.role === "admin"); }
function canEdit(socket) {
  const account = currentAccount(socket);
  const guest = currentGuest(socket);
  const participant = currentParticipant(socket);
  if (!participant) return false;
  if (account) {
    if (account.mustChangePassword || account.locked) return false;
    const b = loadBoard(socket.data.boardId);
    return b.hostUserId === account.id || !b.permissions[account.id]?.readOnly;
  }
  return Boolean(guest && guestCanEdit(guest));
}
function getRoomState(socket, boardId) {
  const b = loadBoard(boardId);
  const account = currentAccount(socket);
  const guest = currentGuest(socket);
  const scope = socketScope(socket, b), admin = Boolean(account?.role === "admin");
  socket.data.zoneSig = zoneSignature(b, scope, admin);
  const readOnly = guest ? guest.mode === "view-only" : Boolean(account && b.permissions[account.id]?.readOnly);
  return {
    strokes: filterStrokesFor(scope, b.strokes || []),
    background: b.background || { ...DEFAULT_BACKGROUND },
    hostUserId: b.hostUserId || null,
    permissions: { readOnly, isHost: admin, guestMode: guest?.mode || null },
    boardSettings: normalizeBoardSettings(b.settings),
    participants: publicParticipants(boardId),
    files: scope ? [] : Array.isArray(b.files) ? b.files.map(f => ({ ...f, url: `/uploads/${f.path}` })) : [],
    timer: timerPayload(boardId),
    viewSync: normalizeViewSync(b.viewSync),
    zones: zonesFor(b, scope, admin),
    zoneScope: scopePublic(scope),
  };
}
function normalizeStroke(stroke) {
  if (!stroke || typeof stroke !== "object" || !stroke._id) return null;
  if (stroke.type === "stroke" && !Array.isArray(stroke.points)) return null;
  const normalized = { ...stroke, _id: cleanText(stroke._id), type: cleanText(stroke.type) };
  if (normalized.type === "text") {
    const text = String(normalized.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, 5000);
    if (!text.trim()) return null;
    normalized.text = text;
    normalized.fontSize = Math.max(12, Math.min(96, Number(normalized.fontSize || (normalized.width ? normalized.width * 6 : 28)) || 28));
    normalized.x = Number.isFinite(Number(normalized.x)) ? Number(normalized.x) : 0;
    normalized.y = Number.isFinite(Number(normalized.y)) ? Number(normalized.y) : 0;
  } else if (normalized.type === "image") {
    const src = String(normalized.src || "");
    if (!src.startsWith("/uploads/board-files/")) return null;
    normalized.src = src.slice(0, 300);
    normalized.x = Number.isFinite(Number(normalized.x)) ? Number(normalized.x) : 0;
    normalized.y = Number.isFinite(Number(normalized.y)) ? Number(normalized.y) : 0;
    normalized.w = Math.max(1, Math.min(10000, Number(normalized.w) || 400));
    normalized.h = Math.max(1, Math.min(10000, Number(normalized.h) || 300));
    normalized.rotation = Math.max(-Math.PI * 4, Math.min(Math.PI * 4, Number(normalized.rotation) || 0));
    normalized.x = Number.isFinite(Number(normalized.x)) ? Number(normalized.x) : 0;
    normalized.y = Number.isFinite(Number(normalized.y)) ? Number(normalized.y) : 0;
    normalized.w = Math.max(1, Math.min(4000, Number(normalized.w) || 400));
    normalized.h = Math.max(1, Math.min(4000, Number(normalized.h) || 300));
  }
  return normalized;
}
function disconnectSocketFromBoard(socket) {
  const id = safeId(socket.data.boardId);
  const participantId = socket.data.participantId;
  if (!id || !participantId) return;
  const room = participants.get(id);
  const participant = room?.get(participantId);
  participant?.sockets.delete(socket.id);
  if (participant && participant.sockets.size === 0) room.delete(participantId);
  const live = liveStrokes.get(id);
  if (live) {
    for (const [strokeId, ownerSocketId] of live.entries()) {
      if (ownerSocketId === socket.id) { live.delete(strokeId); socket.to(id).emit("stroke-live-cancel", { _id: strokeId }); }
    }
  }
  socket.leave(id); socket.data.boardId = null; socket.data.participantId = null;
  if (room && room.size === 0) { participants.delete(id); liveStrokes.delete(id); }
  broadcastParticipants(id);
}

function adminListUsers() {
  return [...accounts.values()]
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(a => ({ id: a.id, username: a.username, displayName: a.displayName || a.username, avatarUrl: a.avatarPath ? `/uploads/${a.avatarPath}` : null, updatedAt: a.updatedAt || a.createdAt, role: a.role, locked: Boolean(a.locked), mustChangePassword: Boolean(a.mustChangePassword), failedLoginAttempts: Number(a.failedLoginAttempts || 0), createdAt: a.createdAt }));
}
function createUserWithTemp(username) {
  const tempPassword = secureTempPassword();
  const account = createAccount({ username, password: tempPassword, role: "user", mustChangePassword: true });
  return { account, tempPassword };
}

async function cliPrompt(label, { hidden = false } = {}) {
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const value = await new Promise(resolve => rl.question(label, resolve));
    rl.close();
    return value;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  return await new Promise(resolve => {
    let value = "";
    stdout.write(label);

    const finish = () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      resolve(value);
    };

    const onData = chunk => {
      const str = String(chunk);
      for (const char of str) {
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0003") {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdout.write("\nAbgebrochen.\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (char.charCodeAt(0) >= 32) {
          value += char;
          stdout.write("#");
        }
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
async function cliMain(argv) {
  const command = argv[2] || "";
  try {
    if (command === "init-admin") {
      if (getAdmin()) throw new Error("Es gibt bereits einen Administrator.");
      const username = argv[3] || await cliPrompt("Admin-Benutzername: ");
      const password = await cliPrompt("Admin-Passwort (mind. 4 Zeichen): ", { hidden: true });
      const problems = passwordPolicy(password);
      if (problems.length) throw new Error(problems.join(" "));
      const admin = createAccount({ username, password, role: "admin", mustChangePassword: false });
      audit("admin_created", { accountId: admin.id, username: admin.username });
      console.log(`Administrator erstellt: ${admin.username}`);
      return true;
    }
    if (command === "create-user") {
      if (!getAdmin()) throw new Error("Zuerst muss ein Administrator mit 'init-admin' erstellt werden.");
      const username = argv[3] || await cliPrompt("Benutzername: ");
      const result = createUserWithTemp(username);
      audit("user_created_cli", { accountId: result.account.id, username: result.account.username, by: "cli" });
      console.log(`Benutzer erstellt: ${result.account.username}`);
      console.log(`Temporäres Passwort (nur jetzt sichtbar): ${result.tempPassword}`);
      return true;
    }
    if (command === "reset-password") {
      const username = cleanText(argv[3]).toLowerCase();
      const account = [...accounts.values()].find(a => a.username === username);
      if (!account || account.role === "admin") throw new Error("Benutzer nicht gefunden oder Administrator darf hier nicht zurückgesetzt werden.");
      const tempPassword = secureTempPassword();
      const salt = crypto.randomBytes(16).toString("hex");
      account.salt = salt; account.passwordHash = hashPassword(tempPassword, salt); account.mustChangePassword = true; account.failedLoginAttempts = 0; account.locked = false; account.updatedAt = Date.now();
      invalidateAccountSessions(account.id); persistAccounts();
      audit("password_reset_cli", { accountId: account.id, username: account.username, by: "cli" });
      console.log(`Temporäres Passwort (nur jetzt sichtbar): ${tempPassword}`);
      return true;
    }
    if (command === "unlock-user") {
      const username = cleanText(argv[3]).toLowerCase();
      const account = [...accounts.values()].find(a => a.username === username && a.role === "user");
      if (!account) throw new Error("Benutzer nicht gefunden.");
      account.locked = false; account.failedLoginAttempts = 0; account.updatedAt = Date.now(); persistAccounts();
      audit("user_unlocked_cli", { accountId: account.id, username: account.username, by: "cli" });
      console.log(`Benutzer entsperrt: ${account.username}`);
      return true;
    }
    if (command === "list-users") {
      console.table(adminListUsers());
      return true;
    }
    if (["start", "serve", ""].includes(command)) return false;
    console.log("Befehle: init-admin, create-user, reset-password <username>, unlock-user <username>, list-users");
  } catch (e) {
    console.error(`Fehler: ${e.message}`);
  }
  return true;
}


const uploadApp = express();
uploadApp.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Guest-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
uploadApp.use("/uploads", express.static(UPLOADS_DIR, {
  maxAge: "1h",
  index: false,
  setHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

function tokenFromHeader(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
function expressPrincipal(req) {
  const account = getAccountByToken(tokenFromHeader(req));
  if (account && !account.mustChangePassword) return { kind: "account", account };
  const guest = getGuestSession(String(req.headers["x-guest-token"] || ""));
  if (guest) return { kind: "guest", guest };
  return null;
}
function uploadStorage(folder) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, folder),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 10);
      cb(null, `${crypto.randomBytes(18).toString("hex")}${ext}`);
    }
  });
}
function imageFilter(_req, file, cb) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  cb(null, allowed.has(String(file.mimetype || "").toLowerCase()));
}
function documentFilter(_req, file, cb) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]);
  cb(null, allowed.has(String(file.mimetype || "").toLowerCase()));
}
const avatarUpload = multer({ storage: uploadStorage(AVATARS_DIR), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: imageFilter });
const boardFileUpload = multer({ storage: uploadStorage(BOARD_FILES_DIR), limits: { fileSize: 20 * 1024 * 1024, files: 1 }, fileFilter: documentFilter });

uploadApp.post("/api/profile/avatar", avatarUpload.single("file"), (req, res) => {
  const principal = expressPrincipal(req);
  if (!principal || principal.kind !== "account") return res.status(401).json({ error: "Nicht angemeldet." });
  const account = principal.account;
  if (!req.file) return res.status(400).json({ error: "Keine gültige Bilddatei." });
  if (account.avatarPath) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, account.avatarPath)); } catch {}
  }
  account.avatarPath = path.join("avatars", req.file.filename).replace(/\\/g, "/");
  account.updatedAt = Date.now();
  persistAccounts();
  audit("profile_avatar_updated", { accountId: account.id, username: account.username });
  return res.status(201).json({ account: accountPublic(account) });
});

uploadApp.post("/api/boards/:boardId/files", boardFileUpload.single("file"), (req, res) => {
  const principal = expressPrincipal(req);
  if (!principal) return res.status(401).json({ error: "Nicht angemeldet." });
  const boardId = safeId(req.params.boardId);
  const board = loadBoard(boardId);
  if (!board.createdBy && board.hostUserId) board.createdBy = board.hostUserId;
  if (!req.file) return res.status(400).json({ error: "Keine erlaubte Datei." });
  const canUpload = principal.kind === "guest" ? guestCanEdit(principal.guest) : (board.permissions[principal.account.id]?.readOnly ? false : true);
  if (!canUpload) return res.status(403).json({ error: "Nur Lesezugriff." });
  const upScope = computeScope(board, scopeKeyFor(principal.account, principal.guest), principal.account?.role === "admin");
  if (upScope && !upScope.writable.length) return res.status(403).json({ error: "In deinem Bereich darfst du nichts hochladen." });
  const ownerId = principal.kind === "guest" ? principal.guest.guestId : principal.account.id;
  const file = {
    id: crypto.randomUUID(),
    boardId,
    originalName: cleanText(req.file.originalname, "datei"),
    path: path.join("board-files", req.file.filename).replace(/\\/g, "/"),
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: ownerId,
    uploadedAt: Date.now(),
  };
  board.files = Array.isArray(board.files) ? board.files : [];
  board.files.push(file);
  board.updatedAt = Date.now();
  persistBoard(boardId, board);
  audit("board_file_uploaded", { boardId, actor: principal.kind === "guest" ? principal.guest.guestId : principal.account.id, fileId: file.id });
  if (io) emitBoard(boardId, "file-added", sc => sc ? null : { file: { ...file, url: `/uploads/${file.path}` } });
  return res.status(201).json({ file: { ...file, url: `/uploads/${file.path}` } });
});

uploadApp.use((err, _req, res, _next) => {
  if (err) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "Datei ist zu groß." : "Datei konnte nicht verarbeitet werden.";
    return res.status(400).json({ error: message });
  }
});

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Guest-Token", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" }); return res.end(); }

  if (url.pathname === "/api/guest/resolve" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const code = String(body.code || "").trim();
      const inviteToken = String(body.token || "").trim();
      const displayName = cleanText(body.displayName).slice(0, 32);
      if (!displayName || displayName.length < 2) return json(res, 400, { error: "Bitte zuerst einen Namen angeben." });

      let found = null;
      let boardId = null;
      if (code) {
        if (!/^\d{6}$/.test(code)) return json(res, 400, { error: "Gast-Code muss genau 6 Ziffern haben." });
        const result = findGuestInviteByCode(code);
        if (result) { found = result.invite; boardId = result.boardId; }
      } else if (inviteToken) {
        for (const file of fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith(".json"))) {
          const id = path.basename(file, ".json");
          const invite = findGuestInvite(id, inviteToken);
          if (invite) { found = invite; boardId = id; break; }
        }
      }
      if (!found || !boardId) return json(res, 404, { error: "Gast-Code ist abgelaufen oder ungültig." });
      const b = loadBoard(boardId);
      const guestId = newGuestId();
      const sessionToken = newSessionToken();
      guestSessions.set(sessionToken, { guestId, boardId, mode: found.mode, displayName, inviteId: found.id, createdAt: Date.now() });
      audit("guest_joined", { boardId, guestId, mode: found.mode, inviteId: found.id, via: code ? "code" : "link" });
      return json(res, 200, { sessionToken, guest: { id: guestId, displayName, mode: found.mode }, board: { id: b.id, name: b.name, background: b.background || { ...DEFAULT_BACKGROUND } } });
    } catch (e) { return json(res, 400, { error: e.message || "Gastzugang konnte nicht erstellt werden." }); }
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const username = cleanText(body.username).toLowerCase();
      const password = String(body.password || "");
      const account = [...accounts.values()].find(a => a.username === username);
      if (!account) { audit("login_failed", { username, reason: "unknown_user" }); return json(res, 401, { error: "Benutzername oder Passwort ist falsch." }); }
      if (account.locked) { audit("login_blocked", { accountId: account.id, username: account.username, reason: "locked" }); return json(res, 423, { error: "Konto ist gesperrt. Der Administrator muss es im Terminal entsperren.", code: "ACCOUNT_LOCKED" }); }
      if (!verifyPassword(password, account.salt, account.passwordHash)) {
        account.failedLoginAttempts = Number(account.failedLoginAttempts || 0) + 1;
        if (account.failedLoginAttempts >= MAX_LOGIN_FAILURES) { account.locked = true; audit("account_locked", { accountId: account.id, username: account.username, failedAttempts: account.failedLoginAttempts }); }
        else audit("login_failed", { accountId: account.id, username: account.username, failedAttempts: account.failedLoginAttempts });
        account.updatedAt = Date.now(); persistAccounts();
        return json(res, 401, { error: account.locked ? "Konto gesperrt. Bitte Admin kontaktieren." : "Benutzername oder Passwort ist falsch.", code: account.locked ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS" });
      }
      account.failedLoginAttempts = 0; account.updatedAt = Date.now(); persistAccounts();
      const token = createSession(account.id);
      audit("login_success", { accountId: account.id, username: account.username });
      return json(res, 200, { token, account: accountPublic(account) });
    } catch (e) { return json(res, 400, { error: e.message || "Ungültige Anfrage" }); }
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const account = requireAccount(req, res); if (!account) return;
    return json(res, 200, { account: accountPublic(account) });
  }

  if (url.pathname === "/api/profile" && req.method === "PATCH") {
    const account = requireAccount(req, res); if (!account) return;
    try {
      const body = await readBody(req);
      const displayName = cleanText(body.displayName, account.username).slice(0, 48);
      account.displayName = displayName || account.username;
      account.updatedAt = Date.now();
      persistAccounts();
      for (const [boardId, room] of participants) {
        const participant = room.get(account.id);
        if (!participant) continue;
        participant.displayName = account.displayName;
        broadcastParticipants(boardId);
      }
      audit("profile_updated", { accountId: account.id, username: account.username });
      return json(res, 200, { account: accountPublic(account) });
    } catch (e) { return json(res, 400, { error: e.message || "Profil konnte nicht gespeichert werden." }); }
  }

  if (url.pathname === "/api/auth/change-password" && req.method === "POST") {
    const account = requireAccount(req, res); if (!account) return;
    try {
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (!verifyPassword(currentPassword, account.salt, account.passwordHash)) return json(res, 400, { error: "Aktuelles Passwort ist falsch." });
      const problems = passwordPolicy(newPassword);
      if (problems.length) return json(res, 400, { error: problems.join(" ") });
      if (verifyPassword(newPassword, account.salt, account.passwordHash)) return json(res, 400, { error: "Das neue Passwort muss sich vom alten unterscheiden." });
      const salt = crypto.randomBytes(16).toString("hex");
      account.salt = salt; account.passwordHash = hashPassword(newPassword, salt); account.mustChangePassword = false; account.failedLoginAttempts = 0; account.locked = false; account.updatedAt = Date.now(); persistAccounts();
      invalidateAccountSessions(account.id);
      const token = createSession(account.id);
      audit("password_changed", { accountId: account.id, username: account.username, forced: Boolean(body.forced) });
      return json(res, 200, { token, account: accountPublic(account) });
    } catch (e) { return json(res, 400, { error: e.message || "Passwort konnte nicht geändert werden." }); }
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    sessions.delete(getToken(req));
    return json(res, 200, { ok: true });
  }

  const guestInviteMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/guest-invites(?:\/([^/]+))?$/);
  if (guestInviteMatch && req.method === "GET") {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = safeId(decodeURIComponent(guestInviteMatch[1]));
    const b = loadBoard(id);
    return json(res, 200, { invites: (b.guestInvites || []).filter(i => !i.revokedAt).map(i => guestInvitePublic(i, id)) });
  }
  if (guestInviteMatch && req.method === "POST") {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = safeId(decodeURIComponent(guestInviteMatch[1]));
    const b = loadBoard(id);
    const body = await readBody(req);
    const mode = body.mode === "view-only" ? "view-only" : "guest-edit";
    const duration = Math.max(5 * 60 * 1000, Math.min(GUEST_INVITE_TTL_MAX_MS, Number(body.expiresInMs) || 24 * 60 * 60 * 1000));
    const existingCodes = new Set();
    for (const boardFileName of fs.readdirSync(BOARDS_DIR).filter(f => f.endsWith(".json"))) {
      try {
        const other = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, boardFileName), "utf8"));
        for (const item of Array.isArray(other.guestInvites) ? other.guestInvites : []) {
          if (item.codeHash && !item.revokedAt && (!item.expiresAt || item.expiresAt > Date.now())) existingCodes.add(item.codeHash);
        }
      } catch {}
    }
    let code = "";
    let codeHash = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = newGuestCode();
      const candidateHash = hashGuestToken(candidate);
      if (!existingCodes.has(candidateHash)) { code = candidate; codeHash = candidateHash; break; }
    }
    if (!code) return json(res, 503, { error: "Zurzeit konnte kein freier Gast-Code erzeugt werden." });
    const invite = { id: crypto.randomUUID(), type: "code", codeHash, mode, createdAt: Date.now(), expiresAt: Date.now() + duration, revokedAt: null, createdBy: admin.id };
    b.guestInvites = Array.isArray(b.guestInvites) ? b.guestInvites : [];
    b.guestInvites.push(invite); b.updatedAt = Date.now(); persistBoard(id, b);
    audit("guest_invite_created", { boardId: id, inviteId: invite.id, mode, byAccountId: admin.id, via: "code" });
    return json(res, 201, { invite: guestInvitePublic(invite, id), code });
  }
  if (guestInviteMatch && req.method === "DELETE" && guestInviteMatch[2]) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = safeId(decodeURIComponent(guestInviteMatch[1])); const inviteId = safeId(decodeURIComponent(guestInviteMatch[2]));
    const b = loadBoard(id); const invite = (b.guestInvites || []).find(i => i.id === inviteId);
    if (!invite) return json(res, 404, { error: "Einladung nicht gefunden." });
    invite.revokedAt = Date.now(); b.updatedAt = Date.now(); persistBoard(id, b);
    for (const [token, session] of guestSessions) if (session.boardId === id && session.inviteId === inviteId) guestSessions.delete(token);
    audit("guest_invite_revoked", { boardId: id, inviteId, byAccountId: admin.id });
    return json(res, 200, { ok: true });
  }


  if (url.pathname === "/api/folders" && req.method === "GET") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    return json(res, 200, { folders: getFoldersForAccount(account) });
  }
  if (url.pathname === "/api/folders" && req.method === "POST") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    try {
      const body = await readBody(req);
      const name = cleanText(body.name).slice(0,64);
      if (!name) return json(res, 400, { error: "Ordnername fehlt." });
      const parentId = body.parentId ? safeId(body.parentId) : null;
      if (parentId) {
        const parent = folders.get(parentId);
        if (!canManageFolder(account, parent)) return json(res, 403, { error: "Überordner nicht erlaubt." });
      }
      const sameOwner = [...folders.values()].filter(f => f.ownerId === account.id);
      const order = sameOwner.length ? Math.max(...sameOwner.map(f => Number(f.order) || 0)) + 1 : 0;
      const folder = { id: safeId(`${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`), name, ownerId: account.id, parentId, order, createdAt: Date.now(), updatedAt: Date.now() };
      folders.set(folder.id, folder); persistFolders();
      audit("folder_created", { folderId: folder.id, ownerId: account.id, name });
      return json(res, 201, { folder: folderPublic(folder) });
    } catch (e) { return json(res, 400, { error: e.message || "Ordner konnte nicht erstellt werden." }); }
  }
  const folderMatch = url.pathname.match(/^\/api\/folders\/([^/]+)$/);
  if (folderMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    const id = safeId(decodeURIComponent(folderMatch[1]));
    const folder = folders.get(id);
    if (!folder) return json(res, 404, { error: "Ordner nicht gefunden." });
    if (!canManageFolder(account, folder)) return json(res, 403, { error: "Keine Berechtigung." });
    if (req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const name = body.name != null ? cleanText(body.name).slice(0,64) : folder.name;
        const parentId = body.parentId !== undefined ? (body.parentId ? safeId(body.parentId) : null) : folder.parentId;
        if (!name) return json(res, 400, { error: "Ordnername fehlt." });
        if (parentId) {
          if (parentId === folder.id) return json(res, 400, { error: "Ein Ordner kann nicht sich selbst enthalten." });
          const parent = folders.get(parentId);
          if (!canManageFolder(account, parent)) return json(res, 403, { error: "Überordner nicht erlaubt." });
        }
        folder.name = name; folder.parentId = parentId; folder.order = Number.isFinite(Number(body.order)) ? Number(body.order) : folder.order; folder.updatedAt = Date.now(); persistFolders();
        audit("folder_updated", { folderId: id, accountId: account.id });
        return json(res, 200, { folder: folderPublic(folder) });
      } catch (e) { return json(res, 400, { error: e.message || "Ordner konnte nicht geändert werden." }); }
    }
    folders.delete(id); persistFolders();
    for (const [boardId, board] of boards) {
      if (board.folderId === id && (board.createdBy === account.id || account.role === "admin")) {
        board.folderId = null; board.updatedAt = Date.now(); persistBoard(boardId, board);
      }
    }
    audit("folder_deleted", { folderId: id, accountId: account.id });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/boards" && req.method === "GET") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    return json(res, 200, allBoards(url.searchParams.get('sort') || 'updated', account));
  }

  if (url.pathname === "/api/boards" && req.method === "POST") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    try {
      const body = await readBody(req);
      const name = cleanText(body.name);
      if (!name) return json(res, 400, { error: "Name fehlt." });
      const folderId = body.folderId ? safeId(body.folderId) : null;
      if (!canUseFolder(account, folderId)) return json(res, 403, { error: "Dieser Ordner darf nicht verwendet werden." });
      const id = safeId(`${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`);
      const now = Date.now(); const b = { id, name, folderId, strokes: [], files: [], background: { ...DEFAULT_BACKGROUND }, updatedAt: now, createdAt: now, hostUserId: getAdmin()?.id || account.id, permissions: {}, settings: { allowUserDeleteOthers: false }, access: { mode: "all", userIds: [] }, createdBy: account.id, guestInvites: [], zones: [], timer: { status: "idle", durationMs: 5 * 60 * 1000, remainingMs: 5 * 60 * 1000, startedAt: null, endsAt: null, version: 0, updatedAt: now } };
      boards.set(id, b); persistBoard(id, b);
      audit("board_created", { boardId: id, boardName: name, accountId: account.id, username: account.username });
      return json(res, 201, { id, name, members: 0, background: b.background, folderId });
    } catch (e) { return json(res, 400, { error: e.message || "Ungültige Anfrage" }); }
  }

  const boardAccessMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/access$/);
  if (boardAccessMatch && (req.method === "GET" || req.method === "PATCH")) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = safeId(decodeURIComponent(boardAccessMatch[1]));
    const b = loadBoard(id);
    if (req.method === "GET") {
      return json(res, 200, { access: normalizeBoardAccess(b.access) });
    }
    try {
      const body = await readBody(req);
      const mode = body.mode === "selected" ? "selected" : "all";
      const requested = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
      const userIds = [...new Set(requested)].filter(id2 => { const a = accounts.get(id2); return a && a.role !== "admin"; });
      b.access = { mode, userIds }; b.updatedAt = Date.now(); persistBoard(id, b);
      audit("board_access_updated", { boardId: id, mode, userIds, byAccountId: admin.id, byUsername: admin.username });
      if (mode === "selected") {
        const room = getParticipants(id);
        for (const [participantId, participant] of room) {
          if (participant.kind !== "account" || participant.accountId === admin.id || canAccountAccessBoard(accounts.get(participant.accountId), b)) continue;
          for (const socketId of participant.sockets) {
            const targetSocket = io?.sockets?.sockets?.get(socketId);
            targetSocket?.emit("board-access-revoked", { boardId: id });
            targetSocket?.disconnect(true);
          }
        }
      }
      broadcastParticipants(id);
      return json(res, 200, { access: b.access });
    } catch (e) { return json(res, 400, { error: e.message || "Board-Zugriff konnte nicht gespeichert werden." }); }
  }

  if (url.pathname.startsWith("/api/boards/") && req.method === "GET") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    const id = safeId(url.pathname.split("/").pop());
    const b = loadBoard(id);
    if (!canAccountAccessBoard(account, b)) return json(res, 403, { error: "Du hast keinen Zugriff auf dieses Whiteboard.", code: "BOARD_ACCESS_DENIED" });
    const zs = computeScope(b, account.id, account.role === "admin");
    return json(res, 200, { id: b.id, name: b.name, strokes: filterStrokesFor(zs, b.strokes), files: zs ? [] : Array.isArray(b.files) ? b.files.map(f => ({ ...f, url: `/uploads/${f.path}` })) : [], background: b.background || { ...DEFAULT_BACKGROUND }, timer: timerPayload(id), hostUserId: b.hostUserId || null, createdBy: b.createdBy || null, createdAt: b.createdAt || null, updatedAt: b.updatedAt || null, folderId: b.folderId || null, access: normalizeBoardAccess(b.access), settings: normalizeBoardSettings(b.settings), viewSync: normalizeViewSync(b.viewSync) });
  }

  const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch && req.method === "PATCH") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    const id = safeId(decodeURIComponent(boardMatch[1]));
    const b = loadBoard(id);
    if (account.role !== "admin" && b.createdBy !== account.id) return json(res, 403, { error: "Keine Berechtigung." });
    try {
      const body = await readBody(req);
      if (body.name === undefined && body.folderId === undefined) return json(res, 400, { error: "Keine Änderung angegeben." });
      if (body.name !== undefined) {
        const name = cleanText(body.name);
        if (!name) return json(res, 400, { error: "Name fehlt." });
        b.name = name.slice(0, 80);
      }
      if (body.folderId !== undefined) {
        const folderId = body.folderId ? safeId(body.folderId) : null;
        if (!canUseFolder(account, folderId)) return json(res, 403, { error: "Dieser Ordner darf nicht verwendet werden." });
        b.folderId = folderId;
      }
      b.updatedAt = Date.now(); persistBoard(id, b);
      io?.to(id).emit("board-meta", { id, name: b.name, updatedAt: b.updatedAt });
      audit("board_renamed", { boardId: id, accountId: account.id, username: account.username });
      return json(res, 200, { id, name: b.name, folderId: b.folderId || null, updatedAt: b.updatedAt });
    } catch (e) { return json(res, 400, { error: e.message || "Board konnte nicht geändert werden." }); }
  }
  if (boardMatch && req.method === "DELETE") {
    const account = requireAccount(req, res, { allowPendingPassword: false }); if (!account) return;
    const id = safeId(decodeURIComponent(boardMatch[1]));
    const b = loadBoard(id);
    if (account.role !== "admin" && b.createdBy !== account.id) return json(res, 403, { error: "Keine Berechtigung." });
    boards.delete(id); participants.delete(id); liveStrokes.delete(id); stopTimerLoop(id);
    try { fs.unlinkSync(boardFile(id)); } catch {}
    io?.to(id).emit("board-deleted", { boardId: id });
    audit("board_deleted", { boardId: id, accountId: account.id, username: account.username });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/users" && req.method === "GET") {
    const admin = requireAdmin(req, res); if (!admin) return;
    return json(res, 200, { users: adminListUsers() });
  }

  if (url.pathname === "/api/admin/users" && req.method === "POST") {
    const admin = requireAdmin(req, res); if (!admin) return;
    try {
      const body = await readBody(req);
      const result = createUserWithTemp(body.username);
      audit("user_created_admin", { accountId: result.account.id, username: result.account.username, byAccountId: admin.id, byUsername: admin.username });
      return json(res, 201, { account: accountPublic(result.account), temporaryPassword: result.tempPassword });
    } catch (e) { return json(res, 400, { error: e.message || "Benutzer konnte nicht erstellt werden." }); }
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(reset-password|unlock|lock)$/);
  if (adminUserMatch && req.method === "POST") {
    const admin = requireAdmin(req, res); if (!admin) return;
    const userId = safeId(decodeURIComponent(adminUserMatch[1]));
    const action = adminUserMatch[2];
    const account = accounts.get(userId);
    if (!account || account.role === "admin") return json(res, 404, { error: "Benutzer nicht gefunden." });
    if (action === "unlock") {
      account.locked = false; account.failedLoginAttempts = 0; account.updatedAt = Date.now(); persistAccounts();
      audit("user_unlocked_admin", { accountId: account.id, username: account.username, byAccountId: admin.id, byUsername: admin.username });
      return json(res, 200, { account: accountPublic(account) });
    }
    if (action === "lock") {
      account.locked = true; account.failedLoginAttempts = Math.max(MAX_LOGIN_FAILURES, Number(account.failedLoginAttempts || 0)); account.updatedAt = Date.now(); invalidateAccountSessions(account.id); for (const targetSocket of io?.sockets?.sockets?.values?.() || []) { if (targetSocket.data?.accountId === account.id) { targetSocket.emit("kicked", { reason: "Dein Konto wurde vom Administrator gesperrt." }); targetSocket.disconnect(true); } } persistAccounts();
      audit("user_locked_admin", { accountId: account.id, username: account.username, byAccountId: admin.id, byUsername: admin.username });
      return json(res, 200, { account: accountPublic(account) });
    }
    const temporaryPassword = secureTempPassword();
    const salt = crypto.randomBytes(16).toString("hex");
    account.salt = salt; account.passwordHash = hashPassword(temporaryPassword, salt); account.mustChangePassword = true; account.failedLoginAttempts = 0; account.locked = false; account.updatedAt = Date.now();
    invalidateAccountSessions(account.id); persistAccounts();
    audit("password_reset_admin", { accountId: account.id, username: account.username, byAccountId: admin.id, byUsername: admin.username });
    return json(res, 200, { account: accountPublic(account), temporaryPassword });
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OnlineWhiteboard server");
}

const server = http.createServer((req, res) => { if (req.url.startsWith('/api/profile/avatar') || req.url.startsWith('/api/boards/') && req.url.includes('/files') || req.url.startsWith('/uploads/')) return uploadApp(req, res); requestHandler(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: "Interner Serverfehler." }); }); });
let io;
function createRealtimeServer() {
  ({ Server } = require("socket.io"));
  io = new Server(server, { cors: { origin: true, credentials: true }, transports: ["websocket", "polling"], connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true } });
  io.use((socket, next) => {
    const token = String(socket.handshake.auth?.token || "");
    const account = getAccountByToken(token);
    if (account) {
      if (account.mustChangePassword) return next(new Error("PASSWORD_CHANGE_REQUIRED"));
      socket.data.kind = "account"; socket.data.accountId = account.id; socket.data.username = account.username; socket.data.participantId = account.id;
      return next();
    }
    const guestToken = String(socket.handshake.auth?.guestToken || "");
    const guest = getGuestSession(guestToken);
    if (!guest) return next(new Error("AUTH_REQUIRED"));
    socket.data.kind = "guest"; socket.data.guestToken = guestToken; socket.data.guestId = guest.guestId; socket.data.username = guest.displayName; socket.data.participantId = guest.guestId;
    next();
  });
  registerSocketHandlers();
}

function registerSocketHandlers() {
  io.on("connection", socket => {
  socket.on("board:sync-request", () => {
    const id = safeId(socket.data.boardId);
    if (!id) return;
    socket.emit("board-state", getRoomState(socket, id));
  });
  socket.on("join-board", raw => {
    const boardId = safeId(typeof raw === "string" ? raw : raw?.boardId);
    const account = currentAccount(socket);
    const guest = currentGuest(socket);
    if (!boardId || (!account && !guest)) return;
    if (socket.data.boardId && socket.data.boardId !== boardId) disconnectSocketFromBoard(socket);
    if (guest && guest.boardId !== boardId) return;
    const b = loadBoard(boardId);
    if (account && !canAccountAccessBoard(account, b)) {
      socket.emit("board-access-denied", { boardId, message: "Du hast keinen Zugriff auf dieses Whiteboard." });
      return;
    }
    const admin = getAdmin();
    if (admin && b.hostUserId !== admin.id) { b.hostUserId = admin.id; persistBoard(boardId, b); }
    const participantId = account?.id || guest.guestId;
    const room = getParticipants(boardId);
    let participant = room.get(participantId);
    if (!participant) participant = { participantId, kind: account ? "account" : "guest", accountId: account?.id || null, guestMode: guest?.mode || null, inviteId: guest?.inviteId || null, username: account?.username || guest.displayName, displayName: account?.displayName || guest.displayName, sockets: new Set(), joinedAt: Date.now() };
    participant.username = account?.username || guest.displayName; participant.displayName = account?.displayName || guest.displayName; participant.guestMode = guest?.mode || participant.guestMode; participant.sockets.add(socket.id);
    room.set(participantId, participant);
    if (account && !b.permissions[account.id]) b.permissions[account.id] = { readOnly: false };
    socket.join(boardId); socket.data.boardId = boardId; socket.data.participantId = participantId;
    socket.emit("board-state", getRoomState(socket, boardId));
    socket.emit("timer:sync", timerPayload(boardId));
    if (getTimerState(boardId).status === "running") ensureTimerLoop(boardId);
    broadcastParticipants(boardId);
  });
  socket.on("leave-board", () => disconnectSocketFromBoard(socket));
  socket.on("cursor:move", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); if (!id) return;
    const x = Number(payload?.x), y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const cx = Math.max(-10000, Math.min(10000, x)), cy = Math.max(-10000, Math.min(10000, y));
    const out = { userId: socket.data.participantId, username: socket.data.username, x: cx, y: cy };
    emitBoard(id, "cursor:move", sc => scopeSeesPoint(sc, { x: cx, y: cy }) ? out : null, socket.id);
  });
  socket.on("stroke-live", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); let stroke = normalizeStroke(payload?.stroke);
    if (!id || !stroke || !canEdit(socket)) return;
    const own = socketScope(socket, loadBoard(id));
    if (own) { stroke = enforceWrite(own, stroke); if (!stroke) return; }
    getLiveStrokes(id).set(stroke._id, socket.id);
    emitBoard(id, "stroke-live", sc => scopeSees(sc, stroke) ? { stroke } : null, socket.id);
  });
  socket.on("stroke-live-cancel", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); const strokeId = cleanText(payload?._id); if (!id || !strokeId) return;
    const live = getLiveStrokes(id); if (live.get(strokeId) !== socket.id) return; live.delete(strokeId); socket.to(id).emit("stroke-live-cancel", { _id: strokeId });
  });
  socket.on("stroke-commit", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); let stroke = normalizeStroke(payload?.stroke); if (!id || !stroke || !canEdit(socket)) return;
    const b = loadBoard(id); const own = socketScope(socket, b);
    if (own) { const checked = enforceWrite(own, stroke); if (!checked) { socket.emit("zone-denied", { ids: [stroke._id] }); return; } stroke = checked; }
    stroke.ownerId = socket.data.participantId || null;
    getLiveStrokes(id).delete(stroke._id);
    if (!b.strokes.some(s => s?._id === stroke._id)) { b.strokes.push(stroke); b.updatedAt = Date.now(); persistBoard(id, b); }
    emitBoard(id, "stroke-commit", sc => scopeSees(sc, stroke) ? { stroke } : null);
  });
  socket.on("draw-batch", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); const list = Array.isArray(payload) ? payload : (payload?.strokes || []); if (!id || !list.length || !canEdit(socket)) return;
    let valid = list.map(normalizeStroke).filter(Boolean).map(item => ({ ...item, ownerId: socket.data.participantId || null })); if (!valid.length) return;
    const b = loadBoard(id); const own = socketScope(socket, b);
    if (own) { const denied = []; valid = valid.flatMap(it => { const r = enforceWrite(own, it); if (!r) denied.push(it._id); return r ? [r] : []; }); if (denied.length) socket.emit("zone-denied", { ids: denied }); if (!valid.length) return; }
    const seen = new Set(b.strokes.map(s => s?._id)); const fresh = valid.filter(s => !seen.has(s._id)); if (!fresh.length) return;
    b.strokes.push(...fresh); b.updatedAt = Date.now(); persistBoard(id, b);
    emitBoard(id, "draw-batch", sc => { const l = fresh.filter(it => scopeSees(sc, it)); return l.length ? l : null; });
  });
  function serverRotatePoint(point, center, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), dx = point.x - center.x, dy = point.y - center.y;
    return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
  }
  function serverRotateObject(item, angle, center) {
    if (!angle || !center) return item;
    if (item.type === "stroke") { item.points = (item.points || []).map(pt => serverRotatePoint(pt, center, angle)); return item; }
    if (item.type === "line") { const a=serverRotatePoint({x:item.x1,y:item.y1},center,angle), b=serverRotatePoint({x:item.x2,y:item.y2},center,angle); item.x1=a.x; item.y1=a.y; item.x2=b.x; item.y2=b.y; return item; }
    if (["rect","circle","image"].includes(item.type)) { const w=Number(item.w)||0,h=Number(item.h)||0,cx=(Number(item.x)||0)+w/2,cy=(Number(item.y)||0)+h/2,c=serverRotatePoint({x:cx,y:cy},center,angle); item.x=c.x-w/2; item.y=c.y-h/2; item.rotation = (Number(item.rotation)||0)+angle; return item; }
    if (item.type === "text") { const w=Math.max(30,Math.min(5000,String(item.text||"").length*10)),h=Math.max(30,Number(item.fontSize)||28); const cx=(Number(item.x)||0)+w/2,cy=(Number(item.y)||0)+h/2,c=serverRotatePoint({x:cx,y:cy},center,angle); item.x=c.x-w/2; item.y=c.y+h/2; item.rotation=(Number(item.rotation)||0)+angle; return item; }
    return item;
  }
  socket.on("transform-objects", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId);
    if (!id || !canEdit(socket)) return;
    let list = Array.isArray(payload?.transforms) ? payload.transforms : [];
    if (!list.length) return;
    const b = loadBoard(id); const own = socketScope(socket, b);
    if (own) { const byIdAll = new Map(b.strokes.map(s => [s?._id, s])); list = list.filter(t => { const it = byIdAll.get(cleanText(t?.id)); return it && scopeCanWrite(own, it); }); if (!list.length) return; }
    // Preview transforms are ephemeral. They are broadcast but never persisted, avoiding drift.
    if (payload?.preview) {
      const out = list.map(t => ({ ...t, state: t.state ? normalizeStroke({ ...t.state, _id: t.id }) : undefined }));
      const itemOf = new Map(b.strokes.map(s => [s?._id, s]));
      emitBoard(id, "objects-transformed", sc => { const l = sc && !sc.seeAll ? out.filter(t => { const it = itemOf.get(t.id); return it && scopeSees(sc, it); }) : out; return l.length ? { transforms: l } : null; }, socket.id);
      return;
    }
    const byId = new Map(list.map(t => [cleanText(t?.id), t]));
    const transformed=[]; const befores=new Map();
    for (const item of b.strokes) {
      const raw=byId.get(item?._id); if(!raw) continue;
      const snap = JSON.parse(JSON.stringify(item));
      if (own && !scopeCanWrite(own, snap)) continue;
      const rollback = () => { Object.keys(item).forEach(k => delete item[k]); Object.assign(item, snap); };
      if (raw.state && typeof raw.state === "object") {
        const next=normalizeStroke({ ...raw.state, _id:item._id, ownerId:item.ownerId });
        if (next && own && !scopeCanWrite(own, next)) continue;
        if (next) { Object.keys(item).forEach(k => delete item[k]); Object.assign(item,next); transformed.push({ id:item._id, state:item }); befores.set(item._id, snap); }
        continue;
      }
      const t={
        dx: Math.max(-50000, Math.min(50000, Number(raw?.dx) || 0)),
        dy: Math.max(-50000, Math.min(50000, Number(raw?.dy) || 0)),
        angle: Math.max(-Math.PI * 4, Math.min(Math.PI * 4, Number(raw?.angle) || 0)),
        sx: Math.max(0.01, Math.min(20, Number(raw?.sx) || 1)),
        sy: Math.max(0.01, Math.min(20, Number(raw?.sy) || 1)),
        anchor: raw?.anchor && Number.isFinite(Number(raw.anchor.x)) && Number.isFinite(Number(raw.anchor.y)) ? { x: Number(raw.anchor.x), y: Number(raw.anchor.y) } : null,
        center: raw?.center && Number.isFinite(Number(raw.center.x)) && Number.isFinite(Number(raw.center.y)) ? { x: Number(raw.center.x), y: Number(raw.center.y) } : null,
      };
      if (t.dx || t.dy) {
        if (item.type === "stroke") item.points=(item.points||[]).map(pt=>({x:pt.x+t.dx,y:pt.y+t.dy}));
        else if (item.type === "line") { item.x1+=t.dx; item.y1+=t.dy; item.x2+=t.dx; item.y2+=t.dy; }
        else if (["rect","circle","image","text"].includes(item.type)) { item.x=(Number(item.x)||0)+t.dx; item.y=(Number(item.y)||0)+t.dy; }
      }
      if (t.sx !== 1 || t.sy !== 1) {
        const a=t.anchor || {x:0,y:0};
        if (item.type === "stroke") item.points=(item.points||[]).map(pt=>({x:a.x+(pt.x-a.x)*t.sx,y:a.y+(pt.y-a.y)*t.sy}));
        else if (item.type === "line") { item.x1=a.x+(item.x1-a.x)*t.sx; item.y1=a.y+(item.y1-a.y)*t.sy; item.x2=a.x+(item.x2-a.x)*t.sx; item.y2=a.y+(item.y2-a.y)*t.sy; }
        else if (["rect","circle","image"].includes(item.type)) { item.x=a.x+((Number(item.x)||0)-a.x)*t.sx; item.y=a.y+((Number(item.y)||0)-a.y)*t.sy; item.w=Math.max(4,(Number(item.w)||4)*t.sx); item.h=Math.max(4,(Number(item.h)||4)*t.sy); }
        else if (item.type === "text") { item.x=a.x+((Number(item.x)||0)-a.x)*t.sx; item.y=a.y+((Number(item.y)||0)-a.y)*t.sy; item.maxWidth=Math.max(40,(Number(item.maxWidth)||TEXT_DEFAULT_WIDTH)*t.sx); item.fontSize=Math.max(12,Math.min(160,(Number(item.fontSize)||28)*Math.max(.1,(t.sx+t.sy)/2))); }
      }
      if (t.angle && t.center) serverRotateObject(item,t.angle,t.center);
      if (own && !scopeCanWrite(own, item)) { rollback(); continue; }
      transformed.push({ id:item._id, dx:t.dx, dy:t.dy, angle:t.angle, center:t.center, sx:t.sx, sy:t.sy, anchor:t.anchor }); befores.set(item._id, snap);
    }
    if (!transformed.length) return;
    b.updatedAt=Date.now(); persistBoard(id,b);
    const itemNow = new Map(b.strokes.map(s => [s?._id, s]));
    emitBoardMulti(id, sc => {
      if (!sc || sc.seeAll) return [["objects-transformed", { transforms: transformed }]];
      const tr = [], add = [], rem = [];
      for (const rec of transformed) {
        const before = befores.get(rec.id), after = itemNow.get(rec.id), vb = scopeSees(sc, before), va = scopeSees(sc, after);
        if (vb && va) tr.push(rec); else if (va) add.push(after); else if (vb) rem.push(rec.id);
      }
      return [...(tr.length ? [["objects-transformed", { transforms: tr }]] : []), ...(add.length ? [["draw-batch", add]] : []), ...(rem.length ? [["erase", { ids: rem }]] : [])];
    }, socket.id);
  });
  socket.on("erase", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); if (!id || !canEdit(socket)) return;
    const requested = new Set(Array.isArray(payload?.ids) ? payload.ids : []); if (!requested.size) return;
    const account = currentAccount(socket); const b = loadBoard(id); const own = socketScope(socket, b);
    const allowCrossDelete = Boolean(normalizeBoardSettings(b.settings).allowUserDeleteOthers);
    const ids = new Set(b.strokes.filter(s => requested.has(s._id) && (!own || scopeCanWrite(own, s)) && (account?.role === 'admin' || allowCrossDelete || !s.ownerId || s.ownerId === socket.data.participantId || b.hostUserId === account?.id)).map(s => s._id));
    if (!ids.size) return;
    b.strokes = b.strokes.filter(s => !ids.has(s._id)); b.updatedAt = Date.now(); persistBoard(id, b); io.to(id).emit("erase", { ids: [...ids] });
  });
  socket.on("set-delete-others", payload => {
    const id = safeId(socket.data.boardId); if (!id || !isHost(socket)) return;
    const b = loadBoard(id); b.settings = normalizeBoardSettings(b.settings);
    b.settings.allowUserDeleteOthers = Boolean(payload?.enabled);
    b.updatedAt = Date.now(); persistBoard(id, b);
    io.to(id).emit("board-settings", b.settings);
    audit("board_delete_permission_updated", { boardId: id, allowUserDeleteOthers: b.settings.allowUserDeleteOthers, byAccountId: currentAccount(socket)?.id || null });
  });
  socket.on("clear-board", raw => {
    const id = safeId(socket.data.boardId || (typeof raw === "string" ? raw : raw?.boardId)); if (!id || !canEdit(socket) || !isHost(socket)) return;
    const b = loadBoard(id); b.strokes = []; b.updatedAt = Date.now(); persistBoard(id, b); io.to(id).emit("clear-board");
  });
  socket.on("set-background", payload => {
    const id = safeId(socket.data.boardId || payload?.boardId); if (!id || !canEdit(socket)) return;
    if (socketScope(socket, loadBoard(id))) return;
    const raw = payload?.background ?? payload; const background = {
      color: typeof raw?.color === "string" ? raw.color.slice(0, 32) : DEFAULT_BACKGROUND.color,
      pattern: ["none", "grid", "dots", "lines"].includes(raw?.pattern) ? raw.pattern : "none",
      size: Math.max(8, Math.min(60, Number(raw?.size) || DEFAULT_BACKGROUND.size)),
    };
    const b = loadBoard(id); b.background = background; b.updatedAt = Date.now(); persistBoard(id, b); io.to(id).emit("set-background", background);
  });
  socket.on("set-readonly", payload => {
    const id = safeId(socket.data.boardId); const targetId = cleanText(payload?.userId); if (!id || !targetId || !isHost(socket)) return;
    const targetAccount = accounts.get(targetId); if (!targetAccount || targetAccount.role === "admin") return; const b = loadBoard(id); const target = getParticipants(id).get(targetId); if (!target) return;
    const readOnly = Boolean(payload?.readOnly); b.permissions[targetId] = { ...(b.permissions[targetId] || {}), readOnly }; b.updatedAt = Date.now(); persistBoard(id, b);
    for (const socketId of target.sockets) io.sockets.sockets.get(socketId)?.emit("permission-changed", { readOnly, isHost: false });
    broadcastParticipants(id);
  });
  socket.on("set-all-readonly", payload => {
    const id = safeId(socket.data.boardId); if (!id || !isHost(socket)) return; const b = loadBoard(id); const readOnly = Boolean(payload?.readOnly);
    for (const [accountId, p] of getParticipants(id)) {
      if (accounts.get(accountId)?.role === "admin") continue;
      b.permissions[accountId] = { ...(b.permissions[accountId] || {}), readOnly };
      for (const socketId of p.sockets) io.sockets.sockets.get(socketId)?.emit("permission-changed", { readOnly, isHost: false });
    }
    b.updatedAt = Date.now(); persistBoard(id, b); broadcastParticipants(id);
  });
  socket.on("kick-user", payload => {
    const id = safeId(socket.data.boardId); const targetId = cleanText(payload?.userId); if (!id || !targetId || !isHost(socket)) return;
    const targetAccount = accounts.get(targetId); if (!targetAccount || targetAccount.role === "admin") return; const b = loadBoard(id); const target = getParticipants(id).get(targetId); if (!target) return;
    for (const socketId of target.sockets) { const targetSocket = io.sockets.sockets.get(socketId); targetSocket?.emit("kicked", { reason: "Du wurdest vom Host entfernt." }); targetSocket?.disconnect(true); }
  });
  socket.on("view-sync-toggle", payload => {
    const id = safeId(socket.data.boardId); if (!id || !isHost(socket)) return;
    const b = loadBoard(id);
    const current = normalizeViewSync(b.viewSync);
    const enabled = Boolean(payload?.enabled);
    const zoom = Math.max(0.25, Math.min(5, Number(payload?.zoom) || current.zoom));
    const pan = { x: Math.max(-20000, Math.min(20000, Number(payload?.pan?.x) || 0)), y: Math.max(-20000, Math.min(20000, Number(payload?.pan?.y) || 0)) };
    const center = payload?.center && Number.isFinite(Number(payload.center.x)) && Number.isFinite(Number(payload.center.y))
      ? { x: Math.max(-100000, Math.min(100000, Number(payload.center.x))), y: Math.max(-100000, Math.min(100000, Number(payload.center.y))) }
      : current.center;
    b.viewSync = { enabled, zoom, pan, center, updatedAt: Date.now(), seq: current.seq + 1 };
    flushViewSyncPersistence(id, b);
    io.to(id).emit("view-sync-state", normalizeViewSync(b.viewSync));
    if (enabled) io.to(id).emit("host-view", normalizeViewSync(b.viewSync));
  });
  socket.on("host-view", payload => {
    const id = safeId(socket.data.boardId); if (!id || !isHost(socket)) return;
    const b = loadBoard(id); const viewSync = normalizeViewSync(b.viewSync);
    if (!viewSync.enabled) return;
    const zoom = Math.max(0.25, Math.min(5, Number(payload?.zoom) || viewSync.zoom));
    const pan = { x: Math.max(-20000, Math.min(20000, Number(payload?.pan?.x) || 0)), y: Math.max(-20000, Math.min(20000, Number(payload?.pan?.y) || 0)) };
    const center = payload?.center && Number.isFinite(Number(payload.center.x)) && Number.isFinite(Number(payload.center.y))
      ? { x: Math.max(-100000, Math.min(100000, Number(payload.center.x))), y: Math.max(-100000, Math.min(100000, Number(payload.center.y))) }
      : viewSync.center;
    b.viewSync = { enabled: true, zoom, pan, center, updatedAt: Date.now(), seq: viewSync.seq + 1 };
    persistViewSyncThrottled(id, b);
    socket.to(id).emit("host-view", normalizeViewSync(b.viewSync));
  });
  /* ── Bereiche: nur Admins ── */
  const zoneAdmin = () => { const id = safeId(socket.data.boardId); return id && isHost(socket) ? id : null; };
  socket.on("zone:candidates", () => { const id = zoneAdmin(); if (!id) return; socket.emit("zone-candidates", { candidates: zoneCandidates(loadBoard(id)) }); });
  socket.on("zone:create", payload => {
    const id = zoneAdmin(); if (!id) return; const b = loadBoard(id);
    if (b.zones.length >= MAX_ZONES) { socket.emit("admin-error", { message: `Maximal ${MAX_ZONES} Bereiche pro Board.` }); return; }
    const z = { id: crypto.randomUUID().slice(0, 8), name: cleanText(payload?.name, `Bereich ${b.zones.length + 1}`).slice(0, 40), color: validColor(payload?.color) || ZONE_COLORS[b.zones.length % ZONE_COLORS.length], ...cleanZoneRect(payload), locked: false, assignments: {}, createdAt: Date.now() };
    b.zones.push(z); b.updatedAt = Date.now(); persistBoard(id, b);
    audit("zone_created", { boardId: id, zoneId: z.id, byAccountId: currentAccount(socket)?.id || null });
    broadcastZones(id); socket.emit("zone-created", { id: z.id });
  });
  socket.on("zone:update", payload => {
    const id = zoneAdmin(); if (!id) return; const b = loadBoard(id); const z = b.zones.find(x => x.id === cleanText(payload?.id)); if (!z) return;
    const patch = payload?.patch || {};
    if (typeof patch.name === "string") z.name = cleanText(patch.name, z.name).slice(0, 40);
    if (validColor(patch.color)) z.color = validColor(patch.color);
    if (typeof patch.locked === "boolean") z.locked = patch.locked;
    if (["x", "y", "w", "h"].some(k => k in patch)) Object.assign(z, cleanZoneRect(patch, z));
    b.updatedAt = Date.now(); persistBoard(id, b); broadcastZones(id);
  });
  socket.on("zone:delete", payload => {
    const id = zoneAdmin(); if (!id) return; const b = loadBoard(id); const before = b.zones.length;
    b.zones = b.zones.filter(x => x.id !== cleanText(payload?.id)); if (b.zones.length === before) return;
    b.updatedAt = Date.now(); persistBoard(id, b); audit("zone_deleted", { boardId: id, zoneId: payload?.id }); broadcastZones(id);
  });
  socket.on("zone:assign", payload => {
    const id = zoneAdmin(); if (!id) return; const b = loadBoard(id); const z = b.zones.find(x => x.id === cleanText(payload?.id)); if (!z) return;
    const mode = ZONE_MODES.includes(payload?.mode) ? payload.mode : null;
    const keys = (Array.isArray(payload?.userIds) ? payload.userIds : [payload?.userId]).map(k => String(k || "")).filter(Boolean).slice(0, 200);
    const valid = new Set(zoneCandidates(b).map(c => c.key));
    for (const k of keys) { if (!valid.has(k)) continue; if (mode) z.assignments[k] = mode; else delete z.assignments[k]; }
    b.updatedAt = Date.now(); persistBoard(id, b); audit("zone_assigned", { boardId: id, zoneId: z.id, mode, count: keys.length }); broadcastZones(id);
  });
  socket.on("timer:sync", () => {
    const id = safeId(socket.data.boardId); if (!id) return;
    socket.emit("timer:sync", timerPayload(id));
  });
  socket.on("timer:start", payload => {
    const id = safeId(socket.data.boardId); if (!id || !timerControlAllowed(socket)) return;
    const b = loadBoard(id); const current = getTimerState(id);
    const requestedMs = Math.max(5_000, Math.min(24 * 60 * 60 * 1000, Number(payload?.durationMs) || current.remainingMs || current.durationMs || 5 * 60 * 1000));
    const now = Date.now();
    b.timer = { status: "running", durationMs: Math.max(current.durationMs || requestedMs, requestedMs), remainingMs: requestedMs, startedAt: now, endsAt: now + requestedMs, version: (current.version || 0) + 1, updatedAt: now };
    persistBoard(id, b); ensureTimerLoop(id); broadcastTimer(id, "timer:start");
  });
  socket.on("timer:pause", () => {
    const id = safeId(socket.data.boardId); if (!id || !timerControlAllowed(socket)) return;
    const b = loadBoard(id); const current = getTimerState(id);
    if (current.status !== "running") return;
    b.timer = { ...current, status: "paused", remainingMs: Math.max(0, current.endsAt - Date.now()), startedAt: null, endsAt: null, version: current.version + 1, updatedAt: Date.now() };
    persistBoard(id, b); stopTimerLoop(id); broadcastTimer(id, "timer:pause");
  });
  socket.on("timer:reset", payload => {
    const id = safeId(socket.data.boardId); if (!id || !timerControlAllowed(socket)) return;
    const b = loadBoard(id); const current = getTimerState(id);
    const durationMs = Math.max(5_000, Math.min(24 * 60 * 60 * 1000, Number(payload?.durationMs) || current.durationMs || 5 * 60 * 1000));
    b.timer = { status: "idle", durationMs, remainingMs: durationMs, startedAt: null, endsAt: null, version: current.version + 1, updatedAt: Date.now() };
    persistBoard(id, b); stopTimerLoop(id); broadcastTimer(id, "timer:reset");
  });
  socket.on("disconnect", () => disconnectSocketFromBoard(socket));
  });
}

async function start() {
  const handledCli = await cliMain(process.argv);
  if (handledCli) return;
  createRealtimeServer();
  server.listen(PORT, "0.0.0.0", () => console.log(`OnlineWhiteboard server listening on port ${PORT}`));
}
start();
