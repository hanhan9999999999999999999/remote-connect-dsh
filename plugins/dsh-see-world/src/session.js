/**
 * session.js — 「眼睛」：一段时间内看世界，决定留哪几帧，再把它们做成一张图。
 *
 * 这一层不认识宿主、不认识工具，只认「设备 + 帧 + 时间」。所以它可以脱离 DSH
 * 单独跑（`node scripts/selftest.mjs` 就是走这条路），出问题时能先排除宿主。
 *
 * ## 三个时间尺度
 *
 *   帧（10/s）     判运动、判亮度 —— 只算，不留
 *   采样（~1/s）   留一张小图，供拼图挑选
 *   出图（3~30s）  交给模型 —— 触发条件是「值得说一句」而不是「到点了」
 *
 * ## 为什么必须自己判「值得」
 *
 * 摄像头一直开着，如果每一帧都往模型那儿送，一分钟就是几百张图，而且全是「没变」。
 * 反过来，只在模型主动问的时候才看，那它就永远不知道「刚才有人走过」。
 * 所以：**变化由插件判定并叫醒模型**，模型只管「我该说什么」。
 */

import { spawnFrames, still } from './capture.js';
import {
  diffGrid, blendReference, exposureOf, gainFor, gridOf, isNotable,
} from './analyze.js';
import { buildSheet, buildSingle } from './sheet.js';
import { applyGain, downscaleBox } from './analyze.js';

/** 采样小图的尺寸：拼图格子的上限，也是内存里同时留几帧的代价（1.5 MB/帧）。 */
export const TILE_W = 960;
export const TILE_H = 540;

/** 分析网格的刷新节奏（毫秒）。10fps 全算没必要，4 次/秒够判断「有没有动」。 */
const ANALYSE_EVERY_MS = 220;

/** 采集断了之后的退避重启（毫秒）。用完就报死。 */
const RESTART_DELAYS = [800, 1500, 3000, 6000, 12_000];

/** 空闲这么久没被用到就关流，把摄像头还给系统（用户能在别的软件里用）。 */
export const IDLE_RELEASE_MS = 90_000;

/** 两次「叫醒」之间至少隔这么久（监控模式出图后）。 */
const MONITOR_COOLDOWN_MS = 6000;

const now = () => Date.now();
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function tileOf(rgb, width, height) {
  if (width === TILE_W && height === TILE_H) return Buffer.from(rgb);
  return downscaleBox(rgb, width, height, TILE_W, TILE_H);
}

/**
 * @param {{
 *   ffmpegPath:string, device:string, width?:number, height?:number, fps?:number,
 *   maxFrames?:number, quality?:number, gain?:boolean,
 *   preview?:{width:number, height:number, fps?:number, quality?:number}|null,
 *   log?:(m:string)=>void,
 * }} cfg
 */
