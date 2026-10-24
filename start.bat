@echo off
rem Double-click this file on Windows to start LILA.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Get it from https://nodejs.org ^(the LTS version^), then double-click this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing LILA ^(this takes a minute^)...
  call npm install
  if errorlevel 1 (
    echo Install failed.
    pause
    exit /b 1
  )
)
call npm start
pause
