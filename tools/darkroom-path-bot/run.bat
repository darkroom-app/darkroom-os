@echo off
REM Runs the bot and automatically restarts it if it ever crashes.
REM Put a shortcut to this file in shell:startup to have it start with Windows.
cd /d "%~dp0"

:loop
node darkroom-path-bot.js
echo.
echo Bot se zaustavio - restartujem za 5 sekundi... (zatvori ovaj prozor da ga trajno ugasis)
timeout /t 5 /nobreak >nul
goto loop
