@echo off
REM ============================================================
REM  Hackathon 2026 Review Hub - start the server
REM  Double-click this file, OR run it from a terminal.
REM  Keep this window OPEN during the whole event.
REM ============================================================
cd /d "%~dp0"
echo Starting Hackathon Review Hub...
echo.
echo   This machine : http://localhost:3000
echo   Others (LAN) : http://192.168.0.92:3000
echo.
echo Leave this window open. Press Ctrl+C to stop the server.
echo ============================================================
node server.js
pause
