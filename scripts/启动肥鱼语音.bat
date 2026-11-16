@echo off
chcp 65001 >nul
setlocal
rem 启动肥鱼 CosyVoice3 本地语音服务（Windows 原生，不需要 WSL）
rem 用法：
rem   启动肥鱼语音.bat            启动（隐藏窗口，日志在 phone-bridge\runtime\feiyu-tts\service.log）
rem   启动肥鱼语音.bat console    前台启动，方便看加载日志
rem   启动肥鱼语音.bat stop       停止
rem   启动肥鱼语音.bat status     查看状态

set "ROOT=%~dp0"
if not defined FEIYU_HOME if exist "D:\feiyu\venv\Scripts\python.exe" set "FEIYU_HOME=D:\feiyu"
if not defined FEIYU_HOME (
  echo [x] 没找到肥鱼模型目录，请先设置 FEIYU_HOME，例如：
  echo     set FEIYU_HOME=D:\feiyu
  exit /b 1
)
set "PY=%FEIYU_HOME%\venv\Scripts\python.exe"
set "SVC=%ROOT%phone-bridge\tools\feiyu-tts-service.py"
set "STATE=%ROOT%phone-bridge\runtime\feiyu-tts"
if not defined FEIYU_TTS_PORT set "FEIYU_TTS_PORT=8898"

if not exist "%PY%" (
  echo [x] 没找到 Python：%PY%
  echo     请确认 FEIYU_HOME 指向含 venv\cosyvoice\models 的目录。
  exit /b 1
)
if not exist "%SVC%" (
  echo [x] 没找到服务脚本：%SVC%
  exit /b 1
)

if /i "%~1"=="stop" goto :stop
if /i "%~1"=="status" goto :status
if /i "%~1"=="console" goto :console

rem ---- 已在运行就不重复起（端口以 state 文件为准，肥鱼可能因 8898 被占换了端口） ----
powershell -NoProfile -Command "$sf='%STATE%\service.json'; try { $s=Get-Content $sf -Raw | ConvertFrom-Json; $r=Invoke-RestMethod -Uri ('http://127.0.0.1:' + $s.port + '/health') -TimeoutSec 2; if ($r.ok -and $r.service -eq 'feiyu-tts') { Write-Output ('[=] 已在运行 pid=' + $r.pid + ' port=' + $s.port + ' ready=' + $r.ready + ' style=' + $r.style); exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo [=] 肥鱼语音服务已在运行
  exit /b 0
)

echo [*] 启动肥鱼语音服务（首次加载模型约 10-60 秒）...
powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList '-u','\"%SVC%\"','--home','\"%FEIYU_HOME%\"','--port','%FEIYU_TTS_PORT%','--state-dir','\"%STATE%\"' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$sf='%STATE%\service.json'; for ($i=0; $i -lt 80; $i++) { try { if (Test-Path $sf) { $s=Get-Content $sf -Raw | ConvertFrom-Json; $r=Invoke-RestMethod -Uri ('http://127.0.0.1:' + $s.port + '/health') -TimeoutSec 2; if ($r.ok -and $r.service -eq 'feiyu-tts') { Write-Output ('[ok] port=' + $s.port + ' ready=' + $r.ready + ' loading=' + $r.loading + ' style=' + $r.style + ' device=' + $r.device); exit 0 } } } catch {}; Start-Sleep -Milliseconds 750 }; Write-Output '[!] 60 秒内没等到服务，看日志：%STATE%\service.log'; exit 1"
exit /b %errorlevel%

:console
echo [*] 前台启动，Ctrl+C 停止
"%PY%" -u "%SVC%" --home "%FEIYU_HOME%" --port %FEIYU_TTS_PORT% --state-dir "%STATE%"
exit /b %errorlevel%

:stop
powershell -NoProfile -Command "try { $s=Get-Content '%STATE%\service.json' -Raw | ConvertFrom-Json; Invoke-RestMethod -Uri ('http://127.0.0.1:' + $s.port + '/shutdown') -Method Post -Headers @{ 'X-Feiyu-Token'=$s.token } -TimeoutSec 5 | Out-Null; Write-Output '[ok] 已请求停止'; exit 0 } catch { Write-Output '[!] 服务没在跑，或停止请求失败'; exit 1 }"
exit /b %errorlevel%

:status
powershell -NoProfile -Command "$sf='%STATE%\service.json'; if (-not (Test-Path $sf)) { Write-Output '[!] 没在运行（没有 state 文件）'; exit 0 }; try { $s=Get-Content $sf -Raw | ConvertFrom-Json; $r=Invoke-RestMethod -Uri ('http://127.0.0.1:' + $s.port + '/health') -TimeoutSec 3; $r | ConvertTo-Json -Depth 4 } catch { Write-Output ('[!] 没在运行（state 里是端口 ' + $s.port + '，没有响应）') }"
exit /b 0
