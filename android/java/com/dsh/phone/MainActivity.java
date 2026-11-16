package com.dsh.phone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.media.MediaRecorder;
import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.HandlerThread;
import android.provider.MediaStore;
import android.util.Base64;
import java.nio.ByteBuffer;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Enumeration;
// 直播预览（TextureView 盖在 WebView 上面，Camera2 常开会话）
import android.graphics.SurfaceTexture;
import android.view.Surface;
import android.view.TextureView;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;

/**
 * DSH 手机通道：手机上的壳，把电脑端 phone-bridge 的网页装进来。
 *
 * 两种界面：
 *   1. 配对页（原生控件：电脑地址 + 6 位配对码，或局域网自动发现）
 *   2. 聊天页（WebView 打开 http://电脑:8899/?t=令牌）
 *
 * 刻意不用 lambda / 第三方库：只依赖 android.jar，手工 aapt2+d8 就能打包。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "dsh_phone";
    private static final String VERSION_NAME = "1.9.6";
    /** 页面给的直传地址（含令牌）。设了就由原生把每一帧直接 POST 给电脑，
        不经过 JS 桥——桥那一环以前是最容易静默失败的地方。 */
    /** 页面最后一次「还在管这层取景」的时间。页面崩了 / JS 停了就不会再更新，
        看门狗据此把画面收掉——免得退出直播后画面还盖在会话上。 */
    private volatile long lastOverlayTouch = 0;
    private volatile String pushUrl = "";
    private volatile String lastB64 = "";
    private static final String K_BASE = "base";
    // 内置的公网入口（电脑端自建隧道的固定地址）。
    // 用 HTTPS 域名而不是裸 IP：令牌在 URL 里，走明文 HTTP 等于把钥匙贴在信封上。
    // 具体地址不写在这里：构建时由 android/local.properties 注入 BuildConfig，
    // 那个文件不入库，谁 clone 都只看到示例域名。
    private static final String DEFAULT_PUBLIC = BuildConfig.DEFAULT_PUBLIC;
    private static final String LEGACY_PUBLIC = BuildConfig.LEGACY_PUBLIC;
    private static final String[] DEAD_HOSTS = { "trycloudflare.com", "lhr.life", "localhost.run" };
    private static final String K_TOKEN = "token";
    private static final String K_ALT = "altBase";
    private static final String K_STAY_HTTP = "stayHttp";   // https 进不去退回内网时置 true，避免每次启动又跳回去
    private static final int BG = 0xFF0B0D10;
    private static final int FG = 0xFFE7EDF5;
    private static final int DIM = 0xFF8B98A9;
    private static final int BAD = 0xFFFF6B6B;
    private static final int OK = 0xFF5EE2A0;
    private static final int PORT = 8899;
    private static final int REQ_FILE = 1001;
    private static final int REQ_MIC = 1002;
    private static final int REQ_CAM = 1003;
    private static final int REQ_SHOOT = 1004;

    private SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private String curBase = "";
    private String curToken = "";
    private String altBase = "";
    private boolean triedAlt = false;
    private View errView;
    private MediaRecorder recorder;
    private File recFile;
    private boolean voicePending = false;
    // 网页要摄像头（getUserMedia）时，WebView 会先问宿主；这里替它要到权限再放行。
    private PermissionRequest camReq = null;
    private boolean camPending = false;
    // 原生取帧（Camera2）：不经过 WebView getUserMedia，页面是 http 也能拍。
    private boolean camWantGrab = false;
    private boolean camGrabbing = false;
    private HandlerThread camThread = null;
    private Handler camHandler = null;
    private CameraDevice camDevice = null;
    private CameraCaptureSession camSession = null;
    private ImageReader camReader = null;
    private Uri camShotUri = null;
    // 直播：一个常开的预览会话（TextureView 直接盖在 WebView 上），顺手也能出 JPEG
    private TextureView liveView = null;
    private CameraDevice liveDevice = null;
    private CameraCaptureSession liveSession = null;
    private ImageReader liveReader = null;
    private HandlerThread liveThread = null;
    private Handler liveHandler = null;
    private SurfaceTexture liveTex = null;
    private boolean liveOn = false;

    /** 直播期间把屏幕点亮（用户退出直播时清掉，绝不常驻）。 */
    private void keepScreenOn(final boolean on) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (on) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } catch (Exception ignored) {}
            }
        });
    }
    private boolean liveGrabbing = false;
    private float[] livePending = null;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SHOOT) {
            camShotResult();
        }
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                Uri[] result = null;
                try {
                    result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                } catch (Exception ignored) {
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try { startOverlayWatchdog(); } catch (Throwable ignored) {}
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        // 相机权限在启动时就要一次。等到用户按快门再弹窗，很容易被当成"点了没反应"：
        // 浏览器那条路（getUserMedia）和原生那条路（Camera2）都要它，先要到手最省事。
        try {
            if (Build.VERSION.SDK_INT >= 23
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAM);
            }
        } catch (Throwable ignored) {
        }

        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        String base = prefs.getString(K_BASE, "");
        String token = prefs.getString(K_TOKEN, "");
        // 之前配对过旧域名/临时隧道/明文裸 IP 的，这里自动迁到内置 HTTPS 地址，token 不动（用户不用重新配对）。
        // 旧地址留在 K_ALT，域名万一又被打回，断网兜底还能切回去。
        String norm = base.replaceAll("/+$", "");
        // 内网 http 地址下浏览器根本拿不到摄像头（安全上下文限制），只剩原生取景。
        // 所以只要内置了 https 入口，就把 http 的配对自动迁过去（token 不动，旧地址留在 K_ALT 兜底）。
        boolean httpBase = base.toLowerCase().startsWith("http://");
        boolean canHttps = DEFAULT_PUBLIC.toLowerCase().startsWith("https://") && !DEFAULT_PUBLIC.contains("example.com");
        boolean stayHttp = prefs.getBoolean(K_STAY_HTTP, false);
        boolean wantMigrate = isDeadBase(base) || LEGACY_PUBLIC.equals(norm) || (httpBase && canHttps && !stayHttp);
        if (!base.isEmpty() && wantMigrate && !DEFAULT_PUBLIC.equals(norm)) {
            prefs.edit().putString(K_ALT, base).putString(K_BASE, DEFAULT_PUBLIC).apply();
            base = DEFAULT_PUBLIC;
        }
        if (base.isEmpty() || token.isEmpty()) {
            showSetup("");
        } else {
            showChat(base, token);
        }
    }

    /* ------------------------------------------------------------ 配对页 */

    private void showSetup(String error) {
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }

        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setPadding(pad, dp(44), pad, pad);
        root.setFitsSystemWindows(true);

        TextView title = new TextView(this);
        title.setText("连接你的 DSH");
        title.setTextColor(FG);
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("手机和电脑连同一个 Wi‑Fi。电脑端先启动手机通道，窗口里会显示 6 位配对码。");
        sub.setTextColor(DIM);
        sub.setTextSize(13);
        sub.setPadding(0, dp(8), 0, dp(20));
        root.addView(sub);

        root.addView(label("电脑地址"));
        final EditText urlBox = field(DEFAULT_PUBLIC, InputType.TYPE_TEXT_VARIATION_URI);
        String saved = prefs.getString(K_BASE, "");
        if (!saved.isEmpty() && !isDeadBase(saved)) urlBox.setText(saved);
        root.addView(urlBox);

        root.addView(label("配对码"));
        final EditText codeBox = field("6 位数字", InputType.TYPE_CLASS_NUMBER);
        codeBox.setTextSize(22);
        codeBox.setGravity(Gravity.CENTER);
        root.addView(codeBox);

        final TextView msg = new TextView(this);
        msg.setTextColor(error.isEmpty() ? DIM : BAD);
        msg.setTextSize(13);
        msg.setPadding(0, dp(14), 0, 0);
        msg.setText(error);
        root.addView(msg);

        Button connect = new Button(this);
        connect.setText("连接");
        connect.setTextSize(16);
        connect.setAllCaps(false);
        connect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String u = urlBox.getText().toString().trim();
                String c = codeBox.getText().toString().trim();
                // 允许直接粘贴带令牌的免配对链接：http://x:8899/?t=xxxx
                int qi = u.indexOf("?t=");
                if (qi > 0) {
                    String tok = u.substring(qi + 3).trim();
                    String b = u.substring(0, qi).trim();
                    if (tok.length() > 10) {
                        rememberBase(b);
                        prefs.edit().putString(K_BASE, b).putString(K_TOKEN, tok).apply();
                        showChat(b, tok);
                        return;
                    }
                }
                if (u.isEmpty() || c.isEmpty()) {
                    msg.setTextColor(BAD);
                    msg.setText("地址和配对码都要填。");
                    return;
                }
                msg.setTextColor(DIM);
                msg.setText("正在连接…");
                pair(u, c, msg);
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(20);
        root.addView(connect, lp);

        Button discover = new Button(this);
        discover.setText("自动发现电脑");
        discover.setTextSize(14);
        discover.setAllCaps(false);
        discover.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                msg.setTextColor(DIM);
                msg.setText("正在局域网里找…");
                discover(msg, urlBox);
            }
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46));
        lp2.topMargin = dp(10);
        root.addView(discover, lp2);

        TextView tip = new TextView(this);
        tip.setText("也可以在电脑上把带令牌的链接（…:8899/?t=…）发到手机浏览器直接用；App 里配对更省事。");
        tip.setTextColor(0xFF5D6B7C);
        tip.setTextSize(11);
        tip.setPadding(0, dp(18), 0, 0);
        root.addView(tip);

        setContentView(root);
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(DIM);
        t.setTextSize(12);
        t.setPadding(0, dp(12), 0, dp(6));
        return t;
    }

    private EditText field(String placeholder, int inputType) {
        EditText e = new EditText(this);
        e.setHint(placeholder);
        e.setHintTextColor(0xFF5D6B7C);
        e.setTextColor(FG);
        e.setTextSize(16);
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setBackgroundColor(0xFF11151A);
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        return e;
    }

    private boolean isDeadBase(String b) {
        if (b == null) return false;
        for (String h : DEAD_HOSTS) if (b.contains(h)) return true;
        return false;
    }

    /* ------------------------------------------------------------ 聊天页 */

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_CAM) {
            boolean camOk = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (livePending != null) {
                float[] a = livePending;
                livePending = null;
                if (camOk) startLive(a[0], a[1], a[2], a[3]);
                else liveSay(0, "没有相机权限，看不到画面");
            }
            if (camWantGrab) {
                camWantGrab = false;
                if (camOk) {
                    camGrab();
                } else {
                    camFail("没有相机权限，看不到画面");
                }
            }
        }
        if (requestCode == REQ_CAM && camPending) {
            camPending = false;
            PermissionRequest req = camReq;
            camReq = null;
            if (req != null) {
                boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
                try {
                    if (ok) {
                        req.grant(req.getResources());
                    } else {
                        req.deny();
                        jsToast("没有相机权限，看不到画面");
                    }
                } catch (Exception ignored) {
                }
            }
        }
        if (requestCode == REQ_MIC && voicePending) {
            voicePending = false;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                beginRecord();
            } else {
                jsToast("没有麦克风权限，按住说话用不了");
            }
        }
    }

    // ---------------- 语音输入：原生录音 → 上传识别 ----------------
    // WebView.evaluateJavascript 只能在主线程调用。相机回调、ImageReader 回调、JavascriptInterface
    // 都可能落在别的线程上，直接调会被 WebView 拒掉（异常还会被 catch 吞掉）——
    // 表现就是「画面看得见，但帧永远送不到页面」。所以这里统一转主线程。
    private void jsCall(final String code) {
        if (web == null) return;
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript(code, null);
                } catch (Exception ignored) {
                }
            }
        });
    }

    private void jsToast(String msg) {
        try {
            jsCall("window.__voiceToast && window.__voiceToast(" + JSONObject.quote(msg) + ")");
        } catch (Exception ignored) {
        }
    }

    // ---------------- 摄像头：网页 getUserMedia 的宿主侧放行 ----------------
    private void grantWebPermission(PermissionRequest request) {
        boolean wantCamera = false;
        try {
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantCamera = true;
            }
        } catch (Exception ignored) {
        }
        if (wantCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            if (camReq != null) {
                try {
                    camReq.deny();
                } catch (Exception ignored) {
                }
            }
            camReq = request;
            camPending = true;
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAM);
            return;
        }
        try {
            request.grant(request.getResources());
        } catch (Exception ignored) {
        }
    }

    private void camFail(String msg) {
        camGrabbing = false;
        closeCam();
        jsCall("window.__camFail && window.__camFail(" + JSONObject.quote(msg == null ? "取帧失败" : msg) + ")");
    }

    /** 给页面报个进度，出问题时能看出卡在哪一步（不进日志、只进面板）。 */
    private void camSay(String msg) {
        try {
            jsCall("window.__camInfo && window.__camInfo(" + JSONObject.quote(msg == null ? "" : msg) + ")");
        } catch (Exception ignored) {}
    }

    /* 页面在管这层画面时会不停报位置；一旦 6 秒没人报（页面崩了、JS 停了、
       被切走没来得及收），看门狗自己把画面收掉，绝不让它一直盖在会话上。 */
    private void startOverlayWatchdog() {
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                try {
                    long now = System.currentTimeMillis();
                    if (liveView != null && lastOverlayTouch > 0 && now - lastOverlayTouch > 6000) {
                        lastOverlayTouch = 0;
                        stopLive();
                        camSay("页面 6 秒没管这层画面了，我先收掉");
                    }
                } catch (Throwable ignored) {}
                ui.postDelayed(this, 2000);
            }
        };
        ui.postDelayed(tick, 2000);
    }

    private void camDone(final String b64, final int w, final int h, final String src) {
        // 相机回调可能在任意线程：状态位、关相机、送 JS 全收拢到主线程，避免半途而废
        ui.post(new Runnable() {
            @Override
            public void run() {
                camGrabbing = false;
                closeCam();
                lastB64 = b64;
                jsCall("window.__camFrame && window.__camFrame(" + JSONObject.quote(b64) + "," + w + "," + h + ","
                        + JSONObject.quote(src) + ")");
                pushToServer(b64);   // 页面那边没收到也不耽误电脑收到这一帧
            }
        });
    }


    /** 把这一帧直接 POST 给电脑。跑在单独线程，失败只报不抛。 */
    private void pushToServer(final String b64) {
        final String url = pushUrl;
        if (url == null || url.length() == 0 || b64 == null || b64.length() < 200) return;
        final String data = b64;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                java.net.HttpURLConnection conn = null;
                try {
                    byte[] raw = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
                    conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(12000);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(raw.length);
                    conn.setRequestProperty("Content-Type", "image/jpeg");
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(raw);
                    os.flush();
                    os.close();
                    int code = conn.getResponseCode();
                    if (code / 100 != 2) camSay("原生直传失败 HTTP " + code);
                } catch (Throwable e) {
                    String m = e.getMessage();
                    camSay("原生直传失败：" + (m == null ? e.getClass().getSimpleName() : m));
                } finally {
                    if (conn != null) { try { conn.disconnect(); } catch (Exception ignored) {} }
                }
            }
        }, "cam-push");
        t.setDaemon(true);
        t.start();
    }
    private boolean needCamPerm() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) return false;
        camWantGrab = true;
        requestPermissions(new String[] { Manifest.permission.CAMERA }, REQ_CAM);
        return true;
    }

    private String pickCameraId(CameraManager mgr) {
        try {
            String fallback = null;
            for (String id : mgr.getCameraIdList()) {
                if (fallback == null) fallback = id;
                CameraCharacteristics c = mgr.getCameraCharacteristics(id);
                Integer face = c.get(CameraCharacteristics.LENS_FACING);
                if (face != null && face == CameraCharacteristics.LENS_FACING_BACK) return id;
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * ImageReader 的 JPEG 尺寸必须落在机型支持列表里，否则 acquireNextImage 永远不回来
     * （预览照样能看，于是表现成「画面正常但抓不到帧」）。
     */
    private android.util.Size pickJpegSize(CameraManager mgr, String id, int wantW, int wantH) {
        try {
            CameraCharacteristics ch = mgr.getCameraCharacteristics(id);
            android.hardware.camera2.params.StreamConfigurationMap map =
                ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) return null;
            android.util.Size[] sizes = map.getOutputSizes(android.graphics.ImageFormat.JPEG);
            if (sizes == null || sizes.length == 0) return null;
            long want = (long) wantW * wantH;
            long bestDiff = Long.MAX_VALUE;
            android.util.Size best = null;
            for (android.util.Size s : sizes) {
                long area = (long) s.getWidth() * s.getHeight();
                if (area > want * 3) continue;
                long d = Math.abs(area - want);
                if (d < bestDiff) { bestDiff = d; best = s; }
            }
            return best != null ? best : sizes[0];
        } catch (Exception e) {
            return null;
        }
    }

    /** 静默取一帧：Camera2 只挂 ImageReader，不需要预览界面。 */
    private void camGrab() {
        if (liveGrab()) return;          // 直播开着就复用那条会话，秒出帧
        if (camGrabbing) { camSay("上一帧还没回来，等它一下"); return; }
        if (needCamPerm()) { camSay("正在要相机权限，点「允许」"); return; }
        camGrabbing = true;
        // 看门狗：6.5 秒还没回帧就把闸门放开，别让后面每一眼都卡在同一个死锁上
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (camGrabbing) {
                    camGrabbing = false;
                    camSay("相机 6 秒没回帧，已重置");
                }
            }
        }, 6500);
        camSay("正在打开摄像头…");
        try {
            camThread = new HandlerThread("dsh-cam");
            camThread.start();
            camHandler = new Handler(camThread.getLooper());
            CameraManager mgr = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            final String id = pickCameraId(mgr);
            if (id == null) {
                camFail("这台机器没有可用的摄像头");
                return;
            }
            android.util.Size js = pickJpegSize(mgr, id, 1280, 720);
            camReader = ImageReader.newInstance(js != null ? js.getWidth() : 1280, js != null ? js.getHeight() : 720, android.graphics.ImageFormat.JPEG, 1);
            camReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    Image img = null;
                    try {
                        img = r.acquireNextImage();
                        String b64 = img == null ? null : jpegToB64(img);
                        if (b64 == null) {
                            camFail("相机没出画（画面全黑）");
                            return;
                        }
                        camDone(b64, 0, 0, "grab");
                    } catch (Exception e) {
                        camFail(String.valueOf(e.getMessage()));
                    } finally {
                        if (img != null) img.close();
                    }
                }
            }, camHandler);
            mgr.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice d) {
                    camDevice = d;
                    startCapture();
                }

                @Override
                public void onDisconnected(CameraDevice d) {
                    d.close();
                    camFail("摄像头被别的程序占了");
                }

                @Override
                public void onError(CameraDevice d, int code) {
                    d.close();
                    camFail("摄像头打开失败 " + code);
                }
            }, camHandler);
            ui.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (camGrabbing) camFail("取景超时");
                }
            }, 7000);
        } catch (Exception e) {
            camFail(String.valueOf(e.getMessage()));
        }
    }

    private void startCapture() {
        try {
            camDevice.createCaptureSession(java.util.Collections.singletonList(camReader.getSurface()),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession s) {
                            camSession = s;
                            camSay("相机已打开，等这一帧…");
                            try {
                                CaptureRequest.Builder b =
                                        camDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                b.addTarget(camReader.getSurface());
                                s.capture(b.build(), null, camHandler);
                            } catch (Exception e) {
                                camFail(String.valueOf(e.getMessage()));
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession s) {
                            camFail("摄像头没配上");
                        }
                    }, camHandler);
        } catch (Exception e) {
            camFail(String.valueOf(e.getMessage()));
        }
    }

    private void closeCam() {
        try {
            if (camSession != null) camSession.close();
        } catch (Exception ignored) {
        }
        try {
            if (camDevice != null) camDevice.close();
        } catch (Exception ignored) {
        }
        try {
            if (camReader != null) camReader.close();
        } catch (Exception ignored) {
        }
        camSession = null;
        camDevice = null;
        camReader = null;
        if (camThread != null) {
            try {
                camThread.quitSafely();
            } catch (Exception ignored) {
            }
            camThread = null;
            camHandler = null;
        }
    }

    /** JPEG → 缩到最长边 1440 → base64。 */
    private String jpegToB64(Image img) {
        ByteBuffer buf = img.getPlanes()[0].getBuffer();
        int n = buf.remaining();
        byte[] raw = new byte[n];
        buf.get(raw);
        Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, n);
        if (bm == null) return null;
        // 预览还没出画时，Camera2 给的 JPEG 是一张纯黑图：能解码、能上传、能显示，
        // 但里面什么都没有 —— 电脑收到一片黑，模型只能说「看不出来」。
        // 这种帧在这里就拦下，别让它当成「拍到了」。
        if (isBlankBitmap(bm)) {
            bm.recycle();
            camSay("预览没出画（画面全黑），这一帧不算");
            return null;
        }
        int w = bm.getWidth();
        int h = bm.getHeight();
        float sc = Math.min(1f, 1440f / Math.max(w, h));
        if (sc < 1f) {
            Bitmap s = Bitmap.createScaledBitmap(bm, Math.max(1, Math.round(w * sc)),
                    Math.max(1, Math.round(h * sc)), true);
            bm.recycle();
            bm = s;
        }
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        bm.compress(Bitmap.CompressFormat.JPEG, 78, bo);
        bm.recycle();
        return Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
    }

    /** 系统相机拍一张：最稳，用户能自己取景确认。 */
    private void camSnap() {
        if (needCamPerm()) return;
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.TITLE, "dsh-cam");
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            camShotUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (camShotUri == null) {
                camFail("没法建临时照片");
                return;
            }
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, camShotUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(i, REQ_SHOOT);
        } catch (Exception e) {
            camFail("打不开相机：" + e.getMessage());
        }
    }

    private void camShotResult() {
        Uri uri = camShotUri;
        camShotUri = null;
        if (uri == null) {
            camFail("没拿到照片");
            return;
        }
        String b64 = null;
        try {
            java.io.InputStream in = getContentResolver().openInputStream(uri);
            Bitmap bm = BitmapFactory.decodeStream(in);
            if (in != null) in.close();
            if (bm != null) {
                int w = bm.getWidth();
                int h = bm.getHeight();
                float sc = Math.min(1f, 1440f / Math.max(w, h));
                if (sc < 1f) {
                    Bitmap s = Bitmap.createScaledBitmap(bm, Math.max(1, Math.round(w * sc)),
                            Math.max(1, Math.round(h * sc)), true);
                    bm.recycle();
                    bm = s;
                }
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                bm.compress(Bitmap.CompressFormat.JPEG, 80, bo);
                bm.recycle();
                b64 = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
            }
        } catch (Exception e) {
            camFail("读不出照片：" + e.getMessage());
            return;
        }
        // 临时照片别留在相册里
        try {
            getContentResolver().delete(uri, null, null);
        } catch (Exception ignored) {
        }
        if (b64 == null) {
            camFail("照片是空的");
            return;
        }
        camDone(b64, 0, 0, "snap");
    }

    private class VoiceBridge {
        @JavascriptInterface
        public boolean available() {
            return true;
        }

        @JavascriptInterface
        public void start() {
            if (recorder != null) return;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                voicePending = true;
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
                return;
            }
            beginRecord();
        }

        @JavascriptInterface
        public void stop() {
            endRecord(true);
        }

        @JavascriptInterface
        public void cancel() {
            endRecord(false);
        }
    }

    // ---------------- 原生相机：不进 WebView 的 getUserMedia 也能拍 ----------------
    // 网页在 http 局域网地址下不是安全上下文，navigator.mediaDevices 直接是 undefined，
    // 所以「让他看」不能只靠浏览器 API。这里给页面两个原生入口：
    //   DSHCam.grab() —— Camera2 静默取一帧（不弹界面），给「随时可看」和 AI 主动要看用
    //   DSHCam.snap() —— 走系统相机拍一张（最稳，用户能取景确认）
    // 结果都回到 window.__camFrame(base64, w, h, 'grab'|'snap')。
    // ================= 直播：手机屏幕上实时看到自己的画面 =================
    // 做法：把一块 TextureView 按页面给的矩形贴到 WebView 上面，Camera2 只开一次会话，
    // 预览走 setRepeatingRequest；要出帧给 AI 时往同一个会话里塞一次 JPEG capture。
    // 这样不用 getUserMedia（http 局域网也能用），也不会每帧重开相机的几百毫秒延迟。

    private int px(float css) {
        try {
            return Math.round(css * getResources().getDisplayMetrics().density);
        } catch (Exception e) {
            return Math.round(css);
        }
    }

    private void liveSay(int ok, String msg) {
        try {
            jsCall("window.__livePreview && window.__livePreview(" + ok + "," + JSONObject.quote(msg) + ")");
        } catch (Exception ignored) {
        }
    }

    private void liveFail(String msg) {
        liveOn = false;
        liveSay(0, msg);
        stopLive();
    }

    private void startLive(final float cssL, final float cssT, final float cssW, final float cssH) {
        if (Build.VERSION.SDK_INT < 21) {
            liveSay(0, "需要 Android 5 以上");
            return;
        }
        // 已经在播：只把取景层挪到新位置，不重开相机（页面滚动时会频繁调这里）
        if (liveOn && liveView != null) {
            try {
                ViewGroup.LayoutParams lpx = liveView.getLayoutParams();
                if (lpx instanceof FrameLayout.LayoutParams) {
                    FrameLayout.LayoutParams fl = (FrameLayout.LayoutParams) lpx;
                    fl.width = px(cssW);
                    fl.height = px(cssH);
                    fl.leftMargin = px(cssL);
                    fl.topMargin = px(cssT);
                    liveView.setLayoutParams(fl);
                }
            } catch (Exception ignored) {}
            return;
        }
        if (needCamPerm()) {
            livePending = new float[] { cssL, cssT, cssW, cssH };
            return;   // 权限要到了 onRequestPermissionsResult 里会重开
        }
        stopLive();
        liveOn = true;
        keepScreenOn(true);   // 直播期间屏幕常亮：一黑屏 WebView 就被挂起，那一段就白看了
        liveThread = new HandlerThread("dsh-live");
        liveThread.start();
        liveHandler = new Handler(liveThread.getLooper());
        try {
            CameraManager mgrL = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            String idL = pickCameraId(mgrL);
            android.util.Size jsL = idL == null ? null : pickJpegSize(mgrL, idL, 1280, 720);
            liveReader = ImageReader.newInstance(
                jsL != null ? jsL.getWidth() : 1280,
                jsL != null ? jsL.getHeight() : 720,
                android.graphics.ImageFormat.JPEG, 2);
            liveReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    Image img = null;
                    try {
                        img = r.acquireNextImage();
                        String b64 = img == null ? null : jpegToB64(img);
                        liveGrabbing = false;
                        if (b64 != null) camDone(b64, 0, 0, "grab");
                        else camFail("相机没出画（画面全黑）");
                    } catch (Exception e) {
                        liveGrabbing = false;
                        camFail(String.valueOf(e.getMessage()));
                    } finally {
                        if (img != null) img.close();
                    }
                }
            }, liveHandler);

            liveView = new TextureView(this);
            ViewGroup root = (ViewGroup) findViewById(android.R.id.content);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(cssW), px(cssH));
            lp.leftMargin = px(cssL);
            lp.topMargin = px(cssT);
            root.addView(liveView, lp);
            liveView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
                @Override
                public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
                    liveTex = st;
                    openLive();
                }

                @Override
                public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {
                }

                @Override
                public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
                    return true;
                }

                @Override
                public void onSurfaceTextureUpdated(SurfaceTexture st) {
                }
            });
        } catch (Exception e) {
            liveFail(String.valueOf(e.getMessage()));
        }
    }

    private void openLive() {
        try {
            CameraManager mgr = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            final String id = pickCameraId(mgr);
            if (id == null) {
                liveFail("这台机器没有可用的摄像头");
                return;
            }
            mgr.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice d) {
                    liveDevice = d;
                    startLiveSession();
                }

                @Override
                public void onDisconnected(CameraDevice d) {
                    try { d.close(); } catch (Exception ignored) {}
                    liveFail("摄像头被别的程序占了");
                }

                @Override
                public void onError(CameraDevice d, int code) {
                    try { d.close(); } catch (Exception ignored) {}
                    liveFail("摄像头打开失败 " + code);
                }
            }, liveHandler);
        } catch (Exception e) {
            liveFail(String.valueOf(e.getMessage()));
        }
    }

    private void startLiveSession() {
        try {
            if (liveTex == null) {
                liveFail("预览还没准备好");
                return;
            }
            final Surface surface = new Surface(liveTex);
            List<Surface> targets = new ArrayList<Surface>();
            targets.add(surface);
            if (liveReader != null) targets.add(liveReader.getSurface());
            liveDevice.createCaptureSession(targets, new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession s) {
                    liveSession = s;
                    try {
                        CaptureRequest.Builder b = liveDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        b.addTarget(surface);
                        s.setRepeatingRequest(b.build(), null, liveHandler);
                        liveSay(1, "");
                    } catch (Exception e) {
                        liveFail(String.valueOf(e.getMessage()));
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession s) {
                    liveFail("预览没配上");
                }
            }, liveHandler);
        } catch (Exception e) {
            liveFail(String.valueOf(e.getMessage()));
        }
    }

    /**
     * 直接从预览画面上取一帧。
     * 预览已经在跑了，所见即所传——不依赖相机再吐一张 JPEG，
     * 也就绕开了「某些机型不支持 1280x720 静帧」导致永远等不到图的问题。
     */
    private boolean grabFromView(final TextureView tv, final int maxW) {
        if (tv == null || !tv.isAvailable()) return false;
        // TextureView.getBitmap() 也必须在主线程跑：从相机线程/JS 桥线程直接调，
        // 轻则返回 null，重则抛异常——那条路一直「拿不到帧」却毫无痕迹。
        if (Looper.myLooper() == Looper.getMainLooper()) return grabFromViewOnUi(tv, maxW);
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final boolean[] got = { false };
        ui.post(new Runnable() {
            @Override
            public void run() {
                try {
                    got[0] = grabFromViewOnUi(tv, maxW);
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            latch.await(3, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        return got[0];
    }

    /** 纯色（或几乎纯色）位图 = 预览还没出画。抽 24×24 个点看是不是全一样。 */
    private boolean isBlankBitmap(Bitmap bm) {
        try {
            int w = bm.getWidth(), h = bm.getHeight();
            if (w < 8 || h < 8) return true;
            int first = bm.getPixel(1, 1);
            int sx = Math.max(1, w / 24), sy = Math.max(1, h / 24);
            int same = 0, total = 0;
            for (int y = 1; y < h - 1; y += sy) {
                for (int x = 1; x < w - 1; x += sx) {
                    total += 1;
                    if (bm.getPixel(x, y) == first) same += 1;
                }
            }
            return total > 24 && same * 100 / total >= 99;
        } catch (Exception e) {
            return false;
        }
    }
    private boolean grabFromViewOnUi(TextureView tv, int maxW) {
        if (tv == null || !tv.isAvailable()) return false;
        try {
            int w = tv.getWidth() > 0 ? tv.getWidth() : 720;
            int h = tv.getHeight() > 0 ? tv.getHeight() : 1280;
            float s = Math.min(1f, maxW / (float) Math.max(w, h));
            int bw = Math.max(2, Math.round(w * s));
            int bh = Math.max(2, Math.round(h * s));
            Bitmap bm = tv.getBitmap(bw, bh);
            if (bm == null) return false;
            // 预览还没出画时 getBitmap 会给一张纯色位图：不拦下来就会「帧到了、画面是黑的」，
            // 模型只能说看不到东西 —— 这和「没截取到帧」一样让人摸不着头脑。
            if (isBlankBitmap(bm)) { bm.recycle(); camSay("预览还没出画，改用静帧"); return false; }
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 72, out);
            int fw = bm.getWidth();
            int fh = bm.getHeight();
            bm.recycle();
            String b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
            camDone(b64, fw, fh, "grab");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 直播时取一帧给 AI：优先从正在跑的预览画面里直接抠一帧。 */
    private boolean liveGrab() {
        if (!liveOn) return false;
        // 预览还在画就先从预览里取一帧：这条路跟静帧那条互不干扰，
        // 而且只要屏幕上有画面就一定能拿到帧。以前这里被 liveGrabbing 挡在前面，
        // 闸门没放开时会「声称处理了、其实一帧没给」，页面就只能等到超时 →「没截取到帧」。
        if (liveView != null && grabFromView(liveView, 1280)) return true;
        if (liveGrabbing) { camSay("直播那一帧还没回来"); return true; }
        if (liveSession == null || liveDevice == null || liveReader == null) return false;
        liveGrabbing = true;
        // 看门狗：静帧这条路 2.5 秒还不回就放开闸门，别让后面每一眼都撞同一堵墙
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (liveGrabbing) {
                    liveGrabbing = false;
                    camSay("直播静帧没回来，下次改用预览画面");
                }
            }
        }, 2500);
        try {
            CaptureRequest.Builder b = liveDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            b.addTarget(liveReader.getSurface());
            liveSession.capture(b.build(), null, liveHandler);
            return true;
        } catch (Exception e) {
            liveGrabbing = false;
            camFail(String.valueOf(e.getMessage()));
            return true;
        }
    }

    private void stopLive() {
        liveOn = false;
        keepScreenOn(false);
        liveGrabbing = false;
        try { if (liveSession != null) liveSession.close(); } catch (Exception ignored) {}
        try { if (liveDevice != null) liveDevice.close(); } catch (Exception ignored) {}
        try { if (liveReader != null) liveReader.close(); } catch (Exception ignored) {}
        liveSession = null;
        liveDevice = null;
        liveReader = null;
        liveTex = null;
        try { if (liveThread != null) liveThread.quitSafely(); } catch (Exception ignored) {}
        liveThread = null;
        liveHandler = null;
        if (liveView != null) {
            try {
                ViewGroup p = (ViewGroup) liveView.getParent();
                if (p != null) p.removeView(liveView);
            } catch (Exception ignored) {}
            liveView = null;
        }
    }

    private class CameraBridge {
        /** 页面把「往哪 POST」告诉原生（包含令牌），之后每帧都会自己传一份。 */
        @JavascriptInterface
        public void setUpload(final String url) {
            pushUrl = url == null ? "" : url;
        }

        /** 手动把最近一帧传一次（自检用，不依赖下一帧什么时候来）。 */
        @JavascriptInterface
        public void pushLast() {
            pushToServer(lastB64);
        }
        @JavascriptInterface
        public boolean available() {
            return Build.VERSION.SDK_INT >= 21;
        }

        /* 桥的版本号：页面自检会把它一起报上去，出问题时一眼知道装的是哪版 APK */

        /* 相机权限现在是什么状态：granted / denied / prompt。
           页面据此决定「还能不能弹窗」——被拒过的不会再弹，只能去系统设置里改，
           所以必须把状态如实报上去，别让用户在那儿反复点「再试一次」。 */
        @JavascriptInterface
        public String permState() {
            try {
                if (Build.VERSION.SDK_INT < 23) return "granted";
                int r = checkSelfPermission(Manifest.permission.CAMERA);
                if (r == PackageManager.PERMISSION_GRANTED) return "granted";
                MainActivity a = MainActivity.this;
                if (a.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) return "prompt";
                return "denied";
            } catch (Throwable e) {
                return "unknown";
            }
        }

        /* 一键跳到本应用的权限页：相机被拒之后，人只能在这儿把它打开。 */
        @JavascriptInterface
        public void openSettings() {
            try {
                MainActivity a = MainActivity.this;
                Intent it = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                it.setData(Uri.parse("package:" + a.getPackageName()));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                a.startActivity(it);
            } catch (Throwable e) {
                try {
                    Intent it = new Intent(android.provider.Settings.ACTION_SETTINGS);
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Throwable ignored) {}
            }
        }
        @JavascriptInterface
        public String version() {
            return "cam2/" + VERSION_NAME;
        }

        /* 打包时写进去的 https 入口：页面发现自己在用 http 地址（拿不到摄像头）时，
           可以把人直接请到这个入口上，令牌由页面自己带上 */
        @JavascriptInterface
        public String entry() {
            return BuildConfig.DEFAULT_PUBLIC;
        }

        /* 相机现在忙不忙：页面要看它决定下一帧什么时候排，别硬撞 */
        @JavascriptInterface
        public boolean busy() {
            return camGrabbing || liveGrabbing;        }

        @JavascriptInterface
        public boolean hasPermission() {
            return Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void grab() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    camGrab();
                }
            });
        }

        @JavascriptInterface
        public void snap() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    camSnap();
                }
            });
        }

        // 直播预览：矩形用页面上的 CSS 像素给，这里按屏幕密度换算
        @JavascriptInterface
        public void startPreview(final float l, final float t, final float w, final float h) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    startLive(l, t, w, h);
                }
            });
        }


        /* 页面把取景框滚出视野时把这一层藏掉：原生 View 不会跟着裁剪，
           留着就会盖在标题条 / 会话上 */
        @JavascriptInterface
        public void setPreviewVisible(final boolean v) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (liveView != null) {
                            // 用「挪出屏幕」而不是 INVISIBLE：TextureView 一旦不可见就停止绘制，
                            // getBitmap 会拿到旧画面甚至 null —— 那正是「有画面但截不到帧」的一种来源。
                    lastOverlayTouch = System.currentTimeMillis();
                            liveView.setTranslationY(v ? 0f : -20000f);
                            liveView.setVisibility(View.VISIBLE);
                        }
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void stopPreview() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    stopLive();
                }
            });
        }

        @JavascriptInterface
        public boolean liveOn() {
            return liveOn;
        }
    }

    private android.os.Handler lvlHandler;
    private Runnable lvlTask;

    // 录音时每 120 毫秒把当前振幅推给页面，让用户看见"确实录进去了"
    private void startLevelPoll() {
        stopLevelPoll();
        lvlHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        lvlTask = new Runnable() {
            @Override
            public void run() {
                if (recorder == null) return;
                int amp = 0;
                try {
                    amp = recorder.getMaxAmplitude();
                } catch (Exception ignored) {
                }
                // getMaxAmplitude 是 0..32767，压到 0..100，再开个平方根让小声也看得见
                int pct = (int) Math.round(Math.sqrt(Math.min(1.0, amp / 32767.0)) * 100);
                jsCall("window.__voiceLevel && window.__voiceLevel(" + pct + ")");
                if (lvlHandler != null) lvlHandler.postDelayed(this, 120);
            }
        };
        lvlHandler.postDelayed(lvlTask, 120);
    }

    private void stopLevelPoll() {
        if (lvlHandler != null) {
            lvlHandler.removeCallbacks(lvlTask);
            lvlHandler = null;
            lvlTask = null;
        }
        jsCall("window.__voiceLevel && window.__voiceLevel(0)");
    }

    private void beginRecord() {
        try {
            recFile = new File(getCacheDir(), "voice.m4a");
            if (recFile.exists()) recFile.delete();
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioChannels(1);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setOutputFile(recFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            jsCall("window.__voiceState && window.__voiceState('recording')");
            startLevelPoll();
        } catch (Exception e) {
            recorder = null;
            jsToast("开始录音失败：" + e.getMessage());
            jsCall("window.__voiceState && window.__voiceState('idle')");
        }
    }

    private void endRecord(boolean upload) {
        stopLevelPoll();
        if (recorder == null) return;
        long size = 0;
        try {
            recorder.stop();
        } catch (Exception ignored) {
        }
        try {
            recorder.release();
        } catch (Exception ignored) {
        }
        recorder = null;
        if (recFile != null) size = recFile.length();
        jsCall("window.__voiceState && window.__voiceState('idle')");
        if (!upload) {
            if (recFile != null) recFile.delete();
            return;
        }
        if (recFile == null || !recFile.exists() || size < 1200) {
            jsToast("太短了，按住多说两个字");
            return;
        }
        uploadVoice(recFile);
    }

    private void uploadVoice(final File f) {
        jsCall("window.__voiceState && window.__voiceState('uploading')");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String url = curBase + "/api/asr?t=" + curToken;
                HttpURLConnection c = null;
                try {
                    byte[] body = new byte[(int) f.length()];
                    FileInputStream in = new FileInputStream(f);
                    int off = 0;
                    while (off < body.length) {
                        int n = in.read(body, off, body.length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                    in.close();

                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setDoOutput(true);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(90000);
                    c.setRequestProperty("content-type", "application/octet-stream");
                    c.setRequestProperty("x-audio-ext", "m4a");
                    c.setFixedLengthStreamingMode(body.length);
                    OutputStream os = c.getOutputStream();
                    os.write(body);
                    os.flush();
                    os.close();

                    int code = c.getResponseCode();
                    java.io.InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                    if (is != null) {
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
                        is.close();
                    }
                    JSONObject j = new JSONObject(new String(bo.toByteArray(), "UTF-8"));
                    String text = j.optString("text", "");
                    if (j.optBoolean("ok", false) && text.length() > 0) {
                        jsCall("window.__voiceResult && window.__voiceResult(" + JSONObject.quote(text) + ")");
                    } else {
                        jsToast(j.optString("error", "没听清，再说一次？"));
                    }
                } catch (Exception e) {
                    jsToast("识别失败：" + e.getMessage());
                } finally {
                    if (c != null) c.disconnect();
                    try { f.delete(); } catch (Exception ignored) {}
                    jsCall("window.__voiceState && window.__voiceState('idle')");
                }
            }
        }).start();
    }
    private void showChat(String base, String token) {
        if (web == null) {
            web = new WebView(this);
            web.setBackgroundColor(BG);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setTextZoom(100);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);
            if (Build.VERSION.SDK_INT >= 21) {
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }
            s.setUserAgentString(s.getUserAgentString() + " DSHPhone/1.0");

            web.addJavascriptInterface(new VoiceBridge(), "DSHVoice");
            web.addJavascriptInterface(new CameraBridge(), "DSHCam");
            web.setWebChromeClient(new WebChromeClient());
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    if (url.startsWith("http://") || url.startsWith("https://")) return false;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                    return true;
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    hideErr();
                }

                @Override
                public void onReceivedError(WebView view, int errorCode, String description,
                                            String failingUrl) {
                    if (failingUrl != null && failingUrl.contains("/?t=")) onWebError(description);
                }

                @Override
                public void onReceivedError(WebView view, android.webkit.WebResourceRequest req,
                                            android.webkit.WebResourceError err) {
                    if (Build.VERSION.SDK_INT >= 23 && req != null && req.isForMainFrame()) {
                        onWebError(String.valueOf(err.getDescription()));
                    }
                }
            });

            // 手机端「发文件」：把网页里的 <input type=file> 接到系统文件选择器上。
            web.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                                 FileChooserParams params) {
                    if (filePathCallback != null) {
                        filePathCallback.onReceiveValue(null);
                    }
                    filePathCallback = cb;
                    try {
                        Intent intent = params.createIntent();
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        startActivityForResult(intent, REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        filePathCallback = null;
                        return false;
                    }
                }

                // 网页里的「📷 让他看」走 getUserMedia，默认实现会直接拒绝，必须自己放行。
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            grantWebPermission(request);
                        }
                    });
                }
            });

            // 点开图片 / 附件时，交给系统看图或浏览器
            web.setDownloadListener(new android.webkit.DownloadListener() {
                @Override
                public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                            String mimeType, long contentLength) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                }
            });
        }
        curBase = base.replaceAll("/+$", "");
        curToken = token;
        altBase = prefs.getString(K_ALT, "");
        if (altBase.equals(curBase)) altBase = "";
        triedAlt = false;
        errView = null;
        setContentView(web);
        web.loadUrl(curBase + "/?t=" + token);
    }


    /* ------------------------------------------- 打不开时的兜底（黑屏克星） */

    /** 记下上一个可用地址，等下次连不上时自动换过去。 */
    private void rememberBase(String base) {
        String old = prefs.getString(K_BASE, "");
        if (!old.isEmpty() && !old.equals(base)) {
            prefs.edit().putString(K_ALT, old).apply();
        }
    }

    private void onWebError(final String desc) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                // 先试备用地址（比如上次用的是局域网，现在人在外面）
                if (!triedAlt && altBase != null && altBase.length() > 8 && !altBase.equals(curBase)) {
                    triedAlt = true;
                    String backup = altBase;
                    rememberBase(curBase);
                    curBase = backup;
                    altBase = "";
                    // 退回内网地址了就记住这个选择，否则下次启动又会自动跳回 https
                    prefs.edit().putString(K_BASE, curBase)
                            .putBoolean(K_STAY_HTTP, curBase.toLowerCase().startsWith("http://")).apply();
                    web.loadUrl(curBase + "/?t=" + curToken);
                    return;
                }
                showErr(desc);
            }
        });
    }

    private void hideErr() {
        if (errView != null) {
            errView.setVisibility(View.GONE);
        }
    }

    /** 盖一层原生错误页：说清是哪一步失败，并给出可点的下一步。 */
    private void showErr(String desc) {
        if (curBase.isEmpty()) return;
        if (errView == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setBackgroundColor(BG);
            box.setGravity(Gravity.CENTER);
            box.setPadding(dp(24), dp(24), dp(24), dp(24));
            if (box.getParent() == null) {
                ViewGroup root = (ViewGroup) findViewById(android.R.id.content);
                root.addView(box, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            errView = box;
        }
        LinearLayout box = (LinearLayout) errView;
        box.removeAllViews();

        TextView t = new TextView(this);
        t.setText("连不上这台电脑");
        t.setTextColor(FG);
        t.setTextSize(20);
        t.setGravity(Gravity.CENTER);
        box.addView(t);

        TextView sub = new TextView(this);
        sub.setText(curBase + "\n" + (desc == null || desc.isEmpty() ? "网络不通或电脑上的通道没开" : desc));
        sub.setTextColor(DIM);
        sub.setTextSize(13);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(10), 0, 0);
        box.addView(sub);

        TextView hint = new TextView(this);
        hint.setText(curBase.startsWith("https://")
                ? "公网地址可能已经过期（每次重开都会换）。回电脑上让我重新开，或换个新地址。"
                : "人在外面时局域网地址是连不上的：回电脑上开公网通道，拿 https 地址填进来。");
        hint.setTextColor(0xFF5D6B7C);
        hint.setTextSize(12);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(14), 0, 0);
        box.addView(hint);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setAllCaps(false);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                hideErr();
                triedAlt = false;
                web.loadUrl(curBase + "/?t=" + curToken);
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(180), dp(48));
        lp.topMargin = dp(24);
        box.addView(retry, lp);

        Button edit = new Button(this);
        edit.setText("换个地址");
        edit.setAllCaps(false);
        edit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errView = null;
                showSetup("上次连的 " + curBase + " 打不开，换一个试试。");
            }
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(dp(180), dp(48));
        lp2.topMargin = dp(10);
        box.addView(edit, lp2);

        errView.setVisibility(View.VISIBLE);
        errView.bringToFront();
    }

    /* ------------------------------------------------------------ 配对请求 */

    private void pair(final String rawUrl, final String code, final TextView msg) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String base = rawUrl.trim().replaceAll("/+$", "");
                if (!base.startsWith("http://") && !base.startsWith("https://")) base = "http://" + base;
                try {
                    JSONObject body = new JSONObject();
                    body.put("code", code);
                    HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/pair").openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(12000);
                    c.setDoOutput(true);
                    c.setRequestProperty("content-type", "application/json");
                    OutputStream os = c.getOutputStream();
                    os.write(body.toString().getBytes("UTF-8"));
                    os.close();
                    int status = c.getResponseCode();
                    InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    String text = readAll(is);
                    JSONObject json = new JSONObject(text);
                    if (!json.optBoolean("ok", false)) {
                        throw new RuntimeException(json.optString("error", "配对失败"));
                    }
                    final String token = json.getString("token");
                    final String finalBase = base;
                    rememberBase(finalBase);
                    prefs.edit().putString(K_BASE, finalBase).putString(K_TOKEN, token).apply();
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            showChat(finalBase, token);
                        }
                    });
                } catch (final Exception e) {
                    String m = String.valueOf(e.getMessage());
                    if (m.contains("Failed to connect") || m.contains("ECONNREFUSED")
                            || m.contains("ETIMEDOUT") || m.contains("timed out")) {
                        m = "连不上 " + base + "。检查电脑地址、同一个 Wi‑Fi、以及电脑防火墙是否放行 8899。";
                    }
                    final String fm = m;
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            msg.setTextColor(BAD);
                            msg.setText(fm);
                        }
                    });
                }
            }
        }).start();
    }

    /* --------------------------------------------------------- 局域网发现 */

    private void discover(final TextView msg, final EditText urlBox) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String found = null;
                DatagramSocket sock = null;
                try {
                    sock = new DatagramSocket();
                    sock.setBroadcast(true);
                    sock.setSoTimeout(2200);
                    byte[] probe = "DSH-PHONE-DISCOVER".getBytes("UTF-8");
                    String bcast = broadcastAddress();
                    for (int attempt = 0; attempt < 3 && found == null; attempt++) {
                        try {
                            sock.send(new DatagramPacket(probe, probe.length,
                                    InetAddress.getByName("255.255.255.255"), PORT));
                        } catch (Exception ignored) {
                        }
                        if (bcast != null) {
                            try {
                                sock.send(new DatagramPacket(probe, probe.length,
                                        InetAddress.getByName(bcast), PORT));
                            } catch (Exception ignored) {
                            }
                        }
                        byte[] buf = new byte[2048];
                        DatagramPacket in = new DatagramPacket(buf, buf.length);
                        try {
                            sock.receive(in);
                            String reply = new String(in.getData(), 0, in.getLength(), "UTF-8");
                            JSONObject json = new JSONObject(reply);
                            if ("dsh-phone-bridge".equals(json.optString("app"))) {
                                found = "http://" + in.getAddress().getHostAddress()
                                        + ":" + json.optInt("port", PORT);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                } catch (Exception ignored) {
                } finally {
                    if (sock != null) sock.close();
                }
                final String result = found;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        if (result == null) {
                            msg.setTextColor(BAD);
                            msg.setText("没找到。手动填电脑 IP：在电脑上运行 ipconfig，看「IPv4 地址」。");
                        } else {
                            urlBox.setText(result);
                            msg.setTextColor(OK);
                            msg.setText("找到了 " + result + "，现在输入配对码。");
                        }
                    }
                });
            }
        }).start();
    }

    private static String broadcastAddress() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null && ia.getAddress() instanceof Inet4Address) {
                        return ia.getBroadcast().getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics()));
    }

    /* ------------------------------------------------------------ 返回键 */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }
            new AlertDialog.Builder(this)
                    .setTitle("DSH 手机通道")
                    .setMessage("要做什么？")
                    .setPositiveButton("重新配对", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            prefs.edit().clear().apply();
                            recreate();
                        }
                    })
                    .setNegativeButton("退出", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            finish();
                        }
                    })
                    .setNeutralButton("取消", null)
                    .show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        stopLive();   // 退到后台就关直播预览，别在兜里一直开着相机
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopLive();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
