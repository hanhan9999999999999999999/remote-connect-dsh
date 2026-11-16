/**
 * _test_coalesce.mjs — 连发合并的端到端验证。
 * 连发 3 条 → 确认日志只出现 1 个 turn、并带 coalesce 记录。
 *   node _test_coalesce.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

// 改完 server.mjs 后 watcher 会留一个「待重启」标记，下一条消息会先触发重启再跑，
// 那样测的是重启逻辑不是合并逻辑 —— 开测前先清掉。
try {
  fs.unlinkSync('runtime/needs-restart.json');
  console.log('  已清掉 needs-restart.json');
} catch {}

const token = JSON.parse(fs.readFileSync('runtime/state.json', 'utf8')).token;
const BASE = 'http://127.0.0.1:8899';

const j = async (p, o) => (await fetch(`${BASE}${p}${p.includes('?') ? '&' : '?'}t=${token}`, o)).json();
const send = (text) => j('/api/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
});

const t0 = Date.now();
for (const t of ['连发合并测试 A', '连发合并测试 B', '连发合并测试 C']) {
  const r = await send(t);
  console.log(`  send ${t} → ${JSON.stringify(r)}`);
}
console.log(`三条发完，用时 ${Date.now() - t0}ms`);

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await j('/api/state');
  process.stdout.write(`[${i}] busy=${s.busy} q=${s.queued}\r`);
  if (!s.busy && s.queued === 0) {
    console.log('\n--- 跑完，最近 6 条消息 ---');
    for (const m of s.messages.slice(-6)) {
      console.log(`  ${m.role}${m.system ? '(sys)' : ''}: ${String(m.text || '').slice(0, 120)}${m.error ? '  ERR=' + String(m.error).slice(0, 200) : ''}`);
    }
    break;
  }
}
