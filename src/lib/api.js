export const API = window.__WHITEBOARD_API__ || "";
export const TOKEN_KEY = "whiteboard-auth-token";
export const THEME_KEY = "whiteboard-theme";
export const GUEST_SESSION_KEY = "whiteboard-guest-session";

export function getSavedToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
export function saveToken(token) { try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {} }
export function readGuestSession() { try { return JSON.parse(sessionStorage.getItem(GUEST_SESSION_KEY) || "null"); } catch { return null; } }
export function saveGuestSession(value) { try { value ? sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(value)) : sessionStorage.removeItem(GUEST_SESSION_KEY); } catch {} }

export async function api(path, options = {}, token = "") {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try { response = await fetch(`${API}${path}`, { ...options, headers }); }
  catch { throw new Error("Server nicht erreichbar. Bitte Verbindung prüfen."); }
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) { const err = new Error(body?.error || `HTTP ${response.status}`); err.status = response.status; err.code = body?.code; throw err; }
  return body;
}

export async function upload(path, file, token = "", field = "file", guestToken = "") {
  const form = new FormData();
  form.append(field, file);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (guestToken) headers["X-Guest-Token"] = guestToken;
  let response;
  try { response = await fetch(`${API}${path}`, { method: "POST", headers, body: form }); }
  catch { throw new Error("Upload fehlgeschlagen – Server nicht erreichbar."); }
  let body = null; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

export function uid() { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; } }
export function structuredCloneSafe(value) { try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); } }
