import React, { useMemo, useState } from "react";
import { Icon, Avatar } from "./Icons";
import { colorFromId } from "../lib/geometry";
import { ZONE_COLORS, ZONE_MODES } from "../lib/zones";

const MODE_ORDER = ["open", "focus", "view"];

// Verwaltung der Bereiche (nur Admin): anlegen, benennen, einfärben, sperren, Personen mit Modus zuweisen.
export default function ZonesPanel({ zones, counts, candidates, selectedId, onSelect, onCreate, onUpdate, onDelete, onAssign, onJump, onExport, onClear, onClose }) {
  const [filter, setFilter] = useState("");
  const sel = zones.find(z => z.id === selectedId) || null;
  const people = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return candidates.filter(c => !q || `${c.name} ${c.username || ""}`.toLowerCase().includes(q));
  }, [candidates, filter]);
  const assigned = z => Object.keys(z.assignments || {}).length;

  return <aside className="zonePanel glass" onPointerDown={e => e.stopPropagation()} aria-label="Bereiche verwalten">
    <header className="zpHead">
      <span className="zpIcon"><Icon name="zone" size={18} /></span>
      <div><b>Bereiche</b><small>{zones.length ? `${zones.length} Bereich${zones.length === 1 ? "" : "e"}` : "Noch keine Bereiche"}</small></div>
      <button className="iconButton" onClick={onClose} aria-label="Schließen"><Icon name="close" size={18} /></button>
    </header>

    <div className="zpBody">
      {!zones.length && <div className="zpEmpty">
        <Icon name="zone" size={30} />
        <b>Teile dein Board in Bereiche auf</b>
        <p>Ziehe mit dem Bereich-Werkzeug (B) ein Rechteck auf. Danach legst du fest, wer dort schreiben darf und was die Person sieht.</p>
      </div>}

      <div className="zpList">
        {zones.map(z => <section key={z.id} className={`zoneCard ${z.id === selectedId ? "sel" : ""}`} style={{ "--zc": z.color }}>
          <button className="zcHead" onClick={() => onSelect(z.id === selectedId ? null : z.id)} aria-expanded={z.id === selectedId}>
            <i className="zcDot" />
            <span className="zcName"><b>{z.name}</b><small>{assigned(z)} Person{assigned(z) === 1 ? "" : "en"} · {counts[z.id] || 0} Objekt{(counts[z.id] || 0) === 1 ? "" : "e"}</small></span>
            {z.locked && <Icon name="lock" size={15} className="zcLock" />}
            <Icon name="chevronDown" size={16} className="zcChev" />
          </button>

          {z.id === selectedId && <div className="zcBody">
            <label className="zcField">Name
              <input key={z.id + z.name} defaultValue={z.name} maxLength={40} onBlur={e => { const v = e.target.value.trim(); if (v && v !== z.name) onUpdate(z.id, { name: v }); else e.target.value = z.name; }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); e.stopPropagation(); }} />
            </label>
            <div className="zcField">Farbe
              <div className="zcColors">{ZONE_COLORS.map(c => <button key={c} className={`zcSwatch ${c === z.color ? "on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => onUpdate(z.id, { color: c })} />)}</div>
            </div>
            <div className="zcActions">
              <button onClick={() => onJump(z)}><Icon name="target" size={15} /> Hinspringen</button>
              <button className={z.locked ? "on" : ""} onClick={() => onUpdate(z.id, { locked: !z.locked })} title="Gesperrt: außer dir darf niemand in diesem Bereich schreiben"><Icon name={z.locked ? "lock" : "unlock"} size={15} /> {z.locked ? "Gesperrt" : "Sperren"}</button>
              <button onClick={() => onExport(z)}><Icon name="image" size={15} /> PNG</button>
              <button onClick={() => onClear(z)} disabled={!(counts[z.id] > 0)}><Icon name="eraser" size={15} /> Leeren</button>
              <button className="danger" onClick={() => onDelete(z.id)}><Icon name="trash" size={15} /> Löschen</button>
            </div>

            <div className="zcPeople">
              <div className="zcPeopleHead"><b>Personen</b><span>Modus pro Person</span></div>
              <div className="zcModes">{MODE_ORDER.map(m => <div key={m}><b>{ZONE_MODES[m].label}</b><span>{ZONE_MODES[m].desc}</span></div>)}</div>
              {candidates.length > 6 && <input className="zcSearch" placeholder="Person suchen …" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => e.stopPropagation()} />}
              {candidates.length > 1 && <div className="zcBulk"><span>Alle:</span>
                {MODE_ORDER.map(m => <button key={m} onClick={() => onAssign(z.id, people.map(c => c.key), m)}>{ZONE_MODES[m].short}</button>)}
                <button onClick={() => onAssign(z.id, people.map(c => c.key), null)}>Entfernen</button></div>}
              {!candidates.length && <p className="zcNone">Es gibt noch keine Konten oder Gast-Links, die du zuweisen könntest. Lege Konten im Dashboard an oder erzeuge einen Gast-Link über „Teilen“.</p>}
              <ul>
                {people.map(c => { const cur = z.assignments?.[c.key] || null, other = zones.filter(o => o.id !== z.id && o.assignments?.[c.key]).length; return <li key={c.key}>
                  <Avatar name={c.name} url={c.avatarUrl ? c.avatarUrl : null} size={28} color={colorFromId(c.key)} />
                  <span className="zcWho"><b>{c.name}</b><small>{c.type === "guest" ? c.username : `@${c.username}`}{other ? ` · +${other} weitere` : ""}</small></span>
                  <div className="seg" role="group" aria-label={`Modus für ${c.name}`}>
                    <button className={!cur ? "on" : ""} onClick={() => onAssign(z.id, [c.key], null)} title="Nicht diesem Bereich zugewiesen">Aus</button>
                    {MODE_ORDER.map(m => <button key={m} className={cur === m ? "on" : ""} onClick={() => onAssign(z.id, [c.key], m)} title={ZONE_MODES[m].desc}>{ZONE_MODES[m].short}</button>)}
                  </div>
                </li>; })}
              </ul>
            </div>
          </div>}
        </section>)}
      </div>
    </div>

    <footer className="zpFoot"><button className="primary" onClick={onCreate}><Icon name="plus" size={16} /> Neuer Bereich</button><small>Tipp: Taste <kbd>B</kbd> und im Board aufziehen. Mit gezogenen Ecken skalierst du.</small></footer>
  </aside>;
}
