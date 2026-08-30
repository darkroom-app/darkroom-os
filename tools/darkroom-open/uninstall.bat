@echo off
REM DARKROOM OS: removes the darkroom-open:// link handler installed by
REM install.bat - deletes the registry key and the installed helper.

setlocal
echo Uklanjam Darkroom Open helper...

reg delete "HKCU\Software\Classes\darkroom-open" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\DarkroomOpen" >nul 2>&1

echo Gotovo.
pause
