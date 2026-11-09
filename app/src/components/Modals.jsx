import React, { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { Spinner } from "./Loading";
import { Icon, Avatar } from "./Icons";
import { API } from "../lib/api";
import { colorFromId } from "../lib/geometry";
import { toast } from "./Toast";

const DISPLAY_NAME_MAX = 48;
const avatarSrc = (u, v) => u ? `${API}${u}?v=${encodeURIComponent(v || "1")}` : null;

export function ParticipantsPanel({ participants, currentId, selfName, isAdmin, allowUserDeleteOthers, setDeleteOthers, setUserReadOnly, setAllReadOnly, kickUser, onClose }) {
  const others = participants.filter(p => p.userId !== currentId);
  return <aside className="participantsPopover" role="dialog" aria-label="Teilnehmer">
    <div className="popHead"><div><h3>Teilnehmer</h3><span className="liveDot"><i /> {participants.length} online</span></div><button className="iconButton" onClick={onClose} aria-label="Schließen"><Icon name="close" size={18} /></button></div>
    {isAdmin && <div className="popSection">
      <div className="adminSettingRow"><div><b>Fremde Objekte löschen</b><span>Teilnehmer dürfen Objekte anderer entfernen.</span></div><label className={`switch ${allowUserDeleteOthers ? "on" : ""}`}><input type="checkbox" checked={allowUserDeleteOthers} onChange={e => setDeleteOthers(e.target.checked)} /><span /></label></div>
      <div className="bulkRow"><button onClick={() => setAllReadOnly(true)}><Icon name="lock" size={15} /> Alle sperren</button><button onClick={() => setAllReadOnly(false)}><Icon name="unlock" size={15} /> Alle freigeben</button></div>
    </div>}
    <div className="participantList">
      <div className="participantRow selfRow"><Avatar name={selfName} size={34} color={colorFromId(currentId)} /><div className="pInfo"><b>{selfName}</b><span>Du</span></div><span className="status active">Online</span></div>
      {others.map(p => <div className="participantRow" key={p.userId}>
        <Avatar name={p.displayName} size={34} color={colorFromId(p.userId)} />
        <div className="pInfo"><b>{p.displayName}</b><span>{p.kind === "guest" ? (p.guestMode === "guest-edit" ? "Gast · Bearbeiten" : "Gast · Ansicht") : p.isHost ? "Host" : (p.devices > 1 ? `${p.devices} Geräte` : "1 Gerät")}</span></div>
        <span className={p.readOnly ? "status readonly" : "status active"}>{p.readOnly ? "Ansicht" : "Aktiv"}</span>
        {isAdmin && p.kind === "account" && !p.isHost && <div className="pActions"><button className="iconButton" title={p.readOnly ? "Freigeben" : "Schreibsperre"} onClick={() => setUserReadOnly(p.userId, !p.readOnly)}><Icon name={p.readOnly ? "unlock" : "lock"} size={16} /></button><button className="iconButton danger" title="Entfernen" onClick={() => kickUser(p.userId)}><Icon name="logout" size={16} /></button></div>}
      </div>)}
      {participants.length <= 1 && <div className="emptyParticipants">Noch niemand sonst ist hier.</div>}
    </div>
  </aside>;
}

export function GuestShareModal({ invites, error, busy, onCreate, onRevoke, onClose }) {
  return <Modal open title="Gäste einladen" onClose={onClose} className="guestSharePanel">
    <p className="muted">Erstelle einen temporären 6-stelligen Code (24 h gültig). Gäste geben ihn beim Anmelden unter „Gastzugang“ ein und wählen einen Namen.</p>
    <div className="guestCreateButtons"><button className="primary" disabled={busy} onClick={() => onCreate("guest-edit")}>{busy ? <Spinner label="Erstellen…" /> : <><Icon name="pencil" size={16} /> Code mit Bearbeitung</>}</button><button disabled={busy} onClick={() => onCreate("view-only")}><Icon name="eye" size={16} /> Nur Ansicht</button></div>
    {error && <div className="errorBox">{error}</div>}
    <div className="inviteList">{invites.map(inv => <div className="inviteRow" key={inv.id}>
      <div className="inviteMain">
        {inv.code ? <code className="guestCodeReveal">{inv.code.slice(0, 3)} {inv.code.slice(3)}</code> : <code className="guestCodeReveal hidden">••• •••</code>}
        <span>{inv.mode === "view-only" ? "Nur Ansicht" : "Bearbeiten"} · bis {inv.expiresAt ? new Date(inv.expiresAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "unbegrenzt"}{!inv.code && " · Code nur bei Erstellung sichtbar"}</span>
      </div>
      <div className="inviteActions">{inv.code && <button className="iconButton" title="Kopieren" onClick={() => { navigator.clipboard?.writeText(inv.code); toast("Code kopiert", "success", 1800); }}><Icon name="copy" size={16} /></button>}<button className="iconButton danger" title="Widerrufen" onClick={() => onRevoke(inv.id)}><Icon name="trash" size={16} /></button></div>
    </div>)}{invites.length === 0 && <div className="emptyParticipants">Noch keine Gast-Codes erstellt.</div>}</div>
  </Modal>;
}

export function BoardAccessModal({ board, users, mode, setMode, userIds, setUserIds, error, busy, onSave, onClose }) {
  const toggleUser = id => setUserIds(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  return <Modal open title={`Zugriff · ${board?.name || "Whiteboard"}`} onClose={onClose} className="boardAccessPanel">
    <p className="muted">Lege fest, welche Benutzer dieses Board öffnen dürfen. Der Administrator hat immer Zugriff.</p>
    <div className="segmented"><button className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}>Alle Benutzer</button><button className={mode === "selected" ? "active" : ""} onClick={() => setMode("selected")}>Nur ausgewählte</button></div>
    {mode === "selected" && <div className="accessUserList">{users.map(user => <label className="accessUserRow" key={user.id}><input type="checkbox" checked={userIds.includes(user.id)} onChange={() => toggleUser(user.id)} /><Avatar name={user.displayName || user.username} url={avatarSrc(user.avatarUrl, user.updatedAt)} size={32} /><span><b>{user.displayName || user.username}</b><small>@{user.username}</small></span></label>)}{users.length === 0 && <div className="emptyParticipants">Keine normalen Benutzer vorhanden.</div>}</div>}
    {error && <div className="errorBox">{error}</div>}
    <div className="actions"><button className="primary" disabled={busy} onClick={onSave}>{busy ? <Spinner label="Speichern…" /> : "Zugriff speichern"}</button><button onClick={onClose}>Abbrechen</button></div>
  </Modal>;
}

export function ProfileModal({ account, profileName, setProfileName, currentPassword, setCurrentPassword, newPassword, setNewPassword, newPassword2, setNewPassword2, file, setFile, error, busy, onSave, onClose }) {
  const preview = useMemo(() => file ? URL.createObjectURL(file) : avatarSrc(account.avatarUrl, account.updatedAt), [file, account.avatarUrl, account.updatedAt]);
  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);
  return <Modal open title="Mein Profil" onClose={onClose} className="profilePanel">
    <form onSubmit={e => { e.preventDefault(); onSave(); }}>
      <div className="profileHero"><Avatar name={account.displayName || account.username} url={preview} size={72} className="big" /><div><b>{account.displayName || account.username}</b><span>@{account.username}</span><label className="uploadButton"><Icon name="image" size={16} /> Bild ändern<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => setFile(e.target.files?.[0] || null)} /></label>{file && <small className="fileSelected">{file.name}</small>}</div></div>
      <label className="fieldLabel">Anzeigename<input value={profileName} maxLength={DISPLAY_NAME_MAX} onChange={e => setProfileName(e.target.value)} /></label>
      <div className="sectionDivider" /><h3>Passwort ändern</h3><p className="muted">Nur ausfüllen, wenn du dein Passwort ändern möchtest.</p>
      <input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Aktuelles Passwort" />
      <input type="password" minLength={4} autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Neues Passwort" />
      <input type="password" minLength={4} autoComplete="new-password" value={newPassword2} onChange={e => setNewPassword2(e.target.value)} placeholder="Neues Passwort wiederholen" />
      {error && <div className="errorBox">{error}</div>}
      <div className="actions"><button className="primary" disabled={busy}>{busy ? <Spinner label="Speichern…" /> : "Speichern"}</button><button type="button" onClick={onClose}>Abbrechen</button></div>
    </form>
  </Modal>;
}

