/**
 * 面板行为的离线自检（真的会 re-render 的那种）。
 *
 * clienttest 里的 React 是"一次性求值"的退化成色：hooks 永远返回初值，
 * 所以它能验形态，验不了"点了之后会怎样"。这个脚本换一套能 re-render 的
 * 迷你 React（useState / useEffect / useRef / useCallback / useMemo + 可控
 * 定时器），于是下面这些以前只能靠肉眼在 DSH 里看的行为，现在有断言：
 *
 *   · 打开面板 → 拉到配置和状态 → 空态提示
 *   · 点「开始」→ POST /control {action:'start', sessionId}
 *   · running 之后 <img> 换成 /stream（实时流，不是轮询）
 *   · 按住标题栏拖动 → 位置变化 → 松手落盘 localStorage
 *   · 点「停止」→ POST /control {action:'stop'}
 *   · 自动回报关着时关面板 → 顺手 stop
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
function check(ok, label) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fails += 1;
  return ok;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(ROOT, 'client.js'), 'utf8');

// ── 迷你 React：能 re-render，effect 会在渲染后跑 ─────────────────────
function createHarness() {
  const cells = new WeakMap();
  let cur = null;
  let dirty = false;
  const timers = new Map();
  let nextTid = 1;
  let now = 0;
  const listeners = new Map();

  const same = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function execEffect(cell, fn, deps) {
    if (cell.ran && deps != null && same(cell.deps, deps)) return;
    if (typeof cell.cleanup === 'function') cell.cleanup();
    cell.deps = deps;
    cell.ran = true;
    const out = fn();
    cell.cleanup = typeof out === 'function' ? out : null;
  }

  let onElement = null;   // 由 createHost 注入：effects 跑之前把 ref 填好（React 就是这么干的）
  function renderComp(fn, props) {
    if (!cells.has(fn)) cells.set(fn, []);
    const store = cells.get(fn);
    const ctx = { store, i: 0, effects: [] };
    const prev = cur;
    cur = ctx;
    let out;
    try {
      out = fn(props);
    } finally {
      cur = prev;
    }
    if (onElement && out && typeof out === 'object') onElement(out);
    for (const e of ctx.effects) execEffect(e.cell, e.fn, e.deps);
    return out;
  }

  const React = {
    createElement(type, props, ...children) {
      const el = { type, props: props ?? {}, children: children.flat(Infinity) };
      return el;
    },
    useState(init) {
      const c = cur;
      const i = c.i++;
      if (!(i in c.store)) c.store[i] = { v: typeof init === 'function' ? init() : init };
      const cell = c.store[i];
      const set = (next) => {
        const v = typeof next === 'function' ? next(cell.v) : next;
        if (Object.is(v, cell.v)) return;
        cell.v = v;
        dirty = true;
      };
      return [cell.v, set];
    },
    useEffect(fn, deps) {
      const c = cur;
      const i = c.i++;
      if (!(i in c.store)) c.store[i] = { ran: false, deps: null, cleanup: null };
      c.effects.push({ cell: c.store[i], fn, deps });
    },
    useCallback(fn, deps) {
      const c = cur;
      const i = c.i++;
      const cell = c.store[i] ?? (c.store[i] = { fn, deps });
      if (!same(cell.deps, deps)) { cell.fn = fn; cell.deps = deps; }
      return cell.fn;
    },
    useMemo(fn, deps) {
      const c = cur;
      const i = c.i++;
      const cell = c.store[i] ?? (c.store[i] = { v: undefined, deps: null, has: false });
      if (!cell.has || !same(cell.deps, deps)) { cell.v = fn(); cell.deps = deps; cell.has = true; }
      return cell.v;
    },
    useRef(value) {
      const c = cur;
      const i = c.i++;
      if (!(i in c.store)) c.store[i] = { current: value };
      return c.store[i];
    },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setTimeout(fn, ms) { const id = nextTid++; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const fire = (type, ev) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(ev); };

  /** 把时间往前推，并把到点的定时器都跑一遍（跑完可能又排出新的）。 */
  async function advance(ms = 0) {
    now += ms;
    for (let guard = 0; guard < 400; guard += 1) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= now);
      if (!due.length) break;
      for (const [id, t] of due) {
        timers.delete(id);
        await t.fn();
      }
    }
    await flush();
  }
  const flush = () => new Promise((r) => setImmediate(r));

  return {
    React, win, fire, advance, flush, renderComp,
    setOnElement(fn) { onElement = fn; },
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; },
  };
}

