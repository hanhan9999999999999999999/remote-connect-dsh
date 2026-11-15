/**
 * index.js — 插件的门面：把「眼睛」和「工具」接起来。
 *
 * 这一层只做四件事，别往里塞逻辑：
 *   1. 拿到依赖（tools / attachments / sessionController）
 *   2. 按需创建眼睛，按需创建叫醒循环
 *   3. 把 sheet 交给 attachments 换成 ref，再把 (图 + 文字) 交回模型
 *   4. 出问题时把原因留在日志里 —— 而不是让工具静默消失
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadDefineTool } from './define-tool.js';
import { DEFAULT_BLOCK_SEC, DEFAULT_LOOK_SEC, TOOL_NAME, seeWorldToolSpec } from './tool-spec.js';
import { createEye } from './session.js';
import { createWatcher, wakeSession } from './loop.js';
import { ffmpegHint, dshHome, resolveFfmpeg } from './binaries.js';
import { listDevices, still } from './capture.js';
import { exposureWord, gainFor, exposureOf } from './analyze.js';
import { buildSingle } from './sheet.js';
import { encodePng } from './png.js';
import { DEFAULTS, RESOLUTIONS, load as loadSettings, save as saveSettings } from './settings.js';
import { ROUTE_PREFIX, createRoutes } from './routes.js';
import { createPreview } from './live.js';
import { createJpegEncoder } from './jpeg.js';

export const name = 'see-world';
export const inject = ['tools', 'attachments', 'sessionController'];

const CLOCK = (ms) => new Date(ms).toTimeString().slice(0, 8);

/** 取服务：`ctx.get()` 优先，老环境退回属性访问。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没注册就是没注册 */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * 返回值必须是 lossless JSON：`undefined`、`NaN`、`Infinity` 都会让宿主报
 * `tool returned invalid output: value is not lossless JSON`。
 */
function toLosslessJson(v, depth = 0) {
  if (depth > 12) return null;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => toLosslessJson(x, depth + 1));
  if (v instanceof Uint8Array) return null;
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toLosslessJson(x, depth + 1);
    return out;
  }
  return null;
}

function logPath(env) {
  const home = dshHome(env);
  return join(home ?? process.cwd(), 'see-world-error.log');
}

