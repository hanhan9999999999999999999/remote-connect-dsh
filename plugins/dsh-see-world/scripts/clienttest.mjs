/**
 * client.js 的离线自检。
 *
 * 真正的浏览器行为（slot 渲染、fetch）要靠 DSH 起来才能验，这里只保证：
 *   · 文件能被 ModuleLoader 形态加载，id 就是包名
 *   · factory 只 require('react')，不碰任何 Harness 客户端包
 *   · apply() 注册的三个槽位名字 / id / order 正确，label 能出字
 *   · 三个组件都能被调用出一个合法的元素树（不抛、有可见文字）
 *   · 样式确实挂进了 head，并且带 dataset.plugin 便于卸载
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

/** 只实现 client.js 真的会用到的那部分 React（hooks 全部退化成一次性求值）。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useEffect() {},
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(value) { return { current: value }; },
};

function loadClient(language, pattern, opts = {}) {
  let loaded = null;
  const styles = [];
  const calls = [];
  const doc = {
    head: { appendChild: (el) => styles.push(el) },
    createElement: () => ({ tag: '', dataset: {}, textContent: '', remove() {} }),
  };
  const store = { ...(opts.store ?? {}) };
  const win = {
    __ModuleLoader__: { load: (spec) => { loaded = spec; } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  const nav = { language };
  if (opts.clipboard !== false) {
    nav.clipboard = { writeText: async (text) => { calls.push({ path: 'clipboard', text }); } };
  }
  const url = { createObjectURL: () => 'blob:see-world', revokeObjectURL() {} };
  const noFetch = async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    throw new Error('offline');
  };

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'navigator', 'fetch', 'URL', CODE);
  run(win, doc, nav, noFetch, url);

  const mod = loaded.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`client.js 不该 require('${id}')`);
  });
  return { spec: loaded, mod, styles, pattern, calls, store };
}

/** 把元素树里的可见文字拢成一串。 */
function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    const own = textOf(node.children);
    const attrs = [node.props?.title, node.props?.placeholder, node.props?.['aria-label']]
      .filter(Boolean).join(' ');
    return `${own} ${attrs}`.trim();
  }
  return '';
}

console.log('1) ModuleLoader 形态');
{
  const { spec, mod, styles } = loadClient('zh-CN');
  check(spec?.id === 'dsh-see-world', `load({ id }) = ${spec?.id}`);
  check(typeof spec?.factory === 'function', 'factory 是函数');
  check(mod?.name === 'dsh-see-world', `导出的 name = ${mod?.name}`);
  check(Array.isArray(mod?.inject) && mod.inject.join() === 'slots', `导出的 inject = ${JSON.stringify(mod?.inject)}`);
  check(typeof mod?.apply === 'function', '导出了 apply');

  console.log('2) apply 注册的槽位');
  const regs = [];
  const disposed = [];
  const ctx = {
    effect: (fn) => { disposed.push(fn()); return () => {}; },
    slots: {
      inject: (name, cb) => { cb(); return () => {}; },
      register: (spec2, comp) => { regs.push({ spec: spec2, comp }); return () => {}; },
    },
  };
  let threw = null;
  try { mod.apply(ctx); } catch (e) { threw = e; }
  check(!threw, `apply 不抛（${threw?.message ?? 'ok'}）`);
  check(regs.length === 3, `注册了 3 个槽位（实际 ${regs.length}）`);
  const names = regs.map((r) => r.spec.name);
  check(names.join(',') === 'settings.section,conversation.composer.dock,shell.overlay', `槽位顺序 ${names.join(' → ')}`);
  check(regs.every((r) => typeof r.spec.id === 'string' && r.spec.id.length > 0), '每个槽位都有 id');
  check(regs.every((r) => Number.isFinite(r.spec.order)), '每个槽位都有数字 order');
  check(regs[0].spec.label?.() === '看世界', `设置页 label = ${regs[0].spec.label?.()}`);

  check(styles.length === 1, `样式插入 head 1 次（实际 ${styles.length}）`);
  const style = styles[0];
  check(style?.dataset?.plugin === 'dsh-see-world', 'style 带 dataset.plugin 便于卸载');
  check((style?.textContent ?? '').length > 2000, `CSS 有 ${style?.textContent?.length ?? 0} 字符`);
  check(/\.dsw-page/.test(style?.textContent ?? ''), 'CSS 里是本插件前缀（.dsw-），不覆盖宿主 class');
  // 不挡宿主操作：遮罩层不吃指针事件，只有面板本体吃
  const css = style?.textContent ?? '';
  const overlayRule = (css.match(/\.dsw-overlay\{[^}]*\}/) ?? [''])[0];
  const panelRule = (css.match(/\.dsw-panel\{[^}]*\}/) ?? [''])[0];
  check(/pointer-events:\s*none/.test(overlayRule), `遮罩层不吃指针事件：${overlayRule.trim()}`);
  check(/pointer-events:\s*auto/.test(panelRule), `面板本体吃指针事件：${panelRule.trim().slice(0, 60)}…`);
  check(!/dsh-client-ui-primitives|@deepseek-ai\//.test(CODE), 'client.js 里没有 require Harness 客户端包');

  console.log('3) 三个组件能出元素树');
  const [settings, composer, panel] = regs.map((r) => r.comp);
  check(typeof settings === 'function' && typeof composer === 'function' && typeof panel === 'function', '三个都是组件');

  const settingsTree = settings();
  const settingsText = textOf(settingsTree);
  check(!!settingsTree, '设置页有输出');
  check(settingsText.includes('看世界 · 摄像头'), '设置页有标题');
  // 这里 hooks 是退化的，effect 不会跑，所以只会看到「读取中」这一态。
  check(settingsText.includes('读取中'), `设置页先给读取态：${settingsText.slice(0, 24)}…`);
  const FIELDS = ['摄像头设备', '分辨率', '输入帧率', '拼图帧数', '画质', '预览宽度', '预攒画面',
    '自动回报', '回报时带图', '回报次数上限'];
  check(FIELDS.every((k) => CODE.includes(k)), `表单字段文案齐全（${FIELDS.join('/')}）`);

  const composerTree = composer();
  check(textOf(composerTree).includes('看世界'), `输入框按钮有文字：${textOf(composerTree)}`);
  check(composerTree?.type === 'button' && composerTree.props?.['aria-pressed'] === false, '按钮是 <button> 且带 aria-pressed');

  check(panel() === null, '没打开时浮层不渲染');

  // 点一下按钮 → 浮层应该出来
  composerTree.props.onClick();
  const panelTree = panel();
  check(!!panelTree, '点按钮后浮层渲染');
  const panelText = textOf(panelTree);
  check(panelText.includes('还没有画面') || panelText.includes('读取中'), `浮层有占位文字：${panelText.slice(0, 40)}…`);
  check(panelText.includes('抓一张发到会话'), '浮层有「抓一张发到会话」按钮');
  check(/×/.test(panelText) || panelText.includes('关闭'), '浮层有关闭按钮');

  const styleTag = style;
  check(styleTag?.remove !== undefined, '样式元素可移除（卸载时会调 remove）');
}

