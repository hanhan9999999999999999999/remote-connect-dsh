// TTS：优先 Edge 神经音色（和电脑端 DSH 的 TTS 插件同一套引擎），失败回落 Windows OneCore。
// 为什么换：OneCore 是系统 SAPI 音色，机械；Edge 的 zh-CN-XiaoxiaoNeural 等是神经音色，和电脑端听感一致。
// 之前我用 python edge-tts 失败过 —— 那是 v1 端点（speech.platform.bing.com）已废弃；
// 插件用的是 v2 端点 api.msedgeservices.com + Sec-MS-GEC 令牌，本文件复用插件内嵌的 worker 源码。
//
// 情感（2026-11-01 加）：Edge 免费端点实测拒收 mstts:express-as（code=1007 SSML is invalid，
// 合法 style 和乱写的 style 一律被拒，说明是解析阶段整条作废，不是"忽略"）。
// 所以情感只能落在 prosody 的 rate/pitch/volume 上，并且靠"每句话单独用一组参数合成"来做语气起伏。
// 参数表、标签解析、自动推断都在 ../tools/voice/emotion.mjs（语音领域的单一来源，本目录只消费）。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMOTIONS, DEFAULT_EMOTION, normalizeEmotion, emotionParams, inferEmotion,
  segmentByEmotion, stripEmotionTags, emotionCatalog, parseEmotionSpec,
} from '../tools/voice/emotion.mjs';

// 让 server.mjs / 前端能直接从这里问到情感表，不用再找一条路径
export { EMOTIONS, DEFAULT_EMOTION, normalizeEmotion, emotionParams, stripEmotionTags, emotionCatalog, parseEmotionSpec };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = process.env.PHONE_TTS_WORKER || path.join(HERE, 'tools', 'tts_onecore_worker.ps1');
const EDGE_WORKER = process.env.PHONE_EDGE_TTS_WORKER || path.join(HERE, 'tools', 'edge-tts-worker.cjs');
const OUTDIR = path.join(HERE, 'runtime', 'tts');
const MAX_BYTES = Number(process.env.PHONE_TTS_MAX_BYTES || 128 * 1024 * 1024); // 总量上限，超了按最旧删
// 条数只是兜底护栏：真正生效的是下面的字节上限（128MB ÷ 平均 220KB ≈ 580 个），
// 原来卡在 240 会让缓存只用到一半就被迫淘汰 → 老消息重放要重新合成（0.5–8s）。
const MAX_FILES = Number(process.env.PHONE_TTS_MAX_FILES || 600);

// Edge 失败后的冷却期：这段时间内直接走本地音色，不再每条语音都卡满预算。
// 为什么需要：断网 / Edge 抽风时，每条语音都要先白等 6 秒（还可能 ×3 次重试）才出声，
// 那个体验比"一上来就是机械音"糟得多。成功一次立刻解除冷却。
let edgeDownUntil = 0;
// 冷却别设长：Edge 的失败多是随机抖动，5 分钟冷却会把整段对话都锁在惠惠（机械、偏快）上，
// 表现成「换过音色但听起来还是那个声音」。30 秒足够躲开连续故障，又能很快回到神经音色。
const EDGE_COOLDOWN_MS = Math.max(0, Number(process.env.PHONE_EDGE_COOLDOWN_MS || 30000));
const EDGE_TIMEOUT = Number(process.env.PHONE_EDGE_TIMEOUT_MS || 25000);
// 预热进行中：这段时间发来的请求给更大的等待预算，避免"刚好在预热那一秒发语音"
// 被 6 秒预算砍掉、回落成机械音。预热本身只跑一次，之后就一直是 null。
let warmupPromise = null;

// Edge 神经音色（本机逐个实测可合成）。id 直接用微软音色全名，和电脑端插件一致。
export const VOICES = [
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 · 中文女声（默认，和电脑端同音色）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 中文女声（偏亮）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 中文女声（通用）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 中文男声（温和）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 中文男声（浑厚）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 中文男声（播音腔）', lang: 'zh', engine: 'edge' },
  { id: 'zh-CN-XiaobeiNeural', label: '晓北 · 中文女声（东北腔）', lang: 'zh', engine: 'edge' },
  { id: 'en-US-JennyNeural', label: 'Jenny · 英文女声', lang: 'en', engine: 'edge' },
  { id: 'en-US-GuyNeural', label: 'Guy · 英文男声', lang: 'en', engine: 'edge' },
];
export const DEFAULT_VOICE = 'zh-CN-XiaoxuanNeural';  // 主人 2026-10-31 指定：voice-message-01.mp3 就是她

// 老音色名（OneCore 时代）继续认，直接走本地系统音色，不联网
const ONECORE_IDS = ['Huihui', 'Yaoyao', 'Kangkang', 'Zira', 'David'];

// ---- 肥鱼本地引擎（CosyVoice3，跑在主人这台 4060 上）----
// 与 Edge 并列的第三种输出。模型服务见 phone-bridge/tools/feiyu-tts-service.py，
// 用根目录的「启动肥鱼语音.bat」起停。选它就完全离线、不依赖微软端点，
// 代价是首句要等模型推理（4060 上大约 0.4 秒 / 字，之后靠缓存）。
const FEIYU_DEFAULT_PORT = 8898;
export const FEIYU_STATE = process.env.PHONE_FEIYU_STATE || path.join(HERE, 'runtime', 'feiyu-tts', 'service.json');