// ── 假宿主 ────────────────────────────────────────────────────────────
function createHost({ language = 'zh-CN', store = {}, routes = {}, fetchStream = null } = {}) {
  const H = createHarness();
  const calls = [];
  const styles = [];
  const draws = [];
  const canvases = [];
  let loaded = null;

  const doc = {
    head: { appendChild: (el) => styles.push(el) },
    createElement: () => ({ tag: '', dataset: {}, textContent: '', remove() {} }),
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const win = {
    ...H.win,
    __ModuleLoader__: { load: (spec) => { loaded = spec; } },
    localStorage,
  };
  const nav = { language, clipboard: { writeText: async (t) => calls.push({ path: 'clipboard', text: t }) } };
  const url = { createObjectURL: () => 'blob:see-world', revokeObjectURL() {} };

  const table = {
    'GET /config': () => ({
      ok: true,
      config: {
        device: 'CAM', width: 1280, height: 720, fps: 10, frames: 4, quality: 1, previewWidth: 640,
        monitor: true, sendOnOpen: false, autoReply: true, replyIntervalSec: 25, replyAttach: true,
        replyBudget: 20, ffmpegPath: null,
      },
      resolutions: [[640, 480], [1280, 720]],
    }),
    'GET /status': () => ({
      ok: true, running: false, device: 'CAM',
      capture: { fps: 10, frames: 0 }, preview: { fps: 30 }, at: null,
      reply: { auto: true, intervalSec: 25, budget: 20, wakes: 0, running: false, sessionId: null, replyInSec: null },
      sessions: [],
    }),
    'POST /control': () => ({ ok: true, running: true }),
    'POST /send': () => ({ ok: true, images: 1 }),
    'POST /config': () => ({ ok: true, config: {}, warnings: [] }),
  };
  const fetchImpl = async (urlStr, init = {}) => {
    const method = init.method ?? 'GET';
    const path = String(urlStr).replace(/^.*\/api\/see-world/, '');
    const key = `${method} ${path.split('?')[0]}`;
    calls.push({ path: key, body: init.body ? JSON.parse(init.body) : undefined });
    // 实时流：由测试指定一个假 body（能一片片吐字节）
    if (key === 'GET /stream' && fetchStream) return fetchStream(urlStr);
    const handler = routes[key] ?? table[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({ ok: false }) };
    const body = handler(init.body ? JSON.parse(init.body) : undefined);
    const status = body?.__status ?? 200;
    const payload = { ...body };
    delete payload.__status;
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'navigator', 'fetch', 'URL', 'setTimeout', 'clearTimeout', CODE);
  run(win, doc, nav, fetchImpl, url, win.setTimeout, win.clearTimeout);

  const mod = loaded.factory((id) => {
    if (id === 'react') return H.React;
    throw new Error(`client.js 不该 require('${id}')`);
  });

  // 三个槽位组件
  const regs = [];
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (name, cb) => { cb(); return () => {}; },
      register: (spec, comp) => { regs.push({ spec, comp }); return () => {}; },
    },
  };
  mod.apply(ctx);
  const byId = {};
  for (const r of regs) byId[r.spec.name] = r.comp;

  const makeCanvas = () => {
    const el = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (bmp) => { draws.push({ w: bmp?.width, h: bmp?.height }); },
      }),
    };
    canvases.push(el);
    return el;
  };
  H.setOnElement((el) => {
    if (el.type === 'canvas' && el.props?.ref && typeof el.props.ref === 'object') {
      el.props.ref.current = makeCanvas();
    }
  });

  return {
    H, mod, regs, byId, calls, store, styles, win,
    draws,
    canvas: makeCanvas,
    canvases,
  };
}

/** 渲染一次并返回元素树（每次调用都会跑一遍 hooks + effects）。 */
function render(host, comp, props) {
  return expand(host, host.H.renderComp(comp, props));
}