console.log('4) 英文环境');
{
  const { mod } = loadClient('en-US');
  const regs = [];
  mod.apply({
    effect: (fn) => { fn(); },
    slots: { inject: (n, cb) => cb(), register: (s, c) => { regs.push({ spec: s, comp: c }); } },
  });
  check(regs[0]?.spec?.label?.() === 'See World', `英文 label = ${regs[0]?.spec?.label?.()}`);
  check(textOf(regs[1]?.comp?.()).includes('See World'), '英文按钮文字');
}

console.log('5) 绑定"你正在看的那个会话"');
{
  // shell 把当前会话 persist 在 localStorage['dsh.sessions.current'] 里
  const { mod, calls } = loadClient('zh-CN', undefined, {
    store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-viewing' }) },
  });
  const regs = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (n, cb) => cb(), register: (s, c) => { regs.push({ spec: s, comp: c }); } },
  });
  const composer = regs.find((r) => r.spec.name === 'conversation.composer.dock')?.comp;
  composer().props.onClick();
  const bind = calls.find((c) => c.path === '/api/see-world/control');
  check(!!bind, '点按钮会问宿主一次 /control');
  check(bind?.body?.action === 'bind', `action = ${bind?.body?.action}`);
  check(bind?.body?.sessionId === 'sess-viewing', `绑到正在看的会话（${bind?.body?.sessionId}）`);

  // 没有持久化（隐私模式）时不能乱绑
  const { mod: mod2, calls: calls2 } = loadClient('zh-CN', undefined, { store: {} });
  const regs2 = [];
  mod2.apply({
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (n, cb) => cb(), register: (s, c) => { regs2.push({ spec: s, comp: c }); } },
  });
  regs2.find((r) => r.spec.name === 'conversation.composer.dock')?.comp().props.onClick();
  check(!calls2.some((c) => c.path === '/api/see-world/control'), '没有当前会话时不乱绑（交给宿主兜底）');
}

