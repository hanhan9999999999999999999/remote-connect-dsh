/**
 * capture.js — 一根常驻的 ffmpeg 管道，把摄像头的画面变成 rgb24 帧。
 *
 * ## 为什么是「常驻」而不是每次抓一张
 *
 * 实测这台机器的摄像头从 spawn 到第一帧 **约 2 秒**（硬件唤醒 + 自动曝光收敛）。
 * 模型每看一次就开一次进程的话，一次「看一眼」里有两秒是在等硬件醒过来，
 * 而且每次醒过来的前几帧都是糊的/偏色的。所以：**开着就不关**，
 * 首帧那 2 秒只付一次；空闲足够久（见 session.js）才释放设备。
 *
 * ## 为什么 v4l2 / dshow / avfoundation 三家写法都写在同一处
 *
 * 只有这里知道「设备怎么被打开」这一个知识。上层（session / index）只认
 * 「给我帧」和「列出设备」，平台差异不该漏到别处 —— 漏出去就会变成
 * 某个平台上「插件装了但看不到」。
 */

import { spawn } from 'node:child_process';

/** 首帧最多等这么久；超时算这个 attempt 失败，换下一组参数。 */
export const FIRST_FRAME_MS = 12_000;

/** Windows 上 dshow 的缓冲要开大，否则自动曝光期间会丢帧丢到 ffmpeg 报错。 */
const DS_BUFFER = '256M';

/**
 * 打开设备的参数（不含输出侧）。
 *
 * **不要加 `-thread_queue_size`**：gyan.dev 的 build 会把它判成输出选项然后报
 * 「Option thread_queue_size not found」，而且报错出现在第一帧之前，看起来就像设备打不开。
 */
