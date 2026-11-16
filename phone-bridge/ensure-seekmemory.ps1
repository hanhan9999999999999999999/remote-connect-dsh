# ⚠ 本文件必须以 UTF-8 BOM 保存：Windows PowerShell 5.1 没有 BOM 会按 GBK 读，中文注释会让脚本解析失败。
# SeekMemory 内核守护（独立于桥接守护，互不影响）
# 幂等：healthz 200 就直接退出。
#
# v2 修的问题：
#   · python 内核冷启动经常要 20 秒以上，旧版 20 秒就判死，下一轮又拉一个，
#     于是两个内核抢 8791，日志里全是「启动后 20 秒仍未就绪」。
#   · 旧版只看端口占用者，正在启动（还没监听）的内核杀不到，会叠出第二个进程。
#     现在先按命令行找内核进程，给它时间，超时才杀。
$root = 'D:\document\Remote Connect DSH\phone-bridge'
$smLog = Join-Path $root 'runtime\ensure.log'
$smData = Join-Path $root 'runtime\seekmemory'
$smPort = 8791
$smToken = 'seekmemory_kernel_token_0123456789abcdef'
$smKernel = Join-Path $root 'seekmemory-kernel.py'

function Note($m) {
  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -Path $smLog -Value ("$ts $m") -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Test-Kernel {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ("http://127.0.0.1:{0}/healthz" -f $smPort) -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-KernelProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'seekmemory-kernel\.py' })
}

# 1) 活着就退出
if (Test-Kernel) { exit 0 }

# 2) 找 python
$py = $null
foreach ($c in @("$env:LOCALAPPDATA\Programs\Python", "$env:USERPROFILE\AppData\Local\Programs\Python")) {
  if (Test-Path $c) {
    $cand = Get-ChildItem $c -Filter python.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $py = $cand.FullName; break }
  }
}
if (-not $py) { $py = (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe') }
if (-not (Test-Path $py) -or -not (Test-Path $smKernel)) { Note 'SEEKMEMORY WARN 缺 python 或 kernel 脚本'; exit 1 }

# 3) 已有内核进程但还没服务：先等它（最多 45 秒），别急着再拉一个
$procs = Get-KernelProcs
if ($procs.Count -gt 0) {
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Kernel) { Note ('SEEKMEMORY READY (等已有进程 pid={0})' -f (($procs | ForEach-Object ProcessId) -join ',')); exit 0 }
  }
  Note ('SEEKMEMORY KILL 已有进程等不到就绪 pid={0}' -f (($procs | ForEach-Object ProcessId) -join ','))
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

# 4) 端口残留（非内核进程占着就报出来）
$old = @(Get-NetTCPConnection -LocalPort $smPort -State Listen -ErrorAction SilentlyContinue)
if ($old.Count -gt 0) {
  $old | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

# 5) 拉起（注意别用 $args，它是 PowerShell 的自动变量）
New-Item -ItemType Directory -Force -Path $smData | Out-Null
$argList = @("`"$smKernel`"", '--data-dir', "`"$smData`"", '--port', "$smPort", '--token', $smToken)
$p = Start-Process -FilePath $py -ArgumentList $argList -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $smData 'kernel.log') `
  -RedirectStandardError (Join-Path $smData 'kernel.err.log')
Note ('SEEKMEMORY STARTED pid={0} python={1}' -f $p.Id, $py)

# 6) 最多等 45 秒（python 冷启动 + 加载索引）
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Kernel) { Note ('SEEKMEMORY READY after {0}s' -f ($i + 1)); exit 0 }
  if ($p.HasExited) { break }
}
$errTail = ''
try { $errTail = (Get-Content (Join-Path $smData 'kernel.err.log') -Tail 3 -ErrorAction SilentlyContinue) -join ' | ' } catch {}
Note ('SEEKMEMORY ERROR 未就绪 exited={0} err={1}' -f $p.HasExited, $errTail)
exit 1
