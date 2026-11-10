import React from "react";
import { Icon } from "./Icons";
import { DIAGRAM_KINDS, LIMITS, anchorHint, compileFunction, parseBars, parsePoints } from "../lib/diagram";

const Num = ({ label, value, onChange, min, max, step = 1, suffix }) => <label className="dgField"><span>{label}</span>
  <span className="dgNum"><input type="number" inputMode="decimal" value={value} min={min} max={max} step={step} onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} onBlur={e => { const n = Number(e.target.value); if (!Number.isFinite(n) || (min != null && n < min)) onChange(min ?? 0); else if (max != null && n > max) onChange(max); }} onKeyDown={e => e.stopPropagation()} />{suffix && <em>{suffix}</em>}</span></label>;
const Check = ({ label, value, onChange }) => <label className="toggleRow dgCheck"><span>{label}</span><span className={`switch ${value ? "on" : ""}`}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /><span /></span></label>;
const Area = ({ label, value, onChange, placeholder, rows = 3, hint }) => <label className="dgField dgArea"><span>{label}</span><textarea rows={rows} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} onKeyDown={e => e.stopPropagation()} spellCheck={false} />{hint && <small>{hint}</small>}</label>;

// Einstellungen für Diagramme/Tabellen. Danach wird per Klick auf das Board platziert (Vorschau folgt dem Mauszeiger).
export default function DiagramPanel({ cfg, setCfg, count, onClose }) {
  const up = patch => setCfg(c => ({ ...c, ...patch }));
  const badFn = String(cfg.funcs || "").split(/\n/).map(s => s.trim()).filter(Boolean).some(s => !compileFunction(s));
  const pts = parsePoints(cfg.points).length;
  return <aside className="diagPanel glass" onPointerDown={e => e.stopPropagation()} aria-label="Diagramm erstellen">
    <header className="zpHead">
      <span className="zpIcon"><Icon name="chart" size={18} /></span>
      <div><b>Diagramm &amp; Tabelle</b><small>{count ? `${count} Objekte` : "Einstellen, dann aufs Board klicken"}</small></div>
      <button className="iconButton" onClick={onClose} aria-label="Schließen"><Icon name="close" size={18} /></button>
    </header>
    <div className="dgTabs" role="tablist">{DIAGRAM_KINDS.map(k => <button key={k.id} role="tab" aria-selected={cfg.kind === k.id} className={cfg.kind === k.id ? "on" : ""} onClick={() => up({ kind: k.id })}>{k.label}</button>)}</div>
    <div className="dgBody">
      {cfg.kind === "coord" && <>
        <div className="dgField"><span>Form</span><div className="seg dgSeg2" role="group">
          <button className={cfg.form === "L" ? "on" : ""} onClick={() => up({ form: "L" })} title="Nur der obere rechte Bereich (positive Werte)">L &nbsp;· ein Quadrant</button>
          <button className={cfg.form === "+" ? "on" : ""} onClick={() => up({ form: "+" })} title="Alle vier Quadranten mit Nullpunkt in der Mitte">+ &nbsp;· vier Quadranten</button></div></div>
        <div className="dgRow"><Num label={cfg.form === "+" ? "X-Achse (je Seite)" : "X-Achse"} value={cfg.nx} min={LIMITS.nx[0]} max={LIMITS.nx[1]} onChange={v => up({ nx: v })} suffix="Kästchen" />
          <Num label={cfg.form === "+" ? "Y-Achse (je Seite)" : "Y-Achse"} value={cfg.ny} min={LIMITS.ny[0]} max={LIMITS.ny[1]} onChange={v => up({ ny: v })} suffix="Kästchen" /></div>
        <div className="dgRow"><Num label="Wert pro Kästchen" value={cfg.step} min={0.001} step="any" onChange={v => up({ step: v })} />
          <label className="dgField"><span>Kästchengröße</span><select value={cfg.cellMul} onChange={e => up({ cellMul: +e.target.value })}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}× Hintergrund</option>)}</select></label></div>
        <div className="dgRow"><label className="dgField"><span>Name X</span><input value={cfg.xLabel} maxLength={6} onChange={e => up({ xLabel: e.target.value })} onKeyDown={e => e.stopPropagation()} /></label>
          <label className="dgField"><span>Name Y</span><input value={cfg.yLabel} maxLength={6} onChange={e => up({ yLabel: e.target.value })} onKeyDown={e => e.stopPropagation()} /></label></div>
        <Check label="Pfeilspitzen" value={cfg.arrows} onChange={v => up({ arrows: v })} />
        <Check label="Gitterlinien mitzeichnen" value={cfg.gridLines} onChange={v => up({ gridLines: v })} />
        <Area label="Punkte (optional)" value={cfg.points} onChange={v => up({ points: v })} placeholder={"A(2|3)  B(5|1)  (4|4)"} rows={2} hint={cfg.points && !pts ? "Format: A(2|3) – kein Punkt erkannt" : pts ? `${pts} Punkt${pts === 1 ? "" : "e"} erkannt` : ""} />
        <Area label="Funktionen (optional, eine pro Zeile)" value={cfg.funcs} onChange={v => up({ funcs: v })} placeholder={"y = 2x + 1\ny = x^2 / 4"} rows={2} hint={badFn ? "⚠ Eine Funktion wird nicht verstanden (erlaubt: + − * / ^, sin, cos, sqrt, abs …)" : ""} />
      </>}
      {cfg.kind === "table" && <>
        <div className="dgRow"><Num label="Zeilen" value={cfg.rows} min={LIMITS.rows[0]} max={LIMITS.rows[1]} onChange={v => up({ rows: v })} /><Num label="Spalten" value={cfg.cols} min={LIMITS.cols[0]} max={LIMITS.cols[1]} onChange={v => up({ cols: v })} /></div>
        <div className="dgRow"><Num label="Zellbreite" value={cfg.cellW} min={LIMITS.cellW[0]} max={LIMITS.cellW[1]} onChange={v => up({ cellW: v })} suffix="Kästch." /><Num label="Zellhöhe" value={cfg.cellH} min={LIMITS.cellH[0]} max={LIMITS.cellH[1]} onChange={v => up({ cellH: v })} suffix="Kästch." /></div>
        <Check label="Kopfzeile hervorheben" value={cfg.header} onChange={v => up({ header: v })} />
        <Area label="Inhalt (optional)" value={cfg.content} onChange={v => up({ content: v })} rows={5} placeholder={"Name; Alter; Note\nAnna; 12; 1\nBen; 13; 2"} hint="Eine Zeile pro Tabellenzeile, Zellen mit ; oder Tab trennen (z. B. aus Excel einfügen). Die Tabelle wächst mit dem Inhalt." />
      </>}
      {cfg.kind === "numberline" && <>
        <div className="dgRow"><Num label="von" value={cfg.from} step="any" onChange={v => up({ from: v })} /><Num label="bis" value={cfg.to} step="any" onChange={v => up({ to: v })} /></div>
        <div className="dgRow"><Num label="Schrittweite" value={cfg.nlStep} min={0.001} step="any" onChange={v => up({ nlStep: v })} /><Num label="Länge je Schritt" value={cfg.perStep} min={LIMITS.perStep[0]} max={LIMITS.perStep[1]} onChange={v => up({ perStep: v })} suffix="Kästch." /></div>
        <label className="dgField"><span>Markierte Werte (optional)</span><input value={cfg.marks} placeholder="3; 7,5" onChange={e => up({ marks: e.target.value })} onKeyDown={e => e.stopPropagation()} /></label>
      </>}
      {(cfg.kind === "bars" || cfg.kind === "lines" || cfg.kind === "pie") && <>
        <Area label="Daten (Name: Wert, eine Zeile pro Säule)" value={cfg.data} onChange={v => up({ data: v })} rows={5} placeholder={"Mathe: 12\nDeutsch: 9"} hint={parseBars(cfg.data).length ? `${parseBars(cfg.data).length} Säule${parseBars(cfg.data).length === 1 ? "" : "n"}` : "Keine gültigen Daten – Format „Name: 5“"} />
        <label className="dgField"><span>Titel (optional)</span><input value={cfg.title} maxLength={60} onChange={e => up({ title: e.target.value })} onKeyDown={e => e.stopPropagation()} /></label>
        {cfg.kind !== "pie" && <Num label="Höhe höchstens" value={cfg.barH} min={LIMITS.barH[0]} max={LIMITS.barH[1]} onChange={v => up({ barH: v })} suffix="Kästchen" />}
      </>}
    </div>
    <footer className="dgFoot"><Icon name="target" size={16} /><span>Jetzt auf das Board klicken: <b>{anchorHint(cfg.kind)}</b>. Er rastet am Hintergrund-Raster ein. <kbd>Esc</kbd> bricht ab.</span></footer>
  </aside>;
}