// 肥鱼的端口不是写死的：8898 可能被本机别的项目（例如 DSH Live2D 的 mini-bridge）
// 先占走，肥鱼服务启动时会自动往后找空端口，并把真实端口写进 service.json。
// 这里按「PHONE_FEIYU_URL > service.json 的 port > 8898」解析，缓存键带上 state 文件的
// mtime 和当前 env —— 服务换端口、换 token 后，下一次请求就能跟上，不用重启桥。
let feiyuStateCache = { key: '', at: 0, url: '', token: '', port: 0, pid: 0 };
export function feiyuServiceState(force = false) {
  const envUrl = (process.env.PHONE_FEIYU_URL || '').trim().replace(/\/+$/, '');
  let mtime = 0;
  try { mtime = fs.statSync(FEIYU_STATE).mtimeMs; } catch {}
  const key = envUrl + '|' + mtime;
  if (!force && feiyuStateCache.key === key && Date.now() - feiyuStateCache.at < 5000) return feiyuStateCache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FEIYU_STATE, 'utf8')) || {}; } catch {}
  const port = Number(raw.port) > 0 ? Number(raw.port) : FEIYU_DEFAULT_PORT;
  feiyuStateCache = {
    key,
    at: Date.now(),
    url: envUrl || `http://127.0.0.1:${port}`,
    token: String(raw.token || ''),
    port,
    pid: Number(raw.pid) || 0,
  };
  return feiyuStateCache;
}
/** 当前肥鱼服务地址（会跟着 service.json 的端口走）。 */
export function feiyuUrl() {
  return feiyuServiceState().url;
}
/** 兼容旧引用：模块加载时的地址快照；动态地址请用 feiyuUrl()。 */
export const FEIYU_URL = feiyuServiceState().url;

const FEIYU_TIMEOUT = Math.max(5000, Number(process.env.PHONE_FEIYU_TIMEOUT_MS || 90000));
// 本地模型的推理时长≈音频时长，段切太长第一声会等很久，所以肥鱼单独用更短的段。
const FEIYU_SEG = Math.max(40, Number(process.env.PHONE_FEIYU_SEG || 90));

// 兜底音色表：服务没起、或还没拉到 /styles 时用它。真正的列表由 references 目录决定，
// 服务端扫到什么这里就同步什么（新增/删除参考音频不用改代码）。
const FEIYU_FALLBACK = [
  { id: 'feiyu-cute', label: '肥鱼 · 可爱', lang: 'zh', engine: 'feiyu', style: 'cute' },
  { id: 'feiyu-gentle', label: '肥鱼 · 温柔大姐姐', lang: 'zh', engine: 'feiyu', style: 'gentle' },
];

// 服务没起来时，手机上也应该看到 references 里真实存在的全部音色，而不是只剩两条兜底。
// 桥进程启动时直接扫一遍目录；服务起来后 /api/voices 会用 /styles 的结果覆盖（顺序/精调标记以服务为准）。
const FEIYU_REF_DIR = process.env.PHONE_FEIYU_REFS
  || path.join('D:', path.sep, 'feiyu', 'models', 'FeiyuVoice-CosyVoice3', 'references');
