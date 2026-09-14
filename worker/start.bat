@echo off
REM Start the ClipForge render worker.
cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo   No .env file found.
  echo   Copy .env.example to .env and paste your worker secret into it.
  echo.
  pause
  exit /b 1
)

docker compose up --build
pause
