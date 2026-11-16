
// 手机端「用户旅程」回归：一次跑完整轮（26 步），输出 PASS/FAIL 表。用法：
//   node _e2e.mjs "http://127.0.0.1:8899/?t=TOKEN"
// ws 从哪来：本地 node_modules 优先，其次桌面 profile 里的那份（用 HOME 拼，不写死用户名）
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const require_ = createRequire(import.meta.url);
let WebSocket;
try {
  WebSocket = require_('ws');
} catch (_) {
  // 没装 ws 就退回 DSH 桌面 profile 里自带的那一份（DSH_HOME 优先，缺省 D:/dsh-home）
  const home = process.env.DSH_HOME || process.env.PHONE_DSH_HOME || 'D:/dsh-home';
  const candidates = [
    home + '/profiles/desktop/node_modules/ws/index.js',
    home + '/profiles/desktop/node_modules/ws/wrapper.mjs',
  ];
  let loaded = null;
  for (const f of candidates) {
    try {
      loaded = (await import(pathToFileURL(f).href)).default;
      break;
    } catch (_e) {}
  }
  if (!loaded) {
    throw new Error('跑这个回归需要 ws：在 phone-bridge 里 npm i ws，或设置 DSH_HOME 指向装过 dsh 的目录');
  }
  WebSocket = loaded;
}
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

// 每次跑用独立的 user-data-dir + 随机端口，别再用固定值：
//   固定目录会碰上上一次残留的实例（Edge 单例转发会把启动参数甩给老进程，新进程立刻退，
//   然后 CDP 连到的是那具尸体）；固定 10141 还会和手工跑的探针抢。
// 目录名里带自己的 pid（`e2eEdge-<pid>-<ts>`），是为了清理时能按名字精确匹配 ——
// 任何时候都不要用「杀所有 msedge」那种一刀切，主人自己开的窗口会被一起关掉。
const E2E_TAG = 'e2eEdge-' + process.pid + '-' + Date.now();
const PORT = 9000 + Math.floor(Math.random() * 900);
const USER_DIR = 'C:\\Temp\\' + E2E_TAG;
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(EDGE_EXE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--disable-background-networking',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + USER_DIR,
    '--window-size=492,950', 'about:blank'],
  { stdio: 'ignore' });

// 收掉自己开的这个无头 Edge。proc.kill() 只杀浏览器主进程，Edge 是多进程的，
// 所以再按自己的 tag 兜一层，最后把临时 profile 删掉。
// 正常结束、抛异常、被 server 侧 90 秒超时 kill，三条路都会走到这里。
function killMyEdge() {
  try { proc.kill(); } catch (_) {}
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + E2E_TAG + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, timeout: 8000, stdio: 'ignore' });
  } catch (_) {}
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (_) {}
}
let cleaned = false;
function cleanupOnce() { if (cleaned) return; cleaned = true; killMyEdge(); }
process.on('exit', cleanupOnce);
process.on('SIGTERM', () => { cleanupOnce(); process.exit(1); });
process.on('SIGINT', () => { cleanupOnce(); process.exit(1); });
process.on('uncaughtException', (e) => {
  try { console.error('EX ' + ((e && e.message) || e)); } catch (_) {}
  cleanupOnce(); process.exit(1);
});

// 整体硬超时：任何一步卡住都不许把整轮拖死，至少留下「卡在哪」。
const HARD_MS = Number(process.env.PHONE_E2E_TIMEOUT_MS || 75000);
let lastStep = "(还没开始)";
const hardTimer = setTimeout(() => {
  try {
    console.error("FAIL  回归整体超时（" + Math.round(HARD_MS / 1000) + " 秒，卡在：" + lastStep + "）");
    console.error("\n== 0/0 通过 ==");
  } catch (_) {}
  cleanupOnce();
  process.exit(1);
}, HARD_MS);
try { hardTimer.unref && hardTimer.unref(); } catch (_) {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 回归会往待办里塞 e2e- 开头的临时条目；失败时可能来不及删。
// 每次开跑先按前缀清一遍，避免测试垃圾越积越多（也顺手清出主人自己的列表）。
const APP_URL = process.argv[2] || '';
const U = (() => { try { return new URL(APP_URL); } catch { return null; } })();
const APP_PREFIX = U ? U.origin + U.pathname.replace(/[^/]*$/, '') : '';
const APP_TOKEN = U ? (U.searchParams.get('t') || '') : '';
async function cleanE2E() {
  if (!APP_PREFIX || !APP_TOKEN) return;
  try {
    const q = (p) => APP_PREFIX + p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(APP_TOKEN);
    const r = await fetch(q('api/todos')).then((x) => x.json());
    const junk = (r.items || []).filter((it) => String(it.text || '').startsWith('e2e-'));
    for (const it of junk) {
      await fetch(q('api/todos'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: it.id }),
      }).catch(() => {});
    }
    if (junk.length) console.log('· 清掉 ' + junk.length + ' 条历史 e2e 待办');
  } catch (_) {}
}
await cleanE2E();