const FEIYU_ALIASES = {
  '可爱': 'cute', '温柔大姐姐': 'gentle', '小鲸鱼': 'whale', '八重神子': 'yae',
  '菲比': 'phoebe', '弗洛洛': 'fururu', '卡芙卡': 'kafka',
};
// 与 feiyu-tts-service.py 的 slug_for 保持一致：手机保存的是 feiyu-<slug>，发回服务时按 id 解析。
function feiyuSlug(name) {
  const raw = String(name || '').trim();
  if (FEIYU_ALIASES[raw]) return FEIYU_ALIASES[raw];
  const ascii = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  return 'style-' + crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 6);
}
const FEIYU_ORDER = ['cute', 'gentle', 'whale', 'yae', 'phoebe', 'fururu', 'kafka'];
function feiyuVoicesFromDisk() {
  try {
    const rows = fs.readdirSync(FEIYU_REF_DIR)
      .filter((f) => /\.wav$/i.test(f))
      .map((file) => {
        const stem = file.replace(/\.wav$/i, '');
        // 与服务一致：没有同名 .txt 参考文本的音色不可用，不列出来骗用户。
        if (!fs.existsSync(path.join(FEIYU_REF_DIR, stem + '.txt'))) return null;
        const style = feiyuSlug(stem);
        const rank = FEIYU_ORDER.indexOf(style);
        return {
          rank: rank === -1 ? 999 : rank,
          v: { id: 'feiyu-' + style, label: '肥鱼 · ' + stem, lang: 'zh', engine: 'feiyu', style },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.v.style.localeCompare(b.v.style))
      .map((x) => x.v);
    return rows.length ? rows : FEIYU_FALLBACK.slice();
  } catch {
    return FEIYU_FALLBACK.slice();
  }
}
let feiyuRegistry = feiyuVoicesFromDisk();

export const FEIYU_VOICES = FEIYU_FALLBACK;
export function feiyuVoices() {
  return feiyuRegistry;
}
export function allVoices() {
  return [...VOICES, ...feiyuRegistry];
}
export function isFeiyuVoice(id) {
  return feiyuRegistry.some((v) => v.id === id) || /^feiyu-/.test(String(id || ''));
}
export function defaultFeiyuVoice() {
  return (feiyuRegistry[0] && feiyuRegistry[0].id) || 'feiyu-cute';
}

/**
 * 从本地服务拉当前有哪些音色。失败就保留上一份（服务临时没起不该把手机上的列表清空）。
 * 返回的 id 带 `feiyu-` 前缀，和 Edge 音色在同一个 namespace 里不打架。
 */
export async function feiyuStyles(ms = 1500) {
  try {
    const res = await fetch(feiyuUrl() + '/styles', { signal: AbortSignal.timeout(Math.max(300, ms)) });
    if (!res.ok) return feiyuRegistry;
    const j = await res.json().catch(() => null);
    // 只认肥鱼自己的响应：别的程序碰巧占着这个端口时，别把它的 JSON 当成音色表。
    if (!j || !Array.isArray(j.styles)) return feiyuRegistry;
    const rows = j.styles;
    if (!rows.length) return feiyuRegistry;
    feiyuRegistry = rows.map((s) => ({
      id: 'feiyu-' + s.id,
      label: '肥鱼 · ' + (s.label || s.id) + (s.checkpointKind === 'finetune' ? '（精调）' : ''),
      lang: 'zh',
      engine: 'feiyu',
      style: s.id,
      seconds: s.referenceSeconds || 0,
    }));
    return feiyuRegistry;
  } catch {
    return feiyuRegistry;
  }
}
export const DEFAULT_FEIYU_VOICE = 'feiyu-cute';

// 给前端做引擎选择用的元数据。顺序就是手机上显示的先后。
export const ENGINES = [
  { id: 'edge', label: 'Edge 神经音色', hint: '在线，和电脑端同一套，9 个音色', online: true },
  { id: 'feiyu', label: '肥鱼 · 本地', hint: '本机 GPU 合成，完全离线，音色跟着 references 目录走', online: false },
  { id: 'onecore', label: '系统音色', hint: 'Windows 自带，断网兜底，机械感强', online: false },
];

// 服务的 token 在每次启动时重写；feiyuServiceState 已经按 mtime 缓存，这里直接取。
function feiyuToken() {
  return feiyuServiceState().token;
}

/**
 * 一个响应是不是肥鱼服务自己的。旧版（1.1.0 之前）没有 service 字段，用
 * ready/styles 形状兜底；被别的程序占端口时通常是 {ok:false,error:...}，一律不认。
 */
export function isFeiyuHealth(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.service === 'feiyu-tts') return true;
  return typeof j.ready === 'boolean' && Array.isArray(j.styles);
}

/** 本地服务活着吗、模型加载好没。给设置页显示状态用，超时很短，绝不拖慢页面。 */
export async function feiyuHealth(ms = 1200) {
  const t0 = Date.now();
  const url = feiyuUrl();
  try {
    const res = await fetch(url + '/health', { signal: AbortSignal.timeout(Math.max(200, ms)) });
    const j = await res.json().catch(() => null);
    if (!isFeiyuHealth(j)) {
      const hint = j && j.error ? String(j.error).slice(0, 80) : 'HTTP ' + res.status;
      return {
        ok: false, foreign: true, url, ms: Date.now() - t0,
        error: `${url} 被其他程序占用（${hint}）`,
      };
    }
    const rows = Array.isArray(j.styles) ? j.styles : [];
    const cur = rows.find((s) => s && s.id === j.style) || null;
    return {
      ok: true, url, ms: Date.now() - t0, port: feiyuServiceState().port,
      ready: !!j.ready, loading: !!j.loading, style: j.style || '',
      styleLabel: cur ? (cur.label || cur.id || '') : (j.style || ''),
      styles: j.styles || [], device: j.device || '', inferences: j.inferences || 0,
      loadError: j.loadError || '', version: j.version || '',
    };
  } catch (e) {
    // 服务可能刚换端口重启：丢掉缓存，下一次重新读 service.json。
    feiyuStateCache = { key: '', at: 0, url: '', token: '', port: 0, pid: 0 };
    return { ok: false, url, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/** -8% → 0.92。肥鱼只认倍率，情绪只能落在语速上（Edge 的 pitch 它没有）。 */
export function speedFromRate(rate) {
  const m = /^([+-]?\d+(?:\.\d+)?)\s*%/.exec(String(rate || ''));
  const n = m ? Number(m[1]) : 0;
  return Math.min(1.35, Math.max(0.65, Math.round((1 + n / 100) * 100) / 100));
}

/**
 * 这次该用哪个引擎、哪个音色。纯函数，方便单测。
 * 优先级：显式 engine > 音色 id 自带的归属 > 老规矩（未知音色走 OneCore）。
 */
export function resolveEngine(voice, wantEngine) {
  const asked = String(voice || DEFAULT_VOICE);
  const w = String(wantEngine || '').toLowerCase();
  const knownEdge = VOICES.some((v) => v.id === asked);
  const knownFeiyu = feiyuRegistry.some((v) => v.id === asked);
  const isFeiyu = isFeiyuVoice(asked);
  let engine = isFeiyu ? 'feiyu' : ONECORE_IDS.includes(asked) ? 'onecore' : knownEdge ? 'edge' : 'onecore';
  if (w === 'feiyu' || w === 'edge' || w === 'onecore') engine = w;
  // 引擎和音色必须同族，否则 worker 会拿到一个不存在的 voice 静默失败。
  // 肥鱼音色被删掉后，旧 id 会落到当前列表的第一个，而不是硬用那个死 id。
  let v = asked;
  if (engine === 'feiyu' && !knownFeiyu) v = defaultFeiyuVoice();
  if (engine === 'edge' && !knownEdge) v = DEFAULT_VOICE;
  if (engine === 'onecore' && !ONECORE_IDS.includes(asked)) v = 'Huihui';
  return { engine, voice: v, asked };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

let proc = null;
let buf = '';
const waiters = [];
let readyPromise = null;

function onLine(line) {
  if (waiters.length) waiters.shift()(line);
}
function nextLine(ms = 25000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tts timeout')), ms);
    waiters.push((l) => { clearTimeout(t); resolve(l); });
  });
}

function start() {
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', () => {
    proc = null;
    readyPromise = null;
  });
}

async function ensure() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    start();
    const first = await nextLine(20000);
    if (!/READY/.test(first)) throw new Error('tts worker 没起来：' + first.slice(0, 120));
    return true;
  })();
  return readyPromise;
}

export function status() {
  return {
    running: !!proc, voices: allVoices(), defaultVoice: DEFAULT_VOICE, dir: OUTDIR,
    engine: 'edge+onecore+feiyu', engines: ENGINES,
    defaultFeiyuVoice: DEFAULT_FEIYU_VOICE, feiyuUrl: feiyuUrl(),
  };
}