export function createEye(cfg) {
  const {
    ffmpegPath, device, width = 1280, height = 720, fps = 10,
    maxFrames = 4, quality = 1, preview = null, log = () => {},
  } = cfg;

  const state = {
    running: false,
    opening: null,
    frames: 0,
    analysed: 0,
    lastFrameAt: 0,
    lastGrid: null,
    ref: null,
    lastExposure: null,
    lastGain: 1,
    restarts: 0,
    fatal: null,
    lastError: null,
    lastUseAt: now(),
    sheets: 0,
    lastSheetAt: 0,
    /** 最近若干帧（tile 尺寸），供拼图挑选 */
    ring: [],
    /** 刚采到的那一帧（原尺寸），面板的实时预览用；ring 只收"有变化"的帧 */
    fresh: null,
    /** 刚采到的 JPEG（预览尺寸，ffmpeg 里现成的），面板的趋势图直接推它 */
    jpeg: null,
    /** 监控模式下攒出来的、等模型来取的图 */
    pending: [],
    /** 「有没有开始过」—— 第一次 watch 要马上给一张，不能干等变化 */
    delivered: 0,
    lastMoved: 0,
    lastScore: 0,
  };

  let handle = null;
  let restartTimer = null;
  let restartIdx = 0;
  let idleTimer = null;
  let lastAnalyseAt = 0;
  let monitor = null;      // {notableSince, lastBuildAt}
  const waiters = new Set();   // watch 的等待者

  const touch = () => { state.lastUseAt = now(); };

  const pushRing = (entry) => {
    state.ring.push(entry);
    const keep = Math.max(6, maxFrames + 3);
    if (state.ring.length > keep) state.ring.splice(0, state.ring.length - keep);
  };

  const notify = (pending) => {
    for (const fn of [...waiters]) {
      try { fn(pending); } catch { /* 一个等待者出问题不该影响别人 */ }
    }
  };

  /** 组一张图：从 ring 里挑代表帧。 */
  const buildFromRing = ({ frames: picked, note = '', at = now() }) => {
    const list = picked.length ? picked : state.ring.slice(-1);
    if (!list.length) return null;
    const gain = state.lastGain;
    const first = list[0].at;
    const last = list[list.length - 1].at;
    const title = [
      'CAM', String(device).toUpperCase(),
      `${clock(first)}-${clock(last)}`, `${list.length}F`,
      `${width}X${height}`,
    ].join(' ');
    const sheet = buildSheet({
      frames: list.map((f, i) => ({ ...f, label: `${i + 1} ${clock(f.at)}` })),
      title, gain, quality,
    });
    state.sheets += 1;
    state.lastSheetAt = at;
    return {
      ...sheet,
      frames: list.map((f, i) => ({
        index: i + 1, at: f.at, clock: clock(f.at), score: +(f.score ?? 0).toFixed(1), moved: +(f.moved ?? 0).toFixed(3), pick: f.pick ?? '',
      })),
      from: first,
      to: last,
      note,
      gain,
      exposure: state.lastExposure,
      device,
      capture: { width, height, fps },
    };
  };

  /** 从若干采样里挑「最值得看」的 maxFrames 张。 */
  const pickFrames = (samples, limit) => {
    if (!samples.length) return [];
    const picked = [samples[0]];
    let anchor = samples[0];
    for (const s of samples.slice(1, -1)) {
      if (picked.length >= limit - 1) break;
      const d = Math.abs(s.score) + s.moved * 40;
      if (d >= 10) { picked.push(s); anchor = s; }
    }
    const lastSample = samples[samples.length - 1];
    if (picked.length < limit && lastSample && lastSample !== picked[picked.length - 1]) {
      picked.push(lastSample);
    }
    // 按时间顺序，序号在拼图里才有意义
    picked.sort((a, b) => a.at - b.at);
    return picked.slice(0, limit);
  };

  const onJpeg = (jpg, meta) => {
    // 同一个 ffmpeg 里现成编好的 JPEG：面板的实时流直接用，不重编码、不再走 PNG
    state.jpeg = { data: Buffer.from(jpg), at: meta.at };
    state.jpegCount = (state.jpegCount ?? 0) + 1;
  };

  const onFrame = (frame, meta) => {
    state.frames += 1;
    state.lastFrameAt = meta.at;
    // 最新一帧原样留着：面板的实时预览要走这条路。
    // ring 里只收"有变化"的帧（1.2 秒才勉强收一张），拿它当预览会变成幻灯片。
    state.fresh = { rgb: frame, width, height, at: meta.at };
    const t = now();
    if (t - lastAnalyseAt < ANALYSE_EVERY_MS) return;
    lastAnalyseAt = t;

    const grid = gridOf(frame, width, height);
    const expo = exposureOf(frame, width, height);
    state.lastExposure = expo;
    state.lastGain = gainFor(expo.meanV);
    state.analysed += 1;

    if (!state.ref) state.ref = Uint8Array.from(grid);
    const vsRef = diffGrid(state.ref, grid);
    const vsPrev = state.lastGrid ? diffGrid(state.lastGrid, grid) : { score: 0, moved: 0, peak: 0 };

    state.lastScore = vsRef.score;
    state.lastMoved = Math.max(vsPrev.moved, vsRef.moved * 0.6);

    // 采样：只要变化过阈值就算「这一帧值得留」，但至少每 400ms 才留一张，避免同一动作留 4 张
    const last = state.ring[state.ring.length - 1];
    const worthKeeping = !last
      || vsRef.score >= 8 || vsPrev.score >= 8 || vsPrev.moved >= 0.08
      || meta.at - last.at >= 1200;
    if (worthKeeping) {
      pushRing({
        rgb: tileOf(frame, width, height),
        width: TILE_W,
        height: TILE_H,
        at: meta.at,
        score: vsRef.score,
        moved: vsPrev.moved,
      });
    }

    // 监控模式：连续「值得」达到一定时长 → 攒一张，等模型来取
    if (monitor) {
      const notable = isNotable({ score: vsRef.score, moved: vsPrev.moved }, monitor.thresholds);
      if (notable) {
        if (!monitor.since) monitor.since = meta.at;
        const longEnough = meta.at - monitor.since >= (monitor.holdMs ?? 700);
        const cooled = meta.at - (monitor.lastBuildAt ?? 0) >= MONITOR_COOLDOWN_MS;
        if (longEnough && cooled && state.ring.length >= 2) {
          const picked = state.ring.slice(-Math.min(maxFrames, state.ring.length));
          const sheet = buildFromRing({
            frames: picked,
            note: vsPrev.moved >= 0.3 ? '画面出现大幅整体变化' : '画面里出现了值得看的变化',
            at: meta.at,
          });
          if (sheet) {
            state.pending.push(sheet);
            if (state.pending.length > 3) state.pending.shift();
            monitor.lastBuildAt = meta.at;
            monitor.since = 0;
            notify(true);
          }
        }
      } else if (monitor.since && meta.at - monitor.since > 20_000) {
        monitor.since = 0;      // 早就安静了，重新开始计
      }
    }

    blendReference(state.ref, grid, { alpha: 0.03 });
    state.lastGrid = grid;
  };

  const onError = (e) => {
    state.lastError = e;
    log(`采集错误 ${e.reason}: ${e.message} ${e.hint ?? ''}`);
    if (e.reason === 'permission-denied' || e.reason === 'not-found' || e.reason === 'dependency-missing') {
      state.fatal = e;
      state.running = false;
      return;
    }
    if (e.reason === 'stream-ended' || e.reason === 'device-unavailable' || e.reason === 'no-frame') {
      scheduleRestart(e.reason);
    }
  };

  const scheduleRestart = (why) => {
    if (restartTimer || state.fatal) return;
    if (state.restarts >= RESTART_DELAYS.length) {
      state.fatal = { reason: 'stream-dead', message: `重开 ${state.restarts} 次都失败（${why}）`, hint: '设备可能被别的程序拿走了。' };
      state.running = false;
      return;
    }
    const delay = RESTART_DELAYS[Math.min(state.restarts, RESTART_DELAYS.length - 1)];
    state.restarts += 1;
    log(`${delay}ms 后重开采集（第 ${state.restarts} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      handle = null;
      start();
    }, delay);
    if (state.opening) restartTimer.ref?.(); else restartTimer.unref?.();
  };

  const start = () => {
    if (handle || state.fatal) return;
    state.running = true;
    handle = spawnFrames({
      ffmpegPath,
      device,
      width,
      height,
      fps,
      // 设备只喂一份：要同时出预览流，就按预览的帧率去请求（30）；分析那一路自己降到 fps
      inputFps: preview ? Math.max(fps, preview.fps ?? 30) : fps,
      preview,
      onFrame,
      onJpeg,
      onFirst: () => { state.openedAt = now(); restartIdx = 0; },
      onError,
      log,
    });
  };

  const open = () => {
    touch();
    if (handle && state.running) return Promise.resolve({ ok: true });
    if (state.fatal) return Promise.resolve({ ok: false, error: state.fatal });
    if (state.opening) return state.opening;
    state.opening = new Promise((resolve) => {
      const startedAt = now();
      start();
      const tick = setInterval(() => {
        if (state.frames > 0) {
          clearInterval(tick);
          clearTimeout(giveUp);
          state.opening = null;
          resolve({ ok: true });
          return;
        }
        if (state.fatal) {
          clearInterval(tick);
          clearTimeout(giveUp);
          state.opening = null;
          resolve({ ok: false, error: state.fatal });
        }
      }, 80);
      const giveUp = setTimeout(() => {
        clearInterval(tick);
        state.opening = null;
        resolve({ ok: false, error: state.lastError ?? { reason: 'no-frame', message: `等了 ${Math.round((now() - startedAt) / 1000)} 秒没有画面` } });
      }, 20_000);
      // 这两个计时器是"有人在 await 这个 Promise"的凭据：一旦 unref，ffmpeg 又恰好
      // 立刻退出（设备名写错就是这样），事件循环就空了 —— 调用方会永远等下去。
    });
    return state.opening;
  };

  /** 空闲就把流关掉：摄像头是共享设备，用户可能要用它开会。 */
  const startIdleWatch = () => {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!handle || monitor) return;
      if (now() - state.lastUseAt > IDLE_RELEASE_MS) {
        log('空闲释放摄像头');
        close();
      }
    }, 15_000);
    idleTimer.unref?.();
  };

  const close = () => {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (handle) { try { handle.stop(); } catch { /* ignore */ } handle = null; }
    state.running = false;
    state.ring = [];
    state.fresh = null;
    state.jpeg = null;
    state.lastGrid = null;
    state.ref = null;
  };

  startIdleWatch();

  /**
   * 看一段时间，返回一张拼图。
   *
   * @param {{seconds?:number, maxFrames?:number, intervalMs?:number}} o
   */
  const look = async ({ seconds = 3, maxFrames: want = null, intervalMs = 700 } = {}) => {
    touch();
    const limit = Math.max(1, Math.min(9, want ?? maxFrames));
    const opened = await open();
    if (!opened.ok) return { ok: false, error: opened.error };

    const t0 = now();
    const samples = [];
    const span = Math.max(600, Math.min(30_000, seconds * 1000));
    while (now() - t0 < span) {
      const cur = state.ring[state.ring.length - 1];
      if (cur && samples[samples.length - 1]?.at !== cur.at) samples.push({ ...cur });
      await new Promise((r) => { setTimeout(r, intervalMs); });
    }
    if (!samples.length) {
      const cur = state.ring[state.ring.length - 1];
      if (cur) samples.push({ ...cur });
    }
    let picked = pickFrames(samples, limit);
    const movedMax = samples.reduce((m, s) => Math.max(m, s.moved ?? 0), 0);
    const spread = picked.reduce((m, s) => Math.max(m, s.moved ?? 0), 0);
    // 一动不动的时候留 4 张一样的图没意义：给一张大的，字和细节都更清楚
    if (picked.length > 1 && spread < 0.02) picked = [picked[picked.length - 1]];
    const sheet = buildFromRing({ frames: picked, note: '' });
    if (!sheet) return { ok: false, error: { reason: 'no-frame', message: '这段时间没收到画面' } };
    return { ok: true, sheet, elapsed: (now() - t0) / 1000, samples: samples.length, movedMax };
  };

  /** 一张原分辨率静止图（先停流，抓完再开回来）。 */
  const snapshot = async () => {
    touch();
    const wasRunning = Boolean(handle);
    if (wasRunning) close();
    try {
      const shot = await still({ ffmpegPath, device });
      const gain = gainFor(exposureOf(shot.rgb, shot.width, shot.height).meanV);
      const exposure = exposureOf(shot.rgb, shot.width, shot.height);
      state.lastExposure = exposure;
      const built = buildSingle({
        frame: shot,
        title: `CAM ${String(device).toUpperCase()} ${clock(now())} ${shot.width}X${shot.height}`,
        gain,
        maxWidth: 1600,
      });
      return { ok: true, ...built, gain, exposure, source: { width: shot.width, height: shot.height }, ms: shot.ms };
    } catch (e) {
      // 抓不到原图就退回上一帧（并说清楚这是降级的）
      const cur = state.ring[state.ring.length - 1];
      if (cur) {
        const built = buildSingle({ frame: cur, title: `CAM ${String(device).toUpperCase()} ${clock(now())} FALLBACK`, gain: state.lastGain, maxWidth: 1600 });
        return { ok: true, ...built, gain: state.lastGain, degraded: true, error: { reason: e.reason ?? 'still-failed', message: String(e.message ?? e) } };
      }
      return { ok: false, error: { reason: e.reason ?? 'still-failed', message: String(e.message ?? e), hint: e.hint ?? '' } };
    } finally {
      if (wasRunning) start();
    }
  };

  /** 开始长期盯着；变化时攒图。 */
  const startMonitor = ({ thresholds = null, holdMs = 700 } = {}) => {
    touch();
    monitor = { since: 0, lastBuildAt: 0, thresholds: thresholds ?? { scoreAt: 16, movedAt: 0.22 }, holdMs };
    return open();
  };

  const stopMonitor = () => { monitor = null; };

  /**
   * 阻塞等一张图。
   *
   * 第一次调用先给一张（约 2 秒），之后只在「有变化」的时候返回 ——
   * 否则模型会一头撞进 300 秒的空等，而那期间世界什么都没发生。
   */
  const watch = async ({ seconds = 300, first = null, maxFrames: want = null } = {}) => {
    touch();
    const opened = await open();
    if (!opened.ok) return { ok: false, error: opened.error };
    if (state.pending.length) {
      const sheet = state.pending.shift();
      state.delivered += 1;
      return { ok: true, sheet, immediate: true };
    }
    if (!monitor) await startMonitor({});

    const firstShot = first ?? state.delivered === 0;
    if (firstShot) {
      // 给硬件一点时间收敛自动曝光，再出一张「现在的样子」
      await new Promise((r) => { setTimeout(r, 2200); });
      const samples = state.ring.slice(-Math.max(2, Math.min(state.ring.length, want ?? maxFrames)));
      const sheet = buildFromRing({ frames: samples, note: '开场：现在画面里是这样' });
      // 一帧都没收到（设备被占、刚开流就断了）时别返回 sheet:null —— 上游会当成成功去取图
      if (!sheet) {
        return {
          ok: false,
          error: {
            reason: state.lastError?.reason ?? 'no-frame',
            message: state.lastError?.message ?? '摄像头一帧都没送过来',
            hint: state.lastError?.hint ?? '',
            detail: state.lastError?.detail ?? '',
          },
        };
      }
      state.delivered += 1;
      return { ok: true, sheet, initial: true };
    }

    const t0 = now();
    const limitMs = Math.max(1000, Math.min(860_000, seconds * 1000));
    const result = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        waiters.delete(onPending);
        clearTimeout(timer);
        resolve(v);
      };
      const onPending = () => {
        if (!state.pending.length) return;
        done({ ok: true, sheet: state.pending.shift() });
      };
      const timer = setTimeout(() => done({ ok: false, reason: 'no-change' }), limitMs);
      timer.unref?.();
      waiters.add(onPending);
      // 入队前可能已经攒好了，补一次检查
      if (state.pending.length) onPending();
    });

    if (result.ok) { state.delivered += 1; return result; }
    // 等到超时也没变化：给一张「没变」的图，别让模型两手空空
    const sheet = buildFromRing({ frames: state.ring.slice(-2), note: `等了 ${Math.round(limitMs / 1000)} 秒，画面基本没变` });
    if (!sheet) return { ok: false, error: { reason: 'no-frame', message: '没有画面' } };
    state.delivered += 1;
    return { ok: true, sheet, quiet: true, waited: (now() - t0) / 1000 };
  };

  const peek = () => {
    touch();
    if (!state.pending.length) return null;
    state.delivered += 1;
    return state.pending.shift();
  };

  /**
   * 最新一帧，缩到 maxWidth 宽并按当前增益归一 —— 给网页面板做预览用。
   *
   * 面板每 300ms 来取一张，等于"有人在看"，所以这里 touch()：别让人盯着看
   * 90 秒的画面被空闲释放掉。停止按钮 / 关面板就不再调它，超时照常释放。
   */
  const latest = ({ maxWidth = 640 } = {}) => {
    touch();
    // 优先用刚采集到的原帧（每秒 fps 张都能拿到）；ring 只有在"值得留"的时候才收一张，
    // 拿它做预览会变成 1 秒一张的幻灯片。两者都在空的时候再返回 null。
    const cur = state.fresh ?? state.ring[state.ring.length - 1];
    if (!cur) return null;
    const want = Math.max(80, Math.min(cur.width, Math.round(Number(maxWidth) || 640)));
    const h = Math.max(1, Math.round((want * cur.height) / cur.width));
    const small = want === cur.width && h === cur.height
      ? cur.rgb
      : downscaleBox(cur.rgb, cur.width, cur.height, want, h);
    // applyGain 是原地改的：拿到的若是原帧本身，先拷一份，别把采集那边的像素改掉
    const rgb = small === cur.rgb ? Buffer.from(cur.rgb) : small;
    return {
      rgb: applyGain(rgb, state.lastGain),
      width: want,
      height: h,
      at: cur.at,
      gain: state.lastGain,
      exposure: state.lastExposure,
    };
  };

  /**
   * 最新一张现成 JPEG（预览尺寸）。面板的实时流用它：ffmpeg 已经在同一条流里
   * 编好了，不必再起第二个编码进程，也不消耗 JS 的 CPU。
   */
  const latestJpeg = () => {
    touch();
    const cur = state.jpeg;
    if (!cur) return null;
    return { data: cur.data, at: cur.at, mediaType: 'image/jpeg' };
  };

  const status = () => ({
    running: Boolean(handle) && state.running,
    device,
    capture: { width, height, fps },
    preview: preview
      ? {
        width: preview.width,
        height: preview.height,
        fps: preview.fps ?? 30,
        jpegs: state.jpegCount ?? 0,
        bytes: state.jpeg ? state.jpeg.data.length : 0,
        at: state.jpeg ? state.jpeg.at : null,
      }
      : null,
    frames: state.frames,
    analysed: state.analysed,
    ageMs: state.lastFrameAt ? now() - state.lastFrameAt : null,
    at: state.lastFrameAt || null,
    restarts: state.restarts,
    sheets: state.sheets,
    pending: state.pending.length,
    monitoring: Boolean(monitor),
    exposure: state.lastExposure,
    gain: +state.lastGain.toFixed(2),
    score: +state.lastScore.toFixed(1),
    moved: +state.lastMoved.toFixed(3),
    lastError: state.lastError ? { reason: state.lastError.reason, message: state.lastError.message, detail: state.lastError.detail ?? '', hint: state.lastError.hint } : null,
    fatal: state.fatal ? { reason: state.fatal.reason, message: state.fatal.message, hint: state.fatal.hint } : null,
    idleReleaseInSec: monitor ? null : Math.max(0, Math.round((state.lastUseAt + IDLE_RELEASE_MS - now()) / 1000)),
  });

  return {
    open, close, look, snapshot, watch, peek, latest, latestJpeg, status,
    startMonitor, stopMonitor,
    get running() { return Boolean(handle) && state.running; },
    get pendingCount() { return state.pending.length; },
    touch,
    __state: state,
  };
}
