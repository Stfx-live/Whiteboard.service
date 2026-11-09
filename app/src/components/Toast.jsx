import React, { useEffect, useState } from "react";
import { Icon } from "./Icons";
import Modal from "./Modal";

// Mini-Eventbus: toast("Text", "error") und askConfirm({...}) funktionieren aus jeder Funktion heraus.
const listeners = new Set();
let toastSeq = 0;
export function toast(message, type = "info", duration = 4200) {
  const item = { id: ++toastSeq, message: String(message || ""), type, duration };
  listeners.forEach(fn => fn({ kind: "toast", item }));
  return item.id;
}
let confirmResolver = null;
export function askConfirm({ title = "Bist du sicher?", message = "", confirmLabel = "Bestätigen", cancelLabel = "Abbrechen", danger = false } = {}) {
  return new Promise(resolve => {
    if (confirmResolver) confirmResolver(false);
    confirmResolver = resolve;
    listeners.forEach(fn => fn({ kind: "confirm", payload: { title, message, confirmLabel, cancelLabel, danger } }));
  });
}

let promptResolver = null;
export function askPrompt({ title = "Eingabe", label = "", value = "", confirmLabel = "Speichern", placeholder = "", maxLength = 80 } = {}) {
  return new Promise(resolve => {
    if (promptResolver) promptResolver(null);
    promptResolver = resolve;
    listeners.forEach(fn => fn({ kind: "prompt", payload: { title, label, value, confirmLabel, placeholder, maxLength } }));
  });
}

export function ToastHost() {
  const [prompt, setPrompt] = useState(null);
  const [promptValue, setPromptValue] = useState("");
  const [items, setItems] = useState([]);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const fn = event => {
      if (event.kind === "toast") {
        setItems(v => [...v.slice(-3), event.item]);
        setTimeout(() => setItems(v => v.map(t => t.id === event.item.id ? { ...t, leaving: true } : t)), event.item.duration);
        setTimeout(() => setItems(v => v.filter(t => t.id !== event.item.id)), event.item.duration + 260);
      } else if (event.kind === "confirm") setDialog(event.payload);
      else if (event.kind === "prompt") { setPrompt(event.payload); setPromptValue(event.payload.value || ""); }
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const answerPrompt = value => { setPrompt(null); const r = promptResolver; promptResolver = null; r?.(value); };
  const answer = value => { setDialog(null); const r = confirmResolver; confirmResolver = null; r?.(value); };
  return <>
    <div className="toastStack" role="status" aria-live="polite">
      {items.map(t => <div key={t.id} className={`toast toast-${t.type} ${t.leaving ? "leaving" : ""}`} onClick={() => setItems(v => v.filter(x => x.id !== t.id))}>
        <Icon name={t.type === "error" ? "warn" : t.type === "success" ? "check" : "info"} size={18} />
        <span>{t.message}</span>
      </div>)}
    </div>
    <Modal open={Boolean(prompt)} title={prompt?.title} onClose={() => answerPrompt(null)} className="confirmPanel" overlayClassName="confirmOverlay">
      <form onSubmit={e => { e.preventDefault(); const v = promptValue.trim(); answerPrompt(v || null); }}>
        {prompt?.label && <label className="fieldLabel">{prompt.label}</label>}
        <input autoFocus value={promptValue} maxLength={prompt?.maxLength} placeholder={prompt?.placeholder} onChange={e => setPromptValue(e.target.value)} onFocus={e => e.target.select()} />
        <div className="actions"><button className="primary" disabled={!promptValue.trim()}>{prompt?.confirmLabel}</button><button type="button" onClick={() => answerPrompt(null)}>Abbrechen</button></div>
      </form>
    </Modal>
    <Modal open={Boolean(dialog)} title={dialog?.title} onClose={() => answer(false)} className="confirmPanel" overlayClassName="confirmOverlay">
      {dialog?.message && <p className="confirmText">{dialog.message}</p>}
      <div className="actions">
        <button autoFocus className={dialog?.danger ? "primary dangerSolid" : "primary"} onClick={() => answer(true)}>{dialog?.confirmLabel}</button>
        <button onClick={() => answer(false)}>{dialog?.cancelLabel}</button>
      </div>
    </Modal>
  </>;
}
