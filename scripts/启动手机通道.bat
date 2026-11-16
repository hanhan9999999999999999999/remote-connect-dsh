@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0phone-bridge"

rem ---- 选一个能用的 node（优先选已被 Windows 防火墙放行的那个，手机才连得上）----
set "NODE="
for /d %%d in ("%LOCALAPPDATA%\openai\codex\runtimes\cua_node\*") do (
  if exist "%%d\bin\node.exe" set "NODE=%%d\bin\node.exe"
)
if not defined NODE set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo.
  echo   没找到 node.exe。请安装 Node.js 或设置环境变量 NODE 指向 node.exe。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 DSH 手机通道 ......
echo   node: %NODE%
echo.
"%NODE%" server.mjs

echo.
echo   通道已停止。按任意键关闭窗口。
pause >nul
