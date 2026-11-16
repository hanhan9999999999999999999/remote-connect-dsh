# 通过本机 VPN 插件（mihomo）的代理，把 phone-camera 分支推到 GitHub。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-github.ps1
#       可选 -Branch main 指定要推的目标分支（默认 phone-camera）
#       可选 -Proxy http://127.0.0.1:7891 指定代理端口
param(
  [string]$Branch = 'phone-camera',
  [string]$Proxy  = 'http://127.0.0.1:7891',
  [string]$Source = 'publish-clean'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# 1) 代理先确认活着：探一次 github.com，不通就直接说清楚，不浪费一次推送
Write-Host "[1/4] 探代理 $Proxy ..."
# schannel 在这条代理上握手经常失败，探测也走 --ssl-no-revoke；curl 自己报错不等于代理死了，
# 再退一步只看端口有没有人监听，真正的结论交给下面那次 git push。
$_prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$probe = & curl.exe -x $Proxy -sS --ssl-no-revoke -o NUL -w '%{http_code}' -m 20 https://github.com 2>$null
$ErrorActionPreference = $_prevEap
if ($probe -ne '200') {
  $alive = Test-NetConnection -ComputerName ([Uri]$Proxy).Host -Port ([Uri]$Proxy).Port -InformationLevel Quiet -WarningAction SilentlyContinue
  if (-not $alive) { throw "代理不通（$Proxy 没有监听）。先确认 VPN 插件在跑。" }
  Write-Host "      github.com 探测返回 $probe（握手抖动），端口在听，继续试推送"
} else {
  Write-Host "      代理通了（200）"
}

# 2) 令牌从 .git-credentials 取，不打印
$credFile = Join-Path $env:USERPROFILE '.git-credentials'
if (-not (Test-Path $credFile)) { throw "找不到 $credFile，先登录一次 GitHub" }
$line = Get-Content $credFile | Where-Object { $_ -match 'github\.com' } | Select-Object -First 1
if (-not $line) { throw "$credFile 里没有 github.com 的凭据" }
$user = ($line -split '//')[1].Split(':')[0]
$tok  = (($line -split '//')[1].Split(':')[1] -replace '@github\.com.*$', '')
if (-not $tok) { throw '凭据里取不到令牌' }

# 3) 推送：schannel 在这个代理上握手会失败，固定用 openssl + TLS1.2 + HTTP/1.1；
#    凭据管理器会弹窗卡住，所以这一次推送不带它，直接把令牌放进 URL
Write-Host "[2/4] 推 $Source -> origin/$Branch"
$env:GIT_TERMINAL_PROMPT = '0'
$url = "https://${user}:${tok}@github.com/${user}/remote-connect-dsh.git"
$gitArgs = @(
  '-c', "http.proxy=$Proxy",
  '-c', 'credential.helper=',
  '-c', 'http.sslBackend=openssl',
  '-c', 'http.sslVersion=tlsv1.2',
  '-c', 'http.version=HTTP/1.1',
  'push', '--force', $url, "refs/heads/${Source}:refs/heads/$Branch"
)
# git 把进度写 stderr，$ErrorActionPreference='Stop' 会把它当成异常，这里临时放松
$ErrorActionPreference = 'Continue'
$out = & git @gitArgs 2>&1
$ErrorActionPreference = 'Stop'
$code = $LASTEXITCODE
$out | ForEach-Object { $_ -replace [regex]::Escape($tok), '***' } | Select-Object -Last 4
if ($code -ne 0) { throw "推送失败（exit $code）" }

# 4) 远端核对：远端那个分支的 sha 必须等于本地快照
Write-Host "[3/4] 核对远端"
$local = (& git rev-parse $Source).Trim()
$remote = (& git -c "http.proxy=$Proxy" -c 'credential.helper=' -c 'http.sslBackend=openssl' -c 'http.version=HTTP/1.1' ls-remote --heads $url "refs/heads/$Branch" 2>$null)
$remoteSha = ($remote -split "`t")[0]
Write-Host "      本地 $Source = $local"
Write-Host "      远端 $Branch = $remoteSha"
if ($remoteSha -ne $local) { throw "远端 sha 与本地快照不一致，推送没真正落地" }

Write-Host "[4/4] OK：https://github.com/$user/remote-connect-dsh/tree/$Branch"
