import React from "react";

export function Spinner({ label = "Bitte warten…" }) {
  return <span className="spinnerWrap"><span className="spinner" aria-hidden="true" />{label ? <span>{label}</span> : null}</span>;
}

export function LoadingOverlay({ visible, label = "Wird geladen…" }) {
  if (!visible) return null;
  return <div className="loadingOverlay"><Spinner label={label} /></div>;
}

export function SkeletonCard() {
  return <div className="skeletonCard"><span /><span /><span /></div>;
}
