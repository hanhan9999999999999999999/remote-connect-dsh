@echo off
title Restart DSH
echo.
echo   Restarting DeepSeek Harness ...
echo   (plugin changes only take effect after a restart)
echo.
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "D:\deepseekharness\DeepSeek Harness.exe"
echo   Done. The app is starting; the phone bridge plugin loads with it.
timeout /t 3 /nobreak >nul
