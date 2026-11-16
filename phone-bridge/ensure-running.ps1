# DSH 手机通道守护脚本（幂等）
# ⚠ 本文件必须以 UTF-8 BOM 保存：Windows PowerShell 5.1 没有 BOM 会按 GBK 读，中文注释会让脚本解析失败。
#
# 职责只有一个：桥接没在服务，就把它重新拉起来（端口读 runtime/port.json）。
#   - 活着 → 立刻退出（登录项 DSH-Phone-Guard.vbs 每分钟都会探一次，只在失败时调这里）
#   - 半死不活（进程在但不响应）→ 杀掉重启
#   - 并发调用 → 用锁跳过，避免两个进程抢同一个端口打出 EADDRINUSE
#
# SeekMemory 内核由 ensure-seekmemory.ps1 单独看护（VBS 每次都会调），这里不再重复。
# 兼容 Windows PowerShell 5.1（VBS 用 powershell.exe 调它）。

param([switch]$Guard)  # 守护脚本调用时带 -Guard；插件/人手调用不带，表示「这次是主动要开」
$ErrorActionPreference = 'Continue'
$root = 'D:\document\Remote Connect DSH\phone-bridge'
$log = Join-Path $root 'runtime\ensure.log'

# 端口跟着 runtime\port.json 走（插件换端口后不用改这个脚本）。
# 读不到 / 内容坏了就退回 8899 —— 守护脚本永远不该因为配置缺失而停摆。
$port = 8899
try {
  $pf = Join-Path $root 'runtime\port.json'
  if (Test-Path $pf) {
    $pj = Get-Content $pf -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($pj -and $pj.port -and [int]$pj.port -ge 1024 -and [int]$pj.port -le 65535) { $port = [int]$pj.port }
  }
} catch {}

function Note([string]$msg) {
  try {
    $line = '{0}Z {1}' -f (Get-Date).ToUniversalTime().ToString('s'), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    $item = Get-Item $log -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt 204800) {
      $tail = Get-Content $log -Tail 300
      Set-Content -Path $log -Value $tail -Encoding UTF8
    }
  } catch {}
}

function Test-Bridge {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 ('http://127.0.0.1:{0}/api/health' -f $port)
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Invoke-Ensure {
  # 活着就退出（最常见的一条路径，必须最快）
  if (Test-Bridge) { return 0 }

  # 拿锁期间别的进程可能已经拉起来了
  if (Test-Bridge) { Note 'ALIVE 竞争窗口内已由他处拉起'; return 0 }

  # 1) 清掉半死不活的旧桥接进程
  #    注意：桥接的启动命令行是 `node.exe server.mjs`，不含目录，
  #    所以只能靠端口占用者找（旧版按命令行匹配 phone-bridge 永远匹配不上，
  #    于是每次守护都起第二个进程，冒出 EADDRINUSE）。
  $victims = @()
  foreach ($l in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $pr = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    if ($pr -and $pr.ProcessName -eq 'node') { $victims += $l.OwningProcess }
    else { Note ('WARN 端口 {0} 被非 node 进程 pid={1} 占用' -f $port, $l.OwningProcess) }
  }
  # 兜底：还活着的 server.mjs 孤儿（没在监听端口的那种）
  $orphans = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\.mjs' })
  foreach ($o in $orphans) { if ($victims -notcontains $o.ProcessId) { $victims += $o.ProcessId } }
  $victims = @($victims | Select-Object -Unique)
  if ($victims.Count -gt 0) {
    Note ('KILL 旧进程不响应 pid={0}' -f ($victims -join ','))
    foreach ($v in $victims) { Stop-Process -Id $v -Force -ErrorAction SilentlyContinue }
    for ($k = 0; $k -lt 15; $k++) {
      Start-Sleep -Milliseconds 300
      if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) { break }
    }
  }

  # 2) 端口还被别人占着就别硬启，留下证据
  $owner = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($owner.Count -gt 0) {
    Note ('WARN 端口 {0} 仍被 pid={1} 占用，本次不启动' -f $port, (($owner | ForEach-Object OwningProcess) -join ','))
    return 1
  }

  # 3) 选 node：优先防火墙已放行的 codex node，其次 DSH 自带 node，最后 PATH 里的
  $node = $null
  $codexCandidates = Get-ChildItem -Path "$env:LOCALAPPDATA\openai\codex\runtimes\cua_node" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'bin\node.exe' } |
    Where-Object { Test-Path $_ }
  if ($codexCandidates) { $node = @($codexCandidates)[-1] }
  if (-not $node) {
    $dshNode = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $dshNode) { $node = $dshNode }
  }
  if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
  }
  if (-not $node) { Note 'ERROR 找不到可用的 node.exe'; return 1 }

  # 4) 启动（隐藏窗口、脱离父进程）
  $stdout = Join-Path $root 'runtime\daemon.log'
  $stderr = Join-Path $root 'runtime\daemon.err.log'
  $proc = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Note ('STARTED bridge pid={0} node={1}' -f $proc.Id, $node)

  # 5) 等它真的能服务（索引预热 + 插件同步，最多 30 秒）
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Bridge) {
      Note ('READY bridge pid={0} after {1}s' -f $proc.Id, ($i + 1))
      return 0
    }
    if ($proc.HasExited) { break }
  }

  $errTail = ''
  try { $errTail = (Get-Content $stderr -Tail 3 -ErrorAction SilentlyContinue) -join ' | ' } catch {}
  Note ('ERROR 启动后未就绪 pid={0} exited={1} err={2}' -f $proc.Id, $proc.HasExited, $errTail)
  return 1
}

# 手动关闭（插件里点「关闭远程服务」）→ 什么都不做，等用户再点「开启」
if ($Guard -and (Test-Path (Join-Path $root 'runtime\paused.flag'))) { Note 'PAUSED 已被手动关闭，守护跳过启动'; exit 0 }
if ((Test-Path (Join-Path $root 'runtime\paused.flag')) -and -not $Guard) { Remove-Item (Join-Path $root 'runtime\paused.flag') -Force -ErrorAction SilentlyContinue; Note 'RESUME 收到主动开启请求，清掉 paused.flag' }

# 若入口已经在服务，直接退出，连锁都不碰
if (Test-Bridge) { exit 0 }

# 并发保护：90 秒内的锁文件说明另一次启动正在进行
$lock = Join-Path $root 'runtime\ensure.lock'
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalSeconds -lt 90) { Note 'SKIP 已有一次启动在进行中'; exit 0 }
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType File -Path $lock -Force | Out-Null
$code = 1
try {
  $code = Invoke-Ensure
} catch {
  Note ('ERROR 守护脚本异常：{0}' -f $_.Exception.Message)
  $code = 1
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
exit $code
