@echo off
REM Stop the ClipForge render worker.
cd /d "%~dp0"
docker compose down
pause