// ---- Edge 神经音色：spawn 插件内嵌的零依赖 worker（stdin 传文本，stdout 给 OK <tmp.mp3>）----
// 位置参数协议（worker 侧 findVoiceArgs）：voice rate pitch volume [style]
// rate/pitch/volume 就是情感的全部表达手段，见文件顶部说明。
function synthEdge(text, voice, outFile, params) {
  // 默认也必须走 emotionParams —— 直接取 EMOTIONS.neutral 会跳过全局语速偏移
  const p0 = params || emotionParams(DEFAULT_EMOTION);
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(process.execPath, [EDGE_WORKER, voice, p0.rate, p0.pitch, p0.volume], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      e ? reject(e) : resolve();
    };
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} done(new Error('edge tts 超时')); }, EDGE_TIMEOUT);
    p.on('error', (e) => done(e));
    p.on('close', (code) => {
      const m = /^OK (.+)$/m.exec(out);
      if (code === 0 && m) {
        const tmp = m[1].trim();
        try {
          fs.copyFileSync(tmp, outFile);
          try { fs.unlinkSync(tmp); } catch {}
          return done();
        } catch (e) {
          return done(e);
        }
      }
      done(new Error(String(err || out || ('exit ' + code)).replace(/\s+/g, ' ').slice(0, 180)));
    });
    p.stdin.end(text);
  });
}

const FFMPEG = process.env.PHONE_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.PHONE_FFPROBE || 'ffprobe';

// mp3 时长（秒）：给前端语音条显示「0:12」用
function mp3Dur(file) {
  return new Promise((resolve) => {
    let cp;
    try {
      cp = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return resolve(0);
    }
    let s = '';
    cp.stdout.setEncoding('utf8');
    cp.stdout.on('data', (d) => { s += d; });
    cp.on('error', () => resolve(0));
    cp.on('close', () => resolve(Math.round((Number(s) || 0) * 10) / 10));
    setTimeout(() => { try { cp.kill(); } catch {} resolve(0); }, 8000);
  });
}

// wav -> mp3（老路径：OneCore 输出 wav 时用）
// target 可指定：肥鱼的临时 wav 名字带 .fy 后缀，不能直接用 replace('.wav') 推。
function toMp3(wavFile, target) {
  return new Promise((resolve) => {
    const mp3 = target || wavFile.replace(/\.wav$/, '.mp3');
    try {
      if (fs.existsSync(mp3) && fs.statSync(mp3).size > 800) return resolve(mp3);
    } catch {}
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        if (ok && fs.existsSync(mp3) && fs.statSync(mp3).size > 800) return resolve(mp3);
      } catch {}
      resolve(wavFile);
    };
    let cp;
    try {
      cp = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-i', wavFile, '-ac', '1', '-b:a', '48k', mp3], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      return finish(false);
    }
    cp.on('error', () => finish(false));
    cp.on('close', (code) => finish(code === 0));
    setTimeout(() => { try { cp.kill(); } catch {} finish(false); }, 20000);
  });
}

function wavDur(wavFile) {
  try {
    const sz = fs.statSync(wavFile).size - 44;
    if (sz <= 0) return 0;
    return Math.round((sz / 32000) * 10) / 10;
  } catch {
    return 0;
  }
}

// 正经读 WAV 头：不依赖 ffprobe，也能认 24k / 44.1k 这些不同采样率。
// 为什么需要：本机没装 ffmpeg（toMp3 会原样留 wav），老 wavDur 又硬编码 32KB/s，
// 于是「肥鱼」这种 24k 立体声化后的文件时长会算错，语音条上的 0:12 就不可信。
function wavDurFile(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (st.size < 44) return 0;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(st.size, 65536));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4);
      const sz = head.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 20 <= head.length) byteRate = head.readUInt32LE(off + 16);
      else if (id === 'data') {
        dataSize = sz > 0 ? Math.min(sz, st.size - off - 8) : st.size - off - 8;
        break;
      }
      off += 8 + sz + (sz % 2);
    }
    if (!byteRate || dataSize <= 0) return 0;
    return Math.round((dataSize / byteRate) * 10) / 10;
  } catch {
    return 0;
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
  }
}

// 统一时长入口：wav 走头解析，mp3 才用 ffprobe
async function durOf(file) {
  if (/\.wav$/i.test(String(file || ''))) {
    const d = wavDurFile(file);
    if (d) return d;
  }
  return await mp3Dur(file);
}

// 预热：桥接启动后后台合成一句最短的话，把 node 进程、DNS、TLS 握手这些
// 「第一次才付」的成本提前花掉。用户第一次点语音时就不用等那 5–12 秒。
//
// 为什么必须真的连一次网：实测冷启动第一发要 12.1 秒，其中 DNS 解析独占 11.9 秒
// （Resolve-DnsName 实测 11896ms；缓存热了以后 dns.lookup 只要 43ms）。
// 所以「命中缓存就直接返回」的预热等于没做 —— 它只是读了个文件，网络路径依然冷。
// 这里命中缓存时改用一个一次性的假文本去真连，音频拿到就删。
//
// 另外这里**不能**走 synth()：synth() 只有 6 秒预算，冷启动 12 秒必然超时，
// 而超时会把边沿冷却打开，于是"启动后五分钟内所有语音都被误判成机械音"。
export async function warmup() {
  // 预热只跑一次；期间发来的真实请求共享这次连接尝试，别让它们各自再去冷解析一遍 DNS
  if (warmupPromise) return warmupPromise;
  warmupPromise = doWarmup().finally(() => { warmupPromise = null; });
  return warmupPromise;
}

