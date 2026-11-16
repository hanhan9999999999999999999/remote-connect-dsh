// 真机之外最接近真实的一条验证：用浏览器自己的摄像头通路（getUserMedia → canvas → JPEG）。
//
// camtest.mjs 注入的是一个「假原生桥」，测的是原生兜底与 UI；这个脚本装的是**浏览器假摄像头**
// （Chrome 的 --use-fake-device-for-media-stream，会生成一段动的测试图案），
// 走的是手机在 https 下真正会走的那条路：没有 DSHCam，全靠 getUserMedia + canvas。
//
// 用法: node test/realcam.mjs [--shots] [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PHONE_BRIDGE_PORT || 8899);
const DBG = Number(process.env.CAM_DEBUG_PORT || 9412);
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'test', 'out');

const fails = [];
const oks = [];
function ok(msg) { oks.push(msg); console.log('  ✓ ' + msg); }
function bad(msg, extra) { fails.push(msg + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + msg + (extra ? ' → ' + extra : '')); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'state.json'), 'utf8')).token;
const api = (p, opt) => fetch(`http://127.0.0.1:${PORT}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(T)}`, opt);

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.wait = new Map(); }
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
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.log('没有找到 Edge/Chrome'); return; }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshreal-'));
  const child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    // 这两个是 Chrome 自己的「假摄像头」：不接设备也能出实时画面（会动的测试图案）
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = []; addEventListener('error', (e) => __errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason && e.reason.message || e.reason)));`,
  });

  const shot = async (name) => {
    if (!SHOTS) return;
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('    📷 ' + name + '.png');
  };

  console.log('\n[1] 打开页面（不带假原生桥，走浏览器真通路）');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${encodeURIComponent(T)}` });
  for (let i = 0; i < 40; i++) { await sleep(300); if (await cdp.eval('!!window.__bus').catch(() => false)) break; }
  const hasNative = await cdp.eval('!!(window.DSHCam && window.DSHCam.available && window.DSHCam.available())');
  if (!hasNative) ok('页面里没有原生桥（测的确实是 getUserMedia 那条路）'); else bad('居然有原生桥，测的不是浏览器路');
  const hasGum = await cdp.eval('!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)');
  if (hasGum) ok('浏览器给了 getUserMedia'); else bad('没有 getUserMedia');

  // 先把上一轮可能残留的直播关掉，重置计数基线
  await cdp.eval(`(async () => { try { await window.__liveStop(); } catch (_) {} await new Promise(r => setTimeout(r, 400)); })()`);
  const before = await (await api('/api/camera/state')).json();
  const pushesBefore = Number(before.totalPushes || 0);
  const photosBefore = await cdp.eval(`document.querySelectorAll('.row.me .shot img').length`);

  console.log('\n[2] 点「直播」→ 浏览器流起来');
  await cdp.eval(`document.getElementById('cam-live').click()`);
  await sleep(1500);
  const modeOn = await cdp.eval(`document.body.classList.contains('live-mode')`);
  modeOn ? ok('直播条出来了（body.live-mode）') : bad('直播没起来');
  await shot('r1-live-start');

  let vw = 0;
  for (let i = 0; i < 30; i++) {
    vw = await cdp.eval(`(() => { const v = document.getElementById('lb-video'); return v ? v.videoWidth : 0; })()`);
    if (vw > 0) break;
    await sleep(300);
  }
  if (vw > 0) ok(`video 出画了：宽 ${vw}`); else bad('video 一直是 0 宽（画面没出来）');

  const tag = await cdp.eval(`(document.getElementById('lb-status') || {}).textContent || ''`);
  if (/浏览器直取/.test(tag)) ok('状态行写的是「浏览器直取」'); else bad('状态行没写浏览器直取', tag);

  console.log('\n[3] 看服务端到底收到了什么');
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await (await api('/api/camera/state')).json();
    if (Number(st.totalPushes || 0) > pushesBefore) break;
    await sleep(500);
  }
  const got = Number(st.totalPushes || 0) - pushesBefore;
  if (got > 0) ok(`服务端收到 ${got} 帧`); else bad('服务端一帧都没收到');

  if (st && st.frames > 0) {
    const latest = await (await api('/api/camera/latest?n=2&timeout=3000')).json();
    const fr = latest.frames || [];
    if (fr.length >= 1) {
      const f = fr[fr.length - 1];
      const bytes = Math.round((f.b64 || '').length * 0.75);
      if (bytes > 8000) ok(`这一帧是 ${f.w}×${f.h} · ${Math.round(bytes / 1024)}KB 的真 JPEG`); else bad('帧太小，可能是空图', bytes + 'B');
      if ((f.w || 0) >= 640) ok(`宽度 ${f.w} 达到可用清晰度`); else bad('宽度不足 640', String(f.w));
      if (fr.length >= 2) ok('拿到了 ' + fr.length + ' 帧（Chrome 假摄像头是静态图案，两帧相同属正常）'); else bad('只拿到 ' + fr.length + ' 帧');
      if (f.mime === 'image/jpeg') ok('mime 是 image/jpeg'); else bad('mime 不对', f.mime);
    } else bad('取帧接口没给帧');
  } else bad('缓冲里没有帧');

  console.log('\n[4] 会话里应该出现「我」发的那一眼');
  let photos = 0;
  for (let i = 0; i < 30; i++) {
    photos = await cdp.eval(`document.querySelectorAll('.row.me .shot img').length`);
    if (photos > photosBefore) break;
    await sleep(500);
  }
  if (photos > photosBefore) ok(`会话里多了 ${photos - photosBefore} 张「我」发的照片`); else bad('会话里没出现照片');
  await shot('r2-live-with-photo');

  console.log('\n[5] 停止后要真的放开摄像头');
  await cdp.eval(`document.getElementById('lb-stop').click()`);
  await sleep(1200);
  const lives = await (await api('/api/camera/state')).json();
  const on = !!(lives.live && lives.live.on);
  if (!on) ok('服务端 live.on=false'); else bad('停了服务端还开着');
  const srcObj = await cdp.eval(`(() => { const v = document.getElementById('lb-video'); return v && v.srcObject ? 'still' : 'released'; })()`);
  if (srcObj === 'released') ok('浏览器这边的 video 也松手了（相机释放）'); else bad('video 还挂着流（相机没放开）');
  const modeOff = await cdp.eval(`document.body.classList.contains('live-mode')`);
  if (!modeOff) ok('直播条收起，不再盖住会话'); else bad('直播条还挂着');

  console.log('\n[6] 自检：三条路逐条报结果');
  await cdp.eval(`(document.getElementById('lb-cfg') || {}).click && document.getElementById('lb-cfg').click()`);
  await sleep(400);
  await cdp.eval(`document.getElementById('cfg-test').click()`);
  let probe = null;
  for (let i = 0; i < 30; i++) {
    await sleep(600);
    const st = await (await api('/api/camera/state')).json();
    probe = st.probe;
    if (probe && probe.steps && probe.steps.length) break;
  }
  if (probe && probe.steps && probe.steps.length >= 2) {
    const line = probe.steps.map((s) => `${s.n}${s.ok ? '✓' : '✗'}`).join(' · ');
    ok('自检把每条路都报了出来：' + line);
    const br = probe.steps.find((s) => s.n === '浏览器');
    if (br && br.ok) ok('浏览器那条路在自检里是通的（' + (br.why || '') + '）'); else bad('浏览器那条路自检没通', br && br.why);
    const nat = probe.steps.find((s) => s.n === '原生');
    if (nat && !nat.ok) ok('没有原生桥时如实报错：' + (nat.why || '')); else bad('没有原生桥却报成功');
  } else {
    bad('自检没有把分路结果送到服务端', JSON.stringify(probe));
  }
  await cdp.eval(`document.getElementById('livecfg-close').click()`);
  const errs = await cdp.eval(`window.__errs || []`);
  if (!errs.length) ok('全程 0 个 JS 错误'); else bad('页面报错：' + errs.join(' | '));

  console.log('\n===== 结果 =====');
  console.log(`通过 ${oks.length} 项，失败 ${fails.length} 项`);
  if (fails.length) { fails.forEach((f) => console.log('  ✗ ' + f)); console.log('FAILED'); }
  else console.log('PASS');

  if (!process.argv.includes('--keep')) { try { child.kill(); } catch {} }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('realcam error:', e); process.exit(2); });