export function inputArgs({ platform = process.platform, device, fps = 10, width = 1280, height = 720, variant = 0,
  vcodec = '' } = {}) {
  if (platform === 'win32') {
    const base = ['-rtbufsize', DS_BUFFER, '-f', 'dshow'];
    // 请求 MJPEG 输入：同一个 UVC 相机，yuyv422 在 1280x720 上只给 10fps，mjpeg 给 30fps
    const codec = vcodec && variant < 2 ? ['-vcodec', vcodec] : [];
    if (variant === 0) return [...base, ...codec, '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', `video=${device}`];
    if (variant === 1) return [...base, ...codec, '-video_size', `${width}x${height}`, '-i', `video=${device}`];
    return [...base, '-i', `video=${device}`];
  }
  if (platform === 'darwin') {
    const idx = String(device);
    if (variant === 0) return ['-f', 'avfoundation', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', `${idx}:none`];
    if (variant === 1) return ['-f', 'avfoundation', '-framerate', String(fps), '-i', `${idx}:none`];
    return ['-f', 'avfoundation', '-i', `${idx}:none`];
  }
  // linux
  const dev = String(device).startsWith('/dev/') ? String(device) : `/dev/video${device}`;
  const fmt = vcodec && variant < 2 ? ['-input_format', vcodec] : [];
  if (variant === 0) return ['-f', 'v4l2', ...fmt, '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', dev];
  if (variant === 1) return ['-f', 'v4l2', ...fmt, '-video_size', `${width}x${height}`, '-i', dev];
  return ['-f', 'v4l2', '-i', dev];
}

/** 输出侧：统一缩到 width×height，rgb24，走 stdout。 */
export function outputArgs({ width = 1280, height = 720, fps = 10 } = {}) {
  return [
    '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:flags=fast_bilinear`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    'pipe:1',
  ];
}

/**
 * 两路输出：一条设备、两个消费者。
 *
 * 摄像头是**独占**的（第二个进程会拿到 `Could not run graph`），所以"给主人看的
 * 视频流"和"给模型看的帧"必须从同一个 ffmpeg 里分出去：
 *
 * - `pipe:1`  → MJPEG，preview 尺寸、preview 帧率，浏览器直接当视频流播（零额外进程）
 * - `pipe:3`  → rawvideo rgb24，分析用的小帧（增益、差异、拼版）
 *
 * ffmpeg 只解码一次，两个 `-vf` 各自缩放降帧。`pipe:3` 在 Windows 上可用，
 * 前提是 spawn 时 `stdio` 里给第 4 个管道。
 */
export function dualOutputArgs({
  width = 1280, height = 720, fps = 10,
  preview = { width: 640, height: 360, fps: 30, quality: 5 },
} = {}) {
  return [
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${preview.fps},scale=${preview.width}:${preview.height}:flags=fast_bilinear`,
    '-c:v', 'mjpeg', '-q:v', String(preview.quality ?? 5),
    '-f', 'mjpeg', 'pipe:1',
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${width}:${height}:flags=fast_bilinear`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:3',
  ];
}

/** 公共前置：安静、不读 stdin、低延迟。 */
const PRE = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer', '-flags', 'low_delay'];

/** attempt 的最后一档去掉低延迟那组（个别驱动不认），保证还有一条路能开。 */
function preFor(variant) {
  return variant >= 2 ? ['-hide_banner', '-loglevel', 'error', '-nostdin'] : PRE;
}

const HINTS = {
  'device-unavailable': '设备被别的程序占用了（相机 App、会议软件、OBS 都可能霸着它），关掉再试。',
  'permission-denied': '系统拒绝了摄像头权限：Windows 设置 → 隐私和安全性 → 相机，允许桌面应用访问。',
  'not-found': '没有这个设备。先 `see_world({action:"devices"})` 看清单，再用 `camera` 指定。',
  'dependency-missing': 'ffmpeg 不可用，检查路径配置。',
  'no-frame': '设备打开了但没出帧（可能在等自动曝光，或者被虚拟摄像头占着）。',
};

function classify(text = '') {
  const t = String(text);
  if (/Could not find|No such file|not found|Cannot find|Impossible to find|No such device/i.test(t)) return 'not-found';
  if (/Permission denied|Access is denied|Operation not permitted/i.test(t)) return 'permission-denied';
  if (/Could not run graph|Device or resource busy|already in use|Error opening input|Immediate exit requested/i.test(t)) return 'device-unavailable';
  if (/ENOENT|spawn .* ENOENT/i.test(t)) return 'dependency-missing';
  return 'capture-failed';
}

// 给用户看的话：退出码对用户没有意义，原因才有
const REASON_TEXT = {
  'device-unavailable': '打不开这个摄像头（多半被别的程序占着，或者名字不对）',
  'not-found': '找不到这个摄像头',
  'permission-denied': '系统没允许用摄像头',
  'dependency-missing': '找不到 ffmpeg',
  'no-frame': '摄像头没有画面',
  'stream-ended': '采集流断了',
  'capture-failed': '采集失败了',
};

/** 从 stderr 里挑一行最有信息量的，当作细节附在原因后面。 */
function detailLine(stderr = '') {
  const lines = String(stderr).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const pick = lines.find((l) => /error|could not|cannot|failed|denied|busy|invalid|no such/i.test(l))
    || lines[lines.length - 1]
    || '';
  return pick.slice(0, 240);
}

/**
 * 打开摄像头，持续吐帧。
 *
 * 返回的句柄**立刻可用**：`start()` 后由内部按 `variant` 依次尝试，
 * 哪个 attempt 撑过首帧就用哪个；全失败时 `onError` 带分类和中文提示。
 *
 * @param {{
 *   ffmpegPath:string, device:string, width?:number, height?:number, fps?:number,
 *   platform?:NodeJS.Platform,
 *   onFrame:(rgb:Buffer, meta:{index:number, at:number})=>void,
 *   onFirst?:()=>void,
 *   onError?:(e:{reason:string, message:string, hint:string, stderr:string})=>void,
 *   onExit?:(code:number|null)=>void,
 *   log?:(m:string)=>void,
 * }} o
 */
export function spawnFrames(o) {
  const {
    ffmpegPath, device, width = 1280, height = 720, fps = 10, platform = process.platform,
    inputFps = fps,
    preview = null, vcodec = preview ? 'mjpeg' : '',
    onFrame, onJpeg = null, onFirst = () => {}, onError = () => {}, onExit = () => {}, log = () => {},
  } = o;

  const frameBytes = width * height * 3;
  const state = {
    child: null,
    stopped: false,
    variant: 0,
    frames: 0,
    dropped: 0,
    jpegs: 0,
    jpegBytes: 0,
    stderr: '',
    firstAt: 0,
    startedAt: 0,
    restarts: 0,
  };

  let pending = Buffer.alloc(0);
  let jpegPending = Buffer.alloc(0);
  let firstFrameTimer = null;

  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);

  const cleanup = () => {
    if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = null; }
    pending = Buffer.alloc(0);
    jpegPending = Buffer.alloc(0);
  };

  const markFirst = () => {
    if (state.firstAt) return;
    state.firstAt = Date.now();
    if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = null; }
    try { onFirst(); } catch { /* 上层回调不该拖垮采集 */ }
  };

  const pushRaw = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      state.frames += 1;
      markFirst();
      // 帧是 subarray（零拷贝视图），上层必须自己拷走；这里给的是只读视图
      try { onFrame(frame, { index: state.frames - 1, at: Date.now() }); } catch { /* ignore */ }
    }
    // 防御：驱动偶发吐半帧后卡住，缓冲别无限涨
    if (pending.length > frameBytes * 4) { pending = pending.subarray(pending.length - frameBytes); state.dropped += 1; }
  };

  const pushJpeg = (chunk) => {
    jpegPending = jpegPending.length ? Buffer.concat([jpegPending, chunk]) : chunk;
    for (;;) {
      const start = jpegPending.indexOf(SOI);
      if (start < 0) {
        if (jpegPending.length > 3) jpegPending = jpegPending.subarray(jpegPending.length - 3);
        return;
      }
      const end = jpegPending.indexOf(EOI, start + 3);
      if (end < 0) {
        if (start > 0) jpegPending = jpegPending.subarray(start);
        return;
      }
      const jpg = jpegPending.subarray(start, end + 2);
      jpegPending = jpegPending.subarray(end + 2);
      state.jpegs += 1;
      state.jpegBytes = jpg.length;
      markFirst();
      if (onJpeg) { try { onJpeg(jpg, { index: state.jpegs - 1, at: Date.now() }); } catch { /* ignore */ } }
    }
  };

  const killChild = () => {
    const c = state.child;
    state.child = null;
    if (!c || c.killed) return;
    try { c.kill('SIGTERM'); } catch { /* 已经没了 */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
    t.unref?.();
  };

  const attempt = (variant) => {
    if (state.stopped) return;
    state.variant = variant;
    state.stderr = '';
    state.startedAt = Date.now();

    const args = [
      ...preFor(variant),
      ...inputArgs({ platform, device, fps: inputFps, width, height, variant, vcodec }),
      ...(preview
        ? dualOutputArgs({ width, height, fps, preview })
        : outputArgs({ width, height, fps })),
    ];
    log(`ffmpeg 开流 attempt=${variant}: ${args.join(' ')}`);

    let child;
    try {
      child = spawn(ffmpegPath, args, {
        stdio: preview ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      onError({
        reason: 'dependency-missing',
        message: String(e?.message ?? e),
        hint: HINTS['dependency-missing'],
        stderr: '',
      });
      return;
    }
    state.child = child;

    if (preview) {
      child.stdout.on('data', (chunk) => {
        if (state.stopped) return;
        pushJpeg(chunk);
      });
      const raw = child.stdio[3];
      if (raw) {
        raw.on('data', (chunk) => {
          if (state.stopped) return;
          pushRaw(chunk);
        });
        raw.on('error', () => { /* 管道被 ffmpeg 关掉时正常 */ });
      }
    } else {
      child.stdout.on('data', (chunk) => {
        if (state.stopped) return;
        pushRaw(chunk);
      });
    }

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      state.stderr = (state.stderr + text).slice(-4000);
    });

    firstFrameTimer = setTimeout(() => {
      if (state.stopped || state.firstAt) return;
      log(`attempt=${variant} 首帧超时，换下一档`);
      killChild();
    }, FIRST_FRAME_MS);
    firstFrameTimer.unref?.();

    child.on('error', (e) => {
      if (state.stopped) return;
      const reason = classify(String(e?.message ?? e));
      onError({ reason, message: String(e?.message ?? e), hint: HINTS[reason] ?? '', stderr: state.stderr });
    });

    child.on('close', (code) => {
      if (state.stopped) { cleanup(); return; }
      cleanup();
      const gotFrame = Boolean(state.firstAt);
      if (!gotFrame && variant < 2) {
        attempt(variant + 1);
        return;
      }
      onExit(code);
      if (!gotFrame) {
        // stderr 说话最算数；只有它什么都没说时，才用退出码兜底
        // （Windows 的 -5 / 0xFFFFFFFB 通常是"设备被占用"）
        const fromText = classify(state.stderr);
        const byCode = (fromText === 'capture-failed' && (code === -5 || code === 4294967291))
          ? 'device-unavailable'
          : '';
        const reason = byCode || fromText;
        onError({
          reason,
          message: REASON_TEXT[reason] ?? `ffmpeg 退出（code ${code}）`,
          detail: detailLine(state.stderr),
          hint: HINTS[reason] ?? HINTS['no-frame'],
          stderr: state.stderr,
        });
        return;
      }
      // 出过帧之后断了：交给上层决定要不要重开（session 有退避重启）
      onError({
        reason: 'stream-ended',
        message: `采集流中断（code ${code}）`,
        hint: '会自动重开；如果一直重开失败，检查设备是否被占用。',
        stderr: state.stderr,
      });
    });
  };

  attempt(0);

  return {
    get state() { return state; },
    get running() { return Boolean(state.child) && !state.stopped; },
    stop() {
      state.stopped = true;
      cleanup();
      killChild();
    },
  };
}

