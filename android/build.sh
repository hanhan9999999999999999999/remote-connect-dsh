#!/usr/bin/env bash
# 手工把 DSH 手机通道打成一个可安装 APK（aapt2 + javac + d8 + zipalign + apksigner）。
# 全程在无空格目录 C:\dshbuild 里做；d8/apksigner 直接跑 jar，避开 .bat 的引号麻烦。
set -euo pipefail

SRC="/d/document/Remote Connect DSH/android"
DIST="/d/document/Remote Connect DSH/dist"
SDK="/c/android-sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
D8="$BT/lib/d8.jar"
APKSIGNER="$BT/lib/apksigner.jar"
WORK="/c/dshbuild"
# python 用哪一份：优先环境变量，其次用户目录下的 dsh 运行时（别把用户名写进仓库）
PY="${DSH_PY:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe}"
[ -x "$PY" ] || PY="python"
KS_PASS="dshphone"

[ -f "$PLATFORM" ] || { echo "缺 android.jar：$PLATFORM"; exit 1; }
[ -x "$BT/aapt2.exe" ] || { echo "缺 aapt2：$BT"; exit 1; }
[ -f "$D8" ] || { echo "缺 d8.jar"; exit 1; }
[ -f "$APKSIGNER" ] || { echo "缺 apksigner.jar"; exit 1; }

echo "== 1. 同步源码到 $WORK"
rm -rf "$WORK"
mkdir -p "$WORK/gen" "$WORK/classes" "$WORK/dex" "$WORK/apk"
cp -r "$SRC/AndroidManifest.xml" "$SRC/java" "$SRC/res" "$WORK/"
cd "$WORK"

echo "== 2. aapt2 compile 资源"
"$BT/aapt2.exe" compile --dir res -o res.zip
echo "   res.zip: $(stat -c %s res.zip) bytes"

echo "== 3. aapt2 link → 带资源、未签名的 APK + R.java"
"$BT/aapt2.exe" link \
  -o apk/base.apk \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  -R res.zip \
  --java gen \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 2 \
  --version-name 1.1 \
  --auto-add-overlay
echo "   base.apk: $(stat -c %s apk/base.apk) bytes"

echo "== 4. javac 编译 Java（以 android.jar 为 bootclasspath，无 lambda）"
find java gen -name '*.java' > sources.txt
if ! javac -source 8 -target 8 -nowarn -parameters \
      -bootclasspath "$PLATFORM" \
      -classpath "$PLATFORM" \
      -d classes \
      @sources.txt; then
  echo "!! javac 失败"
  exit 1
fi
echo "   类文件: $(find classes -name '*.class' | wc -l)"

echo "== 5. d8 → classes.dex"
CLASSES=$(find classes -name '*.class' | tr '\n' ' ')
java -cp "$D8" com.android.tools.r8.D8 \
  --lib "$PLATFORM" --min-api 24 --output dex $CLASSES
ls -l dex/

echo "== 6. 把 classes.dex 塞进 APK"
"$PY" - <<'PYEOF'
import zipfile, shutil, os
src = r"C:\dshbuild\apk\base.apk"
dst = r"C:\dshbuild\apk\with-dex.apk"
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(r"C:\dshbuild\dex\classes.dex", "classes.dex")
print("   with-dex.apk:", os.path.getsize(dst), "bytes")
PYEOF

echo "== 7. zipalign"
"$BT/zipalign.exe" -f -p 4 apk/with-dex.apk apk/aligned.apk
echo "   aligned.apk: $(stat -c %s apk/aligned.apk) bytes"

echo "== 8. 签名密钥（首次生成后复用）"
if [ ! -f dsh-phone.keystore ] && [ -f "/d/document/Remote Connect DSH/dist/dsh-phone.keystore" ]; then
  cp -f "/d/document/Remote Connect DSH/dist/dsh-phone.keystore" dsh-phone.keystore
fi
if [ ! -f dsh-phone.keystore ]; then
  keytool -genkeypair -v \
    -keystore dsh-phone.keystore -alias dsh -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=DSH Phone Bridge, OU=Local, O=Local, L=Local, S=Local, C=CN" 2>&1 | tail -2
fi

echo "== 9. apksigner 签名"
java -jar "$APKSIGNER" sign \
  --ks dsh-phone.keystore --ks-key-alias dsh \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --min-sdk-version 24 \
  --out apk/DSH-Phone.apk apk/aligned.apk

echo "== 10. 校验"
java -jar "$APKSIGNER" verify --verbose --print-certs apk/DSH-Phone.apk | head -14
echo "--- badging:"
"$BT/aapt2.exe" dump badging apk/DSH-Phone.apk | head -6

mkdir -p "$DIST"
cp apk/DSH-Phone.apk "$DIST/DSH-Phone.apk"
cp dsh-phone.keystore "$DIST/dsh-phone.keystore"
echo "== 完成：$DIST/DSH-Phone.apk ($(stat -c %s "$DIST/DSH-Phone.apk") bytes)"