console.log('6) 关面板会不会放开摄像头');
{
  // 假 React 把子节点挂在 node.children 上（不是 props.children）
  const walk = (node, out = []) => {
    if (!node || typeof node !== 'object' || !node.type) return out;
    out.push(node);
    for (const kid of node.children ?? []) walk(kid, out);
    return out;
  };

  const { mod, calls } = loadClient('zh-CN', undefined, { store: {} });
  const regs = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    slots: { inject: (n, cb) => cb(), register: (s, c) => { regs.push({ spec: s, comp: c }); } },
  });
  const composer = regs.find((r) => r.spec.name === 'conversation.composer.dock')?.comp;
  const panel = regs.find((r) => r.spec.name === 'shell.overlay')?.comp;
  composer().props.onClick();
  const tree = panel();
  const nodes = walk(tree);
  const closeBtn = nodes.find((n) => String(n.props.className ?? '').includes('dsw-x'));
  check(!!closeBtn, `浮层上找到关闭按钮（节点 ${nodes.length} 个：${nodes.map((n) => n.props.className || n.type).slice(0, 12).join(' | ')}）`);
  check(/收起面板/.test(String(closeBtn?.props?.title ?? '')), `关闭按钮有说明：${closeBtn?.props?.title}`);
  closeBtn?.props?.onClick?.();
  const stopped = calls.filter((c) => c.path === '/api/see-world/control' && c.body?.action === 'stop');
  // 自动回报没开（状态拿不到 = 视为关着）：收起面板就该放手，别一直占着摄像头
  check(stopped.length === 1, `自动回报关着时，关面板会放开摄像头（stop ×${stopped.length}）`);
  check(panel() === null, '关掉之后浮层不再渲染');
}

console.log('7) 拖动的落点算得对不对');
{
  const { mod } = loadClient('zh-CN', undefined, { store: {} });
  const { clampBox, clampWidth } = mod.__test ?? {};
  check(typeof clampBox === 'function' && typeof clampWidth === 'function', '__test 暴露了拖动的纯函数');

  const base = { x: 100, y: 80, w: 600 };
  const moved = clampBox(base, 40, 30, 1280, 800);
  check(moved.x === 140 && moved.y === 110, `正常拖动跟手（x ${moved.x} / y ${moved.y}）`);
  check(moved.w === 600, '拖动不改宽度');

  const left = clampBox(base, -999, -999, 1280, 800);
  check(left.x === 6 && left.y === 6, `往左上拖出屏幕会被夹回（x ${left.x} / y ${left.y}）`);

  const right = clampBox(base, 9999, 9999, 1280, 800);
  check(right.x === 1280 - 600 - 6, `往右下拖不会出视口（x ${right.x} = 1280-600-6）`);
  check(right.y === 800 - 64, `底部留住 64px（y ${right.y}）`);

  const tiny = clampBox(base, 0, 0, 400, 300);
  check(tiny.x >= 6 && tiny.y >= 6, '视口比面板还小时也不会变成负坐标');

  const wider = clampWidth(base, 120, 1280);
  check(wider.w === 720, `改宽跟手（w ${wider.w}）`);
  const tooSmall = clampWidth(base, -9999, 1280);
  check(tooSmall.w === 360, `最小宽度 360（w ${tooSmall.w}）`);
  const tooWide = clampWidth(base, 9999, 1280);
  check(tooWide.w === 1280 - 100 - 8, `不能宽过右边界（w ${tooWide.w}）`);
  check(tooWide.x === 100, '改宽不动左边位置');
}

console.log('8) 诊断单能不能直接贴给人');
{
  const { mod } = loadClient('zh-CN', undefined, { store: {} });
  const { buildDiag } = mod.__test ?? {};
  check(typeof buildDiag === 'function', '__test 暴露了 buildDiag');
  const text = buildDiag({
    config: { device: 'CAM', fps: 10 },
    meta: { status: { running: true, reply: { auto: true } } },
    devices: [{ name: 'CAM', kind: 'video' }],
  }, '2026-11-15T10:00:00.000Z');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 下面断言会报 */ }
  check(!!parsed, '诊断单是合法 JSON');
  check(parsed?.plugin === 'dsh-see-world', `诊断单标明插件（${parsed?.plugin}）`);
  check(parsed?.at === '2026-11-15T10:00:00.000Z', '诊断单带时间戳（可直接对时间线）');
  check(parsed?.config?.device === 'CAM', '诊断单带配置');
  check(parsed?.status?.running === true, '诊断单带运行状态');
  check(Array.isArray(parsed?.devices) && parsed.devices.length === 1, '诊断单带设备列表');
  check(!/undefined/.test(text), '诊断单里没有 undefined（贴出去不会难堪）');
  // 设置页确实有这个按钮（退化的 hooks 下配置没读到，只看源码里有文案与 title）
  check(CODE.includes("t('diag')") && CODE.includes('copyDiag'), '设置页挂了「复制诊断信息」按钮');
}

console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过');
process.exit(fails ? 1 : 0);
