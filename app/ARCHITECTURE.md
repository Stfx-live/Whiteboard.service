# Whiteboard v50 – Stabilitäts- und UI-Refactor

## Fehleranalyse

### 1. Canvas-Painting
Vorher konnte dieselbe Eingabe durch State-Updates, Pointer-Events und Zoom/Pan mehrere direkte `paintBase()`-Aufrufe auslösen. Das erhöht die Paint-Last und kann auf Touch-/Stiftgeräten als Ruckeln erscheinen.

**Fix:** `paintBase()` plant genau einen `requestAnimationFrame`-Durchlauf. Die eigentliche Zeichenroutine ist `renderBoardFrame()`.

```js
function paintBase() {
  if (paintFrame.current) return;
  paintFrame.current = requestAnimationFrame(() => {
    paintFrame.current = null;
    renderBoardFrame();
  });
}
```

### 2. Objektmessung
Vorher wurde beim Berechnen von Text-Bounds jedes Mal ein neues Canvas erzeugt.

**Fix:** Ein wiederverwendbarer Offscreen-Kontext:

```js
if (!measureCanvas.current) {
  measureCanvas.current = document.createElement("canvas").getContext("2d");
}
const layout = getCanvasTextLayout(measureCanvas.current, textObject);
```

### 3. Remote-Transformationen
Vorher wurde für jedes lokale Objekt wiederholt `find()` auf der eingehenden Transform-Liste ausgeführt.

**Fix:** Einmal `Map` erstellen, dann O(1)-Lookup pro Objekt.

```js
const byId = new Map(transforms.map(t => [t.id, t]));
```

### 4. Event- und Ressourcenbereinigung
Der Paint-Frame, Preview-Frame und Host-View-Frame werden beim Unmount abgebrochen. Socket-/Pointer-Listener bleiben weiterhin in ihren jeweiligen `useEffect`-Cleanup-Funktionen gebunden.

## Performance-Prinzipien

- Canvas mit `requestAnimationFrame` bündeln.
- Lokale Vorschau nicht vom Server-Event abhängig machen.
- Persistente Transformation erst beim Abschluss speichern.
- Ephemere Cursor-/Live-Stroke-Daten nicht in den dauerhaften Board-State schreiben.
- Remote-Operationen indexieren (`Map`) statt verschachtelte Suchen.
- Animationen primär über `transform`/`opacity` durchführen.
- `prefers-reduced-motion` respektieren.
