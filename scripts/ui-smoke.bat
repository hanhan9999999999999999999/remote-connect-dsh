@echo off
chcp 65001 >nul
REM 桌面端 UI 冒烟（无头 Edge）。可传 URL：ui-smoke.bat http://127.0.0.1:9891/
cd /d "%~dp0.."
node scripts\ui-smoke.mjs %*
echo.
pause
