# DSH 手机通道 —— 语音识别（Windows 自带 System.Speech，离线、免费）
#
# 输入：固定文件 <项目>\phone-bridge\runtime\asr\input.wav
#       （Node 侧每次把转码好的 16k/16bit/单声道 PCM 写到这里）
# 输出：stdout 一行 OK|<文本> 或 ERR|<信息>
#
# ⚠️ 三条硬约束，都是实测撞出来的（PowerShell 5.1 + System.Speech）：
#   1. 路径必须是脚本里的字面量。用 param 传参、读 $env、甚至 Get-Content 读文件，
#      同一个音频、同一个字符串，SetInputToWaveFile 之后 Recognize() 就报
#      「没有将任何音频数据提供给识别器」。所以 Node 侧负责把音频搬到固定位置。
#   2. Recognize() 绝对不能出现在 while/for 循环体里 —— 只要进循环，第一次调用就报同样的错。
#      因此这里只做"单次识别"，长录音按段由 Node 侧切开分别调用。
#   3. SetInputToWaveFile 不要放进 try 块（放进去同样会报错）。

Add-Type -AssemblyName System.Speech

# 输出必须是 UTF-8，否则 Node 侧读到的是 GBK 乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$path = 'D:\document\Remote Connect DSH\phone-bridge\runtime\asr\input.wav'

if (-not (Test-Path -LiteralPath $path)) {
  [Console]::Out.WriteLine('ERR|找不到音频文件')
  exit 0
}

$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
  Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if (-not $info) {
  [Console]::Out.WriteLine('ERR|本机没有中文语音识别引擎')
  exit 0
}

$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$e.SetInputToWaveFile($path)

try {
  $r = $e.Recognize()
  if ($r -and $r.Text) {
    [Console]::Out.WriteLine('OK|' + $r.Text.Trim())
  } else {
    [Console]::Out.WriteLine('OK|')
  }
} catch {
  $msg = $_.Exception.Message -replace "`r|`n", ' '
  [Console]::Out.WriteLine('ERR|' + $msg)
}