async function doWarmup() {
  const voice = DEFAULT_VOICE;
  const emoKey = DEFAULT_EMOTION;
  const params = emotionParams(emoKey);
  const t0 = Date.now();
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const base = '嗯';
    const stem = cacheStemFor(base, voice, emoKey, params);
    const cachedFile = path.join(OUTDIR, stem + '.mp3');
    const cached = fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 800;
    // 命中缓存 → 用带时间戳的假文本绕开缓存，真正走一次 DNS/TLS；合成完立刻删
    const text = cached ? base + Date.now() : base;
    const target = cached ? path.join(OUTDIR, 'warmup-' + Date.now() + '.mp3') : cachedFile;
    const p = synthEdge(text, voice, target, params);
    p.catch(() => {});   // 与 synth() 同理：超时后它仍可能 reject，别让进程被 unhandledRejection 杀掉
    await p;
    const sz = fs.existsSync(target) ? fs.statSync(target).size : 0;
    if (cached) { try { fs.unlinkSync(target); } catch {} }
    if (sz < 1000) throw new Error('合成结果为空');
    return { ok: true, ms: Date.now() - t0, cached };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// 缓存 key 算法（纯函数，专门抽出来是为了能单测它 —— 这里错一次就是"播放永远只有第一次那个语气"）
//
// 规则：key 里必须同时含「情感名」和「最终的三参数」，两者任一变化都要换 key。
// 为什么连情感名都要进 key：neutral 和 happy 万一哪天参数撞了（比如都调成 -8%），
// 只按参数算 key 会让两条不同语义的语音共用一份缓存，将来一改参数就串味。
//
// 注意：加情感功能时 key 算法整体换了代，**磁盘上旧的 600 个缓存不再命中**。
// 这是有意的 —— 语速统一调慢过（RATE_SHIFT），旧音频的语速本来就和现在不一致，
// 继续命中反而是错的。旧文件留在 runtime/tts 由 prune 按容量自然淘汰，不用手动清。
export function cacheStemFor(clean, voice, emoKey, params, engine) {
  const p = params || emotionParams(DEFAULT_EMOTION);
  // 引擎维度只对非 Edge 生效：Edge 的历史缓存保持原 key，不因为这次改造全部作废。
  const eng = engine === 'feiyu' ? '|eng:feiyu' : engine === 'onecore' ? '|eng:onecore' : '';
  const payload = clean + '|' + voice + '|emo:' + (emoKey || DEFAULT_EMOTION) + '|' + p.rate + '|' + p.pitch + '|' + p.volume + eng;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

// 调本地肥鱼服务合成一句。返回结构和 Edge 那条路一致，上层不用分叉。
async function synthFeiyu(clipped, voiceId, emoKey, params, stem) {
  const v = feiyuRegistry.find((x) => x.id === voiceId) || feiyuRegistry[0];
  const speed = speedFromRate(params && params.rate);
  const tmp = path.join(OUTDIR, stem + '.fy.wav');
  const t0 = Date.now();
  const token = feiyuToken();
  let res;
  try {
    res = await fetch(feiyuUrl() + '/tts', {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json; charset=utf-8' },
        token ? { 'x-feiyu-token': token } : {},
      ),
      body: JSON.stringify({ text: clipped, style: v.style, speed, format: 'wav' }),
      signal: AbortSignal.timeout(FEIYU_TIMEOUT),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    throw new Error(/fetch failed|ECONNREFUSED|ECONNRESET/i.test(msg)
      ? '本地语音服务没起来，先双击「启动肥鱼语音.bat」'
      : msg.slice(0, 160));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('feiyu ' + res.status + ' ' + body.replace(/\s+/g, ' ').slice(0, 120));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error('肥鱼返回的音频是空的');
  fs.writeFileSync(tmp, buf);
  const mp3 = path.join(OUTDIR, stem + '.mp3');
  let file = await toMp3(tmp, mp3);
  if (file !== mp3) {
    // ffmpeg 不可用：留 wav，但名字必须符合 audioPath 的白名单（<hex>.wav）
    const wav = path.join(OUTDIR, stem + '.wav');
    try { fs.copyFileSync(tmp, wav); file = wav; } catch {}
  }
  try { fs.unlinkSync(tmp); } catch {}
  prune();
  return {
    file, name: path.basename(file), cached: false, ms: Date.now() - t0,
    voice: voiceId, asked: voiceId, fellBack: false, chars: clipped.length,
    dur: await durOf(file), engine: 'feiyu', style: v.style, emotion: emoKey,
  };
}

// Edge（或 OneCore 兜底）的完整合成路径。synth() 和肥鱼失败回落都走这里。
async function synthEdgeVoice(clipped, asked, emoKey, params, stem) {
  const key = stem + '.mp3';
  const cached = path.join(OUTDIR, key);
  const t0 = Date.now();
  // 冷却期内直接用本地音色，不让用户白等预算
  if (Date.now() < edgeDownUntil) {
    const oc = await synthOneCore(clipped, asked, stem + '.oc');
    return Object.assign(oc, { edgeError: 'edge cooling down', fellBack: true, emotion: emoKey });
  }
  try {
    // 给 Edge 一个总预算：首连偶发 1006 时它会内部重试、拖到 13 秒以上。
    // 超过预算就先回落本地音色出声（音质差但立刻能听），后台那次仍会完成并写入缓存。
    const BUDGET = warmupPromise
      ? Math.max(15000, Number(process.env.PHONE_EDGE_BUDGET_MS || 6000))
      : Math.max(1500, Number(process.env.PHONE_EDGE_BUDGET_MS || 6000));
    // 重试：Edge 免费端点的 1006 / "audio too small: 0" 是随机抖动，
    // 一次失败就掉到 OneCore（惠惠，机械 + 语速快）会让整段听感跳档，所以先重试几次。
    const TRIES = Math.max(1, Number(process.env.PHONE_EDGE_TRIES || 3));
    let lastErr = null;
    for (let i = 0; i < TRIES; i++) {
      // race 超时**不会取消** synthEdge，它之后仍可能 reject。
      // 不在这里挂一个 catch，Node 24 会把它当 unhandledRejection 直接杀进程 ——
      // 现象是"手机端用着用着服务自己没了"，日志里只有一行 uncaught 就断了，极难对到 TTS 上。
      const p = synthEdge(clipped, asked, cached, params);
      p.catch(() => {});
      try {
        await Promise.race([
          p,
          new Promise(function (_, rej) { setTimeout(function () { rej(new Error('edge budget ' + BUDGET + 'ms')); }, BUDGET); }),
        ]);
        const sz = fs.existsSync(cached) ? fs.statSync(cached).size : 0;
        if (sz < 1000) throw new Error('合成结果为空');
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        try { fs.unlinkSync(cached); } catch {}
        await new Promise((r) => setTimeout(r, 250 + i * 350));
      }
    }
    if (lastErr) throw lastErr;
    edgeDownUntil = 0;   // 成功一次立刻解除冷却
    prune();
    return {
      file: cached, name: key, cached: false, ms: Date.now() - t0, voice: asked, asked, fellBack: false,
      chars: clipped.length, dur: await durOf(cached), engine: 'edge', emotion: emoKey,
    };
  } catch (e) {
    // 网络不通就回落本地系统音色，别让用户点了没声音
    edgeDownUntil = Date.now() + EDGE_COOLDOWN_MS;
    try { fs.unlinkSync(cached); } catch {}
    // OneCore 用 .oc 后缀：它和 Edge 写的是同一个内容位置，如果同名，
    // 超时后后台 Edge 完成会把 OneCore 的音频覆盖掉，于是返回值说 onecore、实际文件是 edge，
    // dur / engine 全部对不上。分开命名后两条路径互不踩。
    const f = await synthOneCore(clipped, asked, stem + '.oc');
    return Object.assign(f, { edgeError: String(e.message || e).slice(0, 160), fellBack: true, emotion: emoKey });
  }
}

export async function synth(text, voice, emotion, intensity, wantEngine) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  const clipped = clean.slice(0, 1200);

  // 情感：认不出就按 neutral，绝不因为一个拼错的情感名把语音整条搞挂
  const emoKey = normalizeEmotion(emotion) || DEFAULT_EMOTION;
  // 必须走 emotionParams 而不是直接读 EMOTIONS[emoKey]：
  // 前者会套上全局语速偏移（RATE_SHIFT）与强度缩放，后者是原始设计值。直接读表 = 偏移永远不生效，
  // 而且缓存 key 会以为语速没变 —— 这正是"改了参数但听起来没变"那类最难查的 bug。
  const params = emotionParams(emoKey, intensity);

  fs.mkdirSync(OUTDIR, { recursive: true });
  const route = resolveEngine(voice, wantEngine);
  let stem = cacheStemFor(clipped, route.voice, emoKey, params, route.engine);
  // mp3 优先（有 ffmpeg 时），没有就用 wav —— 本机没装 ffmpeg，别把 wav 缓存当不存在
  const hit = (s) => {
    for (const ext of ['.mp3', '.wav']) {
      const f = path.join(OUTDIR, s + ext);
      try { if (fs.statSync(f).size > 800) return { file: f, name: s + ext }; } catch {}
    }
    return null;
  };
  const cachedFile = hit(stem);
  if (cachedFile) {
    return {
      file: cachedFile.file, name: cachedFile.name, cached: true, ms: 0, voice: route.voice, asked: route.asked,
      fellBack: false, chars: clipped.length, dur: await durOf(cachedFile.file), engine: route.engine, emotion: emoKey,
    };
  }

  // 1) 肥鱼本地（CosyVoice3）
  if (route.engine === 'feiyu') {
    try {
      return await synthFeiyu(clipped, route.voice, emoKey, params, stem);
    } catch (e) {
      // 服务没起来 / 模型还在加载 / 显存炸了 → 立刻回落 Edge。
      // 宁可这一句换了音色，也别让主人点了半天没声音。
      const feiyuError = String((e && e.message) || e).slice(0, 160);
      const fbVoice = DEFAULT_VOICE;
      stem = cacheStemFor(clipped, fbVoice, emoKey, params, 'edge');
      const c2 = hit(stem);
      if (c2) {
        return {
          file: c2.file, name: c2.name, cached: true, ms: 0, voice: fbVoice, asked: route.asked,
          fellBack: true, feiyuError, chars: clipped.length, dur: await durOf(c2.file), engine: 'edge', emotion: emoKey,
        };
      }
      const r = await synthEdgeVoice(clipped, fbVoice, emoKey, params, stem);
      return Object.assign(r, { asked: route.asked, fellBack: true, feiyuError });
    }
  }

  // 2) Edge 神经音色
  if (route.engine === 'edge') {
    return await synthEdgeVoice(clipped, route.voice, emoKey, params, stem);
  }

  // 3) 系统音色
  const oc = await synthOneCore(clipped, route.voice, stem + '.oc');
  return Object.assign(oc, { emotion: emoKey });
}

async function synthOneCore(clipped, asked, stem) {
  // 中文文本却选了英文音色 → OneCore 会合成出空音频，换中文
  const cjk = (clipped.match(/[\u4e00-\u9fff]/g) || []).length;
  const needZh = cjk >= 2 && cjk / clipped.length > 0.2;
  const askedObj = VOICES.find((x) => x.id === asked);
  let v = ONECORE_IDS.includes(asked) ? asked : 'Huihui';
  let fellBack = false;
  if (needZh && !['Huihui', 'Yaoyao', 'Kangkang'].includes(v)) { v = 'Huihui'; fellBack = true; }
  const wav = path.join(OUTDIR, stem + '.wav');
  await ensure();
  const t0 = Date.now();
  proc.stdin.write(b64(clipped) + '|' + b64(wav.replace(/\\/g, '/')) + '|' + b64(v) + '\n');
  const line = await nextLine(40000);
  if (!line.startsWith('OK|')) throw new Error('合成失败：' + line.slice(0, 200));
  const parts = line.split('|');
  try {
    const sz = fs.statSync(wav).size;
    if (sz < 1000) throw new Error('这个音色读不出这段文字（' + v + '），换一个音色试试');
  } catch (e) {
    if (String(e.message).indexOf('这个音色') === 0) { try { fs.unlinkSync(wav); } catch {} throw e; }
  }
  const dur = wavDurFile(wav) || wavDur(wav);
  // 没有 ffmpeg 时 toMp3 会把 wav 原样返回，而它的名字是 <hex>.oc.wav ——
  // audioPath 的白名单只认 <hex>.wav / <hex>.mp3，不改名的话前端拿到 url 会 404。
  const plainStem = String(stem).replace(/\.oc$/, '');
  let finalFile = await toMp3(wav, path.join(OUTDIR, plainStem + '.mp3'));
  if (!/\.mp3$/i.test(finalFile)) {
    const plainWav = path.join(OUTDIR, plainStem + '.wav');
    try { fs.renameSync(wav, plainWav); finalFile = plainWav; }
    catch { try { fs.copyFileSync(wav, plainWav); finalFile = plainWav; } catch {} }
  }
  prune();
  const finalName = path.basename(finalFile);
  return {
    file: finalFile, name: finalName, cached: false, ms: Number(parts[1]) || Date.now() - t0,
    voice: parts[3] || v, asked, fellBack, chars: clipped.length, dur, engine: 'onecore',
  };
}

function prune() {
  try {
    const names = fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.wav') || f.endsWith('.mp3'));
    const withTime = names
      .map((f) => { const p = path.join(OUTDIR, f); const st = fs.statSync(p); return { f, p, t: st.mtimeMs, sz: st.size }; })
      .sort((a, b) => a.t - b.t);
    // ① 数量上限
    let drop = Math.max(0, withTime.length - MAX_FILES);
    // ② 总量上限：从最旧的开始删，直到降到上限以内
    let total = withTime.reduce((s, x) => s + x.sz, 0);
    let i = 0;
    while (total > MAX_BYTES && i < withTime.length) { total -= withTime[i].sz; i++; drop = Math.max(drop, i); }
    for (let k = 0; k < drop; k++) { try { fs.unlinkSync(withTime[k].p); } catch {} }
  } catch {}
}

export function audioPath(name) {
  if (!/^[a-f0-9]{8,32}\.(wav|mp3)$/.test(String(name || ''))) return null;
  const f = path.join(OUTDIR, name);
  return fs.existsSync(f) ? f : null;
}

export function stop() {
  try { proc && proc.stdin.end(); } catch {}
  try { proc && proc.kill(); } catch {}
  proc = null;
  readyPromise = null;
}

// 按句子切段：长回复分成多段各自合成、前端连着播
export function splitText(text, max = 380) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const segs = clean.split(/(?<=[。！？!?；;…\n])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const s0 of segs) {
    if ((cur + s0).length <= max) { cur += s0; continue; }
    if (cur) { out.push(cur); cur = ''; }
    if (s0.length <= max) { cur = s0; continue; }
    for (let i = 0; i < s0.length; i += max) out.push(s0.slice(i, i + max));
  }
  if (cur) out.push(cur);
  return out;
}

// 分段计划：情感优先，长度其次。**必须是纯函数**，这是本文件最容易埋雷的地方。
// 原因：synthFirst 先返回第一段，前端播完再来 /api/tts?all=1 取剩余，
// 那一次会重新算一遍分段。两次结果只要差一点点，parts 的数量/顺序就错位，
// 表现是"长回复后半段串到别的句子上"或"少播一段"，而且只在长文本+情绪切换时偶发，极难复现。
// 所以：无随机、无时间、无外部状态，输入相同输出必然相同。
export function planSegments(text, forceEmotion, segMax, engine) {
  // segMax 显式给了就全局统一用它（测试、调参用）；没给就按每一档自己的节奏来——
  // 疲惫的人说不了长句、兴奋的人一长串不带喘，这个差别比调快慢更像真人。
  const explicitMax = segMax == null || segMax === '' ? null : Math.max(120, Number(segMax) || 380);
  // 本地模型的推理时长≈音频时长，一段 380 字要等一分半；肥鱼单独收紧到 90 字以内。
  const engineCap = engine === 'feiyu' ? FEIYU_SEG : 0;
  const clean = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  // 1) 先按显式标签 / 文本推断切出情感段
  const raw = segmentByEmotion(clean, forceEmotion);

  // 2) 相邻同情感、同强度合并：语气没变就不该多切一刀，多一段就多一个播放间隙
  const merged = [];
  for (const s of raw) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    const it = s.intensity == null ? 1 : s.intensity;
    const last = merged[merged.length - 1];
    if (last && last.emotion === s.emotion && last.intensity === it) last.text += t;
    else merged.push({ text: t, emotion: s.emotion, intensity: it });
  }

  // 3) 每段再按长度切（单段太长会让第一声等很久，实测 660 字单段要 14.7 秒）
  const out = [];
  for (const seg of merged) {
    const pr = emotionParams(seg.emotion, seg.intensity);
    const maxN0 = explicitMax == null
      ? Math.max(120, Number(process.env.PHONE_TTS_SEG || 0) || pr.segMax || 380)
      : explicitMax;
    const maxN = engineCap ? Math.min(maxN0, engineCap) : maxN0;
    if (seg.text.length <= maxN) { out.push({ ...seg, segMax: maxN, gap: pr.gap }); continue; }
    for (const piece of splitText(seg.text, maxN)) {
      const t = String(piece || '').trim();
      if (t) out.push({ text: t, emotion: seg.emotion, intensity: seg.intensity, segMax: maxN, gap: pr.gap });
    }
  }
  return out;
}

// 多段合成：按情感分段，每段用自己的 prosody 参数独立合成
export async function synthParts(text, voice, emotion, onProgress, wantEngine) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  const t0 = Date.now();
  const route = resolveEngine(voice, wantEngine);
  const segs = planSegments(clean, emotion, process.env.PHONE_TTS_SEG || null, route.engine);
  if (!segs.length) throw new Error('空文本');
  const parts = [];
  let total = 0;
  let fellBack = false;
  let usedVoice = route.voice;
  let engine = '';
  let edgeError = '';
  let feiyuError = '';
  // 进度回调：前端那根语音条的进度条靠它走（分段是并发的，所以按「完成了几段」计数）
  let doneCount = 0;
  const tick = (phase) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(doneCount, segs.length, phase); } catch (_) {}
  };
  tick('start');
  // 两路并发：Edge 每段是独立子进程，并发 2 能把长文本的等待近乎减半；
  // OneCore 是常驻单进程串行 worker，并发只是排队，不会出错。
  // 肥鱼只有一张显卡、服务端一把锁，并发只会互相等，直接串行。
  const CONC = route.engine === 'feiyu' ? 1 : Math.max(1, Number(process.env.PHONE_TTS_CONCURRENCY || 2));
  const results = new Array(segs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < segs.length) {
      const i = cursor++;
      try {
        results[i] = await synth(segs[i].text, route.voice, segs[i].emotion, segs[i].intensity, route.engine);
      } catch (e) {
        results[i] = { __err: e };
      }
      doneCount += 1;
      tick('seg');
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, segs.length) }, worker));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || r.__err) throw (r && r.__err) || new Error('分段合成失败');
    usedVoice = r.voice || usedVoice;
    if (r.fellBack) fellBack = true;
    if (r.engine && !engine) engine = r.engine;
    if (r.edgeError && !edgeError) edgeError = r.edgeError;   // 只记第一条，够定位就行
    if (r.feiyuError && !feiyuError) feiyuError = r.feiyuError;
    parts.push({ name: r.name, dur: r.dur || 0, cached: !!r.cached, emotion: r.emotion || segs[i].emotion, intensity: segs[i].intensity || 1, gapAfter: segs[i].gap || 0 });
    total += r.dur || 0;
  }
  return {
    parts,
    dur: total,
    voice: usedVoice,
    fellBack,
    engine: engine || route.engine,
    edgeError,
    feiyuError,
    ms: Date.now() - t0,
    chars: clean.length,
    name: parts.length ? parts[0].name : '',
    cached: parts.length > 0 && parts.every((x) => x.cached),
    emotion: parts.length ? parts[0].emotion : DEFAULT_EMOTION,
    emotions: [...new Set(parts.map((x) => x.emotion))],
  };
}

