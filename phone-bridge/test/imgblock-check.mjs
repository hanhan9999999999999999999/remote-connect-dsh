// 验证：直播点评把这一帧作为「图片块」递给模型，模型不用读文件就能描述画面
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/state.json'), 'utf8')).token;
const BASE = 'http://127.0.0.1:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const img = fs.readFileSync(path.join(ROOT, 'test/out/probe-shot.jpg'));
const b64 = img.toString('base64');

const before = await (await fetch(`${BASE}/api/state?t=${T}`)).json();
const lastAI = () => {
  const list = (before.messages || []).filter((m) => m.role === 'assistant');
  return list.length ? list[list.length - 1].text || '' : '';
};

const r = await fetch(`${BASE}/api/live/comment?t=${T}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: b64, size: img.length, mime: 'image/jpeg' }),
});
console.log('点评请求 =', r.status, JSON.stringify(await r.json()));
if (r.status !== 200) process.exit(1);

let said = '';
for (let i = 0; i < 60; i += 1) {
  await sleep(3000);
  const st = await (await fetch(`${BASE}/api/state?t=${T}`)).json();
  const list = (st.messages || []).filter((m) => m.role === 'assistant');
  const cur = list.length ? list[list.length - 1].text || '' : '';
  if (cur && cur !== lastAI()) { said = cur; break; }
}

console.log('AI 说：' + (said || '（没等到回复）').slice(0, 300));
const ok = /蓝|蓝底|phone-eye|phone—eye|白字|电话/.test(said);
console.log(ok ? 'OK：模型看见了这一帧（图片块）' : 'FAIL：回复里没有画面信息');
process.exit(ok ? 0 : 1);
