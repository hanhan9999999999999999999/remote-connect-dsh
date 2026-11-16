/**
 * 真跑一轮「看一眼」：推一帧 + 只带 data 的点评请求，然后等模型回话。
 *
 * 这一步会真的消耗一次模型调用（几秒钟），所以不放进 camtest，
 * 需要端到端确认「AI 到底看不看得见图」时手动跑：
 *
 *   node test/live-once.mjs
 *
 * 成功的标志：AI 回的那句话描述的是 test/out/probe-shot.jpg 里的内容
 * （蓝底白字 phone-eye），而不是「这一眼没取到画面」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.PHONE_PORT || 8899);
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'state.json'), 'utf8')).token;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shotPath = path.join(HERE, 'out', 'probe-shot.jpg');
const jpg = fs.readFileSync(shotPath);
const b64 = jpg.toString('base64');

// 桥接会被「改完自动跑回归」重启一下，所以网络错误要重试几次
async function call(fn, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000);
    }
  }
}
const getJson = (u, opt) => call(async () => (await fetch(u, opt)).json());

const push = await getJson(`${BASE}/api/camera/push?t=${TOKEN}&w=640&h=480&src=e2e`, {
  method: 'POST',
  headers: { 'content-type': 'image/jpeg' },
  body: jpg,
});
console.log('推帧：' + JSON.stringify(push));
if (!push.ok) process.exit(1);

const stateNow = async () => getJson(`${BASE}/api/state?t=${TOKEN}`);
const lastAiText = (st) => {
  const msgs = st.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role && m.role !== 'user' && m.role !== 'me' && (m.text || '').trim()) return (m.text || '').trim();
  }
  return '';
};

// 注意：服务端的 messages 只保留最近 120 条，不能用「数组变长」判断有没有新回复，
// 只能记住「上一条 AI 说的话」，等它变了。
const beforeAi = lastAiText(await stateNow());

// 关键：不给 path，只给 data —— 等价于「上传那条路没走通」
const c = await (await fetch(`${BASE}/api/live/comment?t=${TOKEN}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: '你这一眼看到了什么？只用一句话，说画面里最显眼的东西。',
    data: b64,
    size: jpg.length,
    k: 1,
  }),
})).json();
console.log('点评：' + JSON.stringify(c).slice(0, 200));
if (!c.ok) process.exit(1);

let said = '';
let last = '';
let stable = 0;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const st = await stateNow();
  const text = lastAiText(st);
  const fresh = text && text !== beforeAi ? text : '';
  if (fresh && fresh === last) stable += 1; else stable = 0;
  last = fresh;
  // 有内容、且连续两次没再变（流式结束）就算说完 —— 不看 busy，模型可能还在收尾
  if (fresh && (!st.busy || stable >= 2)) { said = fresh; break; }
}
if (!said) said = last;

const flat = said.replace(/\s+/g, ' ').trim();
console.log('\nAI 回复：' + (flat || '（没有等到）').slice(0, 400));
if (/phone-eye|蓝底|测试图/.test(flat)) {
  console.log('\n通过：模型确实看到了这一帧（上传那条路完全没参与）');
} else {
  console.log('\n注意：回复里没出现画面特征，可能没看到图，或它换了说法');
  process.exitCode = 2;
}