// 只等第一段就返回，剩下的在后台继续合成 —— 长回复「点了就出声」，不用等整段
export async function synthFirst(text, voice, emotion, onProgress, wantEngine) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  const route = resolveEngine(voice, wantEngine);
  // 这里必须和 synthParts 用同一个 planSegments，否则前端后续取剩余会对不上（见 planSegments 注释）
  const segs = planSegments(clean, emotion, process.env.PHONE_TTS_SEG || null, route.engine);
  if (!segs.length) throw new Error('空文本');
  if (segs.length <= 1) return await synthParts(clean, route.voice, emotion, onProgress, route.engine);
  const total = segs.length;
  const tick = (done) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(done, total, 'seg'); } catch (_) {}
  };
  tick(0);
  const first = await synth(segs[0].text, route.voice, segs[0].emotion, segs[0].intensity, route.engine);
  tick(1);
  // 后台把剩下的补上（成功后进缓存，前端下次请求就是秒回）
  (async () => {
    for (let i = 1; i < segs.length; i++) {
      try { await synth(segs[i].text, route.voice, segs[i].emotion, segs[i].intensity, route.engine); } catch (_) {}
      tick(i + 1);
    }
  })();
  return {
    parts: [{ ...first, intensity: segs[0].intensity || 1, gapAfter: segs[0].gap || 0 }],
    name: first.name || '',
    ms: first.ms || 0,
    dur: first.dur || 0,
    voice: first.voice,
    engine: first.engine || route.engine,
    // 这两个别丢：前端/日志靠它们判断"为什么这次是机械音"，丢了就只能猜
    fellBack: !!first.fellBack,
    edgeError: first.edgeError || '',
    feiyuError: first.feiyuError || '',
    chars: clean.length,
    segs: segs.length,
    more: segs.length - 1,
    cached: !!first.cached,
    emotion: first.emotion || segs[0].emotion,
    emotions: [...new Set(segs.map((s) => s.emotion))],
  };
}

// 语音缓存占用：给出数量/字节，并提供清理（手机上你会关心它到底占了多少）
export function cacheStats() {
  try {
    const files = fs.readdirSync(OUTDIR).filter((f) => /\.(mp3|wav)$/.test(f));
    let bytes = 0;
    let newest = 0;
    for (const f of files) {
      try { const st = fs.statSync(path.join(OUTDIR, f)); bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (_) {}
    }
    return { count: files.length, bytes, newest, max: MAX_FILES, maxBytes: MAX_BYTES };
  } catch (_) { return { count: 0, bytes: 0, newest: 0, max: MAX_FILES, maxBytes: MAX_BYTES }; }
}

export function cacheClear() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(OUTDIR)) {
      if (!/\.(mp3|wav)$/.test(f)) continue;
      try { fs.unlinkSync(path.join(OUTDIR, f)); n++; } catch (_) {}
    }
  } catch (_) {}
  return n;
}

/** 按上限清理一次（启动时调一次；老版本留下的缓存目录也能顺势瘦下来）。 */
export function cachePrune() {
  const before = cacheStats();
  prune();
  const after = cacheStats();
  return { dropped: before.count - after.count, bytes: before.bytes - after.bytes, ...after };
}
