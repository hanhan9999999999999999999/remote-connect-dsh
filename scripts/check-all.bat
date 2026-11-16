@echo off
setlocal
cd /d "%~dp0.."

rem One-shot self check. Usage:
rem   scripts\check-all.bat            static checks only (fast)
rem   scripts\check-all.bat --full     also run the three browser smokes

set FULL=0
if /i "%~1"=="--full" set FULL=1
set FAILS=0

rem full mode talks to the live service: give it a moment after a restart
if "%FULL%"=="1" (
  powershell -NoProfile -Command "$u='http://127.0.0.1:9890/api/health'; for($i=0;$i -lt 40;$i++){ try{ $r=Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } }catch{}; Start-Sleep -Milliseconds 500 }; exit 0" >nul 2>&1
)

echo.
echo [1/5] python syntax
python -m py_compile server.py db.py api_logger.py local_llm.py && echo   ok || (echo   FAIL & set /a FAILS+=1)
rem memory clear regression: derived relations/entities must be wiped with the fragments
python tools\selftest_memory_clear.py >nul 2>&1 && echo   memory-clear ok || (echo   memory-clear FAIL & set /a FAILS+=1)
rem 500 fallback: the message must be human-readable Chinese, detail keeps the raw exception
python tmp\test-err500.py >nul 2>&1 && echo   err500 ok || (echo   err500 FAIL & set /a FAILS+=1)
rem knowledge page compose: content column must be text, never a list (sqlite binding)
python tools\selftest_pages_content.py >nul 2>&1 && echo   pages ok || (echo   pages FAIL & set /a FAILS+=1)
rem same bug through the real absorb path: 3 observations must end up as version 1 with text content
python tmp\test-pages-absorb.py >nul 2>&1 && echo   pages-absorb ok || (echo   pages-absorb FAIL & set /a FAILS+=1)
rem log readability: network errors must not print GBK mojibake into the console
python tools\selftest_netnote.py >nul 2>&1 && echo   netnote ok || (echo   netnote FAIL & set /a FAILS+=1)
rem crystal recall must carry a score and must not ship embedding / full content to the client
python tools\selftest_crystal_recall.py >nul 2>&1 && echo   crystal-recall ok || (echo   crystal-recall FAIL & set /a FAILS+=1)
rem file version chain: history reads back, restore writes content, and the restore itself leaves an undo snapshot
python tools\selftest_file_versions.py >nul 2>&1 && echo   file-versions ok || (echo   file-versions FAIL & set /a FAILS+=1)
python tools\selftest_versions.py >nul 2>&1 && echo   code-versions ok || (echo   code-versions FAIL & set /a FAILS+=1)
python tools\selftest_backup_due.py >nul 2>&1 && echo   backup-due ok || (echo   backup-due FAIL & set /a FAILS+=1)

python tools\selftest_needs_key.py >nul 2>&1 && echo   needs-key ok || (echo   needs-key FAIL & set /a FAILS+=1)
python tools\selftest_token.py >nul 2>&1 && echo   token ok || (echo   token FAIL & set /a FAILS+=1)
python tools\selftest_dispatch_guard.py >nul 2>&1 && echo   dispatch-guard ok || (echo   dispatch-guard FAIL & set /a FAILS+=1)
python tools\selftest_topic_cleanup.py >nul 2>&1 && echo   topic-cleanup ok || (echo   topic-cleanup FAIL & set /a FAILS+=1)
rem chat pipeline: live stub model round-trip (only with --full; switches model then restores)
if "%FULL%"=="1" goto chatstub
echo   chat-stub skip ^(use --full^)
goto afterchatstub
:chatstub
python tools\selftest_chat_stub.py >nul 2>&1 && echo   chat-stub ok || (echo   chat-stub FAIL & set /a FAILS+=1)
:afterchatstub
rem path traversal: read-ish endpoints must not leak system files (needs running server)
if "%FULL%"=="1" goto trav
echo   traversal skip ^(use --full^)
goto aftertrav
:trav
python tools\selftest_traversal.py > "%~dp0..\tmp\traversal.log" 2>&1 && echo   traversal ok || (echo   traversal FAIL & type "%~dp0..\tmp\traversal.log" & set /a FAILS+=1)
:aftertrav
rem access log must rotate instead of growing forever
python tmp\test-access-rotate.py >nul 2>&1 && echo   access-rotate ok || (echo   access-rotate FAIL & set /a FAILS+=1)

echo [2/5] desktop inline scripts
python scripts\check-desktop-js.py >nul 2>&1 && echo   ok || (echo   FAIL - run: python scripts\check-desktop-js.py & set /a FAILS+=1)

echo [3/5] phone app scripts + unit tests
pushd phone-bridge
cmd /c "npm run check >nul 2>&1" && echo   check ok || (echo   check FAIL & set /a FAILS+=1)
cmd /c "npm test >nul 2>&1" && echo   test ok || (echo   test FAIL & set /a FAILS+=1)
popd

if "%FULL%"=="1" goto full

echo [4/5] api smoke - skipped, add --full to run
echo [5/5] ui smoke - skipped, add --full to run
goto done

:full
echo [4/5] api smoke
node scripts\api-smoke.mjs >nul 2>&1 && echo   ok || (echo   FAIL & set /a FAILS+=1)

echo [5/5] ui smoke
node scripts\ui-smoke.mjs > "%~dp0..\tmp\ui-smoke.log" 2>&1 && echo   ui ok || (echo   ui FAIL & type "%~dp0..\tmp\ui-smoke.log" & set /a FAILS+=1)
node scripts\phone-smoke.mjs >nul 2>&1 && echo   phone ok || (echo   phone FAIL & set /a FAILS+=1)

:done
echo.
if %FAILS%==0 echo ALL OK
if not %FAILS%==0 echo FAILED SECTIONS: %FAILS%
pause
endlocal
