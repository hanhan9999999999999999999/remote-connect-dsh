@echo off
chcp 65001 >nul
echo.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8899" ^| findstr LISTENING') do (
  echo   结束进程 PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
echo   DSH 手机通道已停止。
echo.
timeout /t 2 >nul
