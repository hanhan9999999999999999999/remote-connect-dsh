/**
 * loop.js — 叫醒模型。
 *
 * ## 为什么必须有这一层
 *
 * 摄像头一直开着，图一直在攒。但**模型不会自己再来问**：
 * 它拿到一张图、回一句话，这一轮就结束了。用户看到的是「它答了一句，就没下文了」。
 * 所以「世界变了」这件事必须由插件主动投一条消息进会话。
 *
 * 反过来也不能乱叫：一秒叫一次，模型会一直说话，那是刷屏不是看世界。
 * 所以这里只做四件事 —— **间隔（可配）、限量（可配）、可关、可停**。
 *
 * ## 「说一次就够」
 *
 * 自动回报的第一条消息里把规则说清（不用调工具、每次只说一两句、怎么停），
 * 之后就是短消息。人不该在每一帧后面都看到一段"操作说明"。
 *
 * ## 投递通道
 *
 * 机器自己叫的走 `followup`（排到下一轮）：插断模型正在跑的任务反而更糟。
 * 人在窗口里说的走 `steer`（立刻进这一轮）—— 但摄像头插件没有窗口，
 * 所以这里只有 `followup`。
 */

import { randomUUID } from 'node:crypto';

/** 两次叫醒的硬下限。比这更密就不像"看世界"，像弹幕。 */
export const WAKE_MIN_GAP_MS = 8000;
/** 巡检间隔。纯本地算术，几乎不花什么。 */
export const TICK_MS = 2000;
/** 连续这么多次叫不醒就收工（会话没了还每 8 秒烧一次模型，是最贵的失败模式）。 */
export const WAKE_FAILS_MAX = 3;
/** 默认预算：一段最多自动叫这么多次；叫满就停，等用户/模型再开口。 */
export const MAX_AUTONOMOUS_WAKES = 20;
/** 这么久既没人说话、模型也没调工具 → 认为没人看了，收工。 */
export const IDLE_STOP_MS = 10 * 60 * 1000;

/** 取服务：先 `ctx.get()`，老环境才退回属性访问。 */
export function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没注册就是没注册 */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

export function controllerOf(ctx) { return serviceOf(ctx, 'sessionController'); }

/**
 * 一条 user 消息。
 *
 * `images` 是 `attachments.saveImage()` 换回来的 ref —— 内容块形状是
 * `{type:'image', attachment}`（dsh-llm 的 `ImageBlock`），放在文字前面：
 * 模型先看到画面，再看到那句话。
 */
function userMessage(text, images = []) {
  const blocks = [];
  for (const ref of images ?? []) {
    if (ref) blocks.push({ type: 'image', attachment: ref });
  }
  blocks.push({ type: 'text', text: String(text ?? '') });
  return {
    id: randomUUID(),
    role: 'user',
    content: blocks,
    source: { kind: 'see-world' },
  };
}

/**
 * 就叫醒一次。绝不抛（抛了会被 ticker 的 catch 吞掉，问题看不出来）。
 *
 * 宿主定的三步：`resolveAgent(sessionId)` → `agent.followup(msg)` → `sessions.flush(agent.session)`。
 */
export async function wakeSession(ctx, { sessionId, text, images = [], mode = 'followup' } = {}) {
  const sc = controllerOf(ctx);
  if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
  if (!sessionId) return { ok: false, reason: 'no-session-id' };
  try {
    const resolved = await sc.resolveAgent(sessionId);
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      return { ok: false, reason: String(reason).slice(0, 160) };
    }
    const agent = resolved.agent;
    let via = 'followup';
    if (mode === 'steer' && typeof agent.steer === 'function') {
      try { agent.steer(userMessage(text, images)); via = 'steer'; } catch { agent.followup(userMessage(text, images)); }
    } else {
      agent.followup(userMessage(text, images));
    }
    let flushed = null;
    try {
      const sessions = serviceOf(ctx, 'sessions');
      if (sessions?.flush) flushed = await sessions.flush(agent.session);
    } catch { flushed = false; }
    return { ok: true, via, flushed };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}

