@echo off
REM DARKROOM OS: one-time setup for the darkroom-open:// link handler.
REM Double-click this file. No admin rights needed (registers only for the
REM current Windows user, under HKEY_CURRENT_USER).
REM
REM What it does: copies darkroom-open.ps1 (must sit next to this .bat) into
REM %LOCALAPPDATA%\DarkroomOpen\, then registers a "darkroom-open" URL
REM protocol pointing at it. After this, clicking a "darkroom-open:..." link
REM (the "Otvori folder" button on the app.darkroomstudio.com/open.html page
REM linked from Discord) opens that exact folder in Windows Explorer.

setlocal
set "INSTALL_DIR=%LOCALAPPDATA%\DarkroomOpen"
set "SCRIPT_PATH=%INSTALL_DIR%\darkroom-open.ps1"

echo Instaliram Darkroom Open helper...

if not exist "%~dp0darkroom-open.ps1" (
  echo GRESKA: darkroom-open.ps1 mora da bude u istom folderu kao ovaj install.bat.
  pause
  exit /b 1
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%~dp0darkroom-open.ps1" "%SCRIPT_PATH%" >nul

reg add "HKCU\Software\Classes\darkroom-open" /ve /d "URL:Darkroom Open Protocol" /f >nul
reg add "HKCU\Software\Classes\darkroom-open" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\darkroom-open\shell\open\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%SCRIPT_PATH%\" \"%%1\"" /f >nul

echo.
echo Gotovo! Skripta je instalirana u: %SCRIPT_PATH%
echo Sada mozes da klikces na "Otvori folder" linkove iz Discord-a.
echo (Prvi put ce browser pitati da potvrdis otvaranje spoljne aplikacije - to je normalno, klikni Open/Dozvoli.)
echo.
pause
