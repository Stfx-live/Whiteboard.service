@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Whiteboard Setup - v53 zu v54
echo ==================================================
echo   Whiteboard Setup: v53 deinstallieren, v54 installieren
echo ==================================================
echo.
set "SRC=%~dp0app"
if not exist "%SRC%\package.json" ( echo FEHLER: Ordner "app" fehlt neben der Setup.bat. & goto :fail )

where node >nul 2>nul || ( echo FEHLER: Node.js ist nicht installiert. Bitte von https://nodejs.org installieren. & goto :fail )
where npm >nul 2>nul || ( echo FEHLER: npm wurde nicht gefunden. & goto :fail )

set "TARGET=%~1"
if not "%TARGET%"=="" goto :havetarget
echo Suche nach installierter Version 53 ... (kann einen Moment dauern)
set N=0
for /f "usebackq delims=" %%P in (`powershell -nologo -noprofile -executionpolicy bypass -file "%~dp0Find-Old.ps1"`) do ( set /a N+=1 & set "C!N!=%%P" )
if %N%==0 (
  echo Keine Version 53 automatisch gefunden.
  set /p "TARGET=Ordner der alten Installation von Hand eingeben: "
  goto :havetarget
)
if %N%==1 ( set "TARGET=!C1!" & echo Gefunden: !C1! & goto :havetarget )
echo Mehrere Installationen gefunden:
for /l %%i in (1,1,%N%) do echo   %%i^) !C%%i!
set /p "SEL=Nummer der zu ersetzenden Installation: "
set "TARGET=!C%SEL%!"
:havetarget
set "TARGET=%TARGET:"=%"
if "%TARGET%"=="" ( echo FEHLER: Kein Ordner angegeben. & goto :fail )
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

if not exist "%TARGET%\server.cjs" ( echo FEHLER: In "%TARGET%" wurde keine Whiteboard-Installation gefunden. & goto :fail )
findstr /c:"realtime-whiteboard" "%TARGET%\package.json" >nul 2>nul || ( echo FEHLER: "%TARGET%" ist kein Whiteboard-Projekt. & goto :fail )
findstr /c:"1.0.53" "%TARGET%\package.json" >nul 2>nul || (
  echo WARNUNG: Der Ordner scheint nicht Version 53 zu sein.
  set /p "OK=Trotzdem fortfahren? (j/n): "
  if /i not "!OK!"=="j" goto :fail
)

echo.
echo Alte Installation: %TARGET%
echo Die alte Version wird geloescht (nur "data" bleibt erhalten) und durch v54 ersetzt.
set /p "GO=Fortfahren? (j/n): "
if /i not "%GO%"=="j" goto :fail

for /f %%i in ('powershell -nologo -command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "BACKUP=%TARGET%_backup_%STAMP%"

echo.
echo [1/5] Sicherung der Daten nach "%BACKUP%" ...
if exist "%TARGET%\data" (
  robocopy "%TARGET%\data" "%BACKUP%\data" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 ( echo FEHLER: Sicherung fehlgeschlagen. Nichts wurde geloescht. & goto :fail )
)

echo [2/5] Alte Version 53 wird entfernt ...
for /d %%D in ("%TARGET%\*") do if /i not "%%~nxD"=="data" rd /s /q "%%D"
del /f /q "%TARGET%\*" >nul 2>nul
del /f /q /a:h "%TARGET%\*" >nul 2>nul

echo [3/5] Version 54 wird kopiert ...
robocopy "%SRC%" "%TARGET%" /E /XD data /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 ( echo FEHLER: Kopieren fehlgeschlagen. Daten-Sicherung: %BACKUP% & goto :fail )
if not exist "%TARGET%\data" mkdir "%TARGET%\data"

echo [4/5] Abhaengigkeiten werden installiert (kann dauern) ...
pushd "%TARGET%"
call npm install --no-audit --no-fund
if errorlevel 1 ( popd & echo FEHLER: npm install fehlgeschlagen. & goto :fail )

echo [5/5] Oberflaeche wird gebaut ...
call npm run build
if errorlevel 1 ( popd & echo FEHLER: Build fehlgeschlagen. & goto :fail )

echo.
echo ==================================================
echo   Fertig! Version 54 ist installiert in:
echo   %TARGET%
echo   Daten-Sicherung: %BACKUP%
echo   Starten mit:  npm start   (Browser: http://localhost:8080)
echo ==================================================
set /p "RUN=Jetzt starten? (j/n): "
if /i "%RUN%"=="j" call npm start
popd
pause
exit /b 0

:fail
echo.
echo Setup abgebrochen.
pause
exit /b 1
