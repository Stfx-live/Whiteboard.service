import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { formatDuration } from "../lib/geometry";

export function useBoardTimer(socket, boardId, canControl) {
  const [timer, setTimer] = useState({ status: "idle", durationMs: 5 * 60 * 1000, remainingMs: 5 * 60 * 1000, startedAt: null, endsAt: null, version: 0 });
  const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0);
  const previousStatus = useRef(null);

  useEffect(() => {
    if (!boardId) return;
    previousStatus.current = null;
    const apply = payload => {
      if (!payload) return;
      clockOffset.current = Number(payload.serverNow || Date.now()) - Date.now();
      setTimer(payload); setNow(Date.now());
    };
    const names = ["timer:start", "timer:pause", "timer:reset", "timer:tick", "timer:sync", "timer:expired"];
    names.forEach(name => socket.on(name, apply));
    const onConnect = () => socket.emit("timer:sync");
    socket.on("connect", onConnect);
    if (socket.connected) socket.emit("timer:sync");
    return () => { names.forEach(name => socket.off(name, apply)); socket.off("connect", onConnect); };
  }, [socket, boardId]);

  useEffect(() => {
    if (timer.status !== "running" || !timer.endsAt) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [timer.status, timer.endsAt]);

  // Signalton nur beim Übergang laufend → abgelaufen (nicht beim bloßen Beitreten).
  useEffect(() => {
    const prev = previousStatus.current;
    previousStatus.current = timer.status;
    if (timer.status === "expired" && prev === "running") {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = AudioCtx ? new AudioCtx() : null;
        if (ctx) {
          [0, .22, .44].forEach(delay => { const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.type = "sine"; osc.frequency.value = 880; gain.gain.setValueAtTime(.0001, ctx.currentTime + delay); gain.gain.exponentialRampToValueAtTime(.08, ctx.currentTime + delay + .02); gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + delay + .18); osc.connect(gain); gain.connect(ctx.destination); osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + .2); });
          setTimeout(() => ctx.close?.(), 1200);
        }
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

export function TimerWidget({ timerApi, canControl }) {
  const { timer, remainingMs, start, pause, reset } = timerApi;
  const currentMinutes = Math.max(1, Math.round((timer.durationMs || 5 * 60 * 1000) / 60000));
  const [customMinutes, setCustomMinutes] = useState(currentMinutes);
  const [open, setOpen] = useState(false);
  const summaryRef = useRef(null);
  const panelRef = useRef(null);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 288 });
  useEffect(() => { setCustomMinutes(currentMinutes); }, [currentMinutes]);
  const expired = timer.status === "expired", running = timer.status === "running", paused = timer.status === "paused";
  const safeMinutes = Math.max(1, Math.min(240, Number(customMinutes) || 1));
  const customDuration = safeMinutes * 60 * 1000;
  const progress = timer.durationMs ? Math.max(0, Math.min(1, remainingMs / timer.durationMs)) : 0;
  const idle = !running && !paused && !expired;

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = summaryRef.current?.getBoundingClientRect(); if (!rect) return;
      const width = 288;
      setPanelPos({ top: Math.max(8, Math.min(window.innerHeight - 8, rect.bottom + 10)), left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)), width });
    };
    const onDown = e => { if (!panelRef.current?.contains(e.target) && !summaryRef.current?.contains(e.target)) setOpen(false); };
    update();
    window.addEventListener("resize", update); document.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("resize", update); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const ring = 2 * Math.PI * 9;
  return <div className={`timerWidget ${expired ? "expired" : ""} ${running ? "running" : ""} ${open ? "open" : ""}`}>
    <button ref={summaryRef} className="timerSummary" onClick={() => setOpen(v => !v)} title="Timer" aria-expanded={open}>
      <svg className="timerRing" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" className="ringBg" /><circle cx="12" cy="12" r="9" className="ringFg" strokeDasharray={ring} strokeDashoffset={ring * (1 - progress)} transform="rotate(-90 12 12)" /></svg>
      <span className="timerSummaryTime">{formatDuration(remainingMs)}</span>
    </button>
    {open && createPortal(<div ref={panelRef} className="timerPanel" style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}>
      <div className="timerTop"><span className="timerLabel">{expired ? "Zeit abgelaufen" : running ? "Läuft" : paused ? "Pausiert" : "Countdown"}</span></div>
      <div className="timerBig">{formatDuration(remainingMs)}</div>
      <div className="timerBar"><span style={{ transform: `scaleX(${progress})` }} /></div>
      {canControl ? <div className="timerControls">
        <div className="timerPresets">{[1, 5, 10, 15, 30].map(v => <button key={v} className={safeMinutes === v ? "selected" : ""} onClick={() => { setCustomMinutes(v); if (!running) reset(v * 60 * 1000); }}>{v}m</button>)}</div>
        <label className="timerCustom"><span>Minuten</span><input type="number" min="1" max="240" inputMode="numeric" value={customMinutes} onChange={e => setCustomMinutes(e.target.value)} onKeyDown={e => e.key === "Enter" && reset(customDuration)} /></label>
        <div className="timerActions">
          {running ? <button className="primary" onClick={pause}><Icon name="pause" size={16} /> Pause</button>
            : <button className="primary" onClick={() => start(paused ? (timer.remainingMs || customDuration) : customDuration)}><Icon name="play" size={16} /> {paused ? "Weiter" : expired ? "Neu starten" : "Start"}</button>}
          <button onClick={() => reset(customDuration)}><Icon name="reset" size={16} /> Zurücksetzen</button>
        </div>
      </div> : <div className="timerViewerHint">Nur der Host kann den Timer steuern.</div>}
    </div>, document.body)}
  </div>;
}
