# DSH 手机通道 —— 语音识别 worker（Windows 自带 System.Speech，离线、免费）
#
# 协议（一行一次）：
#   输入  <wav 绝对路径 base64>|<语言，可空，默认 zh-CN>
#   输出  OK|<识别文本>   /   ERR|<错误信息>   /   DBG|<诊断>
#   输入  QUIT  → 退出
#
# 两个已踩的坑（改动前务必看）：
#   1. 不要设 `$ErrorActionPreference = 'Stop'`。它会和 SpeechRecognitionEngine 内部
#      的软错误打架，表现为 SetInputToWaveFile 看似成功、Recognize() 却报
#      「没有将任何音频数据提供给识别器」。
#   2. System.Speech 只吃 16k / 16bit / 单声道 PCM wav，转换由 Node 侧 ffmpeg 完成
#      （且必须 `-map_metadata -1 -fflags +bitexact`，否则带着 LIST 块也会被拒）。

Add-Type -AssemblyName System.Speech

function Get-Engine([string]$culture) {
  $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq $culture } | Select-Object -First 1
  if (-not $info) {
    $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
      Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  }
  if (-not $info) { throw "本机没有可用的语音识别引擎" }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  return $engine
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'QUIT') { break }

  $parts = $line.Split('|')
  $text = ''
  try {
    $bytes = [Convert]::FromBase64String($parts[0].Trim())
    $path = [System.Text.Encoding]::UTF8.GetString($bytes).Trim()
    $culture = 'zh-CN'
    if ($parts.Count -ge 2 -and $parts[1].Trim()) { $culture = $parts[1].Trim() }

    if (-not (Test-Path -LiteralPath $path)) { throw "找不到文件：$path" }

    $engine = Get-Engine $culture
    $engine.SetInputToWaveFile($path)
    $sb = New-Object System.Text.StringBuilder
    while ($true) {
      $r = $engine.Recognize()
      if ($null -eq $r) { break }
      if ($r.Text) { [void]$sb.Append($r.Text) }
    }
    $engine.SetInputToNull()
    $text = $sb.ToString().Trim()
    [Console]::Out.WriteLine('OK|' + $text)
  } catch {
    [Console]::Out.WriteLine('ERR|' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
