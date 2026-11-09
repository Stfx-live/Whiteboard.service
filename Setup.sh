#!/usr/bin/env bash
# Whiteboard Setup: v53 deinstallieren, v54 installieren (Linux/macOS)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; SRC="$HERE/app"
echo "== Whiteboard Setup: v53 -> v54 =="
[ -f "$SRC/package.json" ] || { echo "FEHLER: Ordner 'app' fehlt."; exit 1; }
command -v node >/dev/null && command -v npm >/dev/null || { echo "FEHLER: Node.js/npm fehlt."; exit 1; }
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Suche nach installierter Version 53 ..."
  mapfile -t FOUND < <(for r in "$(dirname "$HERE")" "$HOME" "$PWD"; do find "$r" -maxdepth 5 \( -name node_modules -o -name .git -o -name '*_backup_*' \) -prune -o -name server.cjs -print 2>/dev/null; done | while read -r f; do d="$(dirname "$f")"; [ "$d" = "$SRC" ] && continue; grep -q '"1.0.53"' "$d/package.json" 2>/dev/null && grep -q realtime-whiteboard "$d/package.json" && echo "$d"; done | sort -u)
  if [ ${#FOUND[@]} -eq 1 ]; then TARGET="${FOUND[0]}"; echo "Gefunden: $TARGET"
  elif [ ${#FOUND[@]} -gt 1 ]; then i=1; for f in "${FOUND[@]}"; do echo "  $i) $f"; i=$((i+1)); done; read -rp "Nummer: " n; TARGET="${FOUND[$((n-1))]}"
  else read -rp "Nichts gefunden. Ordner von Hand eingeben: " TARGET; fi
fi
TARGET="${TARGET%/}"
[ -f "$TARGET/server.cjs" ] && grep -q realtime-whiteboard "$TARGET/package.json" || { echo "FEHLER: Keine Whiteboard-Installation in '$TARGET'."; exit 1; }
if ! grep -q '"1.0.53"' "$TARGET/package.json"; then read -rp "Scheint nicht v53 zu sein. Trotzdem fortfahren? (j/n) " a; [ "$a" = j ] || exit 1; fi
read -rp "Die alte Version in '$TARGET' wird gelöscht (nur data bleibt). Fortfahren? (j/n) " a; [ "$a" = j ] || exit 1
BACKUP="${TARGET}_backup_$(date +%Y%m%d-%H%M%S)"
echo "[1/5] Sicherung -> $BACKUP"; mkdir -p "$BACKUP"; [ -d "$TARGET/data" ] && cp -a "$TARGET/data" "$BACKUP/data"
echo "[2/5] Alte Version entfernen"; find "$TARGET" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
echo "[3/5] v54 kopieren"; (cd "$SRC" && tar cf - .) | (cd "$TARGET" && tar xf -); mkdir -p "$TARGET/data"
echo "[4/5] npm install"; cd "$TARGET" && npm install --no-audit --no-fund
echo "[5/5] Build"; npm run build
echo "Fertig! Starten: cd '$TARGET' && npm start  (http://localhost:8080)  Backup: $BACKUP"
