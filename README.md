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

## v55 – Bereiche (Zonen)
Admins ziehen mit dem Werkzeug **Bereich** (Taste `B`) Rechtecke auf dem Board auf und weisen jeder Person (Konto oder Gast-Link) einen Modus zu:
- **Sieht alles** – sieht das ganze Board, darf aber nur im Bereich schreiben/zeichnen. Der Rest wird abgedunkelt.
- **Nur Bereich** – sieht ausschließlich den Bereich und darf nur dort schreiben. Inhalte außerhalb werden gar nicht erst an die Person gesendet.
- **Nur lesen** – sieht nur den Bereich und kann nichts verändern.

Zusätzlich: Namen & Farben, **Sperren** (nur Admin darf schreiben), Verschieben/Skalieren per Ecken, mehrere Bereiche pro Person, Sammel-Zuweisung, Objektzähler, Bereich als PNG exportieren, Bereichsinhalt leeren, „Zu meinem Bereich springen“, automatischer Zoom auf den eigenen Bereich, Live-Änderung der Rechte ohne Neuladen.
Durchgesetzt wird alles serverseitig (Striche werden an der Grenze abgeschnitten, Objekte außerhalb abgelehnt, Hintergrund für Eingeschränkte gesperrt). Max. 24 Bereiche pro Board.

## v56 – Performance (große Boards, Bilder)
- **Speichern:** Änderungen werden gebündelt und asynchron geschrieben (max. 1 Schreibvorgang pro Board alle ~0,7 s, spätestens nach 4 s) statt bei jedem Strich das ganze Board synchron auf die Platte zu schreiben. Beim Beenden (Strg+C/SIGTERM) wird alles gesichert. Boards werden kompakt (ohne Einrückung) gespeichert (~60 % kleiner).
- **Striche:** Freihand-Striche werden vor dem Senden vereinfacht (Ramer-Douglas-Peucker) und serverseitig auf 0,01 gerundet; Doppelpunkte entfallen.
- **Bilder:** Werden vor dem Upload im Browser auf max. 2400 px verkleinert und als WebP komprimiert; der Server kann zusätzlich mit dem optionalen Paket `sharp` optimieren (nicht mehr automatisch installiert, siehe v57.1).
- **Rendering:** Zeichenebene wird gecacht (neue Striche werden nur oben drauf gezeichnet), Pfade als `Path2D` gecacht, beim Herauszoomen werden Punkte ausgedünnt, große Bilder nutzen vorskalierte Mip-Stufen. Cursor, Live-Striche und Bereichsrahmen liegen auf einer eigenen Overlay-Ebene.
- **Netzwerk:** WebSocket-Kompression für große Nachrichten, Uploads werden 30 Tage gecacht.
- **Bugfix Live-Sync:** Striche anderer Personen erscheinen wieder komplett, während sie noch gezeichnet werden. Der Server hatte das `append`-Flag der Live-Chunks verworfen, sodass bei anderen nur der letzte Punkt zu sehen war (Fehler seit v54).
- **Werkzeug-Menü:** Ein erneuter Klick auf das aktive Werkzeug (Stift, Marker, Radierer, Formen, Text) blendet das Einstellungs-Fenster (Farbe, Stärke) ein bzw. aus.

## v57 – Diagramme & Tabellen überarbeitet und durchgetestet
Das Diagramm-Werkzeug (Taste `D`) erzeugt aus Einstellungen normale Board-Objekte (live synchron, rückgängig-fähig, exportierbar, verschiebbar):
- **Koordinatensystem** in Form **L** (ein Quadrant) oder **+** (vier Quadranten): Nullpunkt per Klick, Länge jeder Achse in Kästchen, Wert pro Kästchen, Kästchengröße (1–4× Hintergrund-Raster, rastet am Hintergrund ein), Achsennamen, Zahlen an den Achsen, optional Gitterlinien, Punkte `A(2|3)` und Funktionen `y = x^2/4`.
- **Tabelle** (auch aus Excel einfügbar), **Zahlenstrahl**, **Säulen-**, **Linien-** und **Kreisdiagramm**.
- Bugfixes: Leere/Whitespace-Beschriftungen erzeugen keine ungültigen Texte mehr; extreme Werte (z. B. Schrittweite ∞, ±1e9) werden begrenzt statt NaN zu erzeugen; die „0“ am Nullpunkt überlappt bei „+“ nicht mehr mit „−1“; Kopfleiste auf Handys schneidet Buttons nicht mehr ab (scrollbar).
- Getestet: 20.000 zufällige Konfigurationen ohne Fehler, Browser-Test (alle 6 Diagrammarten, Undo/Redo in einem Schritt, zweiter Nutzer sieht Ergebnis, eingeschränkte Bereiche, Nur-Lesen, Handy-Layout).

## v57.1 – Installationsfehler behoben (Exit-Code 132 / Modul-Fehler)
- **Problem:** In der ersten v56 hing der Server vom nativen Paket `sharp` ab (Bild-Optimierung). Dessen vorkompilierte Bibliothek (libvips) nutzt CPU-Befehle, die manche Server/virtuelle Maschinen nicht haben. Das Betriebssystem beendet den Prozess dann mit **Exit-Code 132 (SIGILL, „illegal instruction“)**; das lässt sich in Node nicht per `try/catch` abfangen. Unter Windows führte dasselbe native Modul zu Modul-/Ladefehlern bei Installation oder Start.
- **Fix:** `sharp` ist keine Abhängigkeit mehr (weder in `package.json` noch im Lockfile), `npm install` lädt kein natives Modul mehr. Der Server lädt `sharp` nur, wenn es von Hand installiert wurde **und** ein Testlauf in einem separaten Prozess erfolgreich ist. Stürzt dieser Test ab, läuft alles ohne serverseitige Optimierung weiter.
- **Keine Einbußen bei der Geschwindigkeit:** Die Bild-Kompression (WebP, max. 2400 px) passiert weiterhin im Browser vor dem Upload; Speichern, Striche-Vereinfachung und Rendering aus v56 sind unverändert.
- `npm run optimize` meldet ohne `sharp` nur einen Hinweis und beendet sich ohne Fehler. Optional nachrüsten: `npm install sharp --no-save`.
- Update-Skripte entfernen ein altes `node_modules/sharp` und Schritt 6 ist nicht mehr kritisch.