/** 起钟。`unref()` 保证它不拖住宿主退出。 */
export function startTicker({ everyMs = TICK_MS, tick, immediate = false } = {}) {
  let disposed = false;
  let running = false;
  const guard = async () => {
    if (disposed || running) return;
    running = true;
    try { await tick(); } catch { /* 钟自己的问题不该把宿主带崩 */ } finally { running = false; }
  };
  const timer = setInterval(guard, everyMs);
  timer.unref?.();
  if (immediate) void guard();
  return { dispose() { disposed = true; clearInterval(timer); } };
}

/** 叫醒文案里要说清的事实（模型据此决定说什么，而不是猜）。 */
export function wakeText(sheet, { device, first = false, attached = false } = {}) {
  const frames = sheet?.frames?.length ?? 0;
  const moved = Math.max(0, ...(sheet?.frames ?? []).map((f) => f.moved ?? 0));
  const span = sheet?.from && sheet?.to
    ? `${new Date(sheet.from).toTimeString().slice(0, 8)} → ${new Date(sheet.to).toTimeString().slice(0, 8)}`
    : '';
  const exposure = sheet?.exposure
    ? (sheet.exposure.meanV > 200 ? '画面很亮（已自动压暗）'
      : sheet.exposure.meanV < 45 ? '画面很暗（已自动提亮，细节可能有限）'
        : '亮度正常')
    : '';

  const head = first
    ? [
      '[摄像头 · 自动回报已开始]',
      '从现在起，摄像头这边有值得看的变化我会直接发给你，不用你调工具，也不用问我要不要看。',
      '规矩（说这一次就够）：每次只说一两句你看到的东西；没新信息就说「没变化」；不要复述这段话，也不要解释流程。',
      '想让我停：说「别看了」，或者在「看世界」面板上关掉「自动回报」。',
      '',
    ]
    : [];

  const body = [
    `[摄像头] ${sheet?.note || '画面有变化'}。`,
    `设备 ${device}${span ? `，${span}` : ''}，共 ${frames} 帧；变动幅度 ${moved.toFixed(2)}（0=没动，1≈整屏换掉）${exposure ? `；${exposure}` : ''}。`,
  ];

  const how = attached
    ? ['图就是这次变化的那几帧（拼成一张，每格左上角钟点、右上角序号）。看完说一两句就行，不用再调工具取图。']
    : ['要看就调 `see_world({action:"peek"})` 取这张图（取一次就没了），然后只说一两句你看到的东西，不要顺手调别的工具。'];

  return [...head, ...body, ...how].join('\n');
}

/**
 * 常驻看世界的循环。
 *
 * @param {object} o
 * @param {object} o.ctx 宿主上下文
 * @param {object} o.eye createEye() 的返回值
 * @param {string} o.device
 * @param {string|null} o.sessionId 开始看的时候那个会话（不能每次现取：多开会话时会取错）
 * @param {() => string|null} [o.getSessionId]
 * @param {(sheet:object)=>Promise<Array>} [o.attach] 把 sheet 的 png 换成附件 ref
 * @param {(m:string)=>void} [o.log]
 * @param {object} [o.options] { auto, intervalSec, budget, attach }
 */
