@echo off
REM DARKROOM OS: one-time setup for the darkroom-open:// link handler.
REM Double-click this file. No admin rights needed (registers only for the
REM current Windows user, under HKEY_CURRENT_USER).
REM
REM What it does: compiles DarkroomOpen.cs (must sit next to this .bat) into
REM an .exe using the .NET Framework's built-in compiler (csc.exe, ships
REM with every Windows 10/11 machine - nothing to download), copies it into
REM %LOCALAPPDATA%\DarkroomOpen\, then registers a "darkroom-open" URL
REM protocol pointing at it. After this, clicking a "darkroom-open:..." link
REM (the "Otvori folder" button on the app.darkroomstudio.com/open.html page
REM linked from Discord) opens that exact folder in Windows Explorer.
REM
REM Compiled to a native .exe rather than shipped as a PowerShell script on
REM purpose: "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden
REM -File ..." is a well-known malware-loader command-line pattern that
REM endpoint security tools (Bitdefender etc.) flag on sight, regardless of
REM what the script actually does - a small compiled program that just opens
REM Explorer doesn't trip that heuristic.

setlocal
set "INSTALL_DIR=%LOCALAPPDATA%\DarkroomOpen"
set "EXE_PATH=%INSTALL_DIR%\DarkroomOpen.exe"

echo Instaliram Darkroom Open helper...

if not exist "%~dp0DarkroomOpen.cs" (
  echo GRESKA: DarkroomOpen.cs mora da bude u istom folderu kao ovaj install.bat.
  pause
  exit /b 1
)

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

set "CSC="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not defined CSC (
  echo GRESKA: nije pronadjen .NET Framework compiler ^(csc.exe^) na ovom racunaru.
  echo Ovo dolazi sa svakim Windows 10/11 racunarom - javi se ako vidis ovu poruku.
  pause
  exit /b 1
)

"%CSC%" /nologo /target:winexe /out:"%EXE_PATH%" /reference:System.Windows.Forms.dll "%~dp0DarkroomOpen.cs"
if errorlevel 1 (
  echo GRESKA: kompajliranje nije uspelo, vidi poruku iznad.
  pause
  exit /b 1
)

reg add "HKCU\Software\Classes\darkroom-open" /ve /d "URL:Darkroom Open Protocol" /f >nul
reg add "HKCU\Software\Classes\darkroom-open" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\darkroom-open\shell\open\command" /ve /d "\"%EXE_PATH%\" \"%%1\"" /f >nul

echo.
echo Gotovo! Instalirano u: %EXE_PATH%
echo Sada mozes da klikces na "Otvori folder" linkove iz Discord-a.
echo (Prvi put ce browser pitati da potvrdis otvaranje spoljne aplikacije - to je normalno, klikni Open/Dozvoli.)
echo.
pause