/**
 * 枚举摄像头。
 *
 * Windows 走 `-list_devices`（输出在 stderr）；macOS 同理；Linux 直接看 /dev/video*。
 * **不抛错**：列不出设备时返回空数组 + 原因，让上层能说出「为什么没有」。
 *
 * @returns {Promise<{devices:Array<{name:string, kind:string, index:number}>, reason?:string, raw?:string}>}
 */
export function listDevices({ ffmpegPath, platform = process.platform, timeoutMs = 15_000 } = {}) {
  if (platform === 'linux') {
    return listLinuxDevices();
  }
  const args = platform === 'darwin'
    ? ['-hide_banner', '-list_devices', 'true', '-f', 'avfoundation', '-i', '']
    : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish({ devices: [], reason: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ devices: parseDevices(out, platform), reason: 'timeout', raw: out.slice(-1500) });
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk) => { out += String(chunk); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); finish({ devices: [], reason: String(e?.message ?? e) }); });
    child.on('close', () => {
      clearTimeout(timer);
      const devices = parseDevices(out, platform);
      finish({ devices, raw: out.slice(-1500), ...(devices.length ? {} : { reason: 'none-listed' }) });
    });
  });
}

/** 从 ffmpeg 的 list_devices 输出里抠出设备。 */
export function parseDevices(text, platform = process.platform) {
  const devices = [];
  if (platform === 'darwin') {
    // [AVFoundation indev @ ...] AVFoundation video devices:
    // [AVFoundation indev @ ...] [0] FaceTime HD Camera
    let section = null;
    for (const line of String(text).split(/\r?\n/)) {
      if (/video devices:/i.test(line)) { section = 'video'; continue; }
      if (/audio devices:/i.test(line)) { section = 'audio'; continue; }
      const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
      if (m && section === 'video') devices.push({ index: Number(m[1]), name: m[2], kind: 'video' });
    }
    return devices;
  }
  // dshow:  [in#0 @ ...] "Name" (video)
  const re = /"([^"]+)"\s*\((video|audio|none)\)/g;
  let m;
  let i = 0;
  while ((m = re.exec(String(text))) !== null) {
    const kind = m[2];
    if (kind === 'audio') continue;
    devices.push({ index: i, name: m[1], kind: kind === 'none' ? 'video?' : 'video' });
    i += 1;
  }
  return devices;
}