let list = null;
for (let i = 0; i < 50; i++) { await sleep(400); try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); list = await r.json(); if (list && list.length) break; } catch (e) {} }
const ws = new WebSocket((list.find((t) => t.type === 'page') || list[0]).webSocketDebuggerUrl);
let id = 0; const waiters = new Map();
const dialogs = [];
ws.on('message', (m) => {
  const j = JSON.parse(m);
  if (j.id && waiters.has(j.id)) { waiters.get(j.id)(j); waiters.delete(j.id); return; }
  // 原生 confirm() 会挡住渲染进程，必须显式收掉；顺手记下文案用来断言
  if (j.method === 'Page.javascriptDialogOpening') dialogs.push(j.params && j.params.message || '');
});
await new Promise((r) => ws.on('open', r));
const send = (method, params) => new Promise((res) => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 120) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 492, height: 950, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: process.argv[2] });
await sleep(5200);

const results = [];
const step = async (name, fn) => {
  lastStep = name;
  let ok = false, detail = '';
  try { const r = await fn(); ok = !!(r && r.ok); detail = (r && r.detail) || ''; }
  catch (e) { ok = false; detail = 'EX: ' + (e && e.message); }
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
};

// 0) 记录原始音色，最后还原
const voice0 = await ev("(window.__st && window.__st.voice) || ''");

// 0.5) 前置：如果当前是空会话（页面停在欢迎页），先接上最近一次会话——
//      否则「渲染出消息」这条断言在空会话下必然失败，那是测试前置问题，不是功能问题
await ev("(async function(){try{var t=new URLSearchParams(location.search).get('t')||localStorage.getItem('dsh.tk')||'';var r=await fetch('/api/sessions?t='+t).then(function(x){return x.json();});var cur=r.current||'';var arr=(r.sessions||[]).filter(function(o){return o.id!==cur&&!o.bad;});if(document.querySelectorAll('#main .row').length>0)return 'had-rows';if(!arr.length)return 'no-sessions';var pick=arr[0];await fetch('/api/session/select?t='+t,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:pick.id})});return 'picked:'+pick.id;}catch(e){return 'err:'+(e&&e.message);}})()");
await sleep(1500);

// 0.9) 令牌落盘后地址栏必须干净
await step('地址栏不残留令牌', async () => {
  const r = await ev("({search:location.search,hash:location.hash,t:(localStorage.getItem('dsh.tk')||'').length})");
  return { ok: !!r && !/[?&]t=/.test(r.search) && r.t >= 16, detail: 'search=' + (r && r.search) + ' tokenlen=' + (r && r.t) };
});

// 1) 页面渲染
await step('页面渲染出消息', async () => {
  const n = await ev("document.querySelectorAll('#main .row').length");
  return { ok: n >= 1, detail: 'rows=' + n };
});

