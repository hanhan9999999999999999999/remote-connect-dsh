// 验证：缓冲是旧的、但请求自己带着画面 → 不能再被 409 挡回去
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/state.json'), 'utf8')).token;
const BASE = 'http://127.0.0.1:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const img = fs.readFileSync(path.join(ROOT, 'test/out/probe-shot.jpg'));
const b64 = img.toString('base64');

const st = await (await fetch(`${BASE}/api/camera/state?t=${T}`)).json();
console.log('推送前 ageMs =', st.ageMs, '帧数 =', st.frames);
console.log('等 9 秒让缓冲变旧…');
await sleep(9000);

const r = await fetch(`${BASE}/api/live/comment?t=${T}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: b64, size: img.length, mime: 'image/jpeg' }),
});
const j = await r.json();
console.log('状态码 =', r.status, JSON.stringify(j));

if (r.status === 200 && j.ok) console.log('OK：缓冲旧 + 自带画面 → 照样收下');
else console.log('FAIL：还被挡回去了（reason=' + j.reason + '）');