export function createWatcher({
  ctx,
  eye,
  device,
  sessionId = null,
  getSessionId = () => null,
  attach = null,
  log = () => {},
  options = {},
  told = null,
} = {}) {
  let ticker = null;
  let disposed = false;
  let lastWakeAt = 0;
  let wakes = 0;
  let fails = 0;
  let lastKey = null;
  let lastNote = null;
  let wakeLog = [];
  // told 是宿主传进来的 Set：同一个会话一辈子只听一次规矩，关掉面板再开也不重讲。
  let rulesTold = Boolean(sessionId && told?.has?.(sessionId));

  const clean = (patch = {}) => {
    const out = {};
    if (patch.auto !== undefined) out.auto = Boolean(patch.auto);
    if (patch.intervalSec !== undefined) {
      const n = Math.round(Number(patch.intervalSec));
      if (Number.isFinite(n)) out.intervalSec = Math.min(600, Math.max(3, n));
    }
    if (patch.budget !== undefined) {
      const n = Math.round(Number(patch.budget));
      if (Number.isFinite(n)) out.budget = Math.min(200, Math.max(1, n));
    }
    if (patch.attach !== undefined) out.attach = Boolean(patch.attach);
    if (patch.device !== undefined) out.device = String(patch.device ?? '');
    return out;
  };

  let cfg = { auto: true, intervalSec: 25, budget: MAX_AUTONOMOUS_WAKES, attach: true, ...clean(options) };

  const sid = () => sessionId || getSessionId() || null;
  const gapMs = () => Math.max(WAKE_MIN_GAP_MS, Math.round((Number(cfg.intervalSec) || 25) * 1000));

  const state = () => {
    const now = Date.now();
    const pending = eye.pendingCount ?? 0;
    const gap = gapMs();
    const since = lastWakeAt ? now - lastWakeAt : Infinity;
    return {
      running: Boolean(ticker) && !disposed,
      sessionId: sid(),
      auto: cfg.auto,
      intervalSec: cfg.intervalSec,
      budget: cfg.budget,
      attach: cfg.attach,
      wakes,
      fails,
      rulesTold,
      lastWakeAgoSec: lastWakeAt ? Math.round(since / 1000) : null,
      // 面板要显示"还要等几秒才轮到下一次回报"
      replyInSec: pending && cfg.auto && wakes < cfg.budget ? Math.max(0, Math.ceil((gap - since) / 1000)) : null,
      pending,
      note: lastNote,
      recent: wakeLog.slice(-5),
    };
  };

  const stop = (reason = 'stopped') => {
    disposed = true;
    ticker?.dispose();
    ticker = null;
    lastNote = reason;
    log(`循环停止：${reason}`);
  };

  const tick = async () => {
    if (disposed || !cfg.auto) return;
    const pending = eye.pendingCount;
    if (!pending) return;

    const head = eye.__state?.pending?.[0];
    const key = head ? `${head.from}-${head.to}-${head.frames?.length}` : null;
    if (key && key === lastKey) return;      // 同一张图不重复叫

    const now = Date.now();
    if (now - lastWakeAt < gapMs()) return;  // 间隔没到
    if (wakes >= cfg.budget) {
      stop(`这一段已经自动回报 ${wakes} 次，先停在这儿`);
      return;
    }
    const idle = eye.__state?.lastUseAt ? now - eye.__state.lastUseAt : 0;
    if (idle > IDLE_STOP_MS) {
      stop(`已经 ${Math.round(idle / 1000)} 秒没人理，收工`);
      return;
    }

    lastWakeAt = now;
    wakes += 1;
    lastKey = key;

    const first = !rulesTold;
    const wantAttach = Boolean(cfg.attach && attach && head?.png);
    let images = [];
    if (wantAttach) {
      try { images = (await attach(head)) ?? []; } catch (e) { log(`附图失败，改叫它自己 peek：${e?.message ?? e}`); }
    }
    const text = wakeText(head, { device: cfg.device || device, first, attached: images.length > 0 });
    const r = await wakeSession(ctx, { sessionId: sid(), text, images });
    if (r.ok) {
      fails = 0;
      rulesTold = true;
      try { told?.add?.(sid()); } catch { /* 宿主没给 Set 就算了 */ }
      wakeLog.push({ at: now, ok: true, images: images.length, text });
    } else {
      fails += 1;
      wakeLog.push({ at: now, ok: false, reason: r.reason });
      log(`叫醒失败（${fails}/${WAKE_FAILS_MAX}）：${r.reason}`);
      if (fails >= WAKE_FAILS_MAX) stop(`连续 ${fails} 次叫不醒：${r.reason}`);
    }
  };

  const start = () => {
    if (ticker) return state();
    disposed = false;
    lastNote = null;
    ticker = startTicker({ everyMs: TICK_MS, tick });
    return state();
  };

  /** 改配置 / 换绑会话，立刻生效（面板上拨开关就走这条路）。 */
  const configure = (patch = {}) => {
    cfg = { ...cfg, ...clean(patch) };
    if (patch.sessionId) sessionId = String(patch.sessionId);
    // 关掉自动回报时把钟也停了：留着它每 2 秒空转一次，纯浪费
    if (!cfg.auto && ticker) { ticker.dispose(); ticker = null; lastNote = '自动回报已关'; }
    return state();
  };

  const bind = (id) => {
    if (!id) return state();
    sessionId = String(id);
    // 换到另一个会话：只有它还没听过规矩时才要重讲一遍（同一个会话一辈子只讲一次）
    rulesTold = Boolean(told?.has?.(sessionId));
    return state();
  };

  return { start, stop, tick, state, configure, bind };
}
