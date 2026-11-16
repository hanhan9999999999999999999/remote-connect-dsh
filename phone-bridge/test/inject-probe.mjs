// 验证：手机端这一轮的正文能正常拼出来并送进模型（taskBody 守卫改动的回归）
// 判定方式：拿「最后一条 assistant 的 id + 文本」当基线，等到它变了。
import fs from 'node:fs';

const ROOT = 'D:/document/Remote Connect DSH/phone-bridge';
const T = JSON.parse(fs.readFileSync(ROOT + '/runtime/state.json', 'utf8')).token;
const B = 'http://127.0.0.1:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = async () => (await fetch(`${B}/api/state?t=${T}`)).json();
const lastAI = (st) => {
  const list = (st.messages || []).filter((m) => m.role === 'assistant');
  return list.length ? list[list.length - 1] : null;
};

const before = lastAI(await state());
const baseId = before ? before.id : '';
const baseText = before ? String(before.text || '') : '';

const r = await fetch(`${B}/api/send?t=${T}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ text: '用一句话告诉我：你该怎么称呼我？' }),
});
console.log('send =', r.status, await r.text());

let said = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(2500);
  const cur = lastAI(await state());
  const txt = cur ? String(cur.text || '') : '';
  if (cur && (cur.id !== baseId || txt !== baseText) && txt) { said = txt; break; }
}

console.log('AI:', said ? said.replace(/\s+/g, ' ').slice(0, 220) : '（没有回复）');
console.log(said && /主人/.test(said) ? 'OK：这一轮正常送出，条款也生效' : 'FAIL：没有拿到回复');
process.exit(said ? 0 : 1);
