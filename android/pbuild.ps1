# 原生命令（javac/d8）会往 stderr 写提示，Stop 模式下会被当终止错误，所以用 Continue + 退出码判断
$ErrorActionPreference = 'Continue'
# Build DSH-Phone.apk without gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner
$SDK   = 'C:\android-sdk'
$BT    = Join-Path $SDK 'build-tools\34.0.0'
$AJAR  = Join-Path $SDK 'platforms\android-34\android.jar'
$SRC   = 'D:\document\Remote Connect DSH\android'
$WORK  = 'C:\dshbuild'
$DIST  = 'D:\document\Remote Connect DSH\dist'
$KEYST = Join-Path $DIST 'dsh-phone.keystore'
$JAVA  = Join-Path $env:JAVA_HOME 'bin\java.exe'
$JAVAC = Join-Path $env:JAVA_HOME 'bin\javac.exe'
$KT    = Join-Path $env:JAVA_HOME 'bin\keytool.exe'

Write-Host '== 1. clean work dir'
if (Test-Path $WORK) { Remove-Item $WORK -Recurse -Force }
New-Item -ItemType Directory -Path $WORK | Out-Null
New-Item -ItemType Directory -Path (Join-Path $WORK 'apk') | Out-Null
Copy-Item (Join-Path $SRC 'AndroidManifest.xml') $WORK
Copy-Item (Join-Path $SRC 'res') $WORK -Recurse
Copy-Item (Join-Path $SRC 'java') $WORK -Recurse

# 公网入口不写进源码：从 android/local.properties 读（该文件不入库），
# 没有就退成示例域名，谁 clone 都能编译，但不知道你的真实地址。
$cfgFile = Join-Path $SRC 'local.properties'
$publicHost = 'https://dsh.example.com/dsh'
$legacyHost = ''
if (Test-Path $cfgFile) {
  foreach ($line in Get-Content $cfgFile) {
    if ($line -match '^\s*dsh\.public\s*=\s*(.+?)\s*$') { $publicHost = $Matches[1] }
    if ($line -match '^\s*dsh\.legacy\s*=\s*(.+?)\s*$') { $legacyHost = $Matches[1] }
  }
}
New-Item -ItemType Directory -Path (Join-Path $WORK 'java\com\dsh\phone') -Force | Out-Null
@"
package com.dsh.phone;
// 构建时生成，不入库。真值来自 android/local.properties。
public final class BuildConfig {
    public static final String DEFAULT_PUBLIC = "$publicHost";
    public static final String LEGACY_PUBLIC = "$legacyHost";
    private BuildConfig() {}
}
"@ | Set-Content -Path (Join-Path $WORK 'java\com\dsh\phone\BuildConfig.java') -Encoding ASCII
Write-Host "   entry: $publicHost"

Push-Location $WORK
try {
  Write-Host '== 2. aapt2 compile'
  & (Join-Path $BT 'aapt2.exe') compile --dir res -o res.zip
  if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

  Write-Host '== 3. aapt2 link'
  & (Join-Path $BT 'aapt2.exe') link -I $AJAR --manifest AndroidManifest.xml -R res.zip --java gen `
      --min-sdk-version 24 --target-sdk-version 34 --version-code 2 --version-name 1.1 `
      --auto-add-overlay -o apk\base.apk
  if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

  Write-Host '== 4. javac'
  # javac 的 @argfile 把反斜杠当转义符，必须用正斜杠且不加引号
  $srcs = Get-ChildItem -Recurse -Filter *.java | ForEach-Object { $_.FullName.Replace('\', '/') }
  Set-Content -Path sources.txt -Value $srcs -Encoding ASCII
  New-Item -ItemType Directory -Path classes | Out-Null
  # 注意：javac 会往 stderr 写「注意: 使用了过时的 API」，在 ErrorActionPreference=Stop 下
  # 直接用 2>&1 管道会把它当终止错误；这里统一重定向到日志文件，只看退出码。
  & $JAVAC -source 8 -target 8 -nowarn -parameters -bootclasspath $AJAR -classpath $AJAR -d classes '@sources.txt' *> javac.log
  if ($LASTEXITCODE -ne 0) {
    Get-Content javac.log -Tail 20 | ForEach-Object { Write-Host "   $_" }
    throw 'javac failed'
  }
  Write-Host ('   class 文件: ' + (Get-ChildItem -Recurse classes -Filter *.class).Count)

  Write-Host '== 5. d8'
  $cls = Get-ChildItem -Recurse -Filter *.class classes | ForEach-Object { $_.FullName }
  New-Item -ItemType Directory -Path dex | Out-Null
  & $JAVA -cp (Join-Path $BT 'lib\d8.jar') com.android.tools.r8.D8 --lib $AJAR --min-api 24 --output dex @cls *> d8.log
  if ($LASTEXITCODE -ne 0) {
    Get-Content d8.log -Tail 25 | ForEach-Object { Write-Host "   $_" }
    throw 'd8 failed'
  }

  Write-Host '== 6. add classes.dex into apk'
  # 以前这里写死 C 盘的 dsh-runtimes 路径，搬盘后就不存在了 —— 逐个试，选第一个活着的。
  $pyCands = @(
    'D:\dsh-home\dsh-runtimes\dsh-next-primary-runtime\dependencies\python\python.exe',
    "$env:USERPROFILE\AppData\Local\Programs\Python\Python311\python.exe",
    'C:\windows\py.exe'
  )
  $py = $pyCands | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $py) { throw 'python not found' }
  $pycode = @'
import zipfile, shutil, sys
src, dst, dex = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("dex size", __import__("os").path.getsize(dex))
'@
  $pyp = Join-Path $env:TEMP 'adddex.py'
  [System.IO.File]::WriteAllText($pyp, $pycode, (New-Object System.Text.UTF8Encoding($false)))
  & $py $pyp (Join-Path $WORK 'apk\base.apk') (Join-Path $WORK 'apk\with-dex.apk') (Join-Path $WORK 'dex\classes.dex')
  if ($LASTEXITCODE -ne 0) { throw 'add dex failed' }

  Write-Host '== 7. zipalign'
  & (Join-Path $BT 'zipalign.exe') -f -p 4 apk\with-dex.apk apk\aligned.apk
  if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

  Write-Host '== 8. keystore'
  if (-not (Test-Path $KEYST)) {
    & $KT -genkeypair -keystore $KEYST -alias dsh -keyalg RSA -keysize 2048 -validity 10950 `
        -storepass dshphone -keypass dshphone `
        -dname "CN=DSH Phone Bridge,OU=Local,O=Local,L=Local,S=Local,C=CN" 2>&1 | Out-Null
  }
  Copy-Item $KEYST (Join-Path $WORK 'k.jks') -Force

  Write-Host '== 9. sign'
  & $JAVA -jar (Join-Path $BT 'lib\apksigner.jar') sign --ks k.jks --ks-pass pass:dshphone --key-pass pass:dshphone `
      --min-sdk-version 24 --out apk\DSH-Phone.apk apk\aligned.apk
  if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

  Write-Host '== 10. verify'
  & $JAVA -jar (Join-Path $BT 'lib\apksigner.jar') verify --print-certs apk\DSH-Phone.apk

  Copy-Item apk\DSH-Phone.apk (Join-Path $DIST 'DSH-Phone.apk') -Force
  $size = (Get-Item (Join-Path $DIST 'DSH-Phone.apk')).Length
  Write-Host "== done: $size bytes -> $DIST\DSH-Phone.apk"
}
finally {
  Pop-Location
}