// 1.5) 草稿必须跟着会话走：A 会话说一半切到 B，不能把 A 的字带过去
const draftStamp = Date.now();
const draftA = 'e2e草稿A-' + draftStamp;
const draftB = 'e2e草稿B-' + draftStamp;
await step('每个会话的草稿互不串台', async () => {
  const cur = await ev("(async function(){var t=new URLSearchParams(location.search).get('t')||localStorage.getItem('dsh.tk')||'';var r=await fetch('/api/sessions?t='+t).then(function(x){return x.json();});return r.current||'';})()");
  const other = await ev("(async function(){var t=new URLSearchParams(location.search).get('t')||localStorage.getItem('dsh.tk')||'';var r=await fetch('/api/sessions?t='+t).then(function(x){return x.json();});var c=r.current||'';var a=(r.sessions||[]).filter(function(o){return o.id!==c&&!o.bad;});return a.length?a[0].id:'';})()");
  if (!cur || !other) return { ok: false, detail: '当前/备用会话不足 cur=' + cur + ' other=' + other };
  const waitHist = async (id) => {
    for (let i = 0; i < 24; i++) {
      const now = await ev("(window.__hist&&window.__hist().id)||''");
      if (now === id) return true;
      await sleep(400);
    }
    return false;
  };
  // 先选回当前会话，让前端 histId 与服务端对齐（e2e 前面的前置步骤可能直接改过服务端）
  await ev('window.__ui.pickSession({id:' + JSON.stringify(cur) + '})');
  await waitHist(cur);
  await ev("(function(){var i=document.getElementById('input');i.value=" + JSON.stringify(draftA) + ";i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const savedA = await ev("localStorage.getItem('dsh.draft:'+" + JSON.stringify(cur) + ")");
  await ev('window.__ui.pickSession({id:' + JSON.stringify(other) + '})');
  const okOther = await waitHist(other);
  const atOther = await ev("document.getElementById('input').value");
  await ev("(function(){var i=document.getElementById('input');i.value=" + JSON.stringify(draftB) + ";i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev('window.__ui.pickSession({id:' + JSON.stringify(cur) + '})');
  const okBack = await waitHist(cur);
  const back = await ev("document.getElementById('input').value");
  const savedB = await ev("localStorage.getItem('dsh.draft:'+" + JSON.stringify(other) + ")");
  // 清掉测试草稿，别留在浏览器里
  await ev("(function(){localStorage.removeItem('dsh.draft:'+" + JSON.stringify(cur) + ");localStorage.removeItem('dsh.draft:'+" + JSON.stringify(other) + ");var i=document.getElementById('input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  // 切回以输入框内容为准：waitHist 只是等渲染，偶尔会比实际慢半拍，不该拿它判红
  const ok = savedA === draftA && atOther !== draftA && savedB === draftB && back === draftA;
  return { ok, detail: 'A存=' + (savedA === draftA) + ' 切走不带=' + (atOther !== draftA) + ' B存=' + (savedB === draftB) + ' 切回=' + back + ' 就位=' + (okOther && okBack) };
});

// 2) 设置面板
await step('打开设置面板', async () => {
  await ev("document.getElementById('btn-cfg').click()");
  await sleep(900);
  const cls = await ev("document.getElementById('cfg').className");
  return { ok: /show/.test(cls), detail: cls };
});

// 3b) 引擎选择：肥鱼没启动时只验选择器，启动了就真切一次再切回来
await step('语音引擎可选且能切换', async () => {
  const chips = await ev("Array.from(document.querySelectorAll('#engine-list [data-engine]')).map(function(x){return x.dataset.engine})");
  const has = Array.isArray(chips) && chips.indexOf('edge') >= 0 && chips.indexOf('feiyu') >= 0;
  if (!has) return { ok: false, detail: 'chips=' + JSON.stringify(chips) };
  const ready = await ev("!!(window.__feiyu && window.__feiyu.ready)");
  if (!ready) return { ok: true, detail: 'chips=' + chips.join(',') + ' · 肥鱼未启动，跳过切换' };
  const before = await ev("window.__engine || 'edge'");
  await ev("(function(){var b=document.querySelector('#engine-list [data-engine=\"feiyu\"]'); if(b) b.click();})()");
  await sleep(1600);
  const after = await ev("window.__engine || ''");
  const allFeiyu = await ev("Array.from(document.querySelectorAll('#voice-list .vopt')).every(function(x){return String(x.dataset.v||'').indexOf('feiyu-')===0})");
  const n = await ev("document.querySelectorAll('#voice-list .vopt').length");
  // 测完用同一个选择器切回去，别把用户的选择留在回归里
  if (before && before !== 'feiyu') {
    await ev("(function(){var b=document.querySelector('#engine-list [data-engine=\"" + before + "\"]'); if(b) b.click();})()");
    await sleep(800);
  }
  return { ok: after === 'feiyu' && allFeiyu && n > 0, detail: before + ' → ' + after + ' · vopt=' + n + ' 全肥鱼=' + allFeiyu };
});

// 3) 语音音色列表
await step('语音音色数量与服务端一致', async () => {
  const n = await ev("document.querySelectorAll('#voice-list .vopt').length");
  // 不写死数字：只要求「够多」且每个按钮都带 data-v（换引擎/加音色时不会假失败）
  const tagged = await ev("Array.from(document.querySelectorAll('#voice-list .vopt')).filter(function(x){return !!x.dataset.v;}).length");
  return { ok: n >= 5 && tagged === n, detail: 'vopt=' + n + ' 带data-v=' + tagged };
});

// 4) 切换音色
await step('切换音色生效', async () => {
  const before = await ev("window.__voice || ''");
  // 点一个「和当前不同」的音色：点同一个当然不会变，别拿它当失败
  await ev("(function(){var bs=Array.from(document.querySelectorAll('#voice-list .vopt')); var t=bs.filter(function(x){return !x.classList.contains('cur');})[0]||bs[0]; if(t) t.click();})()");
  await sleep(1800);
  const after = await ev("window.__voice || ''");
  const cur = await ev("(document.querySelector('#voice-list .vopt.cur')||{}).innerText || ''");
  // 回归不该顺手改掉用户选的音色：测完直接调接口切回去
  // （点按钮找回不可靠：data-v 匹配、绑定时机都可能失手，接口最稳）
  if (before && after && before !== after) {
    try {
      const u = process.argv[2] || '';
      const base = u.replace(/[?#].*$/, '');
      const mt = u.match(/[?&]t=([^&]+)/);
      if (base && mt) {
        await fetch(base + '/api/voice?t=' + mt[1], {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: before }),
        });
        await sleep(400);
      }
    } catch (e) {}
  }
  return { ok: !!after && after !== before, detail: before + ' → ' + after + ' | ' + cur.replace(/\n/g, ' ') };
});

// 5) 打开待办并加一条
const todoText = 'e2e-' + Date.now();
await step('待办：加一条', async () => {
  await ev("(function(){var c=document.getElementById('cfg'); if(c) c.classList.remove('show');})()");
  await ev("document.getElementById('open-todo').click()");
  // 面板按钮由独立脚本块的 bind() 绑定（最长 1.5 秒一轮），刚重启时会抢在绑定前点击 → 轮询到绑定为止
  let addBound = 'unknown';
  for (let bi = 0; bi < 12; bi++) {
    addBound = await ev("typeof document.getElementById('todo-add').onclick");
    if (addBound === 'function') break;
    await sleep(500);
  }
  if (addBound !== 'function') return { ok: false, detail: '加一条按钮没绑事件（onclick=' + addBound + '）' };
  // 等面板把已有条目渲染完再数，否则会数到 0（异步渲染，之前就是这里导致 0→2 误判）
  let rows0 = -1;
  for (let ti = 0; ti < 10; ti++) {
    const n = await ev("document.querySelectorAll('#todo-list .tdrow').length");
    if (n === rows0) break;
    rows0 = n;
    await sleep(300);
  }
  await ev("(function(){var i=document.getElementById('todo-new'); i.value='" + todoText + "'; i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await ev("document.getElementById('todo-add').click()");
  await sleep(2200);
  const rows1 = await ev("document.querySelectorAll('#todo-list .tdrow').length");
  return { ok: rows1 === rows0 + 1, detail: rows0 + ' → ' + rows1 };
});

// 6) 删掉刚加的那条
await step('待办：删掉刚加的', async () => {
  await ev("(function(){var rs=Array.from(document.querySelectorAll('#todo-list .tdrow')); var t=rs.filter(function(r){return r.innerText.indexOf('" + todoText + "')>=0;})[0]; if(t){var b=t.querySelector('.rm'); if(b) b.click();}})()");
  await sleep(1500);
  const left = await ev("(function(){return Array.from(document.querySelectorAll('#todo-list .tdrow')).filter(function(r){return r.innerText.indexOf('" + todoText + "')>=0;}).length;})()");
  await ev("(function(){var s=document.getElementById('todo'); if(s) s.classList.remove('show');})()");
  return { ok: left === 0, detail: '剩余同名=' + left };
});

// 7) 历史抽屉
await step('历史抽屉打开且有分组', async () => {
  await ev("document.getElementById('btn-hist').click()");
  await sleep(1500);
  const cls = await ev("document.getElementById('hist').className");
  const g = await ev("document.querySelectorAll('#hist .hgroup').length");
  const n = await ev("document.querySelectorAll('#hist .sitem').length");
  await ev("(function(){var s=document.getElementById('hist'); if(s) s.classList.remove('show');})()");
  return { ok: /show/.test(cls) && g > 0 && n > 0, detail: 'hgroup=' + g + ' sitem=' + n };
});

// 7b) 历史会话「导出」入口（批量工具条）：存在、有文案、勾选后可用
await step('历史抽屉能批量导出', async () => {
  await ev("document.getElementById('btn-hist').click()");
  await sleep(1200);
  await ev("document.getElementById('hist-batch').click()");
  await sleep(300);
  const hasBtn = await ev("!!document.getElementById('hist-export')");
  const label = await ev("String((document.getElementById('hist-export')||{}).textContent||'')");
  await ev("(function(){var it=document.querySelector('#hist .sitem'); if(it) it.click();})()");
  await sleep(300);
  const sel = await ev("String((document.getElementById('hist-sel')||{}).textContent||'')");
  const wired = await ev("typeof (document.getElementById('hist-export')||{}).onclick === 'function'");
  await ev("document.getElementById('hist-exit').click()");
  await sleep(200);
  await ev("(function(){var s=document.getElementById('hist'); if(s) s.classList.remove('show');})()");
  const ok = hasBtn && /导出/.test(label) && /已选 1/.test(sel) && wired;
  return { ok, detail: '按钮=' + hasBtn + ' 文案=' + label.trim() + ' ' + sel.trim() + ' 已接线=' + wired };
});

// 8) 搜索 + 仅看命中 + 还原
await step('搜索并仅看命中', async () => {
  // 用一个只在部分消息里出现的词，否则「全部命中」时隐藏数本就该是 0（曾经因此误判成 bug）
  // 关键词不能写死：旧版固定 '备份'，一旦当前会话里正好没有这两个字就必然 0 命中，
  // 回归会红得莫名其妙（消息被清空、换会话、换模式都会触发）。
  // 改成从最后一条消息里挑一个「前面各行都没有出现」的片段，保证只有部分行命中。
  const rowsTxt = await ev(
    "Array.from(document.querySelectorAll('#main .row')).map(function(r){return (r.innerText||'').replace(/\\s+/g,' ').trim()})",
  );
  const lines = Array.isArray(rowsTxt) ? rowsTxt.filter(function (t) { return t; }) : [];
  let KW = '';
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const head = lines.slice(0, -1).join(' ');
    for (let len = 2; len <= 4 && !KW; len++) {
      for (let i = 0; i + len <= last.length; i++) {
        const cand = last.slice(i, i + len);
        if (cand.trim().length !== len) continue;
        if (head.indexOf(cand) >= 0) continue;
        if (last.split(cand).length - 1 !== 1) continue;
        KW = cand;
        break;
      }
    }
  }
  if (!KW) KW = (lines[0] || 'a').slice(0, 2).trim() || 'a';
  await ev("document.getElementById('btn-find').click()");
  await sleep(700);
  await ev("(function(){var i=document.getElementById('findq'); i.value='" + KW + "'; i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await sleep(1500);
  const total = await ev("document.querySelectorAll('#main .row').length");
  const hitsTxt = await ev("document.getElementById('findn').textContent");
  const hid0 = await ev("document.querySelectorAll('#main .row.hid').length");
  await ev("document.getElementById('find-only').click()");
  await sleep(1300);
  // 命中行如果是长消息，findPaint 会自动点「展开全文」并 renderAll；
  // 行数会从 40 变 120，所以 total 必须在过滤生效后重新数，不能沿用点之前的。
  const total1 = await ev("document.querySelectorAll('#main .row').length");
  const hid1 = await ev("document.querySelectorAll('#main .row.hid').length");
  const onCls = await ev("document.getElementById('find-only').className");
  await ev("document.getElementById('find-only').click()");
  await sleep(1300);
  const hid2 = await ev("document.querySelectorAll('#main .row.hid').length");
  const strict = lines.length >= 2;
  const ok =
    /on/.test(onCls) && hid0 === 0 && (strict ? hid1 > 0 && hid1 < total1 && hid2 === 0 : hid2 === 0);
  return {
    ok,
    detail:
      'total=' + total1 + '（过滤前 ' + total + '） 词=' + KW + ' 命中=' + String(hitsTxt).replace(/\s+/g, '') +
      ' 隐藏=' + hid1 + ' 还原后=' + hid2 + (strict ? '' : '（消息太少，只验控件行为）'),
  };
});

// 9) 诊断 + 自检
await step('诊断自检全部通过', async () => {
  await ev("(function(){var b=document.getElementById('open-diag'); if(b) b.click();})()");
  await sleep(1200);
  await ev("(function(){var b=document.getElementById('diag-selfcheck'); if(b) b.click();})()");
  await sleep(2500);
  const txt = await ev("(document.getElementById('sc-res')||{}).innerText || ''");
  const ui = await ev("(document.getElementById('ui-sc')||{}).innerText || ''");
  const okServer = /全部通过/.test(txt);
  // 必须真的能调用自检、并且它自己报「全部通过」且项数够多。
  // 不能用「window.__uiFails 为空」当通过 —— 脚本块语法坏掉时它恒为 undefined，会造成假绿。
  const uiRes = await ev("(function(){try{if(typeof window.__uiSelfCheck!=='function')return{err:'no-fn'};var r=window.__uiSelfCheck();return{pass:r.pass,total:r.total,fails:(r.fails||[]).slice(0,6),failCount:(r.fails||[]).length};}catch(e){return{err:String(e&&e.message)}}})()");
  const okUi = !!(uiRes && !uiRes.err && uiRes.total >= 30 && uiRes.pass === uiRes.total && uiRes.failCount === 0);
  await ev("(function(){var s=document.getElementById('diag'); if(s) s.classList.remove('show');})()");
  return { ok: okServer && okUi, detail: (txt.split('\n')[0] || '') + ' / 界面自检 ' + JSON.stringify(uiRes) };
});

// 10) 收尾：还原音色 + 页面异常
await step('长按菜单两页都齐', async () => {
  const r = await ev(`(function(){
    var mine = Array.from(document.querySelectorAll('#main .row.me'));
    var row = mine.length ? mine[mine.length - 1] : document.querySelector('#main .row');
    if (!row) return 'no row';
    var bub = row.querySelector('.bubble') || row;
    bub.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    var p1 = Array.from(document.querySelectorAll('#ctxmenu button[data-act]')).map(function (x) { return x.getAttribute('data-act'); });
    var more = Array.from(document.querySelectorAll('#ctxmenu button')).filter(function (x) { return /^更多/.test(x.textContent); })[0];
    var p2 = [];
    if (more) { more.click(); p2 = Array.from(document.querySelectorAll('#ctxmenu button[data-act]')).map(function (x) { return x.getAttribute('data-act'); }); }
    document.querySelector('#main').click();
    return JSON.stringify({ p1: p1, p2: p2, me: !!(row.classList && row.classList.contains('me')) });
  })()`);
  const o = JSON.parse(r);
  const must1 = ['复制', '引用', '多选'];
  // 「重发」只对「我发的」才有；取不到用户行时别把它算成缺失（否则是测试前置问题）
  const must2 = ['删除（只在本机隐藏）', '编辑后重发', '记成待办', '时间轴'].concat(o.me ? ['重发'] : []);
  const miss = must1.filter((k) => o.p1.indexOf(k) < 0).concat(must2.filter((k) => o.p2.indexOf(k) < 0));
  return { ok: miss.length === 0 && o.p2.length > 0, detail: '第一页 ' + o.p1.length + ' 项 / 第二页 ' + o.p2.length + ' 项' + (miss.length ? ' · 缺 ' + miss.join('、') : '') };
});

await step('后端错误会冒到横幅', async () => {
  const r = await ev(`(async function () {
    var orig = window.fetch;
    window.fetch = function (u, o) {
      if (String(u).indexOf('/api/diag') >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, errors: [{ at: Date.now(), tag: 'e2e', msg: 'injected' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };
    if (window.__checkSystemBanner) await window.__checkSystemBanner();
    var bar = document.getElementById('sysbar');
    var shown = !!bar && bar.className.indexOf('show') >= 0 && bar.textContent.indexOf('后端最近有') >= 0;
    window.fetch = orig;
    if (window.__checkSystemBanner) await window.__checkSystemBanner();
    var gone = !bar || bar.textContent.indexOf('后端最近有') < 0;
    return { shown: shown, gone: gone };
  })()`);
  const o = r || {};
  return { ok: o.shown === true && o.gone === true, detail: '注入后显示=' + o.shown + ' 撤掉后消失=' + o.gone };
});

await step('离线队列面板能列出待发送', async () => {
  const r = await ev(`(function () {
    localStorage.setItem('dsh.outbox', JSON.stringify([{ id: 'e2e-q1', text: 'e2e 排队的这条', files: [], at: Date.now() }]));
    if (window.__ui && window.__ui.renderOutboxPanel) window.__ui.renderOutboxPanel();
    var el = document.getElementById('obox');
    if (el) el.classList.add('show');
    var n = document.querySelectorAll('#obox-list .orow').length;
    var txt = (document.getElementById('obox-list') || {}).textContent || '';
    localStorage.removeItem('dsh.outbox');
    if (window.__ui && window.__ui.renderOutboxPanel) window.__ui.renderOutboxPanel();
    if (el) el.classList.remove('show');
    return { n: n, has: txt.indexOf('e2e 排队的这条') >= 0 };
  })()`);
  const o = r || {};
  return { ok: o.n > 0 && o.has === true, detail: '面板条目=' + o.n + ' 含测试文本=' + o.has };
});

await step('到点提醒会弹通知', async () => {
  const r = await ev(`(function () {
    if (!window.__bang) return { err: 'no __bang' };
    window.__notifyIntent = null;
    window.__notified = null;
    // 不需要真的等一分钟：直接喂一条「已到点」的提醒结构
    window.__bang({ id: 'e2e-n1', text: 'e2e 通知测试', at: Date.now(), label: '现在' });
    var i = window.__notifyIntent || {};
    var body = (document.body || {}).textContent || '';
    return {
      intent: !!window.__notifyIntent,
      titleOk: String(i.title || '').indexOf('提醒') >= 0,
      bodyOk: String(i.body || '').indexOf('e2e 通知测试') >= 0,
      permitted: i.permitted === true,
      banner: body.indexOf('e2e 通知测试') >= 0,
    };
  })()`);
  const o = r || {};
  // 断言「打算弹的通知内容正确」；真正弹出来需要用户授权（真机 true / 无头 false）
  return { ok: o.intent === true && o.titleOk && o.bodyOk && o.banner, detail: '通知意图=' + o.intent + ' 标题对=' + o.titleOk + ' 正文对=' + o.bodyOk + ' 横幅含文案=' + o.banner + ' 已授权=' + o.permitted };
});

await step('提醒会按固定节奏震动', async () => {
  const r = await ev(`(function () {
    window.__vibratePattern = null;
    try { window.__bang({ id: 'e2e-vib', text: '震动测试' }); } catch (e) {}
    return { p: window.__vibratePattern };
  })()`);
  const p = (r && r.p) || null;
  const ok = Array.isArray(p) && p.length === 4 && p[1] === 180;
  return { ok: ok, detail: '振动序列=' + JSON.stringify(p) };
});

await step('设置里有「装到主屏幕」入口', async () => {
  const r = await ev(`(function () {
    var b = document.getElementById('pwa-box');
    var s = document.getElementById('pwa-state');
    return { has: !!b, txt: s ? s.textContent : '', shown: b ? getComputedStyle(b).display : 'none' };
  })()`);
  const ok = !!(r && r.has && /装|好/.test(r.txt || ''));
  return { ok: ok, detail: '面板=' + (r && r.has) + ' 显示=' + (r && r.shown) + ' 文案=' + (r && r.txt) };
});

await step('回声保护会退场、不死循环', async () => {
  const r = await ev(`(function () {
    window.__cancelled = 0;
    window.DSHVoice = { available: function(){return true;}, start: function(){}, stop: function(){}, cancel: function(){ window.__cancelled++; } };
    // 现在录音层统一走 __recCancel（原生/网页两种引擎），断言应该盯这个出口，
    // 而不是假设底下一定是 DSHVoice —— 页面在 localhost 下会选网页引擎。
    var origCancel = window.__recCancel;
    window.__recCancel = function(){ window.__cancelled++; try { if (origCancel) origCancel(); } catch (e) {} };
    window.__convoCfg = { winMs: 400, retryMs: 120, hits: 3, retries: 2, lvl: 25 };
    window.__convo = true;
    window.__convoGuard.until = Date.now() + 400;
    window.__convoGuard.hits = 0;
    window.__convoGuard.retries = 0;
    for (var i = 0; i < 8; i++) window.__convoEchoCheck(60);
    var off = window.__convo === false;
    var c1 = window.__cancelled;
    for (var j = 0; j < 8; j++) window.__convoEchoCheck(60);
    var c2 = window.__cancelled;
    window.__convo = false;
    try { localStorage.setItem('dsh.convo', '0'); } catch (e) {}
    window.__recCancel = origCancel;
    return { off: off, c1: c1, c2: c2 };
  })()`);
  const ok = !!(r && r.off && r.c1 > 0 && r.c2 === r.c1);
  return { ok: ok, detail: '退场=' + (r && r.off) + ' 取消=' + (r && r.c1) + ' 再灌后=' + (r && r.c2) };
});

await step('斜杠命令在本地执行', async () => {
  const n = await ev("window.__slash && window.__slash.cmds ? Object.keys(window.__slash.cmds).length : 0");
  const has = await ev("typeof window.__slash === 'object' && typeof window.__slash.run === 'function'");
  const before = await ev("document.querySelectorAll('#main .row').length");
  const ran = await ev("(function(){try{window.__slash.cmds['/help'].f();return true;}catch(e){return String(e&&e.message||e);}})()");
  await sleep(400);
  const hint = await ev("(document.getElementById('hint') || {}).textContent || ''");
  const after = await ev("document.querySelectorAll('#main .row').length");
  return { ok: has && n >= 8 && ran === true && after === before, detail: 'cmds=' + n + ' 执行=' + ran + ' 提示=' + String(hint).slice(0, 24) + ' 行数 ' + before + '→' + after };
});

// 相处模式的「清空全部历史」：必须存在、必须接线、按下必须先弹确认（不接受就是什么都不做）
await step('清空历史按钮存在且要先确认', async () => {
  await ev("(function(){var b=document.getElementById('btn-clear-history');if(!b)return 'no-btn';var cfg=document.getElementById('cfg');if(cfg&&!cfg.classList.contains('show'))cfg.classList.add('show');return 'ok';})()");
  await sleep(300);
  const there = await ev("!!document.getElementById('btn-clear-history')");
  if (!there) return { ok: false, detail: '按钮不存在' };
  dialogs.length = 0;
  // 注意：不能 await —— confirm 会阻塞渲染进程，Runtime.evaluate 的响应要等对话框关掉才回，
  // 那样就变成「等 evaluate 返回才去关对话框」的死锁。先发出去，再关。
  send('Runtime.evaluate', { expression: "document.getElementById('btn-clear-history').click()", returnByValue: true });
  await sleep(900);
  const msg = dialogs[0] || '';
  // 关键：**拒绝**这个对话框 —— 断言走完一行数据都不能少
  await send('Page.handleJavaScriptDialog', { accept: false });
  await sleep(500);
  const rowsAfter = await ev("document.querySelectorAll('#main .row').length");
  const rowsBefore = await ev("window.__rowsBeforeClear || 0");
  const asked = /清空/.test(msg) && /不可撤销/.test(msg);
  return { ok: asked && rowsAfter > 0, detail: '确认文案=' + (msg ? msg.slice(0, 26).replace(/\n/g, ' ') + '…' : '无') + ' 取消后行数=' + rowsAfter };
});

// 段间停顿：Edge 免费端点拒收 <break>，所以停顿必须由接口按情绪算好、送到前端
// 走 node 侧的 fetch —— 页面内前面几步改过 fetch/onLine，躲开它们才测的是接口本身
await step('语音接口按情绪给出段间停顿', async () => {
  const tok = new URL(process.argv[2]).searchParams.get('t') || '';
  const r = await fetch('http://127.0.0.1:8899/api/tts?all=1&t=' + encodeURIComponent(tok), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '[[兴奋]]太好了！！[[/兴奋]][[疲惫]]可是真的累了……[[/疲惫]]' }),
  }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  const parts = r.parts || [];
  const pick = (k) => Number(((parts.find((p) => p.emotion === k) || {}).gapAfter) || 0);
  const excitedGap = pick('excited');
  const tiredGap = pick('tired');
  return { ok: excitedGap > 0 && tiredGap > excitedGap, detail: 'excited gap=' + excitedGap + 'ms · tired gap=' + tiredGap + 'ms（疲惫该比兴奋停得久）' + (r.error ? ' | err=' + r.error : '') };
});

// 断线自愈的入口必须真的接上：切回前台 / 重连之后要去服务端对一次账，
// 而不是只把 socket 接上（这是「卡在思考、得重开 App」的病根）
await step('回到前台会去对账', async () => {
  const before = await ev("(window.__resyncCount||0)");
  await ev("(function(){document.dispatchEvent(new Event('visibilitychange'));return 1;})()");
  await sleep(1600);
  const after = await ev("(window.__resyncCount||0)");
  const why = await ev("window.__resyncReason || ''");
  return { ok: after > before, detail: '对账次数 ' + before + '→' + after + '（触发原因=' + (why || '无') + '）' };
});


// 剪贴板面板是新增入口，至少验证按钮能开、控件齐全、关闭能收
await step('剪贴板面板能打开', async () => {
  await ev("(function(){var b=document.getElementById('open-clip'); if(b) b.click(); return 1;})()");
  await sleep(350);
  const raw = await ev("(function(){var s=document.getElementById('clip');return JSON.stringify({show:!!(s&&s.classList.contains('show')),ta:!!document.getElementById('clip-ta'),btn:!!document.getElementById('clip-read')});})()");
  let j = {}; try { j = JSON.parse(raw); } catch (e) {}
  await ev("(function(){var b=document.getElementById('clip-close'); if(b) b.click(); return 1;})()");
  return { ok: !!(j.show && j.ta && j.btn), detail: 'show=' + !!j.show + ' · textarea=' + !!j.ta + ' · 读取键=' + !!j.btn };
});

// /health 不需要令牌：里面绝不能出现带 token 的地址（曾经局域网就能拿到钥匙）
await step('健康检查不泄露令牌', async () => {
  const r = await fetch(APP_PREFIX + 'health').then((x) => x.text()).catch((e) => 'ERR ' + e.message);
  const mf = await fetch(APP_PREFIX + 'manifest.webmanifest').then((x) => x.text()).catch((e) => 'ERR ' + e.message);
  const leaked = /[?&]t=[0-9a-f]{24}/i.test(r) || /[?&]t=[0-9a-f]{24}/i.test(mf);
  return { ok: !leaked && !/ERR /.test(r) && !/ERR /.test(mf), detail: leaked ? '响应里出现了 token' : 'health/manifest 均无令牌 · ' + (r.length + mf.length) + 'B' };
});

// 工具调用折叠：新渲染的工具消息必须自动成组，点一下展开、再点收起
await step('工具调用会折叠且可展开', async () => {
  const raw = await ev(`(function(){
    var main=document.getElementById('main');
    var made=[];
    function add(html){var d=document.createElement('div');d.className='row ai';d.innerHTML=html;main.appendChild(d);made.push(d);return d;}
    add('<div class="bubble md"><p>e2e 工具折叠分隔</p></div>');
    for(var i=0;i<3;i++) add('<div class="bubble md"><p>⏺ memory_update</p></div>');
    if(window.__markToolRows) window.__markToolRows();
    var groups=main.querySelectorAll('.row.toolsum');
    var g=groups[groups.length-1];
    var b=g?g.querySelector('.bubble'):null;
    var sum=b?b.textContent.replace(/\\s+/g,' ').trim():'';
    var role=b?b.getAttribute('role'):'';
    var aria0=b?b.getAttribute('aria-expanded'):'';
    var rest=made.filter(function(n){return n.classList.contains('toolrest')}).length;
    if(b) b.click();
    var open=made.filter(function(n){return n.classList.contains('toolrest')}).length;
    var aria1=b?b.getAttribute('aria-expanded'):'';
    if(b) b.click();
    var close=made.filter(function(n){return n.classList.contains('toolrest')}).length;
    var aria2=b?b.getAttribute('aria-expanded'):'';
    if(b) b.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
    var kbOpen=made.filter(function(n){return n.classList.contains('toolrest')}).length;
    if(b) b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    var kbClose=made.filter(function(n){return n.classList.contains('toolrest')}).length;
    made.forEach(function(n){n.remove()});
    if(window.__markToolRows) window.__markToolRows();
    return JSON.stringify({sum:sum,role:role,aria0:aria0,aria1:aria1,aria2:aria2,
      rest:rest,open:open,close:close,kbOpen:kbOpen,kbClose:kbClose});
  })()`);
  let j = {};
  try { j = JSON.parse(raw); } catch (e) { j = { err: String(e && e.message) }; }
  const ok = /3 次工具调用/.test(j.sum || '') && j.role === 'button' &&
    j.aria0 === 'false' && j.aria1 === 'true' && j.aria2 === 'false' &&
    j.rest === 2 && j.open === 0 && j.close === 2 && j.kbOpen === 0 && j.kbClose === 2;
  return { ok, detail: '折叠=' + (j.sum || j.err || '无') + ' role=' + j.role + ' aria=' + j.aria0 + '/' + j.aria1 + '/' + j.aria2 + ' 初始隐藏=' + j.rest + ' 展开=' + j.open + ' 收起=' + j.close + ' 键盘=' + j.kbOpen + '/' + j.kbClose };
});

await step('页面无异常', async () => {
  if (voice0) {
    await ev("(async function(){ await fetch((location.pathname.replace(/[^/]*$/,'')||'/').replace(/([^/])$/,'$1/') + 'api/voice?t=' + (new URLSearchParams(location.search).get('t')||localStorage.getItem('dsh.tk')||''), {method:'POST', body: JSON.stringify({voice:'" + voice0 + "'})}); })()");
    await sleep(800);
  }
  const errs = await ev("(window.__errs || []).length");
  return { ok: errs === 0, detail: 'errs=' + errs };
});

const pass = results.filter((r) => r.ok).length;
console.log('\n== ' + pass + '/' + results.length + ' 通过 ==');
fs.writeFileSync('D:\\document\\Remote Connect DSH\\dist\\e2e.json', JSON.stringify({ at: Date.now(), pass, total: results.length, results }, null, 2));

// 截图留档
await send('Page.bringToFront').catch(() => {});
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result) fs.writeFileSync('D:\\document\\Remote Connect DSH\\dist\\e2e.png', Buffer.from(shot.result.data, 'base64'));
ws.close();
cleanupOnce();
process.exit(pass === results.length ? 0 : 1);