async function listLinuxDevices() {
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir('/dev');
    const devices = names
      .filter((n) => /^video\d+$/.test(n))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((n, i) => ({ index: i, name: `/dev/${n}`, kind: 'video' }));
    return { devices };
  } catch (e) {
    return { devices: [], reason: String(e?.message ?? e) };
  }
}

/**
 * 抓一张原分辨率的静止图（RGB）。
 *
 * **和常驻流互斥**：摄像头通常不能被同一个进程开两次，上层必须先停流再调它。
 * 输出走 rawvideo 而不是 PNG：这样上层还能做过曝补偿再编码，PNG 是最后一步。
 *
 * @returns {Promise<{rgb:Buffer, width:number, height:number, ms:number}>}
 */
export function still(o) {
  const {
    ffmpegPath, device, width = 0, height = 0, platform = process.platform,
    timeoutMs = 20_000, variant = 0,
  } = o;
  const t0 = Date.now();
  const inArgs = inputArgs({ platform, device, fps: 10, width: width || 1280, height: height || 720, variant });
  const scaleArgs = width && height ? ['-vf', `scale=${width}:${height}:flags=lanczos`] : [];
  const args = [
    ...preFor(variant),
    ...inArgs,
    '-frames:v', '1',
    ...scaleArgs,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(Object.assign(new Error(String(e?.message ?? e)), { reason: 'dependency-missing' }));
      return;
    }
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(Object.assign(new Error('抓图超时'), { reason: 'timeout', stderr: err.slice(-800) }));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err = (err + String(c)).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(String(e?.message ?? e)), { reason: 'dependency-missing' })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (!buf.length) {
        const reason = classify(err) === 'capture-failed' ? 'no-frame' : classify(err);
        reject(Object.assign(new Error(`抓图失败（code ${code}）`), { reason, stderr: err.slice(-1200), hint: HINTS[reason] ?? '' }));
        return;
      }
      // 设备给的实际分辨率可能和请求的不同：用长度反推
      let w = width;
      let h = height;
      if (!w || !h) {
        const px = buf.length / 3;
        // 常见 16:9 / 4:3 反推
        const cands = [[1920, 1080], [1280, 720], [2560, 1440], [3840, 2160], [640, 480], [800, 600], [1024, 768], [960, 540]];
        const hit = cands.find(([cw, ch]) => cw * ch === px);
        if (hit) { [w, h] = hit; } else { w = 4; h = Math.round(px / 4); }
      }
      resolve({ rgb: buf, width: w, height: h, ms: Date.now() - t0 });
    });
  });
}

export const __test = { classify, parseDevices };