export function AdminModal({ users, error, busy, newUsername, setNewUsername, onClose, onRefresh, onCreate, onReset, onUnlock, onLock, reveal }) {
  return <Modal open title="Benutzerverwaltung" onClose={onClose} className="adminPanel">
    <p className="muted">Konten werden ausschließlich vom Administrator angelegt. Neue Benutzer erhalten einen Temporärcode und setzen beim ersten Login ein eigenes Passwort.</p>
    <form className="adminCreate" onSubmit={onCreate}><input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="Neuer Benutzername" required minLength={3} maxLength={24} autoComplete="off" /><button className="primary" disabled={busy}>{busy ? <Spinner label="…" /> : <><Icon name="plus" size={16} /> Anlegen</>}</button></form>
    {reveal && <div className="tempPasswordBox"><b>Temporärcode für {reveal.username}</b><code>{reveal.password}</code><button onClick={() => { navigator.clipboard?.writeText(reveal.password); toast("Kopiert", "success", 1500); }}><Icon name="copy" size={15} /> Kopieren</button><p>Nur jetzt sichtbar.</p></div>}
    {error && <div className="errorBox">{error}</div>}
    <div className="adminToolbar"><b>{users.length} Benutzer</b><button onClick={onRefresh} disabled={busy}><Icon name="reset" size={15} /> Aktualisieren</button></div>
    <div className="adminUserList">{users.map(user => <div className="adminUserRow" key={user.id}>
      <Avatar name={user.displayName || user.username} url={avatarSrc(user.avatarUrl, user.updatedAt)} size={38} />
      <div className="adminUserInfo"><b>{user.displayName || user.username}{user.role === "admin" && <em className="roleTag">Admin</em>}</b><span>@{user.username} · <i className={`stateTag ${user.locked ? "locked" : user.mustChangePassword ? "pending" : "ok"}`}>{user.locked ? "gesperrt" : user.mustChangePassword ? "Passwortwechsel offen" : "aktiv"}</i></span></div>
      {user.role !== "admin" && <div className="pActions"><button className="iconButton" title="Temporärcode zurücksetzen" onClick={() => onReset(user)} disabled={busy}><Icon name="key" size={16} /></button>{user.locked ? <button className="iconButton" title="Konto entsperren" onClick={() => onUnlock(user)} disabled={busy}><Icon name="unlock" size={16} /></button> : <button className="iconButton danger" title="Konto sperren" onClick={() => onLock(user)} disabled={busy}><Icon name="lock" size={16} /></button>}</div>}
    </div>)}</div>
  </Modal>;
}

export function MoveBoardModal({ board, folders, onMove, onClose }) {
  return <Modal open title={`Verschieben · ${board?.name || ""}`} onClose={onClose} className="movePanel">
    <div className="moveList">
      <button className={!board?.folderId ? "active" : ""} onClick={() => onMove(board.id, null)}><Icon name="home" size={18} /> Alle Boards (kein Ordner)</button>
      {folders.map(f => <button key={f.id} className={board?.folderId === f.id ? "active" : ""} onClick={() => onMove(board.id, f.id)}><Icon name="folder" size={18} /> {f.name}</button>)}
      {folders.length === 0 && <div className="emptyParticipants">Noch keine Ordner vorhanden.</div>}
    </div>
  </Modal>;
}
