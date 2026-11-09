import React, { useCallback, useEffect, useState } from "react";
import { socket } from "./lib/socket";
import { api, getSavedToken, saveToken, readGuestSession, saveGuestSession, THEME_KEY } from "./lib/api";
import { AuthShell, BrandMark, OtpInput } from "./components/Auth";
import { Spinner } from "./components/Loading";
import { Icon } from "./components/Icons";
import { ToastHost, toast } from "./components/Toast";
import Dashboard from "./components/Dashboard";
import BoardView from "./components/BoardView";

const GUEST_NAME_KEY = "whiteboard-guest-name";

function initialTheme() {
  try { const saved = localStorage.getItem(THEME_KEY); if (saved === "dark" || saved === "light") return saved; } catch {}
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function inviteFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search).get("guest");
    const h = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("guest");
    return q || h || "";
  } catch { return ""; }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [token, setToken] = useState(() => getSavedToken());
  const [account, setAccount] = useState(null);
  const [theme, setTheme] = useState(initialTheme);
  const [guestSession, setGuestSession] = useState(() => readGuestSession());
  const [inviteToken] = useState(inviteFromUrl);
  const [board, setBoard] = useState(() => readGuestSession()?.board || null);

  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [guestName, setGuestName] = useState(() => { try { return sessionStorage.getItem(GUEST_NAME_KEY) || ""; } catch { return ""; } });
  const [guestCode, setGuestCode] = useState("");
  const [guestError, setGuestError] = useState("");
  const [guestBusy, setGuestBusy] = useState(false);
  const [curPw, setCurPw] = useState(""); const [newPw, setNewPw] = useState(""); const [newPw2, setNewPw2] = useState("");
  const [changeError, setChangeError] = useState(""); const [changeBusy, setChangeBusy] = useState(false);

  /* Theme */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1020" : "#eef0fb");
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  /* Sitzung beim Start prüfen */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (inviteToken || guestSession) { setAuthReady(true); return; }
      const saved = getSavedToken();
      if (!saved) { setAuthReady(true); return; }
      try { const d = await api("/api/auth/me", {}, saved); if (!cancelled) { setToken(saved); setAccount(d.account); } }
      catch (e) { if (!cancelled && (e.status === 401 || e.status === 403)) { saveToken(""); setToken(""); } }
      finally { if (!cancelled) setAuthReady(true); }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line

  /* Socket-Verbindung */
  useEffect(() => {
    if (guestSession?.token) { socket.auth = { guestToken: guestSession.token }; if (!socket.connected) socket.connect(); return; }
    if (!token || !account || account.mustChangePassword) { socket.disconnect(); return; }
    socket.auth = { token };
    if (socket.connected) { socket.disconnect(); }
    socket.connect();
  }, [token, account?.id, account?.mustChangePassword, guestSession?.token]); // eslint-disable-line

  useEffect(() => {
    const onErr = err => {
      const m = err?.message;
      if (m === "PASSWORD_CHANGE_REQUIRED") setAccount(v => v ? { ...v, mustChangePassword: true } : v);
      else if (m === "AUTH_REQUIRED" || m === "UNAUTHORIZED") {
        if (readGuestSession()) { saveGuestSession(null); setGuestSession(null); setBoard(null); setGuestError("Der Gastzugang ist abgelaufen oder wurde widerrufen."); }
        else if (getSavedToken()) { saveToken(""); setToken(""); setAccount(null); setBoard(null); toast("Deine Sitzung ist abgelaufen. Bitte erneut anmelden.", "error"); }
      }
    };
    socket.on("connect_error", onErr);
    return () => socket.off("connect_error", onErr);
  }, []);

  const onSession = useCallback((nextToken, nextAccount) => { if (nextToken) { saveToken(nextToken); setToken(nextToken); } if (nextAccount) setAccount(nextAccount); }, []);

  async function submitLogin(e) {
    e.preventDefault(); setAuthError(""); setAuthBusy(true);
    try {
      const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: username.trim(), password }) });
      saveToken(d.token); setToken(d.token); setAccount(d.account); setPassword("");
    } catch (err) { setAuthError(err.message); } finally { setAuthBusy(false); }
  }
  async function joinAsGuest(e) {
    e?.preventDefault(); setGuestBusy(true); setGuestError("");
    try {
      const name = guestName.trim().slice(0, 32);
      const body = inviteToken ? { token: inviteToken, displayName: name } : { code: guestCode.trim(), displayName: name };
      const d = await api("/api/guest/resolve", { method: "POST", body: JSON.stringify(body) });
      const session = { token: d.sessionToken, guest: d.guest, board: d.board };
      saveGuestSession(session); try { sessionStorage.setItem(GUEST_NAME_KEY, d.guest.displayName); } catch {}
      setGuestSession(session); setBoard(d.board); setGuestCode("");
      if (inviteToken) window.history.replaceState({}, "", window.location.pathname);
    } catch (err) { setGuestError(err.message); } finally { setGuestBusy(false); }
  }
  function leaveGuest() { saveGuestSession(null); try { sessionStorage.removeItem(GUEST_NAME_KEY); } catch {} socket.disconnect(); window.location.href = window.location.pathname; }
  async function submitPasswordChange(e) {
    e.preventDefault(); setChangeError("");
    if (newPw !== newPw2) { setChangeError("Die neuen Passwörter stimmen nicht überein."); return; }
    setChangeBusy(true);
    try {
      const d = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: curPw, newPassword: newPw, forced: true }) }, token);
      saveToken(d.token); setToken(d.token); setAccount(d.account); setCurPw(""); setNewPw(""); setNewPw2("");
      toast("Passwort gespeichert. Willkommen!", "success", 2200);
    } catch (err) { setChangeError(err.message); } finally { setChangeBusy(false); }
  }
  async function logout() {
    const old = token; saveToken(""); socket.disconnect(); setToken(""); setAccount(null); setBoard(null);
    try { await api("/api/auth/logout", { method: "POST" }, old); } catch {}
  }
  const exitBoard = useCallback(message => {
    if (readGuestSession()) { if (message) { toast(message, "error", 3500); setTimeout(leaveGuest, 1400); } else leaveGuest(); return; }
    setBoard(null); if (message) toast(message, "error", 4200);
  }, []); // eslint-disable-line

  let screen;
  if (!authReady) {
    screen = <AuthShell loading><section className="authCard"><div className="authBrand"><BrandMark /><span>Collaborative Whiteboard</span></div><div className="authHeading"><h1>Whiteboard</h1><p>Verbindung wird hergestellt …</p></div><Spinner label="Laden …" /></section></AuthShell>;
  } else if (inviteToken && !guestSession) {
    screen = <AuthShell loading={guestBusy}><form className="authCard" onSubmit={joinAsGuest}>
      <div className="authBrand"><BrandMark><Icon name="share" size={20} /></BrandMark><span>Einladung</span></div>
      <div className="authHeading"><h1>Board beitreten</h1><p>Gib einen Namen ein, damit die anderen wissen, wer mitarbeitet.</p></div>
      <div className="authFormPro">
        <label className="floatingField"><input autoFocus value={guestName} maxLength={32} onChange={e => { setGuestName(e.target.value); setGuestError(""); }} placeholder=" " required /><span className="floatingLabel">Dein Name</span></label>
        {guestError && <div className="errorBox">{guestError}</div>}
        <button className="primary full proPrimary" disabled={guestBusy || guestName.trim().length < 2}>{guestBusy ? <Spinner label="Beitreten …" /> : "Board öffnen"}</button>
      </div></form></AuthShell>;
  } else if (!account && !guestSession) {
    const codeReady = guestCode.length === 6 && !guestError;
    screen = <AuthShell loading={authBusy || guestBusy}><section className="authCard">
      <div className="authBrand"><BrandMark /><span>Collaborative Whiteboard</span></div>
      <div className="authHeading"><h1>Willkommen zurück</h1><p>Melde dich an oder betrete ein freigegebenes Board als Gast.</p></div>
      <div className="authTabs" role="tablist" aria-label="Anmeldeart" data-active={mode}>
        <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setGuestError(""); }}>Anmelden</button>
        <button type="button" role="tab" aria-selected={mode === "guest"} className={mode === "guest" ? "active" : ""} onClick={() => { setMode("guest"); setAuthError(""); }}>Gastzugang</button>
        <i className="tabInk" />
      </div>
      <div className="authTabViewport"><div className="authTabContent" key={mode}>
        {mode === "login" ? <form className="authFormPro" onSubmit={submitLogin}>
          <label className="floatingField"><input autoFocus autoComplete="username" value={username} onChange={e => { setUsername(e.target.value); setAuthError(""); }} placeholder=" " required minLength={3} maxLength={64} /><span className="floatingLabel">Benutzername</span></label>
          <label className="floatingField"><input autoComplete="current-password" type="password" minLength={4} value={password} onChange={e => { setPassword(e.target.value); setAuthError(""); }} placeholder=" " required /><span className="floatingLabel">Passwort</span></label>
          <div className="authMetaRow"><button type="button" className="linkButton" onClick={() => setAuthError("Bitte den Administrator um einen Passwort-Reset bitten.")}>Passwort vergessen?</button></div>
          {authError && <div className="errorBox shake" key={authError}>{authError}</div>}
          <button className="primary full proPrimary" disabled={authBusy || !username.trim() || !password}>{authBusy ? <Spinner label="Anmelden …" /> : <>Anmelden <Icon name="arrow" size={18} /></>}</button>
        </form> : <form className="authFormPro" onSubmit={joinAsGuest}>
          <div className={`otpWrap ${guestError ? "shake" : ""} ${codeReady ? "valid" : ""}`} key={guestError || "ok"}>
            <div className="otpLabel"><span>Board-Code</span>{codeReady && <span className="otpValid"><Icon name="check" size={14} /> Vollständig</span>}</div>
            <OtpInput value={guestCode} onChange={v => { setGuestCode(v); setGuestError(""); }} disabled={guestBusy} />
          </div>
          <label className="floatingField"><input autoComplete="name" maxLength={32} value={guestName} onChange={e => { setGuestName(e.target.value); setGuestError(""); }} placeholder=" " required /><span className="floatingLabel">Dein Name</span></label>
          {guestError && <div className="errorBox">{guestError}</div>}
          <button className={`primary full proPrimary ${codeReady && guestName.trim().length >= 2 ? "readyPulse" : ""}`} disabled={guestBusy || guestCode.length !== 6 || guestName.trim().length < 2}>{guestBusy ? <Spinner label="Board öffnen …" /> : <>Beitreten <Icon name="arrow" size={18} /></>}</button>
        </form>}
      </div></div>
      <div className="authFooterHint"><Icon name="shield" size={14} /> Zugriff wird serverseitig geprüft</div>
    </section></AuthShell>;
  } else if (account?.mustChangePassword) {
    screen = <AuthShell loading={changeBusy}><form className="authCard" onSubmit={submitPasswordChange}>
      <div className="authBrand"><BrandMark><Icon name="key" size={20} /></BrandMark><span>Account-Sicherheit</span></div>
      <div className="authHeading"><h1>Passwort festlegen</h1><p>Dein Temporärcode gilt nur einmal. Wähle jetzt dein persönliches Passwort.</p></div>
      <div className="authFormPro">
        <label className="floatingField"><input autoFocus type="password" autoComplete="current-password" value={curPw} onChange={e => setCurPw(e.target.value)} placeholder=" " required /><span className="floatingLabel">Temporärcode</span></label>
        <label className="floatingField"><input type="password" autoComplete="new-password" minLength={4} value={newPw} onChange={e => setNewPw(e.target.value)} placeholder=" " required /><span className="floatingLabel">Neues Passwort</span></label>
        <label className="floatingField"><input type="password" autoComplete="new-password" minLength={4} value={newPw2} onChange={e => setNewPw2(e.target.value)} placeholder=" " required /><span className="floatingLabel">Passwort wiederholen</span></label>
        {changeError && <div className="errorBox">{changeError}</div>}
        <button className="primary full proPrimary" disabled={changeBusy}>{changeBusy ? <Spinner label="Speichern …" /> : "Passwort setzen"}</button>
        <button type="button" className="linkButton" onClick={logout}>Abbrechen und abmelden</button>
      </div></form></AuthShell>;
  } else if (!board) {
    screen = <Dashboard account={account} token={token} theme={theme} setTheme={setTheme} onOpenBoard={setBoard} onLogout={logout} onSession={onSession} />;
  } else {
    screen = <BoardView key={board.id} socket={socket} board={board} account={account} guest={guestSession} token={token} theme={theme} setTheme={setTheme} onExit={exitBoard} />;
  }
  return <>{screen}<ToastHost /></>;
}
