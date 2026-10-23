@echo off
title League Remote
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org - or download LeagueRemote.exe from the Releases page instead. & pause & exit /b 1)
if not exist node_modules (echo Installing... & call npm install --omit=dev --no-fund --no-audit || (pause & exit /b 1))
node server.js
pause
