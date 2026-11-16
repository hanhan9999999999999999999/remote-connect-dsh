@echo off
chcp 65001 >nul
title 放行 DSH 手机通道端口 8899
echo.
echo   这一步需要管理员权限。如果弹出 UAC 提示，请点“是”。
echo.
net session >nul 2>&1
if errorlevel 1 (
  echo   正在以管理员身份重新启动本脚本 ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo   添加规则：TCP 8899（手机访问通道）
netsh advfirewall firewall delete rule name="DSH Phone Bridge 8899" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Phone Bridge 8899" dir=in action=allow protocol=TCP localport=8899 profile=any
echo   添加规则：UDP 8899（手机自动发现电脑）
netsh advfirewall firewall delete rule name="DSH Phone Bridge Discovery 8899" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Phone Bridge Discovery 8899" dir=in action=allow protocol=UDP localport=8899 profile=any
echo.
echo   完成。现在手机和电脑连同一个 Wi-Fi，打开手机上的「DSH 手机通道」即可。
echo.
pause
