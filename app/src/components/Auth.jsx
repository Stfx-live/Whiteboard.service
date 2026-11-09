import React, { useRef } from "react";

export function AuthShell({ children, loading = false }) {
  const ref = useRef(null);
  function move(e) {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.setProperty("--mx", `${((e.clientX - r.left) / r.width - 0.5) * 28}px`);
    ref.current.style.setProperty("--my", `${((e.clientY - r.top) / r.height - 0.5) * 22}px`);
  }
  return <main ref={ref} className={`authPagePro ${loading ? "isLoading" : ""}`} onPointerMove={move}>
    <div className="authGridGlow" />
    <div className="authShape authShapeA" /><div className="authShape authShapeB" /><div className="authShape authShapeC" />
    <div className="authScene">{children}</div>
  </main>;
}

export function BrandMark({ children = "WB" }) { return <div className="brandMark">{children}</div>; }

export function OtpInput({ value, onChange, disabled = false }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || "");
  const focusAt = index => { if (index >= 0 && index < 6) refs.current[index]?.focus(); };
  const applyDigits = raw => { const clean = String(raw || "").replace(/\D/g, "").slice(0, 6); onChange(clean); focusAt(Math.min(clean.length, 5)); };
  return <div className="otpBoxes" onPaste={e => { e.preventDefault(); applyDigits(e.clipboardData.getData("text")); }}>
    {digits.map((digit, index) => <input
      key={index} ref={el => { refs.current[index] = el; }} value={digit} inputMode="numeric" pattern="[0-9]*" maxLength={1} disabled={disabled}
      autoComplete={index === 0 ? "one-time-code" : "off"} aria-label={`Code Stelle ${index + 1}`}
      className={digit ? "filled" : ""}
      onFocus={e => e.currentTarget.select()}
      onChange={e => {
        const n = e.target.value.replace(/\D/g, "").slice(-1);
        const next = digits.slice(); next[index] = n; onChange(next.join("").slice(0, 6));
        if (n) focusAt(Math.min(index + 1, 5));
      }}
      onKeyDown={e => {
        if (e.key === "Backspace" && !digits[index]) { onChange(digits.slice(0, Math.max(0, index)).join("")); focusAt(index - 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); focusAt(index - 1); }
        if (e.key === "ArrowRight") { e.preventDefault(); focusAt(index + 1); }
      }}
    />)}
  </div>;
}
