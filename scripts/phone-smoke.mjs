// 手机端（phone-bridge）界面冒烟：无头 Edge + CDP，390×844，零 npm 依赖
// 用法：node scripts\phone-smoke.mjs [url] [--shot DIR]
//   url 省略时自动读 phone-bridge\runtime\port.json + state.json 拼出 http://127.0.0.1:<port>/?t=<token>
// 退出码：全部通过 0，有失败 1。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'phone-bridge');
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function findEdge() {
  for (const p of EDGE_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch {} }
  throw new Error('找不到 Edge：设置 EDGE_PATH 或安装 Edge');
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function autoUrl() {
  const port = (readJson(path.join(BRIDGE, 'runtime', 'port.json')) || {}).port || 8899;
  const st = readJson(path.join(BRIDGE, 'runtime', 'state.json')) || {};
  const t = st.token ? '?t=' + encodeURIComponent(st.token) : '';
  return `http://127.0.0.1:${port}/${t}`;
}

const args = process.argv.slice(2);
let URL_ = args.find((a) => /^https?:\/\//.test(a)) || '';
const shotIdx = args.indexOf('--shot');
const SHOT_DIR = shotIdx >= 0 ? args[shotIdx + 1] : '';
if (!URL_) URL_ = autoUrl();
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9700 + Math.floor(Math.random() * 120);
const PROFILE = path.join(os.tmpdir(), 'dsh-psmoke-' + Date.now());
const child = spawn(findEdge(), [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--headless=new',
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let ws, id = 0; const pending = new Map(); const errors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const shot = async (name) => {
  if (!SHOT_DIR) return;
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
};
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr) === true) return true;
    await sleep(180);
  }
  return false;
};

try {
  const t0 = Date.now();
  let list;
  while (Date.now() - t0 < 15000) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (list.some((t) => t.type === 'page')) break; } catch {}
    await sleep(150);
  }
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('CONSOLE ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: URL_ });

  // ① 首屏挂载 + 视口宽度
  const up = await waitFor("!!document.querySelector('footer') && document.querySelectorAll('.row').length >= 0 && !!document.getElementById('input')");
  await sleep(1200);
  const w = await ev('innerWidth');
  check('手机端首屏挂载', up && w === 390, `innerWidth=${w}`);

  // ② 至少有一条消息；没有会话时也算通过（空态正常）
  const rows = await ev("document.querySelectorAll('.row').length");
  check('消息流有内容或正常空态', typeof rows === 'number', `rows=${rows}`);

  // ③ 工具折叠：点一下可见行数应上升，再点回落
  const tool = await ev(`(function(){
    var b=document.querySelector('[data-toolgroup] .bubble'); if(!b) return JSON.stringify({skip:true});
    var vis=function(){return [].slice.call(document.querySelectorAll('.row.toolmsg')).filter(function(r){return r.offsetParent!==null;}).length;};
    var n0=vis(); b.click();
    return new Promise(function(res){ setTimeout(function(){ var n1=vis(); b.click(); setTimeout(function(){ res(JSON.stringify({n0:n0,n1:n1,n2:vis(),aria:b.getAttribute('aria-expanded')})); },160); },200); });
  })()`);
  let toolOk = true; try { const o = JSON.parse(tool); if (!o.skip) toolOk = o.n1 > o.n0; } catch { toolOk = false; }
  check('工具调用折叠可展开/收起', toolOk, tool);

  // ④ 长按气泡出菜单（复制/引用/收藏/多选/更多）
  const lp = await ev(`(function(){
    var b=document.querySelector('.row.ai .bubble, .row .bubble'); if(!b) return JSON.stringify({skip:true});
    var r=b.getBoundingClientRect();
    var mk=function(type){return new TouchEvent(type,{bubbles:true,cancelable:true,touches:[new Touch({identifier:9,target:b,clientX:r.left+16,clientY:r.top+16})],changedTouches:[new Touch({identifier:9,target:b,clientX:r.left+16,clientY:r.top+16})]});};
    b.dispatchEvent(mk('touchstart'));
    return new Promise(function(res){ setTimeout(function(){
      b.dispatchEvent(mk('touchend'));
      setTimeout(function(){
        var m=document.getElementById('ctxmenu');
        var labels=m?[].slice.call(m.querySelectorAll('button')).map(function(x){return x.textContent;}):[];
        if(m) m.classList.remove('show');
        res(JSON.stringify({shown:!!(m&&m.classList.contains('show'))||labels.length>0,labels:labels}));
      },420);
    },700); });
  })()`);
  let lpOk = false, lpDetail = lp;
  try { const o = JSON.parse(lp); lpOk = !!o.skip || (o.labels.length >= 3 && o.labels.some((x) => x.indexOf('复制') >= 0)); } catch {}
  check('长按消息出操作菜单', lpOk, lpDetail);

  // ⑤ 图片 lightbox：开→有图→关
  const lb = await ev(`(function(){
    if(!window.__ui || !window.__ui.openLightbox) return 'no-openLightbox';
    var url='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#2fe0c6"/></svg>');
    window.__ui.openLightbox(url);
    var el=document.getElementById('lightbox');
    var out={open:!!(el&&el.classList.contains('show')),imgs:el?el.querySelectorAll('img').length:0};
    var c=el&&el.querySelector('[data-a="close"]'); if(c) c.click();
    out.closed=!(el&&el.classList.contains('show'));
    return JSON.stringify(out);
  })()`);
  let lbOk = false; try { const o = JSON.parse(lb); lbOk = o.open && o.imgs === 1 && o.closed; } catch {}
  check('图片预览可开可关', lbOk, lb);

  // ⑥ 底部输入区可达（不被键盘/提示条挡住）
  const foot = await ev(`(function(){var f=document.querySelector('footer');if(!f)return 'no-footer';var r=f.getBoundingClientRect();return JSON.stringify({top:Math.round(r.top),h:Math.round(r.height),inView:r.top < innerHeight && r.bottom <= innerHeight+1});})()`);
  check('底部输入区在视口内', /"inView":true/.test(foot), foot);

  await shot('phone-smoke');

  const jsErr = errors.filter((e) => !/favicon|ERR_ABORTED|net::ERR/i.test(e));
  check('无未捕获的 JS 异常', jsErr.length === 0, jsErr.slice(0, 2).join(' | '));
} catch (e) {
  check('探针执行', false, e.message);
} finally {
  try { ws?.close(); } catch {}
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(150);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}
