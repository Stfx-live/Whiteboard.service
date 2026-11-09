import React from "react";

export default function Modal({ open, title, children, onClose, className = "", overlayClassName = "" }) {
  if (!open) return null;
  return (
    <div className={`modal ${overlayClassName}`} role="dialog" aria-modal="true" aria-label={title || undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modalPanel ${className}`} onKeyDown={(e) => { if (e.key === "Escape") onClose?.(); }} tabIndex={-1}>
        {(title || onClose) && (
          <div className="modalHeader">
            <div>{title ? <h2>{title}</h2> : null}</div>
            {onClose ? <button type="button" onClick={onClose} aria-label="Schließen">✕</button> : null}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