function writeLog(env, message) {
  try {
    const p = logPath(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch { /* 日志写不进去也别把插件带崩 */ }
}

/** 从 run 里取调用者会话；子会话（delegationDepth>0）不认领，免得叫醒叫错人。 */
function callerSessionOf(run) {
  try {
    const session = run?.agent?.session;
    const depth = run?.invocation?.delegationDepth ?? run?.delegationDepth ?? 0;
    if (depth > 0) return null;
    return session?.header?.id ?? session?.id ?? null;
  } catch { return null; }
}

/** 文字结果：只给事实，不给"你应该说……"（那是模型的事）。 */
function sheetText(sheet, { action, elapsed = null, samples = null, note = '' } = {}) {
  const f = sheet.frames ?? [];
  const moved = Math.max(0, ...f.map((x) => x.moved ?? 0));
  const expo = sheet.exposure;
  const lines = [
    `摄像头：${sheet.device}｜采集 ${sheet.capture.width}×${sheet.capture.height}@${sheet.capture.fps}fps｜`
      + `${CLOCK(sheet.from)} → ${CLOCK(sheet.to)}｜${f.length} 帧`,
    `亮度：${exposureWord(expo)}（均值 ${Math.round(expo?.meanV ?? 0)}/255），已自动${sheet.gain > 1 ? '提亮' : '压暗'} ×${sheet.gain.toFixed(2)}`
      + `${expo?.clipHigh > 0.25 ? `；高光溢出 ${Math.round(expo.clipHigh * 100)}% 的画面已经贴到纯白` : ''}`,
    `变动：${moved.toFixed(2)}（0=没动，1≈整屏换掉）｜图上每格左上角是钟点，右上角是序号`,
  ];
  if (action === 'look') {
    lines.push(`采样：${(elapsed ?? 0).toFixed(1)} 秒内看了 ${samples ?? '?'} 次，挑出 ${f.length} 帧`);
  }
  if (sheet.note) lines.push(`说明：${sheet.note}`);
  if (note) lines.push(`本次目的：${note}`);
  if (f.length > 1) {
    lines.push(`帧序：${f.map((x) => `${x.index}@${x.clock}${x.moved >= 0.05 ? `(动${x.moved.toFixed(2)})` : ''}`).join(' · ')}`);
  }
  lines.push('口述「第几张」时按图上的序号。');
  return lines.join('\n');
}

function errorText(err, extra = '') {
  const reason = err?.reason ?? 'capture-failed';
  const msg = err?.message ?? String(err ?? '未知错误');
  const hint = err?.hint ?? '';
  return [
    `摄像头这边出问题了（${reason}）：${msg}`,
    hint,
    extra,
    '要换设备就 `see_world({action:"devices"})` 看列表，再把 `device` 传进去；'
      + '要确认 ffmpeg 可用性看 `see_world({action:"status"})`。',
  ].filter(Boolean).join('\n');
}

export async function apply(ctx) {
  const env = process.env;
  const log = (m) => { if (env.DSH_SEE_WORLD_DEBUG) writeLog(env, m); };

  try {
    const loaded = loadSettings(env);
    const devices = serviceOf(ctx, 'attachments');
    const tools = serviceOf(ctx, 'tools');
    if (!tools?.register) throw new Error('宿主没给 tools 服务，插件无法注册');

    const platform = process.platform;
    let ff = resolveFfmpeg({ env, platform, settings: loaded.config });
    let ffmpegPath = ff.path;
    log(`ffmpeg=${ffmpegPath} (${ff.source}) platform=${platform}`);

    /**
     * 每次真的要用 ffmpeg 之前都再解析一遍。
     *
     * 为什么不能只在 apply 时算一次：插件先起、用户后装 ffmpeg 是常态（比如刚把
     * ffmpeg.exe 丢进 $DSH_HOME/tools/ffmpeg/bin）。只算一次的话，那个进程会一辈子
     * 拿着 "ffmpeg.exe" 这个裸名字，永远 ENOENT，非重启不可。resolveFfmpeg 只是几个
     * existsSync，重算的代价可以忽略。
     */
    const refreshFfmpeg = () => {
      const next = resolveFfmpeg({ env, platform, settings: loaded.config });
      if (next.path === ffmpegPath) return ffmpegPath;
      log(`ffmpeg 换成 ${next.path}（${next.source}）`);
      ff = next;
      ffmpegPath = next.path;
      // 旧的眼睛是按老路径开的，作废重建
      try { eye?.close(); } catch { /* ignore */ }
      eye = null;
      eyeDevice = null;
      eyeFfmpeg = null;
      eyePreview = null;
      return ffmpegPath;
    };

    /**
     * 面板实时流的分辨率：跟着 `previewWidth` 走，保持摄像头自己的宽高比。
     *
     * 不照搬 RESOLUTIONS 表：那张表是"给用户选的拍摄分辨率"（有 4:3 也有 16:9），
     * 而预览必须和拍摄一个比例，否则画面会被拉扁。所以只按宽度算，高度按比例推。
     */
    const previewSize = () => {
      const w = Math.round(Math.max(240, Math.min(1920, Number(cfg.previewWidth) || 640)));
      const h = Math.max(120, Math.round((w * (cfg.height || 720)) / (cfg.width || 1280)));
      // 偶数：MJPEG 的 4:2:0 采样要偶数边长，奇数会被 ffmpeg 悄悄改掉
      return { width: w + (w % 2), height: h + (h % 2), fps: 30, quality: 6 };
    };
    const keyOf = (p) => (p ? `${p.width}x${p.height}@${p.fps}` : 'off');

    const cfg = {
      device: loaded.config.device ?? null,
      width: loaded.config.width,
      height: loaded.config.height,
      fps: loaded.config.fps,
      maxFrames: loaded.config.frames,
      quality: loaded.config.quality,
      monitor: loaded.config.monitor,
      previewWidth: loaded.config.previewWidth,
      autoReply: loaded.config.autoReply,
      replyIntervalSec: loaded.config.replyIntervalSec,
      replyAttach: loaded.config.replyAttach,
      replyBudget: loaded.config.replyBudget,
    };
    let settingsPathShown = loaded.path;
    let settingsWarnings = loaded.warnings ?? [];

    let eye = null;
    let eyeDevice = null;
    let eyeFfmpeg = null;
    let eyePreview = null;
    let watcher = null;
    let lastSessionId = null;
    /**
     * 最近见过的会话。面板要让人"选一个会话负责看世界"，就必须能列出候选；
     * 宿主没给"列会话"的门，那就从会话事件里自己攒（只有真跑过的会话才在）。
     */
    const knownSessions = new Map();

    /** 已经被告知过"自动回报规矩"的会话。同一个会话只讲一次，换回来也不重讲。 */
    const toldSessions = new Set();

    // 兜底会话：有些宿主路径不带 run.agent，就从会话事件里记一个最近的
    ctx.on?.('session/event', (session) => {
      const id = session?.header?.id ?? session?.id;
      if (!id) return;
      lastSessionId = id;
      const title = session?.header?.title ?? session?.title ?? null;
      const prev = knownSessions.get(id);
      knownSessions.set(id, { id, title: title ?? prev?.title ?? null, lastSeenAt: Date.now() });
      // 只留最近 20 个，别把内存当日志用
      if (knownSessions.size > 20) {
        const oldest = [...knownSessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
        if (oldest) knownSessions.delete(oldest[0]);
      }
    });

    const resolveDevice = async () => {
      if (cfg.device) return cfg.device;
      const found = await listDevices({ ffmpegPath, platform, timeoutMs: 8000 });
      const first = (found.devices ?? []).find((d) => d.kind === 'video');
      if (first?.name) { cfg.device = first.name; return cfg.device; }
      return null;
    };

    const ensureEye = async (wanted = null) => {
      refreshFfmpeg();
      let device = wanted ? String(wanted).trim() : '';
      if (!device) device = cfg.device || (await resolveDevice());
      if (!device) {
        return {
          ok: false,
          error: {
            reason: 'device-unavailable',
            message: '没找到可用的摄像头设备',
            hint: '确认摄像头已插好、没被别的程序独占；也可以先看 `see_world({action:"devices"})`。',
          },
        };
      }
      // 设备或 ffmpeg 变了都要换一条新流：createEye 是按当时的参数开的
      const wantPreview = previewSize();
      if (eye && eyeDevice === device && eyeFfmpeg === ffmpegPath && eyePreview === keyOf(wantPreview)) {
        // 上一条流是"致命错误"就换一条新的，别让一次拔插把后面全废掉
        if (!eye.__state?.fatal) return { ok: true, eye, device };
        try { eye.close(); } catch { /* ignore */ }
      }
      if (eye) { try { eye.close(); } catch { /* ignore */ } }
      eyeDevice = device;
      eyeFfmpeg = ffmpegPath;
      eyePreview = keyOf(wantPreview);
      eye = createEye({
        ffmpegPath, device,
        width: cfg.width, height: cfg.height, fps: cfg.fps,
        maxFrames: cfg.maxFrames, quality: cfg.quality,
        preview: wantPreview,
        log,
      });
      return { ok: true, eye, device };
    };

    /** 自动回报的开关/间隔/次数，一处算出，watcher 和面板共用同一份。 */
    const replyOptions = () => ({
      auto: Boolean(cfg.autoReply),
      intervalSec: Number(cfg.replyIntervalSec) || 25,
      budget: Number(cfg.replyBudget) || 20,
      attach: Boolean(cfg.replyAttach),
      device: eyeDevice ?? cfg.device ?? '',
    });

    /**
     * 挂上（或复用）自动回报的循环。
     *
     * 绑定的会话**不是**每次现取：多开会话时现取会叫错人。
     * 面板点「开始」时会把它的会话传进来（`opts.sessionId`），工具调用时用
     * `callerSessionOf(run)`；都没有才退回"最近活动的会话"。
     */
    /**
     * 自动回报要有"攒图"才转得动：监控（monitor）负责在有变化时把拼版塞进 pending，
     * 缺了它，`autoReply: true` 会变成"开着但永远不响"的静默失败。
     */
    const ensureMonitoring = async () => {
      if (!eye) return false;
      const want = Boolean(cfg.autoReply || cfg.monitor);
      try {
        if (want) await eye.startMonitor({});
        else eye.stopMonitor();
      } catch (e) {
        log(`监控开关失败：${e?.message ?? e}`);
        return false;
      }
      return want;
    };

    const ensureWatcher = (sessionId = null) => {
      if (!eye) return null;
      if (watcher) {
        watcher.configure(replyOptions());
        if (sessionId && sessionId !== watcher.state().sessionId) watcher.bind(sessionId);
        return watcher;
      }
      const bound = sessionId || lastSessionId || null;
      watcher = createWatcher({
        ctx, eye, device: eyeDevice, sessionId: bound,
        getSessionId: () => lastSessionId,
        attach: attachSheet,
        log,
        options: replyOptions(),
        // 同一个会话一辈子只讲一次规矩：关面板再开、换回来都不重讲
        told: toldSessions,
      });
      log(`自动回报绑定会话 ${bound ?? '-'}｜间隔 ${cfg.replyIntervalSec}s｜${cfg.autoReply ? '开' : '关'}`);
      void ensureMonitoring();
      return watcher;
    };

    const attach = async (png, tag) => {
      if (!png) return [];
      if (!devices?.saveImage) return [];
      try {
        const ref = await devices.saveImage({
          data: png, mediaType: 'image/png', name: `see-world-${tag}-${Date.now()}.png`,
        });
        return ref ? [ref] : [];
      } catch (e) {
        log(`saveImage 失败：${String(e?.message ?? e)}`);
        return [];
      }
    };

    /** 把一张 sheet 的 png 挂成附件（自动回报、面板送图都走它）。 */
    const attachSheet = async (sheet) => (sheet?.png ? attach(sheet.png, 'auto') : []);

    const result = (images, text, meta) => toLosslessJson({ images, text, meta });

    /**
     * 抓一段画面并挂成附件 —— 面板的「送进会话」和工具走同一条路，
     * 这样两边的图一定长得一样（同样的拼版、同样的亮度归一）。
     */
    const captureSheet = async ({ seconds = DEFAULT_LOOK_SEC, frames = null, device = null } = {}) => {
      const ready = await ensureEye(device);
      if (!ready.ok) return { ok: false, error: ready.error };
      const out = await ready.eye.look({
        seconds: Math.min(30, Math.max(0.6, Number(seconds) || DEFAULT_LOOK_SEC)),
        maxFrames: Number(frames) || cfg.maxFrames,
      });
      if (!out.ok) return { ok: false, error: out.error };
      const images = await attach(out.sheet.png, 'look');
      return { ok: true, sheet: out.sheet, images, out };
    };

    /**
     * 配置落盘 + 当场生效。
     *
     * 只有"采集参数"变了才需要停流重开（换设备 / 改分辨率 / 改帧率）；改个预览宽度
     * 或者监视开关不该让用户的画面黑一下。ffmpeg 路径变了要重解一次。
     */
    const applyConfig = async (patch) => {
      const saved = saveSettings(patch, env);
      settingsWarnings = saved.warnings ?? [];
      settingsPathShown = saved.path;
      if (!saved.ok) return { ok: false, path: saved.path, config: saved.config, warnings: saved.warnings };

      const next = saved.config;
      // previewWidth 也算"要重开流"：它决定实时流的尺寸，改了就换一条
      const captureChanged = ['device', 'width', 'height', 'fps', 'previewWidth'].some((k) => {
        const before = k === 'device' ? cfg.device : cfg[k === 'maxFrames' ? 'maxFrames' : k];
        if (k === 'device') return (next.device ?? null) !== (before ?? null);
        return Number(next[k]) !== Number(before);
      });

      cfg.device = next.device ?? null;
      cfg.width = next.width;
      cfg.height = next.height;
      cfg.fps = next.fps;
      cfg.maxFrames = next.frames;
      cfg.quality = next.quality;
      cfg.monitor = next.monitor;
      cfg.previewWidth = next.previewWidth;
      cfg.autoReply = next.autoReply;
      cfg.replyIntervalSec = next.replyIntervalSec;
      cfg.replyAttach = next.replyAttach;
      cfg.replyBudget = next.replyBudget;

      // 回报节奏改了要立刻生效：否则用户把间隔从 60 秒改成 5 秒，
      // 还得等下一次开流才认，那看起来就像"设置没保存"。
      if (watcher) {
        watcher.configure(replyOptions());
        if (cfg.autoReply && !watcher.state().running) watcher.start();
      }

      const pathChanged = (next.ffmpegPath ?? null) !== (loaded.config.ffmpegPath ?? null);
      if (pathChanged) {
        ff = resolveFfmpeg({ env, platform, settings: next });
        if (ff.path !== ffmpegPath) {
          ffmpegPath = ff.path;
          log(`ffmpeg 换成 ${ffmpegPath}（${ff.source}）`);
          if (eye) { try { eye.close(); } catch { /* ignore */ } }
          eye = null;
          eyeDevice = null;
        }
      }

      if (captureChanged && eye) {
        // 停掉旧流：留着它只会让"分辨率明明改了却没变"这种问题变得难查
        try { eye.close(); } catch { /* ignore */ }
        eye = null;
        eyeDevice = null;
      }
      // 自动回报必须有"攒图"这一步才转得动：单开 autoReply 也要把监控挂上，
      // 否则用户看到"自动回报：开"却永远收不到消息，这种静默失败最难查。
      if (eye?.running) await ensureMonitoring();
      else if (!(cfg.autoReply || cfg.monitor)) { try { eye?.stopMonitor(); } catch { /* ignore */ } }

      return {
        ok: true,
        path: saved.path,
        config: saved.config,
        warnings: saved.warnings,
        restarted: Boolean(captureChanged),
      };
    };

    /** 面板要的状态：比工具那份多一点（浏览器相关），但仍然只有事实。 */
    const routeStatus = () => {
      const st = eye?.status() ?? null;
      return {
        running: Boolean(st?.running),
        device: st?.device ?? cfg.device,
        capture: st ? { width: st.capture.width, height: st.capture.height, fps: st.capture.fps } : { width: cfg.width, height: cfg.height, fps: cfg.fps },
        preview: st?.preview ?? null,
        frames: st?.frames ?? 0,
        analysed: st?.analysed ?? 0,
        ageMs: st?.ageMs ?? null,
        restarts: st?.restarts ?? 0,
        sheets: st?.sheets ?? 0,
        pending: st?.pending ?? 0,
        monitoring: Boolean(st?.monitoring),
        exposure: st?.exposure ?? null,
        gain: st?.gain ?? null,
        score: st?.score ?? null,
        moved: st?.moved ?? null,
        lastError: st?.lastError ?? null,
        fatal: st?.fatal ?? null,
        idleReleaseInSec: st?.idleReleaseInSec ?? null,
        ffmpeg: { path: ffmpegPath, source: ff.source },
        settingsPath: settingsPathShown,
        warnings: settingsWarnings,
        previewWidth: cfg.previewWidth,
        defaultDevice: cfg.device,
        /** 自动回报这块的实况：面板上那个开关和倒计时都读这里。 */
        reply: (() => {
          const w = watcher?.state() ?? null;
          return {
            auto: w ? w.auto : Boolean(cfg.autoReply),
            intervalSec: w ? w.intervalSec : cfg.replyIntervalSec,
            attach: w ? w.attach : Boolean(cfg.replyAttach),
            budget: w ? w.budget : cfg.replyBudget,
            wakes: w?.wakes ?? 0,
            fails: w?.fails ?? 0,
            running: Boolean(w?.running),
            replyInSec: w?.replyInSec ?? null,
            note: w?.note ?? null,
            sessionId: w?.sessionId ?? lastSessionId ?? null,
            rulesTold: w?.rulesTold ?? false,
          };
        })(),
        sessions: [...knownSessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      };
    };

    /**
     * 装路由。
     *
     * `webServer` **不写进 inject**：没有它的部署（headless/命令行）仍然该有工具，
     * 写进去会让整个插件起不来。而且它可能比本插件晚挂载，所以必须在 `ctx.inject`
     * 的回调里注册 —— apply 时读一次会永远拿到 undefined。
     */
    /**
     * 取一帧给网页用（面板的静帧、实时预览的每一帧都走这里）。
     *
     * 缩放在这里做：摄像头原始帧是 1280×720，推给浏览器前先缩到面板要的宽度，
     * 编码成本就跟着预览尺寸走。返回 `ok:false` 时一定带 reason + hint ——
     * 面板要让用户看见"为什么没画面"，而不是一个沉默的黑框。
     * 只负责取原始像素，编码交给调用方（PNG 用于静帧，JPEG 用于预览）。
     */
    const grabFrame = ({ maxWidth } = {}) => {
      const width = Math.max(160, Math.min(3840, Number(maxWidth) || cfg.previewWidth || 640));
      if (!eye) {
        return {
          ok: false,
          reason: 'idle',
          warnings: ['摄像头还没打开'],
          hint: '点下面的「开始」，或者在会话里让我看一眼。',
        };
      }
      const st = eye.status?.() ?? {};
      if (st.fatal) {
        return {
          ok: false,
          reason: st.fatal.reason || 'fatal',
          warnings: [st.fatal.message || '采集起不来了'],
          hint: [st.fatal.hint, st.fatal.detail].filter(Boolean).join('\n'),
        };
      }
      const f = eye.latest?.({ maxWidth: width });
      if (!f) {
        const err = st.lastError ?? null;
        return {
          ok: false,
          reason: err?.reason || (st.running ? 'waiting-first-frame' : 'not-running'),
          warnings: [err?.message || (st.running ? '正在等第一帧…' : '摄像头没开')],
          hint: [err?.hint, err?.detail, st.running ? '' : '点下面的「开始」。'].filter(Boolean).join('\n'),
        };
      }
      return {
        ok: true,
        rgb: f.rgb,
        width: f.width,
        height: f.height,
        at: f.at,
        gain: Number(f.gain?.toFixed?.(2) ?? f.gain),
      };
    };

    /** 面板预览的 JPEG 编码器：按「尺寸」复用，一个尺寸一个常驻 ffmpeg 进程。 */
    const encoders = new Map();
    const encoderFor = (w, h) => {
      const key = `${w}x${h}`;
      const hit = encoders.get(key);
      if (hit?.canEncode()) return hit;
      if (hit) encoders.delete(key);
      try {
        const enc = createJpegEncoder({
          ffmpegPath,
          width: w,
          height: h,
          quality: 5,
          log,
          onBroken: (why) => {
            log(`预览 JPEG 编码器停了，改用 PNG：${why}`);
            encoders.delete(key);
          },
        });
        encoders.set(key, enc);
        return enc;
      } catch (e) {
        log(`预览 JPEG 编码器建不起来：${e?.message ?? e}`);
        return null;
      }
    };
    const closeEncoders = () => {
      for (const enc of encoders.values()) { try { enc.close(); } catch { /* ignore */ } }
      encoders.clear();
    };

    const readFrame = ({ maxWidth } = {}) => {
      const g = grabFrame({ maxWidth });
      if (!g.ok) return g;
      return {
        ok: true,
        png: encodePng(g.rgb, g.width, g.height, { level: 1 }),
        width: g.width,
        height: g.height,
        at: g.at,
        gain: g.gain,
      };
    };

    /**
     * 实时预览用的取帧。
     *
     * 摄像头是独占的，一个设备只能有一个 ffmpeg，所以"给主人看的视频流"和
     * "给模型看的帧"从同一个进程里分两路出（`dualOutputArgs`）：MJPEG 走 stdout、
     * 分析小帧走 fd 3。这里要的就是那路现成的 JPEG —— 不重编码、不占 JS 的 CPU，
     * 30fps 也能推得动。
     *
     * 只有在没开预览（设备不支持双路）时，才退回"取原始帧 + 自己压 JPEG"的老路。
     */
    const liveFrame = async ({ maxWidth } = {}) => {
      const st = eye?.status?.() ?? null;
      const ready = eye?.latestJpeg?.();
      if (ready) {
        return {
          ok: true,
          data: ready.data,
          mediaType: 'image/jpeg',
          width: st?.preview?.width ?? 0,
          height: st?.preview?.height ?? 0,
          at: ready.at,
          gain: st ? Number(st.gain?.toFixed?.(2) ?? st.gain) : 1,
        };
      }
      if (st?.preview) {
        // 预览这条路开着但还没吐出第一张：这一拍跳过，别退回 PNG 把 CPU 打满
        return { ok: false, reason: 'busy', skip: true };
      }
      const g = grabFrame({ maxWidth });
      if (!g.ok) return g;
      const enc = encoderFor(g.width, g.height);
      if (enc) {
        enc.push(g.rgb, g.at ?? Date.now());
        const snap = enc.snapshot();
        if (snap) {
          return {
            ok: true,
            data: snap.jpg,
            mediaType: 'image/jpeg',
            width: g.width,
            height: g.height,
            at: snap.at,
            gain: g.gain,
          };
        }
        // 编码器刚起来还没吐出第一帧：这一拍跳过，别退回 PNG 把 CPU 打满
        return { ok: false, reason: 'busy', skip: true };
      }
      return {
        ok: true,
        data: encodePng(g.rgb, g.width, g.height, { level: 1 }),
        mediaType: 'image/png',
        width: g.width,
        height: g.height,
        at: g.at,
        gain: g.gain,
      };
    };

    /** 实时预览的分发器：面板开着一条长连接时，这里按帧推画面。 */
    const preview = createPreview({ frame: liveFrame, log });

    const installRoutes = (controllerOf) => {
      try {
        if (typeof ctx?.inject !== 'function') { log('宿主没有 ctx.inject，跳过网页接口'); return; }
        const handle = createRoutes({
          log,
          connection: () => { try { return serviceOf(ctx, 'connection'); } catch { return null; } },
          status: routeStatus,
          frame: readFrame,
          stream: ({ res, width, fps }) => preview.subscribe({ res, width, fps }),
          devices: async () => {
            refreshFfmpeg();
            const found = await listDevices({ ffmpegPath, platform, timeoutMs: 12_000 });
            return {
              devices: found.devices ?? [],
              reason: found.reason ?? null,
              ffmpegPath,
              selected: cfg.device,
            };
          },
          config: () => ({
            path: settingsPathShown,
            config: { ...cfg, device: cfg.device, frames: cfg.maxFrames, framesRaw: cfg.maxFrames },
            defaults: DEFAULTS,
            resolutions: RESOLUTIONS,
            warnings: settingsWarnings,
            ffmpeg: { path: ffmpegPath, source: ff.source },
            platform,
          }),
          saveConfig: (patch) => applyConfig(patch),
          control: async (action, opts = {}) => {
            // 换绑会话：面板上"哪个会话负责处理画面"下拉就走这条
            if (action === 'bind') {
              const target = String(opts.sessionId ?? '').trim();
              if (!target) return { ok: false, warnings: ['没给会话 id'], running: Boolean(eye?.running) };
              if (watcher) watcher.bind(target);
              else if (eye) { ensureWatcher(target)?.start(); }
              lastSessionId = target;
              return { ok: true, running: Boolean(eye?.running), sessionId: target, reply: routeStatus().reply };
            }
            if (action === 'stop') {
              try { watcher?.stop('面板停止'); } catch { /* ignore */ }
              watcher = null;
              try { eye?.stopMonitor(); } catch { /* ignore */ }
              try { eye?.close(); } catch { /* ignore */ }
              // 长连接跟着收：否则浏览器还挂在那里等帧，面板也分不清"停了"和"卡了"
              try { preview.closeAll(); } catch { /* ignore */ }
              try { closeEncoders(); } catch { /* ignore */ }
              return { ok: true, running: false };
            }
            const ready = await ensureEye(opts.device ?? null);
            if (!ready.ok) {
              return {
                ok: false,
                running: false,
                warnings: [ready.error?.message ?? '打不开摄像头'],
                hint: ready.error?.hint ?? '',
                error: ready.error ?? null,
              };
            }
            const opened = await ready.eye.open();
            if (!opened.ok) {
              const why = opened.error ?? {};
              return {
                ok: false,
                running: false,
                warnings: [why.message ?? '打不开摄像头'],
                hint: why.hint ?? '',
                error: why,
              };
            }
            // 面板一开就把自动回报挂上：这才是"打开看世界，这个会话就负责画面"
            await ensureMonitoring();
            const bound = String(opts.sessionId ?? '').trim() || lastSessionId || null;
            try { ensureWatcher(bound)?.start(); } catch (e) { log(`自动回报起不来：${e?.message ?? e}`); }
            return {
              ok: true,
              running: Boolean(ready.eye.running),
              sessionId: bound,
              reply: routeStatus().reply,
            };
          },
          send: async ({ sessionId, seconds, frames, note }) => {
            const shot = await captureSheet({ seconds, frames });
            if (!shot.ok) {
              return {
                ok: false,
                warnings: [shot.error?.message ?? '抓不到画面'],
                hint: shot.error?.hint ?? '',
                error: shot.error ?? null,
              };
            }
            const target = sessionId || lastSessionId;
            // 会话里那张图就是"用户自己贴了一张照片"，所以文案写成用户视角，
            // 别让模型以为这是系统塞进来的指令。
            const text = [
              note || '这是我这边摄像头刚拍到的画面。',
              `（${sheetText(shot.sheet, { action: 'send' }).split('\n')[0]}）`,
            ].join('\n');
            const woken = await wakeSession(ctx, { sessionId: target, text, images: shot.images });
            return {
              ok: true,
              images: shot.images.length,
              sent: Boolean(woken?.ok),
              sessionId: target,
              wake: woken?.ok ? 'ok' : (woken?.reason ?? 'unknown'),
              text,
            };
          },
        });

        ctx.inject(['webServer'], (scoped) => {
          scoped.effect(
            () => scoped.webServer.register({
              kind: 'prefix',
              path: ROUTE_PREFIX,
              handler: (req, res) => handle(req, res),
            }),
            'dsh-see-world: routes',
          );
        });
      } catch (e) {
        writeLog(env, `装路由失败：${String(e?.message ?? e)}`);
        log(`装路由失败：${String(e?.message ?? e)}`);
      }
    };

    installRoutes();

    const helpText = [
      'see_world —— 通过摄像头看世界',
      '',
      '动作：',
      '  look      采样几秒，现在就看一眼（默认 3 秒，最多 30）',
      '  watch     阻塞等：先给当前画面（约 2 秒），之后只在"有变化"时返回',
      '  peek      取一张插件已经攒好的图（被叫醒后用）',
      '  snapshot  一张原分辨率静止图（会短暂停流，约 2 秒）',
      '  devices   列出摄像头设备',
      '  status    采集状态、分辨率、亮度、叫醒次数',
      '  stop      放开摄像头',
      '',
      '设置文件：$DSH_HOME/see-world.json',
      '  { "device": "4K AutoFocus Webcam", "width": 1280, "height": 720, "fps": 10,',
      '    "frames": 4, "quality": 1, "ffmpegPath": "D:\\\\tools\\\\ffmpeg\\\\bin\\\\ffmpeg.exe",',
      '    "monitor": true, "autoReply": true, "replyIntervalSec": 25,',
      '    "replyAttach": true, "replyBudget": 20 }',
      '',
      '自动回报（这个插件和"看一眼就走"的工具最大的不同）：',
      '  · 面板一点「开始」，画面出现值得看的变化就会自动投一条消息进当前会话（可带图）',
      '  · 规矩只在第一句话里说一次，之后都是短消息；不想被自动回报就在面板上关掉',
      '  · 间隔 replyIntervalSec（3~600 秒）、次数上限 replyBudget、是否带图 replyAttach',
      '',
      '行为约定：',
      '  · 亮度自动归一到中灰（对着窗户/灯的过曝画面会先压暗再交给你）',
      '  · 多帧拼成一张图，每格左上角钟点、右上角序号；装 4 帧和装 1 帧的 token 几乎一样',
      '  · 空闲 10 分钟没人理就自动放开摄像头（别人还要开会）',
      '  · 自动回报关掉时，只有你调 look/watch/peek 它才会看',
    ].join('\n');

    const spec = seeWorldToolSpec();
    const defineTool = await loadDefineTool({ log });

    const toolObj = {
      ...spec,
      async execute(args = {}, run) {
        const action = String(args.action ?? 'look').toLowerCase();
        const sessionId = callerSessionOf(run) ?? lastSessionId;
        log(`action=${action} session=${sessionId ?? '-'}`);

        try {
          if (action === 'help') {
            return result([], helpText, { action, version: 1 });
          }

          if (action === 'devices') {
            refreshFfmpeg();
            const found = await listDevices({ ffmpegPath, platform, timeoutMs: 12_000 });
            const list = found.devices ?? [];
            const text = list.length
              ? [
                `找到 ${list.length} 个设备（ffmpeg: ${ffmpegPath}）：`,
                ...list.map((d) => `  · ${d.name}  [${d.kind}]`),
                '',
                `当前使用：${cfg.device ?? '（未指定，将取第一个视频设备）'}`,
                '要换设备就把名字传给 `see_world({device:"..."})`，或写进 $DSH_HOME/see-world.json。',
              ].join('\n')
              : `没列出设备（${found.reason ?? '未知原因'}）。\n${ffmpegHint()}`;
            return result([], text, { action, devices: list, ffmpegPath });
          }

          if (action === 'status') {
            refreshFfmpeg();
            const st = eye?.status() ?? { running: false, device: cfg.device, note: '还没打开过摄像头' };
            const w = watcher?.state() ?? null;
            const text = [
              `设备：${st.device ?? '（未指定）'}｜采集 ${st.capture ? `${st.capture.width}×${st.capture.height}@${st.capture.fps}` : '-'}`,
              `状态：${st.running ? '运行中' : '未运行'}｜已收 ${st.frames ?? 0} 帧 / 分析 ${st.analysed ?? 0} 次｜重开 ${st.restarts ?? 0} 次`,
              st.ageMs != null ? `最近一帧：${(st.ageMs / 1000).toFixed(1)} 秒前` : '还没收到帧',
              st.exposure ? `亮度：${exposureWord(st.exposure)}（均值 ${Math.round(st.exposure.meanV)}/255），增益 ×${st.gain}` : '亮度：未知',
              `攒着的图：${st.pending ?? 0} 张｜已出图 ${st.sheets ?? 0} 张｜监控：${st.monitoring ? '开' : '关'}`,
              `自动回报：${(w?.auto ?? cfg.autoReply) ? '开' : '关'}｜间隔 ${w?.intervalSec ?? cfg.replyIntervalSec} 秒`
                + `｜已回报 ${w?.wakes ?? 0}/${w?.budget ?? cfg.replyBudget} 次｜附图 ${(w?.attach ?? cfg.replyAttach) ? '是' : '否'}`
                + `${w?.sessionId ? `｜绑在会话 ${String(w.sessionId).slice(0, 8)}` : ''}`
                + `${w?.replyInSec != null ? `｜${w.replyInSec} 秒后下一次` : ''}`,
              w ? `叫醒：已叫 ${w.wakes} 次，失败 ${w.fails} 次${w.lastWakeAgoSec != null ? `，上次 ${w.lastWakeAgoSec} 秒前` : ''}${w.note ? `｜${w.note}` : ''}` : '叫醒：未启动',
              st.idleReleaseInSec != null ? `空闲释放：${st.idleReleaseInSec} 秒后` : '',
              st.lastError ? `上次错误：${st.lastError.reason} ${st.lastError.message}` : '',
              st.fatal ? `致命错误：${st.fatal.reason} ${st.fatal.message}` : '',
              `ffmpeg：${ffmpegPath}`,
            ].filter(Boolean).join('\n');
            return result([], text, { action, status: st, watcher: w });
          }

          if (action === 'stop') {
            watcher?.stop('模型调用 stop');
            watcher = null;
            eye?.stopMonitor();
            eye?.close();
            try { preview.closeAll(); } catch { /* ignore */ }
            try { closeEncoders(); } catch { /* ignore */ }
            return result([], '摄像头已放开（流已关闭，别人可以用它了）。自动回报也停了。要再看就再调 `look`。', { action });
          }

          if (action === 'peek') {
            const ready = await ensureEye(args.device);
            if (!ready.ok) return result([], errorText(ready.error), { action, error: ready.error });
            const sheet = ready.eye.peek();
            if (!sheet) {
              const st = ready.eye.status();
              return result([], [
                '现在没有攒着的图（说明这段时间画面没怎么变）。',
                `状态：${st.running ? '采集在跑' : '采集没开'}，最近一帧 ${st.ageMs != null ? `${(st.ageMs / 1000).toFixed(1)} 秒前` : '无'}。`,
                '要看现在的样子就调 `see_world({action:"look"})`。',
              ].join('\n'), { action, empty: true });
            }
            const images = await attach(sheet.png, 'peek');
            return result(images, sheetText(sheet, { action }), { action, sheet: summarize(sheet) });
          }

          if (action === 'snapshot') {
            const ready = await ensureEye(args.device);
            if (!ready.ok) return result([], errorText(ready.error), { action, error: ready.error });
            const shot = await ready.eye.snapshot();
            if (!shot.ok) return result([], errorText(shot.error), { action, error: shot.error });
            const images = await attach(shot.png, 'still');
            const text = [
              `摄像头：${eyeDevice}｜原图 ${shot.source.width}×${shot.source.height}｜${CLOCK(Date.now())}`,
              `亮度：${exposureWord(shot.exposure)}（均值 ${Math.round(shot.exposure.meanV)}/255），已自动${shot.gain > 1 ? '提亮' : '压暗'} ×${shot.gain.toFixed(2)}`,
              `耗时 ${shot.ms} ms（包含停下再重开流）`,
              shot.degraded ? `注意：这次抓到原图失败（${shot.error?.message}），给的是上一帧的放大图。` : '',
              '这是单帧原图，看不到动作；要动作就 `look`。',
            ].filter(Boolean).join('\n');
            return result(images, text, { action, gain: shot.gain, exposure: shot.exposure });
          }

          if (action === 'watch') {
            const ready = await ensureEye(args.device);
            if (!ready.ok) return result([], errorText(ready.error), { action, error: ready.error });
            const seconds = Math.min(860, Math.max(2, Number(args.seconds ?? DEFAULT_BLOCK_SEC)));
            const frames = Number(args.frames ?? cfg.maxFrames);
            // 先挂上循环：这样等 watch 返回、模型说完话之后，变化还能叫醒它
            const w = ensureWatcher(sessionId);
            w?.start();
            await ready.eye.startMonitor({});
            const out = await ready.eye.watch({ seconds, maxFrames: frames });
            if (!out.ok || !out.sheet) {
              return result([], errorText(out.error ?? { reason: 'no-frame', message: '摄像头没送出画面' }), { action, error: out.error ?? null });
            }
            const images = await attach(out.sheet.png, 'watch');
            const head = out.initial
              ? '开场画面（现在的样子）：'
              : out.quiet
                ? `等了 ${Math.round(out.waited ?? seconds)} 秒，画面基本没变：`
                : out.immediate ? '刚才攒下的一张：' : '画面有变化：';
            return result(images, `${head}\n${sheetText(out.sheet, { action, note: args.note })}`,
              { action, sheet: summarize(out.sheet), initial: Boolean(out.initial), quiet: Boolean(out.quiet) });
          }

          // 默认：look
          const ready = await ensureEye(args.device);
          if (!ready.ok) return result([], errorText(ready.error), { action, error: ready.error });
          const seconds = Math.min(30, Math.max(0.6, Number(args.seconds ?? DEFAULT_LOOK_SEC)));
          const frames = Number(args.frames ?? cfg.maxFrames);
          const out = await ready.eye.look({ seconds, maxFrames: frames });
          if (!out.ok) return result([], errorText(out.error), { action, error: out.error });
          const images = await attach(out.sheet.png, 'look');
          return result(images, sheetText(out.sheet, {
            action, elapsed: out.elapsed, samples: out.samples, note: args.note,
          }), { action, sheet: summarize(out.sheet), movedMax: out.movedMax });
        } catch (e) {
          const err = { reason: 'capture-failed', message: String(e?.message ?? e), hint: '' };
          writeLog(env, `execute(${action}) 抛错：${err.message}\n${e?.stack ?? ''}`);
          return result([], errorText(err), { action, error: err });
        }
      },
    };

    const disposers = [];
    disposers.push(tools.register(defineTool(toolObj)));

    // 关掉插件（改写配置、卸载）时别把 ffmpeg 留在后台
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        try { watcher?.stop('插件卸载'); } catch { /* ignore */ }
        try { preview.closeAll(); } catch { /* ignore */ }
        try { closeEncoders(); } catch { /* ignore */ }
        try { eye?.close(); } catch { /* ignore */ }
        for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
      });
    }

    log('注册完成');
  } catch (e) {
    writeLog(env, `apply 失败：${String(e?.message ?? e)}\n${e?.stack ?? ''}`);
    if (env.DSH_SEE_WORLD_DEBUG) throw e;
  }
}

/** 只留摘要（完整 sheet 里有 png Buffer 和几百个数字，不该进 meta）。 */
function summarize(sheet) {
  if (!sheet) return null;
  return {
    device: sheet.device,
    capture: sheet.capture,
    from: sheet.from,
    to: sheet.to,
    frames: sheet.frames?.length ?? 0,
    size: { width: sheet.width, height: sheet.height },
    tile: { width: sheet.tileW, height: sheet.tileH, cols: sheet.cols, rows: sheet.rows },
    gain: Number(sheet.gain?.toFixed?.(2) ?? sheet.gain),
    exposure: sheet.exposure,
    note: sheet.note,
  };
}

// 便于外部复用 / 自测
export { createEye, createWatcher, TOOL_NAME };
export { still, listDevices } from './capture.js';
export { buildSingle, buildSheet } from './sheet.js';
export { exposureOf, gainFor };
export { randomUUID };