/** 把树里的函数组件（Panel 里套的 LiveView 等）就地展开成元素树。 */
function expand(host, node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => expand(host, n));
  if (typeof node.type === 'function') return expand(host, host.H.renderComp(node.type, node.props));
  // React 会把 ref 填成 DOM 节点；这里用假 canvas 顶上，好让 LiveView 拿到 2d context
  if (node.type === 'canvas' && node.props?.ref && typeof node.props.ref === 'object') {
    node.props.ref.current = host.canvas();
  }
  return { ...node, children: expand(host, node.children) };
}

/** 反复渲染 + 推进微任务，直到状态稳定（子组件的 setState 要下一轮才见效）。 */
async function settle(host, comp, times = 4) {
  let tree = render(host, comp);
  for (let i = 0; i < times; i += 1) {
    await host.H.advance(0);
    tree = render(host, comp);
  }
  return tree;
}

/** 在树里按 className 找第一个节点。 */
function find(node, cls) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = find(n, cls); if (hit) return hit; }
    return null;
  }
  const cn = node.props?.className;
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) return node;
  return find(node.children, cls);
}
function findAll(node, cls, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, cls, out); return out; }
  const cn = node.props?.className;
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) out.push(node);
  findAll(node.children, cls, out);
  return out;
}
const hasCall = (calls, path, pred = () => true) => calls.some((c) => c.path === path && pred(c.body));

// ── 开始跑 ────────────────────────────────────────────────────────────
console.log('1) 打开面板：拉配置、拉状态、给空态提示');
let host;
{
  host = createHost({ store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) } });
  const panel = host.byId['shell.overlay'];
  check(typeof panel === 'function', '拿到 shell.overlay 组件');

  // 开着面板渲染
  host.mod.__test && null;
  const btn = host.byId['conversation.composer.dock'];
  const buttonEl = render(host, btn);
  check(!!buttonEl, '输入框按钮渲染出元素');
  buttonEl.props.onClick();                     // 打开面板
  await host.H.advance(0);                      // 让 bind / 配置请求飞出去

  let tree = render(host, panel);
  check(!!find(tree, 'dsw-panel'), '打开之后面板出现');
  const headText = JSON.stringify(tree).includes('看世界');
  check(headText, '面板标题带「看世界」');

  await host.H.advance(0);
  tree = render(host, panel);
  const empty = find(tree, 'dsw-empty-line');
  check(!!empty, `没有画面时有空态提示（${empty?.children?.join?.('') ?? ''}）`);
  check(hasCall(host.calls, 'POST /control', (b) => b?.action === 'bind' && b?.sessionId === 'sess-view'),
    '打开面板时把「当前会话」绑给宿主');
}

console.log('2) 点「开始」：真的让宿主开流，而且带上是哪个会话');
{
  let tree = render(host, host.byId['shell.overlay']);
  const buttons = findAll(tree, 'dsw-btn');
  const startBtn = buttons.find((b) => JSON.stringify(b.children).includes('开始'));
  check(!!startBtn, '有「开始」按钮');
  host.calls.length = 0;
  await startBtn.props.onClick();
  await host.H.advance(0);
  check(hasCall(host.calls, 'POST /control', (b) => b?.action === 'start'), 'POST /control {action:"start"}');
  check(hasCall(host.calls, 'POST /control', (b) => b?.action === 'start' && b?.sessionId === 'sess-view'),
    '「开始」带上了当前会话 id');
}

console.log('3) running 之后，画面换成实时流（不是一张张轮询）');
{
  // 让 /status 说"在跑"，再渲染
  const host2 = createHost({
    store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) },
    routes: {
      'GET /status': () => ({
        ok: true, running: true, device: 'CAM', at: Date.now(),
        capture: { fps: 10, frames: 12 }, preview: { fps: 30 },
        exposure: { meanV: 132 }, gain: 0.9, score: 12.5,
        reply: { auto: true, intervalSec: 25, budget: 20, wakes: 0, running: true, sessionId: 'sess-view', replyInSec: 20 },
        sessions: [],
      }),
    },
  });
  const btn2 = host2.byId['conversation.composer.dock'];
  render(host2, btn2).props.onClick();
  await host2.H.advance(0);
  render(host2, host2.byId['shell.overlay']);    // 第一次渲染挂上 effect
  await host2.H.advance(1000);                   // 让 useStatus 取到 running=true
  // 子组件（LiveView）会先退到 <img>，要再渲染一轮才看得到
  const tree = await settle(host2, host2.byId['shell.overlay'], 3);
  const shot = find(tree, 'dsw-shot');
  const img = find(tree, 'dsw-img');
  check(!!shot, '面板里有画面区域');
  check(!!img, '跑起来之后换成了 <img>（不是空态占位）');
  check(typeof img?.props?.src === 'string' && img.props.src.includes('/stream?'),
    `画面源是长连接流（${String(img?.props?.src).slice(0, 48)}…）`);
  check(img?.props?.src.includes('sess-view') === false, '流地址里不带会话 id（不该泄露到 URL）');
  check(img?.props?.src.includes('fps=30'), '流地址按 preview.fps 请求（30）');
}

