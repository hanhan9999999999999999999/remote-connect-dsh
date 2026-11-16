// 全链路自证：模拟手机这一眼走完「塞缓冲 → 上传 → 点评」，看模型是不是真的看见了
// 用法：node test/live-full.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/state.json'), 'utf8')).token;
const BASE = 'http://127.0.0.1:8899';
const IMG = path.join(ROOT, 'test/out/probe-shot.jpg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };

const jpeg = fs.readFileSync(IMG);

// 1) 塞缓冲（手机 push 那条路）
const pr = await fetch(`${BASE}/api/camera/push?t=${T}&via=${encodeURIComponent('全链路自证')}`, {
  method: 'POST',
  headers: { 'content-type': 'image/jpeg', 'x-w': String(1280), 'x-h': String(720) },
  body: jpeg,
});
(pr.ok ? ok : bad)('塞缓冲 status=' + pr.status);

// 2) 上传（拿 path）
const up = await fetch(`${BASE}/api/upload?t=${T}`, {
  method: 'POST',
  headers: { 'content-type': 'image/jpeg', 'x-file-name': 'live-full.jpg' },
  body: jpeg,
});
const uj = await up.json().catch(() => ({}));
if (uj && /^uploads\/[^/\\]+$/.test(String(uj.path || ''))) ok('上传得到 ' + uj.path + '（' + Math.round((uj.size || 0) / 1024) + ' KB）');
else bad('上传没拿到 path：' + JSON.stringify(uj).slice(0, 120));

// 3) 点评
let said = '';
if (uj && uj.path) {
  const before = await (await fetch(`${BASE}/api/state?t=${T}`)).json();
  const lastAI = () => {
    const list = (before.messages || []).filter((m) => m.role === 'assistant');
    return list.length ? list[list.length - 1].text || '' : '';
  };
  const cr = await fetch(`${BASE}/api/live/comment?t=${T}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: uj.path, size: uj.size, mime: 'image/jpeg' }),
  });
  const cj = await cr.json().catch(() => ({}));
  if (cr.status === 200) ok('点评入队 k=' + cj.k);
  else bad('点评失败 ' + cr.status + ' ' + JSON.stringify(cj).slice(0, 120));

  if (cr.status === 200) {
    for (let i = 0; i < 60; i += 1) {
      await sleep(3000);
      const st = await (await fetch(`${BASE}/api/state?t=${T}`)).json();
      const list = (st.messages || []).filter((m) => m.role === 'assistant');
      const cur = list.length ? list[list.length - 1].text || '' : '';
      if (cur && cur !== lastAI()) { said = cur; break; }
    }
    console.log('  AI 说：' + (said || '（没等到回复）').slice(0, 200));
    if (/蓝|蓝底|phone-eye|白字/.test(said)) ok('模型看见了这一帧（会话里也有那张照片）');
    else bad('回复里没有画面信息');
  }
}

// 4) 会话里那一帧是否以「我」的身份挂着照片
const st = await (await fetch(`${BASE}/api/state?t=${T}`)).json();
const mine = (st.messages || []).filter((m) => m.role === 'user' && Array.isArray(m.files) && m.files.some((f) => /^uploads\//.test(String(f.path || ''))));
if (mine.length) ok('会话里挂着照片的「我」的消息 ' + mine.length + ' 条（最近一条 kind=' + (mine[mine.length - 1].kind || '普通') + '）');
else bad('会话里没有带照片的用户消息');

console.log(process.exitCode ? 'FAILED' : 'PASS');
