// 手机端「眼睛」的自动化验收：真的开一个浏览器，真的点按钮，真的看服务端有没有收到帧。
// 用法: node test/camtest.mjs [--shots] [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const PORT = 8899;
const DBG = 9411;
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'test', 'out');

const fails = [];
const oks = [];
function ok(msg) { oks.push(msg); console.log('  ✓ ' + msg); }
function bad(msg, extra) { fails.push(msg + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + msg + (extra ? ' → ' + extra : '')); }

function token() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'state.json'), 'utf8'));
  return s.token;
}
const T = token();
// 桥接会被「改完文件自动跑回归」的看护重启，请求偶尔会 ECONNRESET / ECONNREFUSED。
// 回归本身不该因此中断：网络层出错就等一下重试，真的连不上再抛。
const api = async (p, opt) => {
  const url = `http://127.0.0.1:${PORT}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(T)}`;
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      return await fetch(url, opt);
    } catch (e) {
      lastErr = e;
      if (i >= 2) { try { await waitHealthy(30); } catch (_) {} }
      await sleep(1500);
    }
  }
  throw lastErr;
};

// 重启桥接之后端口会断一小会儿，这里统一等它回来，别让 ECONNREFUSED 冒充功能失败
async function waitHealthy(maxSec = 90) {
  for (let i = 0; i < maxSec; i++) {
    try {
      // 这里必须用裸 fetch：api() 里会回调 waitHealthy，套起来会自己递归
      const h = await (await fetch('http://127.0.0.1:' + PORT + '/api/health')).json();
      if (h && h.ok) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- 最小 CDP 客户端（Node 24 自带 WebSocket）----
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.wait = new Map(); this.events = []; }
  ready() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error ' + (e && e.message)));
      this.ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && this.wait.has(d.id)) {
          const { res, rej: r2 } = this.wait.get(d.id);
          this.wait.delete(d.id);
          d.error ? r2(new Error(d.error.message)) : res(d.result);
        } else if (d.method) {
          this.events.push(d);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.wait.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.wait.has(id)) { this.wait.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const jpegB64 = fs.existsSync(path.join(os.tmpdir(), 'camtest.jpg'))
  ? fs.readFileSync(path.join(os.tmpdir(), 'camtest.jpg')).toString('base64')
  : '';

const FAKE = `
(() => {
  const B64 = ${JSON.stringify(jpegB64)};
  const tick = (fn, ms) => setTimeout(fn, ms);
  window.__fakeCam = { grabbed: 0, snaps: 0, previews: 0, stops: 0, vis: [] };
  window.DSHCam = {
    available: () => true,
    grab: () => { window.__fakeCam.grabbed++; tick(() => window.__camFrame && window.__camFrame(B64, 1280, 720, 'grab'), 90); },
    snap: () => { window.__fakeCam.snaps++; tick(() => window.__camFrame && window.__camFrame(B64, 1280, 720, 'snap'), 90); },
    startPreview: () => {
      window.__fakeCam.previews++;
      tick(() => window.__livePreview && window.__livePreview(1, ''), 40);
      tick(() => window.__camFrame && window.__camFrame(B64, 1280, 720, 'preview'), 120);
    },
    stopPreview: () => { window.__fakeCam.stops++; },
    setPreviewVisible: (v) => { window.__fakeCam.vis.push(!!v); },
    liveOn: () => true,
    version: () => 'cam2/test',
    busy: () => false,
    entry: () => 'https://dsh.example.com/dsh',
    setUpload: (u) => { window.__fakeCam.upload = u || ''; },
    pushLast: async () => {
      const u = window.__fakeCam.upload;
      if (!u) return false;
      const bin = atob(window.__fakeCam.b64 || B64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: arr });
      return r.ok;
    },
  };
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
})();
`;

process.on('unhandledRejection', (e) => { console.log('    (未捕获的拒绝，继续跑) ' + ((e && e.message) || e)); });

const REAL_ERRS = (list) => (list || []).filter((e) => !/^(reject: )?(Failed to fetch|signal timed out|The operation was aborted.*)$/i.test(String(e)));

async function main() {
  if (!EDGE) { console.log('没有找到 Edge/Chrome，跳过浏览器测试'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcam-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter', '--window-size=430,932',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
  }
  if (!target) { console.log('浏览器没起来'); child.kill(); return; }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE });

  const shot = async (name) => {
    if (!SHOTS) return;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('    📷 ' + name + '.png');
  };

  console.log('\n[1] 打开页面');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${encodeURIComponent(T)}` });
  for (let i = 0; i < 40; i++) { await sleep(300); if (await cdp.eval(`!!window.__bus && !!window.DSHCam`).catch(() => false)) break; }
  const boot = await cdp.eval(`({ cam: !!window.DSHCam, eyes: typeof window.__camGrabOnce === 'function', live: !!window.__liveInfo })`);
  boot.cam && boot.eyes ? ok('页面加载，原生相机桥被识别') : bad('原生相机桥没被识别', JSON.stringify(boot));
  await shot('01-home');

  console.log('\n[2] 打开「让他看」面板');
  await cdp.eval(`document.getElementById('btn-cam').click()`);
  await sleep(700);
  const panel = await cdp.eval(`document.getElementById('cam').classList.contains('show')`);
  panel ? ok('摄像头面板弹出') : bad('摄像头面板没弹出');
  await shot('02-camera');

  console.log('\n[3] 快门：拍一张并发出去');
  const beforeMsg = await cdp.eval(`document.querySelectorAll('.row').length`);
  await cdp.eval(`document.getElementById('cam-shot').click()`);
  await sleep(2500);
  const snapState = await cdp.eval(`({ grabs: window.__fakeCam.grabbed, snaps: window.__fakeCam.snaps, pending: (window.__phone && 1) || 0, msgs: document.querySelectorAll('.row').length })`);
  snapState.snaps >= 1 ? ok(`点了快门 → snap() 被调用 ${snapState.snaps} 次`) : bad('快门没触发 snap()', JSON.stringify(snapState));
  await sleep(1500);
  const afterMsg = await cdp.eval(`document.querySelectorAll('.row').length`);
  afterMsg > beforeMsg ? ok(`照片进了对话（消息 ${beforeMsg} → ${afterMsg}）`) : bad('照片没出现在对话里', `${beforeMsg} → ${afterMsg}`);
  // 服务端计数器在一次重启后会归零（改完文件 8 秒会自动跑回归并重启桥接），
  // 所以这里轮询一下；还没有就再按一次快门，避免把环境抖动记成产品坏。
  let st1 = await (await api('/api/camera/state')).json();
  for (let i = 0; i < 10 && st1.totalPushes < 1; i += 1) { await sleep(600); st1 = await (await api('/api/camera/state')).json(); }
  if (st1.totalPushes < 1) {
    await cdp.eval(`document.getElementById('cam-shot').click()`);
    await sleep(1800);
    for (let i = 0; i < 8 && st1.totalPushes < 1; i += 1) { await sleep(600); st1 = await (await api('/api/camera/state')).json(); }
  }
  st1.totalPushes >= 1 ? ok(`服务端收到帧（共 ${st1.totalPushes} 次推帧）`) : bad('服务端一帧都没收到', JSON.stringify({ pushes: st1.totalPushes, frames: st1.frames }));
  await shot('03-after-snap');

  console.log('\n[4] 直播：开始 → 取帧 → 点评');
  // 上一轮（发照片那条）会占住管线几十秒。等它说完再开直播，
  // 否则直播那几眼全被「他还在看上一眼」挡回来，测的就不是直播本身了。
  {
    let idle = false;
    // 卡住的轮次只会在下一个 turn 完成后才自己松手，干等是没意义的：
    // 等 60 秒还忙就重启桥接（清掉那一轮），然后接着往下测。
    for (let i = 0; i < 120; i++) {
      // 这里必须用裸 fetch：api() 里会回调 waitHealthy，套起来会自己递归
      let h = null;
      try { h = await (await fetch('http://127.0.0.1:' + PORT + '/api/health')).json(); } catch (_) { h = null; }
      if (h && !h.busy) { idle = true; break; }
      // 桥接正在被「改完自动跑回归」重启时这里会连不上，等它回来就行
      if (!h) { await sleep(3000); continue; }
      if (i === 60) {
        console.log('    (管线卡了 60 秒，重启桥接清掉这一轮)');
        try { await api('/api/restart', { method: 'POST' }); } catch (_) {}
        await sleep(1500);
        if (!(await waitHealthy())) { console.log('    (重启后没等到 health ok)'); }
      }
      await sleep(1000);
    }
    if (idle) ok('管线空闲，可以开始直播'); else bad('管线一直忙着，直播没法测');
  }
  // 基线：上一轮跑过的照片还在会话里，得比增量，不能比总数
  const photosBefore = await cdp.eval(`document.querySelectorAll('.row.me .shot img').length`);
  await cdp.eval(`document.getElementById('cam-live').click()`);
  await sleep(1200);
  const barState = await cdp.eval(`({
    mode: document.body.classList.contains('live-mode'),
    barH: (document.getElementById('livebar') || {}).offsetHeight || 0,
    camOpen: document.getElementById('cam').classList.contains('show')
  })`);
  barState.mode && barState.barH > 100 ? ok(`直播条长在会话上方（高 ${barState.barH}px，没有遮罩）`) : bad('直播条没出现', JSON.stringify(barState));
  barState.camOpen ? bad('开了直播，「让他看」面板还开着') : ok('开直播自动收起了摄像头面板');
  await shot('04-live-idle');

  // 间隔调到最短，省得等 20 秒
  await cdp.eval(`(() => { const s = document.getElementById('lb-cad'); s.value = '10000'; s.dispatchEvent(new Event('change')); return s.value; })()`);
  ok('间隔改成 10 秒');

  // 等第一次取帧落地：会话里应该出现一张「我」发的照片
  let live = null;
  for (let i = 0; i < 170; i++) {
    await sleep(500);
    live = await cdp.eval(`({
      grabs: window.__fakeCam.grabbed,
      photos: document.querySelectorAll('.row.me .shot img').length,
      status: (document.getElementById('lb-status') || {}).textContent || '',
      errs: window.__errs.slice(0, 6)
    })`);
    if (live.photos > photosBefore) break;
  }
  const st2 = await (await api('/api/camera/state')).json();
  const freshPhotos = live.photos - photosBefore;
  console.log('    状态：' + JSON.stringify({ photos: freshPhotos, ageMs: Math.round(st2.ageMs || 0), status: live.status, errs: live.errs }).slice(0, 400));
  freshPhotos >= 1 ? ok(`直播取帧成功，会话里新增 ${freshPhotos} 张「我」发的一眼照片`) : bad('直播没取到帧（会话里没新照片）', 'status=' + live.status);
  (st2.ageMs != null && st2.ageMs < 20000)
    ? ok(`服务端缓冲里有新画面（${Math.round(st2.ageMs)}ms 前，共 ${st2.frames} 帧）`)
    : bad('服务端缓冲没有新画面', JSON.stringify({ ageMs: st2.ageMs, frames: st2.frames }));
  REAL_ERRS(live.errs).length === 0 ? ok('页面无 JS 报错') : bad('页面有 JS 报错', JSON.stringify(REAL_ERRS(live.errs)));

  await sleep(2500);
  await shot('05-live-running');

  console.log('\n[5] 间隔可调（10s → 30s）');
  await cdp.eval(`(() => { const s = document.getElementById('lb-cad'); s.value = '30000'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const st3 = await (await api('/api/camera/state')).json();
  st3.live && Number(st3.live.gapMs) === 30000 ? ok('服务端记住间隔 30s') : bad('服务端没记住间隔', JSON.stringify(st3.live));

  console.log('\n[5a] 上传那条路不通时，把这一帧直接塞进点评请求');
  {
    // 拦住 /api/upload（模拟真机上上传失败/超时），看点评请求里有没有带上那一帧
    await cdp.eval(`(() => {
      window.__bodies = [];
      if (!window.__origFetch) window.__origFetch = window.fetch;
      window.fetch = async (u, o) => {
        const url = String(u);
        if (url.indexOf('/api/upload') >= 0) { window.__bodies.push({ url: url, blocked: true }); throw new Error('blocked'); }
        if (o && typeof o.body === 'string' && url.indexOf('/api/live/comment') >= 0) {
          try { const b = JSON.parse(o.body); window.__bodies.push({ url: url, hasData: !!b.data, head: String(b.data || '').slice(0, 8), kb: Math.round(String(b.data || '').length * 0.75 / 1024), path: b.path || '' }); } catch (_) {}
        }
        return window.__origFetch(u, o);
      };
      return 1;
    })()`);
    await cdp.eval(`document.getElementById('lb-ask').click()`);
    let got = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const bs = await cdp.eval(`window.__bodies || []`);
      got = (bs || []).find((b) => b && b.hasData);
      if (got) break;
    }
    const blocked = await cdp.eval(`(window.__bodies || []).some((b) => b && b.blocked)`);
    blocked ? ok('上传那条路被拦住（模拟真机上传失败）') : bad('没走到上传失败那条路，测不到兜底');
    got && /^\/9j/.test(got.head || '')
      ? ok(`点评请求自己带了这一帧（${got.kb} KB，JPEG）`)
      : bad('上传失败时点评请求没带画面', JSON.stringify(got || null));

    // 内联那一帧必须压在上传上限以内，否则服务端会整条丢掉 —— 大图就该先压小图
    got && got.kb > 0 && got.kb <= 1600
      ? ok(`内联那一帧在体积上限以内（${got.kb} KB ≤ 1600 KB）`)
      : bad('内联那一帧超了上限，服务端会丢', got ? got.kb + ' KB' : '没有帧');
    await cdp.eval(`(() => { if (window.__origFetch) window.fetch = window.__origFetch; window.__bodies = []; })()`);
  }

  console.log('\n[5b] 设置面板：间隔能拉到 5 分钟、画质能改到 640');
  {
    await cdp.eval(`document.getElementById('lb-cfg').click()`);
    await sleep(500);
    const opened = await cdp.eval(`!!document.querySelector('#livecfg.show')`);
    opened ? ok('⚙ 打开直播设置面板') : bad('设置面板没打开');
    await cdp.eval(`(() => { const b = document.querySelector('#cfg-presets .cfgchip[data-cad="300"]'); if (b) b.click(); })()`);
    await sleep(1200);
    const st5 = await (await api('/api/camera/state')).json();
    st5.live && Number(st5.live.gapMs) === 300000 ? ok('间隔拉到 5 分钟，服务端认了')
      : bad('服务端没接受 5 分钟间隔', JSON.stringify(st5.live));
    const label = await cdp.eval(`document.getElementById('cfg-cad-v').textContent`);
    label && label.indexOf('5') >= 0 ? ok('面板上的文案跟着变成「' + label + '」') : bad('面板文案没更新', label);

    // 范围放宽后：最快 2 秒、最慢 30 分钟都要真的生效
    await cdp.eval(`(() => { const b = document.querySelector('#cfg-presets .cfgchip[data-cad="2"]'); if (b) b.click(); })()`);
    await sleep(1000);
    const stMin = await (await api('/api/camera/state')).json();
    Number(stMin.live && stMin.live.gapMs) === 2000 ? ok('间隔能压到 2 秒') : bad('2 秒没生效', JSON.stringify(stMin.live));
    await cdp.eval(`(() => { const b = document.querySelector('#cfg-presets .cfgchip[data-cad="1800"]'); if (b) b.click(); })()`);
    await sleep(1000);
    const stMax = await (await api('/api/camera/state')).json();
    Number(stMax.live && stMax.live.gapMs) === 1800000 ? ok('间隔能放到 30 分钟') : bad('30 分钟没生效', JSON.stringify(stMax.live));
    await cdp.eval(`(() => { const b = document.querySelector('#cfg-presets .cfgchip[data-cad="300"]'); if (b) b.click(); })()`);
    await sleep(600);
    // 自检会顺手把那一帧送到服务端，电脑这边能直接看
    {
      const r = await fetch('http://127.0.0.1:8899/api/camera/probe/shot?t=' + encodeURIComponent(T));
      const ct = r.headers.get('content-type') || '';
      const len = Number(r.headers.get('content-length') || 0);
      ct.indexOf('image/jpeg') === 0 && len > 500 ? ok('自检那一帧能在电脑这边取回（' + len + ' 字节 JPEG）')
        : bad('自检帧取不回来', ct + ' ' + len);
    }
    await cdp.eval(`(() => { const b = document.querySelector('#cfg-edges .cfgchip[data-edge="640"]'); if (b) b.click(); })()`);
    await sleep(400);
    await cdp.eval(`document.getElementById('cfg-test').click()`);
    await sleep(2500);
    const probeText = await cdp.eval(`document.getElementById('cfg-test-v').textContent`);
    // 自检现在是三条路逐条报（浏览器 ✓/✗ · 原生 ✓/✗），只要每条都有判定就算说清了
    (/浏览器\s*[✓✗]/.test(probeText || '') && /原生\s*[✓✗]/.test(probeText || '')) ? ok('自检把每条路都判了：' + probeText.slice(0, 60))
      : bad('自检没给出可读结果', probeText);
    /* 面板里要有那一帧的缩略图：卡片里有图 = 真的拍到了（自己就能验证，不用找人转述） */
    const thumb = await cdp.eval(`(() => {
      const w = document.getElementById('cfg-shotwrap');
      const i = document.getElementById('cfg-shot');
      return { shown: !!w && w.style.display !== 'none', src: (i && i.src || '').slice(0, 30), env: (document.getElementById('cfg-env') || {}).textContent || '' };
    })()`);
    thumb.shown && /^data:image\/jpeg/.test(thumb.src)
      ? ok('设置面板里出现那一帧的缩略图（' + thumb.src.slice(0, 22) + '…）')
      : bad('面板里没有缩略图', JSON.stringify(thumb));
    /https|http/.test(thumb.env) ? ok('环境行写清了入口与权限：' + thumb.env.slice(0, 48)) : bad('环境行没写出来', thumb.env);

    /* 不说话也能有证据：页面自己每天静默自检一次 */
    const auto = await cdp.eval(`(async () => {
      if (typeof window.__autoProbeNow !== 'function') return 'missing';
      try { localStorage.removeItem('dsh.autoProbe'); } catch (_) {}
      const r1 = await window.__autoProbeNow(true);
      const r2 = await window.__autoProbeNow(false);
      return r1 + '/' + r2;
    })()`);
    auto === 'ok/skip'
      ? ok('页面会自己静默自检一次，而且同一天不重复（' + auto + '）')
      : bad('自动自检没按预期跑', auto);

    const stProbe = await (await api('/api/camera/state')).json();
    stProbe.probe && stProbe.probe.ok === true ? ok('自检结果记到服务端（' + stProbe.probe.src + ' · ' + stProbe.probe.w + '×' + stProbe.probe.h + '）')
      : bad('服务端没收到自检结果', JSON.stringify(stProbe.probe));
    // 面板里要逐条记「哪一眼、多大、走的哪条路」，出问题时不用靠回忆
    const logText = await cdp.eval(`(document.getElementById('cfg-log') || {}).textContent || ''`);
    /KB/.test(logText) && /✓|✗/.test(logText)
      ? ok('帧日志记到了最近几眼：' + logText.split('\n')[0].slice(0, 46))
      : bad('帧日志没记下来', String(logText).slice(0, 80));
    await shot('06-live-settings');
    await cdp.eval(`document.getElementById('cfg-done').click()`);
    await sleep(400);
    const closed = await cdp.eval(`!document.querySelector('#livecfg.show')`);
    closed ? ok('「好了」把设置面板收掉了') : bad('设置面板没关掉');
    // 下一眼应该用 640 宽去拍
    await cdp.eval(`document.getElementById('lb-ask').click()`);
    await sleep(3500);
    const st6 = await (await api('/api/camera/state')).json();
    st6.size && Number(st6.size.w) === 640 ? ok('画质改了之后这一眼就是 640 宽')
      : bad('画质没生效', JSON.stringify(st6.size));
    // 改回 30 秒，下面 [6] 用
    await cdp.eval(`(() => { const s = document.getElementById('lb-cad'); s.value = '30000'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(800);
  }

  console.log('\n[5c] 电脑这边点一下，手机自己跑一次自检');
  {
    const before = (await (await api('/api/camera/state')).json()).probe;
    const asked = await (await api('/api/camera/diag', { method: 'POST' })).json();
    asked.ok && asked.diag && asked.diag.id ? ok('下发了一次远程自检请求') : bad('远程自检没下发', JSON.stringify(asked));
    let after = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      after = (await (await api('/api/camera/state')).json()).probe;
      if (after && (!before || after.at !== before.at)) break;
    }
    after && before && after.at !== before.at
      ? ok(`页面自己跑完自检并回报了（${after.steps ? after.steps.length : 0} 条路，${after.shot ? after.shot.bytes + ' 字节那一帧' : '没带图'}）`)
      : bad('远程自检没有回报', JSON.stringify(after && { at: after.at, ok: after.ok }));
  }

  console.log('\n[5d] 手机切到后台：先停，别把「切走了」说成「没取到帧」');
  {
    const h1 = await (await api('/api/camera/live/note', { method: 'POST', body: JSON.stringify({ state: 'hidden' }) })).json();
    h1.ok && h1.paused === true ? ok('切到后台时服务端把直播暂停了') : bad('切后台没暂停', JSON.stringify(h1));
    const st1 = await (await api('/api/camera/state')).json();
    st1.live && st1.live.paused ? ok('state 里能看到 paused=true') : bad('state 没反映暂停', JSON.stringify(st1.live));
    const c1 = await (await api('/api/live/comment', { method: 'POST', body: JSON.stringify({ text: '看一眼', k: 1 }) })).json();
    c1.reason === 'paused' ? ok('暂停期间点评直接回 paused（不排队、不烧一轮）') : bad('暂停期间还在叫', JSON.stringify(c1).slice(0, 120));
    const v1 = await (await api('/api/camera/live/note', { method: 'POST', body: JSON.stringify({ state: 'visible' }) })).json();
    v1.ok && v1.paused === false ? ok('回到前台就恢复') : bad('回前台没恢复', JSON.stringify(v1));
    const stm = await (await api('/api/state')).json();
    const notes = (stm.messages || []).filter((m) => m.kind === 'note');
    notes.length ? ok(`会话里留了备忘小字（${notes.length} 条，最新：${String(notes[notes.length - 1].text).slice(0, 24)}…）`)
      : bad('会话里没有备忘小字');
  }

  console.log('\n[5f] 逐帧取图的节奏跟着设置走');
  {
    const fast = await cdp.eval(`(() => { const opt = document.createElement('option'); opt.value = '2000'; opt.textContent = '2 秒'; const s = document.getElementById('lb-cad'); s.appendChild(opt); s.value = '2000'; s.dispatchEvent(new Event('change')); return window.__pollGap(); })()`);
    fast === 2000 ? ok('设成 2 秒 → 逐帧也按 2 秒走') : bad('2 秒时逐帧太快/太慢', String(fast));
    const slow = await cdp.eval(`(() => { const opt = document.createElement('option'); opt.value = '1800000'; opt.textContent = '30 分钟'; const s = document.getElementById('lb-cad'); s.appendChild(opt); s.value = '1800000'; s.dispatchEvent(new Event('change')); return window.__pollGap(); })()`);
    slow === 15000 ? ok('设成 30 分钟 → 逐帧封顶 15 秒（不再每秒烧相机）') : bad('30 分钟时逐帧没封顶', String(slow));
    await cdp.eval(`(() => { const s = document.getElementById('lb-cad'); const o = Array.from(s.options).find((x) => x.value === '20000'); if (o) { s.value = '20000'; s.dispatchEvent(new Event('change')); } return 1; })()`);
    await sleep(300);
  }

  console.log('\n[5g] 原生自带一条直传（桥断了也还有画面）');
  {
    await cdp.eval(`(() => { const s = document.getElementById('lb-stop'); if (s) s.click(); return 1; })()`);
    await sleep(600);
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(1800);
    const up = await cdp.eval(`window.__fakeCam.upload || ''`);
    /\/api\/camera\/push/.test(up) && /[?&]t=/.test(up)
      ? ok('开播时把直传地址（含令牌）交给了原生')
      : bad('原生没拿到直传地址', String(up).slice(0, 80));
    const before = (await (await api('/api/camera/state')).json()).totalPushes || 0;
    await cdp.eval(`window.DSHCam.pushLast()`);
    let after = before;
    for (let i = 0; i < 12 && after <= before; i += 1) { await sleep(500); after = (await (await api('/api/camera/state')).json()).totalPushes || 0; }
    after > before ? ok('原生直传成功（推帧 ' + before + ' → ' + after + '）') : bad('原生直传没送到', before + ' → ' + after);
  }

  console.log('\n[5h] 直播条上直接写「电脑收到没有」');
  {
    const fresh = await cdp.eval(`(() => { window.__paintFeed({ ageMs: 3000 }); const e = document.getElementById('lb-feed'); return { text: e.textContent, shown: e.style.display !== 'none', cls: e.className }; })()`);
    /收到/.test(fresh.text) && fresh.shown
      ? ok('电脑收到了：' + fresh.text)
      : bad('没显示「已收到」', JSON.stringify(fresh));
    const stale = await cdp.eval(`(() => { window.__paintFeed({ ageMs: 60000 }); const e = document.getElementById('lb-feed'); return { text: e.textContent, cls: e.className }; })()`);
    /还没收到/.test(stale.text) && /miss/.test(stale.cls)
      ? ok('没收到时也说得明白：' + stale.text)
      : bad('没显示「还没收到」', JSON.stringify(stale));
  }

  console.log('\n[6] 停止直播：画面收起、相机放开');
  const stopsBefore = await cdp.eval(`window.__fakeCam.stops`);
  await cdp.eval(`document.getElementById('lb-stop').click()`);
  await sleep(1000);
  const st4 = await (await api('/api/camera/state')).json();
  st4.live && st4.live.on === false ? ok('停止后服务端 live.on=false') : bad('停止后 live 还开着', JSON.stringify(st4.live));
  const afterStop = await cdp.eval(`({ mode: document.body.classList.contains('live-mode'), stops: window.__fakeCam.stops, barH: (document.getElementById('livebar') || {}).offsetHeight || 0 })`);
  afterStop.mode ? bad('停止后直播条还挂着') : ok('停止后直播条收起（不会再盖住会话）');
  afterStop.stops > stopsBefore ? ok('顺手把相机预览也收了') : bad('停止后没停原生预览');

  console.log('\n[7] 原生取景：开面板就开预览，关面板就收');
  {
    const before = await cdp.eval(`window.__fakeCam.previews`);
    await cdp.eval(`document.getElementById('btn-cam').click()`);
    await sleep(700);
    const mid = await cdp.eval(`window.__fakeCam.previews`);
    mid > before ? ok('打开「让他看」就调了 startPreview（取景器摆进了框里）') : bad('开面板没有开原生预览', 'previews ' + before + ' → ' + mid);
    const beforeStop = await cdp.eval(`window.__fakeCam.stops`);
    await cdp.eval(`document.getElementById('cam-close').click()`);
    await sleep(500);
    const afterStop = await cdp.eval(`window.__fakeCam.stops`);
    afterStop > beforeStop ? ok('关面板把预览收掉了（不白占相机）') : bad('关面板没停预览');
  }

  console.log('\n[7b] 取景层跟着页面走：滚出视野就藏，滚回来再画');
  {
    // 强制走取景层这条路（默认会先试浏览器流、再试原生逐帧）
    await cdp.eval(`localStorage.setItem('dsh.liveOverlay','1'); localStorage.setItem('dsh.liveSrc','native')`);
    const prevBefore = await cdp.eval(`window.__fakeCam.previews`);
    if (!(await cdp.eval(`document.getElementById('cam').classList.contains('show')`))) {
      await cdp.eval(`document.getElementById('btn-cam').click()`);
      await sleep(600);
    }
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(1500);
    const prevAfter = await cdp.eval(`window.__fakeCam.previews`);
    const barH = await cdp.eval(`(document.getElementById('livebar') || {}).offsetHeight || 0`);
    prevAfter > prevBefore && barH > 100
      ? ok('开了直播就走取景层（startPreview ' + prevBefore + ' → ' + prevAfter + '）')
      : bad('没走取景层', 'previews ' + prevBefore + ' → ' + prevAfter + ' barH=' + barH);
    // 直播条是贴在会话上方的（不随 #main 滚走），所以直接用滚动测不出「离开视野」。
    // 这里把那一条整体挪出屏幕，等价于真机上「取景框不在可视区」的情形。
    await cdp.eval(`document.getElementById('livebar').style.transform = 'translateY(-2000px)'`);
    await sleep(900);
    const boxTop = await cdp.eval(`Math.round(document.getElementById('lb-box').getBoundingClientRect().top)`);
    const visDown = await cdp.eval(`(window.__fakeCam.vis || []).slice(-1)[0]`);
    (visDown === false && boxTop < 0)
      ? ok(`取景框离开可视区后自己藏了（top=${boxTop}，不会盖在会话上）`)
      : (async () => {
          const st = await cdp.eval(`window.__liveState && window.__liveState()`);
          const all = await cdp.eval(`(window.__fakeCam.vis || []).slice(-6)`);
          bad('取景框离开视野后还留着', JSON.stringify({ vis: visDown, boxTop, st, all }));
        })();
    await cdp.eval(`document.getElementById('livebar').style.transform = ''`);
    await sleep(900);
    const visUp = await cdp.eval(`(window.__fakeCam.vis || []).slice(-1)[0]`);
    visUp === true ? ok('滚回直播框，取景层又画上了') : bad('滚回来没恢复取景层', 'last=' + JSON.stringify(visUp));
    await cdp.eval(`document.getElementById('lb-stop').click()`);
    await sleep(600);
    const visAfterStop = await cdp.eval(`window.__fakeCam.stops`);
    visAfterStop > 0 ? ok('停止直播一定收掉取景层（不留残影）') : bad('停止后没有收取景层');

    // 停播后会写一条小结进会话（不花模型调用），让人回头知道这一场看了多少
    await sleep(900);
    const stSum = await (await api('/api/state')).json();
    const sumLine = (stSum.messages || []).filter((m) => /直播结束/.test(String(m.text || ''))).slice(-1)[0];
    sumLine ? ok('停播后留了一条小结：' + String(sumLine.text).slice(0, 40)) : bad('停播后没有小结');
    await cdp.eval(`localStorage.removeItem('dsh.liveOverlay'); localStorage.removeItem('dsh.liveSrc')`);
  }

  console.log('\n[5e] 抓帧卡死能自己发现并重开');
  {
    // 先确保不在直播：看门狗只有在跑的时候才动手
    try { await cdp.eval(`document.getElementById('lb-stop').click()`); } catch (_) {}
    await sleep(700);
    const idle = await cdp.eval(`window.__liveStallCheck(Date.now() + 600000)`);
    idle === 'idle' ? ok('没在直播时看门狗不动手') : bad('没直播还动手了', String(idle));
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(1500);
    const stopsBefore = await cdp.eval(`window.__fakeCam.stops`);
    const first = await cdp.eval(`window.__liveStallCheck(Date.now() + 600000)`);
    first === 'restart' ? ok('卡住 10 分钟没帧 → 第一次自己重开') : bad('看门狗没重开', String(first));
    await sleep(800);
    const stopsAfter = await cdp.eval(`window.__fakeCam.stops`);
    stopsAfter > stopsBefore ? ok('重开时把原生预览也收了一次（相机不会挂着）') : bad('重开没收预览', stopsBefore + ' → ' + stopsAfter);
    const second = await cdp.eval(`window.__liveStallCheck(Date.now() + 600000)`);
    second === 'degrade' ? ok('短时间内又卡一次就换下一条路（不原地打转）') : bad('第二次没换路', String(second));
    await sleep(600);
    try { await cdp.eval(`document.getElementById('lb-stop').click()`); } catch (_) {}
    await sleep(500);
  }
  console.log('\n[8] 翻转镜头：徽标跟着变');
  {
    await cdp.eval(`document.getElementById('btn-cam').click()`);
    await sleep(500);
    const b1 = await cdp.eval(`document.getElementById('cam-badge').textContent`);
    await cdp.eval(`document.getElementById('cam-flip').click()`);
    await sleep(400);
    const b2 = await cdp.eval(`document.getElementById('cam-badge').textContent`);
    await cdp.eval(`document.getElementById('cam-flip').click()`);
    await sleep(400);
    const b3 = await cdp.eval(`document.getElementById('cam-badge').textContent`);
    (b1 !== b2 && b2 !== b3) ? ok('翻转后朝向文案跟着变：' + b1 + ' → ' + b2 + ' → ' + b3)
      : bad('翻转后朝向文案没变', [b1, b2, b3].join(' / '));
    await shot('08-camera-front');
    await cdp.eval(`document.getElementById('cam-close').click()`);
    await sleep(400);
  }

  console.log('\n[9] 相机不出画面时，面板要说人话');
  {
    await cdp.eval(`(() => { window.DSHCam.grab = () => { window.__camFail('测试：镜头被别的应用占着'); }; window.__said = []; try { const s0 = document.getElementById('lb-status'); new MutationObserver(() => window.__said.push(s0.textContent)).observe(s0, { childList: true, subtree: true, characterData: true }); } catch (_) {} window.DSHCam.startPreview = () => {}; window.DSHCam.grab = () => { window.__camFail('测试：镜头被别的应用占着'); }; })()`);
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(1800);
    await cdp.eval(`document.getElementById('lb-ask').click()`);
    await sleep(2500);
    const said = await cdp.eval(`((document.getElementById('lb-status') || {}).textContent || '') + ' | ' + ((window.__said || []).join(' | '))`);
    /没拍到|没画面|没取到|取帧失败|被别的应用|占着/.test(said)
      ? ok('相机不给画面时写明了原因：' + said.slice(0, 60))
      : bad('相机失败时状态行没给出可读原因', said.slice(0, 120));
    await shot('09-live-fail');
    await cdp.eval(`document.getElementById('lb-stop').click()`);
    await sleep(600);
  }

  console.log('\n[9b] 一条路连着失败两次，要自己换下一条（不用人力猜）');
  {
    // 间隔拉到 5 秒（下拉里没有 5 秒这档，先补一个 option 再选），让两次失败落在能等到的范围里
    await cdp.eval(`(() => {
      const s = document.getElementById('lb-cad');
      let o = s.querySelector('option[value="5000"]');
      if (!o) { o = document.createElement('option'); o.value = '5000'; o.textContent = '5 秒'; s.appendChild(o); }
      s.value = '5000';
      s.dispatchEvent(new Event('change'));
    })()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('lb-ask').click()`);   // 第 2 次失败 → 触发换路
    // 原生那条路最长会等 8 秒才判失败，等死数只 7.6 秒会误判成「没换路」，改成轮询到出结果
    let said2 = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      said2 = await cdp.eval(`(document.getElementById('lb-status') || {}).textContent || ''`);
      if (/换成|换到|三条路都拿不到|一秒一张/.test(said2)) break;
    }
    /换成|换到|三条路都拿不到|一秒一张/.test(said2)
      ? ok('第二次失败后自己换路了：' + said2.slice(0, 60))
      : bad('连败两次没有换路，还停在原地', said2.slice(0, 120));

    // 三条路全灭要给出能照着做的卡片，而不是留一行状态字
    let coach = { shown: false, title: '', body: '' };
    for (let i = 0; i < 40; i += 1) {
      coach = await cdp.eval(`(() => {
        const c = document.getElementById('lb-coach');
        return { shown: !!(c && c.classList.contains('show')), title: (document.getElementById('lb-coach-t') || {}).textContent || '', body: (document.getElementById('lb-coach-b') || {}).textContent || '' };
      })()`);
      if (coach.shown && coach.title) break;
      await sleep(500);
    }
    coach.shown && coach.title && coach.body
      ? ok('全灭时弹了处理卡片：' + coach.title)
      : bad('全灭时没有处理卡片', JSON.stringify(coach).slice(0, 120));

    // 卡片上还要留一条「已经好用的那条路」：系统相机拍一张，直接进会话
    const snapBtn = await cdp.eval(`(() => { const s = document.getElementById('lb-coach-snap'); return s ? { shown: s.style.display !== 'none', label: s.textContent || '', bound: s.onclick !== null } : null; })()`);
    snapBtn && snapBtn.shown && /拍一张/.test(snapBtn.label) && snapBtn.bound
      ? ok('全灭时给了兜底：' + snapBtn.label.trim() + '（走系统相机那条已经好用的路）')
      : bad('全灭时没有「拍一张」兜底', JSON.stringify(snapBtn));

    // 卡片上的「再试一次」要真的再发起一次开播（这台假设备没有相机，所以必然再次全灭）
    const before = await cdp.eval(`window.__liveAttempts || 0`);
    await cdp.eval(`document.getElementById('lb-coach-retry').click()`);
    let again = { attempts: before, coach: true };
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      again = await cdp.eval(`({ attempts: window.__liveAttempts || 0, coach: document.getElementById('lb-coach').classList.contains('show') })`);
      if (again.attempts > before) break;
    }
    again.attempts > before
      ? ok('点「再试一次」真的又开播了一次（第 ' + again.attempts + ' 次）')
      : bad('「再试一次」没生效', JSON.stringify(again));
    await cdp.eval(`document.getElementById('lb-stop').click()`);
    await sleep(400);
  }

  console.log('\n[10] 没有原生桥、浏览器又不给权限时，别静默失败');
  {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try { delete window.DSHCam; } catch (_) {}
        try {
          Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
          });
        } catch (_) {}
      })();`,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${encodeURIComponent(T)}` });
    await sleep(2600);
    await cdp.eval(`document.getElementById('btn-cam').click()`);
    await sleep(1500);
    const why = await cdp.eval(`(document.getElementById('cam-status') || {}).textContent || ''`);
    /权限|拒绝|摄像头|https|apk/i.test(why)
      ? ok('浏览器不给权限时说清了原因：' + why.trim().slice(0, 60))
      : bad('浏览器不给权限时没有可读提示', JSON.stringify(why));
    const alive = await cdp.eval(`({ sheet: !!document.querySelector('#cam.show'), errs: window.__errs.slice(0, 5) })`);
    alive.sheet ? ok('面板照样打开，不是一片死白') : bad('面板没打开');
    (alive.errs || []).length === 0 ? ok('这条路径也没抛未捕获错误') : bad('兜底路径抛错了', JSON.stringify(alive.errs));
    await shot('10-no-camera');
  }

  // 收尾：直播的提示在会话里只留一行小字（不刷整段提示词）
  const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state?t=${encodeURIComponent(T)}`)).json();
  const liveRows = (st.messages || []).filter((m) => m.kind === 'live' || /直播 · 第/.test(m.display || ''));
  const chips = await cdp.eval(`(() => {
    const els = [...document.querySelectorAll('.row.live-eye')];
    return { n: els.length, last: els.length ? els[els.length - 1].textContent.trim() : '' };
  })()`);
  if (liveRows.length > 0) {
    const sample = (liveRows[liveRows.length - 1].display || liveRows[liveRows.length - 1].text || '').slice(0, 24);
    ok('会话里留了 ' + liveRows.length + ' 行直播小字（最近一条：' + sample + (chips.n ? ' · 页面上 ' + chips.n + ' 行' : '') + '）');
  } else {
    bad('对话里没有「直播 · 第 N 眼」小字', JSON.stringify({ server: liveRows.length, dom: chips }));
  }
  await shot('07-chat-chips');

  console.log('\n[11] 在 App 里用 http 地址打开时，直接把人请到 https 入口');
  {
    await cdp.send('Network.enable');
    // [10] 注入过「删掉 DSHCam」的脚本，它会一直生效；这里再注入一次把假桥补回来
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.DSHCam = {
          available: () => true,
          grab: () => {},
          snap: () => {},
          startPreview: () => {},
          stopPreview: () => {},
          liveOn: () => true,
          version: () => 'cam2/test',
        setUpload: (u) => { window.__fakeCam.upload = u || ''; },
        pushLast: async () => {
          const u = window.__fakeCam.upload;
          if (!u) return false;
          const bin = atob(window.__fakeCam.b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
          const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: arr });
          return r.ok;
        },
          busy: () => false,
          entry: () => 'https://dsh.example.com/dsh',
        };
      })();`,
    });
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; DSHPhone) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 DSHPhone/1.0',
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${encodeURIComponent(T)}` });
    await sleep(3000);
    await cdp.eval(`document.getElementById('lb-live') ? document.getElementById('lb-live').click() : document.getElementById('cam-live').click()`);
    let card = { shown: false, title: '', go: '' };
    for (let i = 0; i < 30; i += 1) {
      await sleep(400);
      card = await cdp.eval(`(() => {
        const c = document.getElementById('lb-coach');
        const go = document.getElementById('lb-coach-go');
        return { shown: !!(c && c.classList.contains('show')), title: (document.getElementById('lb-coach-t') || {}).textContent || '', go: go && go.style.display !== 'none' ? (go.textContent || '') : '' };
      })()`);
      if (card.shown && card.go) break;
    }
    /拿不到摄像头/.test(card.title) && /https/i.test(card.go)
      ? ok('App 里用 http 打开时给了 https 入口：' + card.title + ' / ' + card.go)
      : bad('没把 http 拿不到摄像头这件事说清楚', JSON.stringify(card));
    const rebuilt = await cdp.eval(`(() => { const go = document.getElementById('lb-coach-go'); return go ? go.onclick !== null : false; })()`);
    rebuilt ? ok('那个按钮真的绑了跳转') : bad('https 按钮没绑点击');
    // App 里默认先走「页面里画帧」：没有原生 View 要摆位，坐标不会错、帧也一定出得来
    await cdp.eval(`try { localStorage.removeItem('dsh.liveSrc'); localStorage.removeItem('dsh.liveOverlay'); } catch (_) {}`);   // 别把 [7b] 的强制路径带进来
  const ordApk = await cdp.eval(`window.__liveOrder && window.__liveOrder()`);
    JSON.stringify(ordApk) === JSON.stringify(['browser', 'poll', 'native'])
      ? ok('App 里的优先顺序是 浏览器流 → 原生逐帧 → 原生取景层')
      : bad('App 里的优先顺序不对', JSON.stringify(ordApk));
    await cdp.eval(`document.getElementById('lb-stop') && document.getElementById('lb-stop').click()`);
    await sleep(300);
    await cdp.send('Network.setUserAgentOverride', { userAgent: '' });
  }

  console.log('\n[13] 画面可以先收起，专心看回复');
  {
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(2200);
    const h1 = await cdp.eval(`Math.round(document.getElementById('lb-box').getBoundingClientRect().height)`);
    await cdp.eval(`document.getElementById('lb-mini').click()`);
    await sleep(600);
    const h2 = await cdp.eval(`Math.round(document.getElementById('lb-box').getBoundingClientRect().height)`);
    const label = await cdp.eval(`document.getElementById('lb-mini').textContent`);
    (h1 > 80 && h2 === 0) ? ok('收起后画面藏起来（' + h1 + ' → 0）') : bad('收起没生效', JSON.stringify({ h1, h2 }));
    String(label).indexOf('△') >= 0 ? ok('按钮变成「展开」') : bad('按钮没变', String(label));
    await cdp.eval(`document.getElementById('lb-mini').click()`);
    await sleep(600);
    const h3 = await cdp.eval(`Math.round(document.getElementById('lb-box').getBoundingClientRect().height)`);
    h3 > 80 ? ok('再点一下又展开（' + h3 + '）') : bad('展开没恢复', String(h3));
    await cdp.eval(`document.getElementById('lb-stop') && document.getElementById('lb-stop').click()`);
    await sleep(400);
  }

  console.log('\n[14] 发出去的那一帧留了张凭据（画面右上角的缩略图）');
  {
    const r = await cdp.eval(`(() => {
      const b = new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
      window.__showSeen(b);
      const el = document.getElementById('lb-seen');
      return { on: el.classList.contains('on'), src: (el.querySelector('img') || {}).src || '' };
    })()`);
    (r && r.on && String(r.src).indexOf('blob:') === 0)
      ? ok('缩略图出现了（就是刚发出去的那一帧）')
      : bad('缩略图没出现', JSON.stringify(r));
    await cdp.eval(`(() => { const i = document.querySelector('#lb-seen img'); if (i) i.click(); return 1; })()`);
    await sleep(400);
    const on = await cdp.eval(`document.getElementById('photoview').classList.contains('on')`);
    on ? ok('点缩略图能看全') : bad('点缩略图没打开大图');
    await cdp.eval(`document.getElementById('pv-close').click()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('lb-stop') && document.getElementById('lb-stop').click()`);
    await sleep(500);
    const cleared = await cdp.eval(`!document.getElementById('lb-seen').classList.contains('on')`);
    cleared ? ok('停播后缩略图收掉（不留旧画面）') : bad('停播后缩略图还挂着');
  }

  console.log('\n[15] 角标说实话：先「已送到」，他答上话了才「他看到了」');
  {
    const r1 = await cdp.eval(`(() => {
      const b = new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
      window.__showSeen(b);
      return (document.getElementById('lb-seen') || {}).dataset ? document.getElementById('lb-seen').dataset.s : '';
    })()`);
    r1 === '已送到' ? ok('刚发出去的时候写的是「已送到」') : bad('角标一开始就不对', JSON.stringify(r1));

    const r2 = await cdp.eval(`(() => { window.__markSeenViewed(); return document.getElementById('lb-seen').dataset.s; })()`);
    r2 === '他看到了' ? ok('他答上话之后角标变「他看到了」') : bad('回复来了角标没变', JSON.stringify(r2));

    // 两分钟以前的旧帧不许冒充「刚看到的」
    const r3 = await cdp.eval(`(() => {
      window.__shotAt = Date.now() - 200000;
      document.getElementById('lb-seen').dataset.s = '已送到';
      window.__markSeenViewed();
      return document.getElementById('lb-seen').dataset.s;
    })()`);
    r3 === '已送到' ? ok('两分钟前的旧帧不会被标成「他看到了」') : bad('旧帧被当成了刚看到的', JSON.stringify(r3));
  }

  console.log('\n[12] 会话里的照片点开能看全');
  {
    const hasShot = await cdp.eval(`!!document.querySelector('.row.me .shot img')`);
    if (!hasShot) bad('会话里没有可点的照片');
    else {
      await cdp.eval(`(() => { const i = document.querySelector('.row.me .shot img'); i.click(); return 1; })()`);
      await sleep(500);
      const on = await cdp.eval(`document.getElementById('photoview').classList.contains('on')`);
      on ? ok('点照片能全屏看') : bad('点照片没打开大图');
      await cdp.eval(`document.getElementById('pv-close').click()`);
      await sleep(300);
      const off = await cdp.eval(`!document.getElementById('photoview').classList.contains('on')`);
      off ? ok('关得掉（不留遮罩）') : bad('大图关不掉');
    }
  }

  console.log('\n[16] 切后台只暂停，回来接着看（不该把整场直播结束掉）');
  {
    await cdp.eval(`document.getElementById('lb-stop') && document.getElementById('lb-stop').click()`);
    await sleep(500);
    /* [9] 那一段把假桥的 grab 弄坏了，这里先把一条能出帧的路修回来，
       否则「回来接着看」根本无从谈起 */
    await cdp.eval(`(() => { window.DSHCam.grab = () => { window.__fakeCam.grabbed = (window.__fakeCam.grabbed || 0) + 1; setTimeout(() => { try { window.__camFrame(B64, 1280, 720, 'grab'); } catch (_) {} }, 80); }; return 1; })()`);
    await cdp.eval(`document.getElementById('cam-live').click()`);
    await sleep(3000);
    const s1 = await cdp.eval(`window.__liveState()`);
    (s1 && s1.running) ? ok('开播了') : bad('开不起来', JSON.stringify(s1));

    await cdp.eval(`(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
    await sleep(900);
    const s2 = await cdp.eval(`window.__liveState()`);
    const t2 = await cdp.eval(`(document.getElementById('lb-status') || {}).textContent || ''`);
    (s2 && s2.running) ? ok('切后台之后直播还在（只是暂停）') : bad('切后台就把直播停了', JSON.stringify(s2));
    /后台/.test(t2) ? ok('状态行说明了在后台：' + t2.slice(0, 30)) : bad('切后台没有说明', t2.slice(0, 60));
    (s2 && s2.overlayTick === false && s2.nativePreview === false)
      ? ok('取景层跟着收掉了（不会在兜里一直开相机）') : bad('切后台取景层还开着', JSON.stringify(s2));

    await cdp.eval(`(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
    await sleep(2500);
    const s3 = await cdp.eval(`window.__liveState()`);
    const t3 = await cdp.eval(`(document.getElementById('lb-status') || {}).textContent || ''`);
    (s3 && s3.running) ? ok('回来之后还在看') : bad('回来之后不看了', JSON.stringify(s3));
    /* 定时器按间隔排，等不到就手动来一眼：这一下走的是同一条链路，
       能到就说明回来之后这条链还是活的 */
    await cdp.eval(`document.getElementById('lb-ask') && document.getElementById('lb-ask').click()`);
    await sleep(2500);
    const s4 = await cdp.eval(`window.__liveState()`);
    (s4 && s4.k > (s3.k || 0)) ? ok(`回来之后还能接着取帧（次 ${s3.k} → ${s4.k}）`) : bad('回来之后就取不了帧了', JSON.stringify({ s3k: s3 && s3.k, s4k: s4 && s4.k }));
    /回来|再看/.test(t3) ? ok('状态行给出回来的反馈') : bad('回来没有反馈', t3.slice(0, 60));
    await cdp.eval(`document.getElementById('lb-stop') && document.getElementById('lb-stop').click()`);
    await sleep(500);
  }

  /* [17] 拦下全黑帧要留个数字：手机报一声 → /api/camera/blank 记账 →
     诊断面板那一行能读出来。没有这一条，「怎么是黑的」只能靠人复述。
     页面上的 token 存在 localStorage 里（URL 上那个只用来做首次引导），
     所以这里走 API 记账 + 检查页面确实挂出了上报入口，两件事分别验。 */
  {
    /* api() 返回的是 Response，要用 .json() 才是数据 */
    const before = await (await api('/api/camera/state')).json();
    const n0 = Number(before && before.blank && before.blank.n) || 0;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/camera/blank?t=${encodeURIComponent(T)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ why: 'test-all-black' }),
    });
    const j = await r.json().catch(() => ({}));
    const n1 = Number(j && j.n) || 0;
    (r.status === 200 && n1 === n0 + 1) ? ok(`全黑帧有记账（${n0} → ${n1}）`) : bad('拦下全黑帧没有记账', JSON.stringify({ status: r.status, n0, n1, j, state: before && before.blank }));

    const dg = await (await api('/api/diag')).json();
    const n2 = Number(dg && dg.camera && dg.camera.blank && dg.camera.blank.n) || 0;
    typeof (dg && dg.camera && dg.camera.blank && dg.camera.blank.n) === 'number' && n2 >= n1
      ? ok(`诊断接口带上了全黑帧数（${n2}）`)
      : bad('诊断接口没有全黑帧数', JSON.stringify({ n2, n1, cam: dg && dg.camera }));

    const hook = await cdp.eval("typeof window.__tellBlank === 'function'");
    hook ? ok('页面挂出了上报入口（全黑帧会自己报给电脑）') : bad('页面没有上报全黑帧的入口');
  }

  // [18] 自检结论卡：把三条路的结果翻译成一句人能做的话
  {
    const has = await cdp.eval("typeof window.__verdictOf === 'function'");
    has ? ok('页面挂出了结论推导（__verdictOf）') : bad('页面没有结论推导');

    const cases = await cdp.eval(`(() => {
      const f = window.__verdictOf;
      if (!f) return null;
      const okStep = [{ n: '浏览器', ok: true, ms: 900 }];
      const deadStep = [{ n: '浏览器', ok: false, why: 'NotAllowedError' }];
      return {
        insecure: f(okStep, { secure: false, perm: 'granted' }, 'x', { w: 1, h: 1, kb: 1 }),
        fine: f(okStep, { secure: true, perm: 'granted', build: 'cam2/1.9.6' }, 'x', { w: 640, h: 480, kb: 9 }),
        black: f(okStep, { secure: true, perm: 'granted', build: 'cam2/1.9.6' }, '', { w: 0, h: 0, kb: 0 }),
        denied: f(deadStep, { secure: true, perm: 'denied', build: 'cam2/1.9.6' }, '', { w: 0, h: 0, kb: 0 }),
      };
    })()`);

    cases && cases.insecure && cases.insecure.level === 'bad' && /地址/.test(cases.insecure.title)
      ? ok('http 地址 → 结论直说「这个地址打不开摄像头」')
      : bad('http 地址的结论不对', JSON.stringify(cases && cases.insecure));
    cases && cases.fine && cases.fine.level === 'ok' && /相机正常/.test(cases.fine.title)
      ? ok('能出画面 → 结论「相机正常，画面能出来」')
      : bad('能出画面的结论不对', JSON.stringify(cases && cases.fine));
    cases && cases.black && cases.black.level === 'warn' && /黑/.test(cases.black.title)
      ? ok('开着但没画面 → 结论「这一帧是黑的」')
      : bad('黑帧的结论不对', JSON.stringify(cases && cases.black));
    cases && cases.denied && cases.denied.level === 'bad' && /权限/.test(cases.denied.title)
      ? ok('权限被拒 → 结论「相机权限被挡了」')
      : bad('权限被拒的结论不对', JSON.stringify(cases && cases.denied));

    // 真点一次「测一下现在的画面」，卡片要真的出现在设置面板里
    await cdp.eval("window.__openLiveCfg && window.__openLiveCfg()");
    await sleep(600);
    await cdp.eval("document.getElementById('cfg-test').click()");
    await sleep(6500);
    const card = await cdp.eval(`(() => { const e = document.getElementById('cfg-verdict');
      return e ? { cls: e.className, h: Math.round(e.getBoundingClientRect().height), t: e.innerText.slice(0, 40), go: !!document.getElementById('cfg-verdict-go') } : null; })()`);
    card && /verdict on/.test(card.cls) && card.h > 20
      ? ok('点一下就把结论卡摆出来了（高 ' + card.h + 'px：' + card.t.replace(/\s+/g, ' ').slice(0, 18) + '…）')
      : bad('结论卡没有出现在面板里', JSON.stringify(card));
    card && card.go ? ok('结论卡上的「下一步」是能点的按钮') : bad('结论卡上的下一步不能点');
    await cdp.eval("document.getElementById('livecfg-close').click()");
    await sleep(300);
  }

  // [19] 浅色主题：白底上不能冒出白字（结论卡 / 面板标题）
  await cdp.eval("localStorage.setItem('dsh.theme','light'); document.body.classList.add('light')");
  await cdp.eval("window.__openLiveCfg && window.__openLiveCfg()");
  await sleep(600);
  await cdp.eval("document.getElementById('cfg-test').click()");
  await sleep(6500);
  const light = await cdp.eval(`(() => {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const rgb = (c) => (String(c).match(/[\\d.]+/g) || []).map(Number);
    const e = document.getElementById('cfg-verdict');
    if (!e) return null;
    const t = e.querySelector('b');
    const cs = getComputedStyle(e);
    const m = rgb(cs.backgroundColor);
    const a = m.length > 3 ? m[3] : 1;
    // 卡片底色是半透明的，实际看到的颜色要跟白面板叠一次
    const over = [0, 1, 2].map((i) => (m[i] == null ? 255 : m[i] * a + 255 * (1 - a)));
    const L2 = lum(over[0], over[1], over[2]);
    const fm = rgb(t ? getComputedStyle(t).color : 'rgb(0,0,0)');
    const L1 = lum(fm[0], fm[1], fm[2]);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const title = document.querySelector('#livecfg .camtitle');
    const tm = rgb(title ? getComputedStyle(title).color : 'rgb(0,0,0)');
    return { ratio: Math.round(ratio * 100) / 100, fg: t ? getComputedStyle(t).color : null,
             bg: cs.backgroundColor, h: Math.round(e.getBoundingClientRect().height),
             titleDark: tm[0] < 110 && tm[1] < 110, light: document.body.classList.contains('light') };
  })()`);
  light && light.light && light.ratio >= 4.5
    ? ok('浅色主题下结论卡看得清（对比度 ' + light.ratio + ':1）')
    : bad('浅色主题下结论卡看不清', JSON.stringify(light));
  light && light.titleDark ? ok('浅色主题下面板标题是深色字') : bad('浅色主题下面板标题还是浅色', JSON.stringify(light && light.fg));
  await cdp.eval("document.getElementById('livecfg-close').click(); document.body.classList.remove('light'); localStorage.removeItem('dsh.theme')");
  await sleep(300);

  const errs = await cdp.eval(`window.__errs.slice(0, 10)`);
  if (REAL_ERRS(errs).length) bad('全程页面报错', JSON.stringify(REAL_ERRS(errs))); else ok('全程 0 个 JS 错误');

  console.log('\n===== 结果 =====');
  console.log(`通过 ${oks.length} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  console.log(fails.length ? '\nFAILED' : '\nPASS');

  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