console.log('4) 按住标题栏拖动：位置跟手，松手落盘');
{
  const host3 = createHost({ store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) } });
  render(host3, host3.byId['conversation.composer.dock']).props.onClick();
  await host3.H.advance(0);
  let tree = render(host3, host3.byId['shell.overlay']);
  const panelEl = find(tree, 'dsw-panel');
  const before = { left: panelEl.props.style.left, top: panelEl.props.style.top };
  const head = find(tree, 'dsw-panel-head');
  check(!!head?.props?.onPointerDown, '标题栏挂了 onPointerDown');

  head.props.onPointerDown({
    button: 0, clientX: 600, clientY: 300, target: null, preventDefault() {},
  });
  host3.H.fire('pointermove', { clientX: 660, clientY: 340 });
  await host3.H.advance(0);
  tree = render(host3, host3.byId['shell.overlay']);
  const after = find(tree, 'dsw-panel').props.style;
  check(after.left !== before.left || after.top !== before.top,
    `拖动之后位置变了（${before.left},${before.top} → ${after.left},${after.top}）`);
  // 往右拖会被右边界夹住：期望值取"跟手"与"不越界"中较小的那个
  const w = parseInt(panelEl.props.style.width, 10);
  const wantX = Math.min(parseInt(before.left, 10) + 60, 1280 - w - 6);
  check(parseInt(after.left, 10) === wantX,
    `x 跟手且不越界（期望 ${wantX}，实际 ${parseInt(after.left, 10)}）`);
  check(parseInt(after.top, 10) - parseInt(before.top, 10) === 40,
    `y 跟手 40px（实际 ${parseInt(after.top, 10) - parseInt(before.top, 10)}）`);

  host3.H.fire('pointerup', {});
  check(typeof host3.store['dsh-see-world.panel'] === 'string', '松手把位置写进 localStorage');
  const saved = JSON.parse(host3.store['dsh-see-world.panel']);
  check(saved.left === undefined && typeof saved.x === 'number', '存的是 {x,y,w}，刷新后能复原');
  check(saved.x === parseInt(after.left, 10), `存下来的 x 就是屏幕上的 x（${saved.x}）`);
}

console.log('5) 点「停止」与关面板');
{
  const runningStatus = () => ({
    ok: true, running: true, device: 'CAM', at: Date.now(),
    capture: { fps: 10, frames: 30 }, preview: { fps: 30 }, exposure: { meanV: 128 },
    reply: { auto: true, intervalSec: 25, budget: 20, wakes: 1, running: true, sessionId: 'sess-view', replyInSec: 22 },
    sessions: [],
  });
  const host4 = createHost({
    store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) },
    routes: { 'GET /status': runningStatus },
  });
  render(host4, host4.byId['conversation.composer.dock']).props.onClick();
  await host4.H.advance(0);
  render(host4, host4.byId['shell.overlay']);
  await host4.H.advance(1000);
  let tree = render(host4, host4.byId['shell.overlay']);
  const stopBtn = findAll(tree, 'dsw-btn').find((b) => JSON.stringify(b.children).includes('停止'));
  check(!!stopBtn, '有「停止」按钮');
  host4.calls.length = 0;
  await stopBtn.props.onClick();
  await host4.H.advance(0);
  check(hasCall(host4.calls, 'POST /control', (b) => b?.action === 'stop'), '「停止」→ POST /control {action:"stop"}');

  // 自动回报是开着的：关面板不该顺手停摄像头
  tree = render(host4, host4.byId['shell.overlay']);
  host4.calls.length = 0;
  find(tree, 'dsw-x').props.onClick();
  await host4.H.advance(0);
  check(!hasCall(host4.calls, 'POST /control', (b) => b?.action === 'stop'), '自动回报开着时，关面板不停摄像头');
  check(render(host4, host4.byId['shell.overlay']) === null, '关掉之后浮层不渲染');
}

