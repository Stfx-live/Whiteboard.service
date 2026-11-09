# Whiteboard v44

## UI-Refactor

Die Oberfläche wurde auf eine gemeinsame Glassmorphism-Designsprache aus dem Login umgestellt: Pastell-Glow-Hintergrund, weiche Glasflächen, blaue/indigofarbene Akzente, einheitliche Rundungen, Buttons, Modals und Werkzeugleisten.

## Aufgeräumter Code

- Historisch doppelte CSS-Layer wurden entfernt und zu einer einzigen Styleschicht zusammengeführt.
- Nicht mehr verwendete Social-Login-Styles und alte Auth-Gimmicks wurden entfernt.
- Das Login-, Passwortwechsel- und Gast-Ladescreen verwenden jetzt dieselbe Auth-Card.
- Das alte zusätzliche Auth-Dot-Grid-Markup wurde entfernt; das Grid wird ausschließlich über CSS erzeugt.
- Icons in Login-Feldern wurden entfernt, damit die Inputs ruhiger und einheitlicher sind.

## Start

Normal:
- Frontend: 8080
- Backend: 3002

Entwicklung (`npm run dev`):
- Frontend: 5173
- Backend: 3001

## v49
Bilddateien werden nicht mehr zusätzlich als Miniatur in der unteren Dateileiste angezeigt. Das Bild erscheint ausschließlich als Canvas-Objekt. Dokument-Dateien bleiben in der Dateileiste sichtbar.


## v50 – Stabilitäts- und Performance-Refactor

- Canvas-Neuzeichnung wird per `requestAnimationFrame` gebündelt, damit Pointer-/Zoom-Events nicht unnötig viele Layout-/Paint-Pässe erzeugen.
- Textmessungen verwenden einen wiederverwendbaren Offscreen-Canvas-Kontext statt bei jeder Bounding-Box ein neues Canvas zu erzeugen.
- Remote-Transformationen werden über `Map` statt mehrfacher Array-Suchen aufgelöst.
- Ein doppelter History-Reset wurde entfernt.
- Ein nicht mehr verwendetes `move-objects`-Socket-Event wurde aus dem Server entfernt; Transformationen laufen zentral über `transform-objects`.
- Animationen berücksichtigen `prefers-reduced-motion`.
- UI-Layer erhalten stabile GPU-freundliche Transform-/Opacity-Animationen.


## v52 fixes
- Lasso transforms are sent as exact object states during preview/final commit to prevent drift/jitter.
- Touch/iPad toolbar is compact and wraps cleanly; text labels collapse to icons.
- Timer popup is portaled to the document body with a fixed z-index so it is not clipped by the toolbar.
- Host-view synchronization is throttled instead of debounced for smoother realtime zoom/pan.


## v53 fixes
- iPad: App nutzt jetzt den gesamten Viewport statt eines künstlich verkleinerten `inset`-Containers.
- iPad: Toolbar ist als kompakte Icon-Dock-Version für Tablet-Breiten optimiert und passt ohne unnötige horizontale Skalierung auf den Bildschirm.
- Ansicht teilen: Der Admin synchronisiert jetzt den sichtbaren Weltmittelpunkt + Zoom statt roher Pixel-Pan-Werte. Dadurch bleibt die gleiche Board-Ansicht auch auf Geräten mit anderer Bildschirmgröße korrekt.
- Ansicht teilen: Teilnehmer übernehmen Host-Ansichten weich per kurzer Animation; alte Sequenzen werden verworfen.
- Timer-Panel bleibt als Portal außerhalb von Toolbar/Canvas und ist dadurch auch auf iPad nicht abgeschnitten.


## v54 – Neues Design & Reparatur
- **Kritischer Fix:** `index.html` lud noch den alten Monolithen (`main.jsx`), die modularen Komponenten (App, BoardView, Dashboard …) waren nicht angeschlossen und hatten kein CSS. `main.jsx` startet jetzt `App.jsx`; der Monolith liegt weiter in `_old/`.
- Komplett neues `style.css` (Aurora-Glass-Design, Hell/Dunkel): animierte Hintergründe, Karten-Stagger, Modal-/Menü-Pop-Animationen, Tab-Slider, schwebende Labels, Shine-Buttons, Tooltips, Toasts.
- Neues Board-Layout: vertikales Dock links, Eigenschaften-Panel daneben; auf Tablet/Handy horizontales Dock unten, Panel automatisch umgeordnet.
- Textfeld fokussiert sofort (kein Tastendruck geht mehr an Kürzel verloren), Slider mit Füllfarbe.
- `prefers-reduced-motion` wird respektiert. `dist/` neu gebaut.
