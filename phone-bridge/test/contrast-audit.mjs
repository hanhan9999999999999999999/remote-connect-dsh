// 浅色主题全表扫描：把每个可见文字节点跟它的实际底色算对比度，低于 4.5:1 的列出来
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(ROOT + '/runtime/state.json', 'utf8')).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const port = 9887;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'contrast-'));
const ch = spawn(exe, ['--headless=new', '--no-first-run', '--user-data-dir=' + prof, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 50; i += 1) { await sleep(400); try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = l.find((x) => x.type === 'page'); if (target) break; } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const waiters = new Map();
await new Promise((r) => { ws.onopen = r; ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiters.has(d.id)) { const w = waiters.get(d.id); waiters.delete(d.id); w(d); } }; });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return 'EXC ' + String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200);
  return r.result.result.value;
};

const SCAN = `(() => {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const parse = (s) => {
    const m = String(s).match(/[\\d.]+/g);
    if (!m) return null;
    return { c: m.slice(0, 3).map(Number), a: m.length > 3 ? Number(m[3]) : 1 };
  };
  // 沿祖先链把半透明底色一层层叠到白纸上
  const bgOf = (el) => {
    const stack = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (p && p.a > 0) { stack.push(p); if (p.a >= 0.999) break; }
      n = n.parentElement;
    }
    let c = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const { c: cc, a } = stack[i];
      c = [0, 1, 2].map((k) => cc[k] * a + c[k] * (1 - a));
    }
    return c;
  };
  const out = [];
  let skipped = 0;
  const walk = document.querySelectorAll('body *');
  for (const el of walk) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    // 只看直接含文字的节点
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    // 渐变底算不出「那一个颜色」，带 emoji 的字也不吃 color —— 都跳过，别报假红
    // 只看文字自己那一层和再往上一层：整页背景也有渐变，不能一路往上找，否则全被跳过
    let grad = false;
    let n2 = el;
    for (let d = 0; n2 && d < 2; d += 1, n2 = n2.parentElement) {
      if (String(getComputedStyle(n2).backgroundImage || '').includes('gradient')) { grad = true; break; }
    }
    if (grad) { skipped += 1; continue; }
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(el.textContent)) { skipped += 1; continue; }
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg.c), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize) || 14;
    const bold = Number(cs.fontWeight) >= 600;
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need) {
      out.push({ sel: (el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase()),
        text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 34), ratio: Math.round(ratio * 100) / 100,
        need, fg: cs.color, bg: 'rgb(' + bg.map((v) => Math.round(v)).join(',') + ')', size });
    }
  }
  return { items: out.slice(0, 40), skipped };
})()`;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('dsh.theme', 'light'); } catch (e) {}
window.DSHCam = { available: () => true, grab: () => { window.__camFail && window.__camFail('NotAllowedError'); }, snap: () => {},
  startPreview: () => {}, stopPreview: () => {}, setPreviewVisible: () => {}, liveOn: () => true,
  version: () => 'cam2/1.9.6', busy: () => false, entry: () => 'https://dsh.example.com/dsh',
  setUpload: () => {}, pushLast: () => true, permState: () => 'denied', openSettings: () => {} };` });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `http://127.0.0.1:8899/?t=${encodeURIComponent(T)}` });
await sleep(4200);

const report = {};
report.main = await ev(SCAN);

await ev(`document.getElementById('btn-cfg') && document.getElementById('btn-cfg').click()`);
await sleep(900);
report.settings = await ev(SCAN);

await ev(`window.__openLiveCfg && window.__openLiveCfg()`);
await sleep(700);
await ev(`document.getElementById('cfg-test').click()`);
await sleep(6000);
report.livecfg = await ev(SCAN);

await ev(`document.getElementById('livecfg-close').click()`);
await sleep(300);
await ev(`document.getElementById('open-diag') && document.getElementById('open-diag').click()`);
await sleep(1200);
report.diag = await ev(SCAN);

for (const [k, v] of Object.entries(report)) {
  if (typeof v === 'string') { console.log(k + ': ' + v); continue; }
  console.log(`\n== ${k}（${v.items.length} 处看不清，跳过 ${v.skipped} 个渐变底/emoji）==`);
  v.items.forEach((x) => console.log(`  ${x.ratio}:1 (要 ${x.need}) ${x.sel} 「${x.text}」 ${x.fg} on ${x.bg} ${x.size}px`));
}

const img = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(ROOT + '/test/out/28-light-diag.png', Buffer.from(img.result.data, 'base64'));
try { ch.kill(); } catch {}
process.exit(0);
