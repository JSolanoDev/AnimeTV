@echo off
cd /d "%~dp0"
echo Starting AnimeTV supervised launcher...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