console.log('6) 自动回报关着时，关面板顺手放开摄像头');
{
  const host5 = createHost({
    store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) },
    routes: {
      'GET /status': () => ({
        ok: true, running: true, device: 'CAM', at: Date.now(),
        capture: { fps: 10 }, preview: { fps: 30 }, exposure: { meanV: 120 },
        reply: { auto: false, intervalSec: 25, budget: 20, wakes: 0, running: false, sessionId: 'sess-view' },
        sessions: [],
      }),
    },
  });
  render(host5, host5.byId['conversation.composer.dock']).props.onClick();
  await host5.H.advance(0);
  await host5.H.advance(1000);
  const tree = render(host5, host5.byId['shell.overlay']);
  const xBtn = find(tree, 'dsw-x');
  check(/收起面板/.test(xBtn?.props?.title ?? ''), `关闭按钮的提示随状态变（${xBtn?.props?.title ?? ''}）`);
  host5.calls.length = 0;
  xBtn.props.onClick();
  await host5.H.advance(0);
  check(hasCall(host5.calls, 'POST /control', (b) => b?.action === 'stop'), '自动回报关着 → 关面板就放开摄像头');
}

console.log('7) 自己切 JPEG 的那条路（canvas）：流里半帧、多帧、跨 read 都要能切出来');
{
  // 造两帧假 JPEG，故意让第一帧被切在两个 chunk 之间，并在前后塞上 multipart 噪音
  const jpg1 = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
  const jpg2 = Uint8Array.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
  const noise = new TextEncoder().encode('\r\n--seeworldframe\r\ncontent-type: image/jpeg\r\n\r\n');
  const all = new Uint8Array(noise.length + jpg1.length + noise.length + jpg2.length);
  let at = 0;
  all.set(noise, at); at += noise.length;
  all.set(jpg1, at); at += jpg1.length;
  all.set(noise, at); at += noise.length;
  all.set(jpg2, at);
  const cut = noise.length + 4;            // 第一帧中间断开
  const chunks = [all.slice(0, cut), all.slice(cut)];

  const bitmaps = [];
  const prevBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (blob) => {
    bitmaps.push(blob?.size ?? 0);
    return { width: 320, height: 180, close() {} };
  };

  const host7 = createHost({
    store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-view' }) },
    routes: {
      'GET /status': () => ({
        ok: true, running: true, device: 'CAM', at: Date.now(),
        capture: { fps: 10 }, preview: { fps: 30 }, gain: 1,
        reply: { auto: true, intervalSec: 25, budget: 20, wakes: 0, running: true, sessionId: 'sess-view' },
        sessions: [],
      }),
    },
    fetchStream: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = chunks[i];
              i += 1;
              return { done: false, value };
            },
          };
        },
      },
    }),
  });

  render(host7, host7.byId['conversation.composer.dock']).props.onClick();
  await host7.H.advance(0);
  render(host7, host7.byId['shell.overlay']);
  await host7.H.advance(1000);
  const tree = await settle(host7, host7.byId['shell.overlay'], 8);

  try {
    check(!!find(tree, 'dsw-canvas'), '有流式解码能力时用 <canvas>（不赌浏览器对 multipart 的容忍度）');
    check(bitmaps.length >= 2, `两帧都被切出来了（解了 ${bitmaps.length} 张）`);
    check(host7.draws.length >= 2, `画到画布上 ${host7.draws.length} 次`);
    check(host7.canvases[0]?.width === 320 && host7.canvases[0]?.height === 180,
      `画布尺寸跟着帧走（${host7.canvases[0]?.width}×${host7.canvases[0]?.height}）`);
    check(host7.draws.every((d) => d.w === 320), '每帧都按真实尺寸绘制');
  } finally {
    globalThis.createImageBitmap = prevBitmap;
  }
}

console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过');
process.exit(fails ? 1 : 0);
