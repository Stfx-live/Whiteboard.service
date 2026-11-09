import React, { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { LoadingOverlay, SkeletonCard, Spinner } from "./Loading";
import { Icon, Avatar } from "./Icons";
import BoardThumbnail from "./BoardThumbnail";
import { AdminModal, BoardAccessModal, MoveBoardModal, ProfileModal } from "./Modals";
import { askConfirm, askPrompt, toast } from "./Toast";
import { API, api, upload } from "../lib/api";

const DISPLAY_NAME_MAX = 48;
const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Gute Nacht" : h < 11 ? "Guten Morgen" : h < 17 ? "Hallo" : h < 22 ? "Guten Abend" : "Gute Nacht"; };
const avatarUrl = a => a?.avatarUrl ? `${API}${a.avatarUrl}?v=${encodeURIComponent(a.updatedAt || "1")}` : null;
function timeAgo(ts) {
  const d = Date.now() - Number(ts || 0); if (!ts) return "—";
  const m = Math.floor(d / 60000);
  if (m < 1) return "gerade eben"; if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60); if (h < 24) return `vor ${h} Std.`;
  const days = Math.floor(h / 24); if (days < 7) return `vor ${days} Tag${days > 1 ? "en" : ""}`;
  return new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
}

export default function Dashboard({ account, token, theme, setTheme, onOpenBoard, onLogout, onSession }) {
  const isAdmin = account.role === "admin";
  const [cards, setCards] = useState([]);
  const [folders, setFolders] = useState([]);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [sortBy, setSortBy] = useState("updated");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(null); // { type: "card"|"folder"|"account", id }
  const [dragId, setDragId] = useState(null);
  const [dropFolder, setDropFolder] = useState(undefined);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [moveTarget, setMoveTarget] = useState(null);
  const [accessTarget, setAccessTarget] = useState(null);
  const [accessMode, setAccessMode] = useState("all");
  const [accessUserIds, setAccessUserIds] = useState([]);
  const [accessError, setAccessError] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminError, setAdminError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [reveal, setReveal] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pName, setPName] = useState("");
  const [pCur, setPCur] = useState(""); const [pNew, setPNew] = useState(""); const [pNew2, setPNew2] = useState("");
  const [pFile, setPFile] = useState(null); const [pError, setPError] = useState(""); const [pBusy, setPBusy] = useState(false);

  async function loadAll(showSpinner = false) {
    if (showSpinner) setLoading(true);
    try {
      const [b, f] = await Promise.all([api(`/api/boards?sort=${encodeURIComponent(sortBy)}`, {}, token), api("/api/folders", {}, token)]);
      setCards(Array.isArray(b) ? b : []); setFolders(f?.folders || []);
    } catch (e) { toast(e.message, "error"); } finally { setLoading(false); }
  }
  useEffect(() => { loadAll(true); }, [sortBy, token]);
  useEffect(() => { const f = () => loadAll(false); window.addEventListener("focus", f); return () => window.removeEventListener("focus", f); }, [sortBy, token]);
  useEffect(() => { const close = e => { if (!e.target.closest?.("[data-pop]")) setMenu(null); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter(b => (!activeFolderId || b.folderId === activeFolderId) && (!q || (b.name || "").toLowerCase().includes(q)));
  }, [cards, activeFolderId, search]);
  const activeFolder = folders.find(f => f.id === activeFolderId);
  const canManage = b => isAdmin || b.createdBy === account.id;

  async function createBoard(e) {
    e?.preventDefault(); const name = newName.trim(); if (!name) return;
    setBusy(true);
    try { const b = await api("/api/boards", { method: "POST", body: JSON.stringify({ name, folderId: activeFolderId }) }, token); setCards(v => [b, ...v]); setNewOpen(false); setNewName(""); onOpenBoard(b); }
    catch (e2) { toast(e2.message, "error"); } finally { setBusy(false); }
  }
  async function createFolder(e) {
    e?.preventDefault(); const name = folderName.trim(); if (!name) return;
    setBusy(true);
    try { const d = await api("/api/folders", { method: "POST", body: JSON.stringify({ name }) }, token); setFolders(v => [...v, d.folder]); setFolderName(""); setFolderOpen(false); setActiveFolderId(d.folder.id); }
    catch (e2) { toast(e2.message, "error"); } finally { setBusy(false); }
  }
  async function renameFolder(folder) {
    const name = await askPrompt({ title: "Ordner umbenennen", value: folder.name, maxLength: 64 }); if (!name || name === folder.name) return;
    try { const d = await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }, token); setFolders(v => v.map(f => f.id === folder.id ? d.folder : f)); } catch (e) { toast(e.message, "error"); }
  }
  async function deleteFolder(folder) {
    if (!await askConfirm({ title: `Ordner „${folder.name}“ löschen?`, message: "Die Boards bleiben erhalten und werden nach „Alle Boards“ verschoben.", confirmLabel: "Löschen", danger: true })) return;
    try { await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }, token); setFolders(v => v.filter(f => f.id !== folder.id)); setCards(v => v.map(c => c.folderId === folder.id ? { ...c, folderId: null } : c)); if (activeFolderId === folder.id) setActiveFolderId(null); }
    catch (e) { toast(e.message, "error"); }
  }
  async function moveBoard(boardId, folderId) {
    setMoveTarget(null);
    try { const d = await api(`/api/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", body: JSON.stringify({ folderId: folderId || null }) }, token); setCards(v => v.map(c => c.id === boardId ? { ...c, folderId: d.folderId || null, updatedAt: d.updatedAt } : c)); toast("Board verschoben", "success", 1500); }
    catch (e) { toast(e.message, "error"); } finally { setDragId(null); setDropFolder(undefined); }
  }
  async function renameBoard(b) {
    const name = await askPrompt({ title: "Board umbenennen", value: b.name, maxLength: 80 }); if (!name || name === b.name) return;
    try { const d = await api(`/api/boards/${encodeURIComponent(b.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }, token); setCards(v => v.map(c => c.id === b.id ? { ...c, name: d.name, updatedAt: d.updatedAt } : c)); } catch (e) { toast(e.message, "error"); }
  }
  async function deleteBoard(b) {
    if (!await askConfirm({ title: `„${b.name}“ löschen?`, message: "Das Board und alle Inhalte werden endgültig entfernt.", confirmLabel: "Löschen", danger: true })) return;
    try { await api(`/api/boards/${encodeURIComponent(b.id)}`, { method: "DELETE" }, token); setCards(v => v.filter(c => c.id !== b.id)); toast("Board gelöscht", "success", 1500); } catch (e) { toast(e.message, "error"); }
  }

  // Admin
  async function loadAdminUsers() { setAdminError(""); try { const d = await api("/api/admin/users", {}, token); setAdminUsers(d.users || []); } catch (e) { setAdminError(e.message); } }
  async function openAdmin() { setMenu(null); setAdminOpen(true); await loadAdminUsers(); }
  async function openAccess(b) {
    setMenu(null); setAccessTarget(b); setAccessError(""); setAccessBusy(true);
    try { const [a] = await Promise.all([api(`/api/boards/${encodeURIComponent(b.id)}/access`, {}, token), loadAdminUsers()]); setAccessMode(a.access?.mode === "selected" ? "selected" : "all"); setAccessUserIds(a.access?.userIds || []); }
    catch (e) { setAccessError(e.message); } finally { setAccessBusy(false); }
  }
  async function saveAccess() {
    setAccessBusy(true); setAccessError("");
    try { await api(`/api/boards/${encodeURIComponent(accessTarget.id)}/access`, { method: "PATCH", body: JSON.stringify({ mode: accessMode, userIds: accessUserIds }) }, token); setCards(v => v.map(c => c.id === accessTarget.id ? { ...c, accessMode } : c)); setAccessTarget(null); toast("Zugriff gespeichert", "success", 1500); }
    catch (e) { setAccessError(e.message); } finally { setAccessBusy(false); }
  }
  async function createUser(e) {
    e?.preventDefault(); if (!newUsername.trim()) return; setAdminBusy(true); setAdminError(""); setReveal(null);
    try { const d = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: newUsername.trim() }) }, token); setNewUsername(""); setReveal({ username: d.account.username, password: d.temporaryPassword }); await loadAdminUsers(); }
    catch (e2) { setAdminError(e2.message); } finally { setAdminBusy(false); }
  }
  async function resetUser(u) {
    if (!await askConfirm({ title: "Temporärcode zurücksetzen?", message: `Für ${u.username} wird ein neuer Temporärcode erzeugt. Das alte Passwort wird ungültig.`, confirmLabel: "Zurücksetzen", danger: true })) return;
    setAdminBusy(true); setAdminError(""); setReveal(null);
    try { const d = await api(`/api/admin/users/${encodeURIComponent(u.id)}/reset-password`, { method: "POST" }, token); setReveal({ username: d.account.username, password: d.temporaryPassword }); await loadAdminUsers(); }
    catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); }
  }
  async function unlockUser(u) { setAdminBusy(true); setAdminError(""); try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/unlock`, { method: "POST" }, token); await loadAdminUsers(); } catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); } }
  async function lockUser(u) {
    if (!await askConfirm({ title: `Konto ${u.username} sperren?`, message: "Der Benutzer wird sofort abgemeldet.", confirmLabel: "Sperren", danger: true })) return;
    setAdminBusy(true); setAdminError(""); try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/lock`, { method: "POST" }, token); await loadAdminUsers(); } catch (e) { setAdminError(e.message); } finally { setAdminBusy(false); }
  }

  // Profil
  async function saveProfile() {
    setPBusy(true); setPError("");
    try {
      if (pNew && pNew !== pNew2) throw new Error("Die neuen Passwörter stimmen nicht überein.");
      if (pNew && !pCur) throw new Error("Bitte das aktuelle Passwort angeben.");
      const prof = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: pName.trim().slice(0, DISPLAY_NAME_MAX) }) }, token);
      let next = prof.account, nextToken = token;
      if (pFile) { const up = await upload("/api/profile/avatar", pFile, token); next = up.account; setPFile(null); }
      if (pNew) { const ch = await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: pCur, newPassword: pNew }) }, token); nextToken = ch.token; next = ch.account; setPCur(""); setPNew(""); setPNew2(""); }
      onSession(nextToken, next); setProfileOpen(false); toast("Profil gespeichert", "success", 1600);
    } catch (e) { setPError(e.message); } finally { setPBusy(false); }
  }

  const folderCount = id => cards.filter(c => c.folderId === id).length;
  const dropProps = id => ({
    onDragOver: e => { if (dragId) { e.preventDefault(); setDropFolder(id); } },
    onDragLeave: () => setDropFolder(undefined),
    onDrop: e => { e.preventDefault(); if (dragId) moveBoard(dragId, id); },
  });

  return <div className="dashboard">
    <aside className="sidebar">
      <div className="sideBrand"><div className="brandMark">WB</div><div><b>Whiteboard</b><span>Workspace</span></div></div>
      <button className="primary newBoardBtn" onClick={() => setNewOpen(true)}><Icon name="plus" size={18} /> Neues Board</button>
      <nav className="folderNav">
        <div className="sideLabel"><span>Bibliothek</span></div>
        <button className={`folderItem ${activeFolderId === null ? "active" : ""} ${dropFolder === null ? "dropHover" : ""}`} onClick={() => setActiveFolderId(null)} {...dropProps(null)}><Icon name="home" size={18} /><span>Alle Boards</span><em>{cards.length}</em></button>
        <div className="sideLabel"><span>Ordner</span><button className="iconButton mini" onClick={() => setFolderOpen(true)} aria-label="Ordner erstellen" data-tip="Ordner erstellen"><Icon name="plus" size={15} /></button></div>
        <div className="folderScroll">
          {folders.map(f => <div className="folderRow" key={f.id} data-pop>
            <button className={`folderItem ${activeFolderId === f.id ? "active" : ""} ${dropFolder === f.id ? "dropHover" : ""}`} onClick={() => setActiveFolderId(f.id)} {...dropProps(f.id)}><Icon name="folder" size={18} /><span>{f.name}</span><em>{folderCount(f.id)}</em></button>
            <button className="folderMore iconButton mini" aria-label="Ordner-Optionen" onClick={() => setMenu(menu?.id === f.id ? null : { type: "folder", id: f.id })}><Icon name="more" size={16} /></button>
            {menu?.type === "folder" && menu.id === f.id && <div className="menuPop folderMenu"><button onClick={() => { setMenu(null); renameFolder(f); }}><Icon name="pencil" size={16} /> Umbenennen</button><button className="danger" onClick={() => { setMenu(null); deleteFolder(f); }}><Icon name="trash" size={16} /> Löschen</button></div>}
          </div>)}
          {folders.length === 0 && <p className="sideHint">Lege Ordner an und ziehe Boards hinein.</p>}
        </div>
      </nav>
      <div className="accountWrap" data-pop>
        {menu?.type === "account" && <div className="menuPop accountMenu">
          <div className="accountMenuHead"><b>{account.displayName || account.username}</b><span>@{account.username} · {isAdmin ? "Administrator" : "Benutzer"}</span></div>
          <button onClick={() => { setMenu(null); setPName(account.displayName || account.username); setPError(""); setProfileOpen(true); }}><Icon name="user" size={17} /> Profil</button>
          {isAdmin && <button onClick={openAdmin}><Icon name="shield" size={17} /> Benutzerverwaltung</button>}
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /> {theme === "dark" ? "Heller Modus" : "Dunkler Modus"}</button>
          <button className="danger" onClick={onLogout}><Icon name="logout" size={17} /> Abmelden</button>
        </div>}
        <button className="accountButton" onClick={() => setMenu(menu?.type === "account" ? null : { type: "account" })}><Avatar name={account.displayName || account.username} url={avatarUrl(account)} size={34} /><span><b>{account.displayName || account.username}</b><small>{isAdmin ? "Administrator" : "Benutzer"}</small></span><Icon name="chevronUp" size={16} /></button>
      </div>
    </aside>

    <main className="dashMain">
      <header className="dashHead">
        <div className="dashTitle"><p className="eyebrow">{greeting()}, {(account.displayName || account.username).split(" ")[0]} 👋</p><h1>{activeFolder ? activeFolder.name : "Alle Boards"}</h1></div>
        <div className="dashTools">
          <label className="searchBox"><Icon name="search" size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Boards durchsuchen …" />{search && <button className="iconButton mini" onClick={() => setSearch("")} aria-label="Suche leeren"><Icon name="close" size={14} /></button>}</label>
          <div className="segmented small"><button className={sortBy === "updated" ? "active" : ""} onClick={() => setSortBy("updated")}>Zuletzt</button><button className={sortBy === "name" ? "active" : ""} onClick={() => setSortBy("name")}>A–Z</button></div>
          <button className="iconButton" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} data-tip="Design wechseln"><Icon name={theme === "dark" ? "sun" : "moon"} size={19} /></button>
        </div>
      </header>

      {loading && cards.length === 0 ? <div className="cards">{[1, 2, 3, 4].map(i => <SkeletonCard key={i} />)}</div>
        : <div className="cards">
          <button className="boardCard newCard" onClick={() => setNewOpen(true)} style={{ "--i": 0 }}><span className="plusOrb"><Icon name="plus" size={26} /></span><b>Neues Board</b><span>Leere Fläche starten</span></button>
          {visible.map((b, i) => <article key={b.id} className={`boardCard ${dragId === b.id ? "dragging" : ""}`} style={{ "--i": i + 1 }} draggable onDragStart={e => { setDragId(b.id); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", b.id); } catch {} }} onDragEnd={() => { setDragId(null); setDropFolder(undefined); }} onClick={() => onOpenBoard(b)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") onOpenBoard(b); }}>
            <BoardThumbnail board={b} />
            <div className="cardBody">
              <div className="cardTitleLine"><b title={b.name}>{b.name}</b>{isAdmin && <span className={`accessBadge ${b.accessMode === "selected" ? "private" : ""}`}><Icon name={b.accessMode === "selected" ? "lock" : "users"} size={12} />{b.accessMode === "selected" ? "Privat" : "Geteilt"}</span>}</div>
              <span className="cardMeta">{b.members > 0 && <i className="onlineDot" />}{b.members > 0 ? `${b.members} online · ` : ""}{timeAgo(b.updatedAt)}</span>
            </div>
            {canManage(b) && <div className="cardMenuWrap" data-pop onClick={e => e.stopPropagation()}>
              <button className="iconButton cardMenuBtn" aria-label="Optionen" onClick={() => setMenu(menu?.id === b.id ? null : { type: "card", id: b.id })}><Icon name="more" size={18} /></button>
              {menu?.type === "card" && menu.id === b.id && <div className="menuPop cardMenu">
                <button onClick={() => { setMenu(null); renameBoard(b); }}><Icon name="pencil" size={16} /> Umbenennen</button>
                <button onClick={() => { setMenu(null); setMoveTarget(b); }}><Icon name="folder" size={16} /> Verschieben</button>
                {isAdmin && <button onClick={() => openAccess(b)}><Icon name="users" size={16} /> Zugriff verwalten</button>}
                <button className="danger" onClick={() => { setMenu(null); deleteBoard(b); }}><Icon name="trash" size={16} /> Löschen</button>
              </div>}
            </div>}
          </article>)}
          {visible.length === 0 && !loading && (search || activeFolderId) && <div className="emptyManager"><div className="emptyOrb"><Icon name="sparkle" size={30} /></div><h3>{search ? "Nichts gefunden" : "Noch kein Board hier"}</h3><p>{search ? `Kein Board passt zu „${search}“.` : "Erstelle ein Board oder ziehe eines aus „Alle Boards“ in diesen Ordner."}</p></div>}
        </div>}
    </main>

    <Modal open={newOpen} title="Neues Whiteboard" onClose={() => setNewOpen(false)} className="smallPanel">
      <form onSubmit={createBoard}><input autoFocus value={newName} maxLength={80} onChange={e => setNewName(e.target.value)} placeholder="Name des Boards" /><p className="muted">Ordner: {activeFolder ? activeFolder.name : "Alle Boards"}</p><div className="actions"><button className="primary" disabled={busy || !newName.trim()}>{busy ? <Spinner label="Erstellen…" /> : "Erstellen"}</button><button type="button" onClick={() => setNewOpen(false)}>Abbrechen</button></div></form>
    </Modal>
    <Modal open={folderOpen} title="Neuer Ordner" onClose={() => setFolderOpen(false)} className="smallPanel">
      <form onSubmit={createFolder}><input autoFocus value={folderName} maxLength={64} onChange={e => setFolderName(e.target.value)} placeholder="Ordnername" /><div className="actions"><button className="primary" disabled={busy || !folderName.trim()}>{busy ? <Spinner label="Erstellen…" /> : "Ordner erstellen"}</button><button type="button" onClick={() => setFolderOpen(false)}>Abbrechen</button></div></form>
    </Modal>
    {moveTarget && <MoveBoardModal board={moveTarget} folders={folders} onMove={moveBoard} onClose={() => setMoveTarget(null)} />}
    {accessTarget && <BoardAccessModal board={accessTarget} users={adminUsers.filter(u => u.role !== "admin")} mode={accessMode} setMode={setAccessMode} userIds={accessUserIds} setUserIds={setAccessUserIds} error={accessError} busy={accessBusy} onSave={saveAccess} onClose={() => setAccessTarget(null)} />}
    {profileOpen && <ProfileModal account={account} profileName={pName} setProfileName={setPName} currentPassword={pCur} setCurrentPassword={setPCur} newPassword={pNew} setNewPassword={setPNew} newPassword2={pNew2} setNewPassword2={setPNew2} file={pFile} setFile={setPFile} error={pError} busy={pBusy} onSave={saveProfile} onClose={() => setProfileOpen(false)} />}
    {adminOpen && <AdminModal users={adminUsers} error={adminError} busy={adminBusy} newUsername={newUsername} setNewUsername={setNewUsername} onClose={() => { setAdminOpen(false); setReveal(null); }} onRefresh={loadAdminUsers} onCreate={createUser} onReset={resetUser} onUnlock={unlockUser} onLock={lockUser} reveal={reveal} />}
    {busy && <LoadingOverlay visible label="Einen Moment …" />}
  </div>;
}
