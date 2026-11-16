/* 直播抗折腾：相机时好时坏，页面不能卡死、不能静默停摆、坏完要能自己恢复。
   节奏用 10 秒（2 秒那一档会被「上一眼还在说」挡掉，测不到相机本身）。
   判定只看页面这一侧：还在跑 / 失败有记账 / 没卡在取帧 / 修好后接着看。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/state.json'), 'utf8')).token;
const B64 = fs.readFileSync(path.join(os.tmpdir(), 'b64.txt'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oks = [];
const fails = [];
const ok = (m) => { oks.push(m); console.log('  ✓ ' + m); };
const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9541;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-'));
const child = spawn(exe, ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(400);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((x) => x.type === 'page');
    if (target) break;
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); w(d); }
};
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (code) => {
  const r = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__camRate = 0.45;
window.__fakeCam = { grabbed: 0, failed: 0 };
window.DSHCam = {
  available: () => true,
  grab: () => {
    window.__fakeCam.grabbed++;
    if (Math.random() < window.__camRate) {
      window.__fakeCam.failed++;
      setTimeout(() => { try { window.__camFail('测试：这一帧没回来'); } catch (_) {} }, 60);
      return;
    }
    setTimeout(() => { try { window.__camFrame(${JSON.stringify(B64)}, 960, 1280, 'test'); } catch (_) {} }, 80);
  },
  snap: () => {}, startPreview: () => {}, stopPreview: () => {},
  setPreviewVisible: () => {}, liveOn: () => true, version: () => 'cam2/1.9.4',
  busy: () => false, entry: () => 'https://dsh.example.com/dsh',
  setUpload: () => {}, pushLast: () => true,
};`,
});
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `http://127.0.0.1:8899/?t=${encodeURIComponent(T)}` });

for (let i = 0; i < 25; i += 1) {
  await sleep(1000);
  if (await ev(`!!document.getElementById('livebar')`)) break;
}

console.log('\n[压测] 相机 45% 失败，10 秒一眼，跑 45 秒');
await ev(`document.getElementById('lb-cfg').click()`);
await sleep(500);
await ev(`(() => { const b = document.querySelector('#cfg-presets [data-cad="10"]'); if (b) b.click(); return 1; })()`);
await sleep(300);
await ev(`document.getElementById('livecfg-close').click()`);
await sleep(300);

await ev(`document.getElementById('cam-live').click()`);
const samples = [];
for (let i = 0; i < 9; i += 1) {
  await sleep(5000);
  samples.push(await ev(`window.__liveState()`));
}
const s1 = samples[samples.length - 1];
console.log('  末态 = ' + JSON.stringify(s1));
const everStuck = samples.some((s) => s && s.beating === true && s.running === false);
(samples.every((s) => s && s.running)) ? ok('相机一直失败也没停摆（全程 running）') : bad('跑着跑着自己停了', JSON.stringify(samples.map((s) => s && s.running)));
(s1 && s1.k >= 3) ? ok(`试了 ${s1.k} 下`) : bad('几乎没在取帧', JSON.stringify(s1));
(s1 && s1.fails >= 1) ? ok(`失败 ${s1.fails} 次都记了账`) : bad('失败没记账', JSON.stringify(s1));
everStuck ? bad('一边停播一边卡着取帧') : ok('没有卡在「正在取帧」');
const seenSample = samples.some((s) => s && s.eyes >= 1);
seenSample ? ok('折腾里也真的看成了几眼') : bad('一眼都没成');

console.log('\n[恢复] 相机修好，看它会不会自己接着看');
await ev(`window.__camRate = 0`);
const before = await ev(`window.__liveState()`);
await sleep(30000);
const s2 = await ev(`window.__liveState()`);
console.log('  恢复后 = ' + JSON.stringify(s2));
(s2 && s2.running) ? ok('修好之后还在跑') : bad('修好后反而不跑了', JSON.stringify(s2));
(s2 && (s2.eyes > (before.eyes || 0) || s2.k > (before.k || 0) + 1)) ? ok(`自己接着看了（眼 ${before.eyes} → ${s2.eyes}，次 ${before.k} → ${s2.k}）`) : bad('相机修好了也没接着看', JSON.stringify({ before, s2 }));

await ev(`document.getElementById('lb-stop').click()`);
await sleep(600);
(await ev(`window.__liveState().running === false`)) ? ok('停得掉，状态干净') : bad('停不下来');

const errs = await ev(`(window.__errs || []).slice(0, 10)`);
const real = (errs || []).filter((e) => !/Failed to fetch|signal timed out|The operation was aborted/.test(String(e)));
real.length ? bad('页面报错：' + JSON.stringify(real)) : ok('全程 0 个 JS 错误');

console.log('\n===== 结果 =====');
console.log(`通过 ${oks.length} 项，失败 ${fails.length} 项`);
fails.forEach((f) => console.log('  ✗ ' + f));
console.log(fails.length ? '\nFAILED' : '\nPASS');

child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fails.length ? 1 : 0);
