// ACP 延迟探针：验证「常驻进程复用」能不能省掉每轮 ~9 秒的启动开销。
// 用法：node tools/acp-probe.mjs ["第一条" "第二条"]
// 只发最小 JSON-RPC（NDJSON over stdio），不依赖 ACP SDK。
import { spawn } from 'node:child_process';
import path from 'node:path';

const DSH = 'D:/deepseekharness/resources/app/dsh';
const BIN = path.join(DSH, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const CWD = process.cwd();

const prompts = process.argv.slice(2);
if (!prompts.length) prompts.push('只回三个字：收到了', '再回三个字：收到了');

const t0 = Date.now();
const child = spawn(process.execPath, [BIN, '--profile', 'acp'], {
  cwd: DSH,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
const waiters = new Map();
let id = 0;
const notifications = [];
let notifyHook = null;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
      if (notifyHook) notifyHook(msg);
    }
  }
});
const stderr = [];
child.stderr.on('data', (d) => stderr.push(d.toString('utf8')));

const rpc = (method, params) => new Promise((resolve, reject) => {
  const i = ++id;
  waiters.set(i, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  setTimeout(() => { if (waiters.has(i)) { waiters.delete(i); reject(new Error('rpc timeout: ' + method)); } }, 180000);
});

const bootAt = () => Date.now() - t0;

try {
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  console.log('boot', bootAt(), 'ms | agent', JSON.stringify(init.agentInfo || init.agent || {}).slice(0, 160));

  const session = await rpc('session/new', { cwd: CWD, mcpServers: [] });
  const sid = session.sessionId || session.id;
  console.log('session', sid, '| ready at', bootAt(), 'ms');
  if (session.models) console.log('models', JSON.stringify(session.models).slice(0, 200));

  for (const [n, text] of prompts.entries()) {
    const ts = Date.now();
    let first = 0, chunks = 0, out = '';
    notifyHook = (m) => {
      if (m.method !== 'session/update') return;
      const u = m.params && m.params.update;
      if (!u) return;
      const kind = u.sessionUpdate || u.type;
      if (kind === 'agent_message_chunk') {
        chunks += 1;
        if (!first) first = Date.now() - ts;
        const c = u.content;
        out += (c && (c.text || (c.type === 'text' ? c.text : ''))) || '';
      }
    };
    const r = await rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] });
    const total = Date.now() - ts;
    notifyHook = null;
    console.log(`turn${n + 1} first=${first}ms total=${total}ms chunks=${chunks} stop=${r && r.stopReason} text=${JSON.stringify(out.slice(0, 60))}`);
  }
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} 
    const err = stderr.join('').trim().split('\n').slice(-6).join('\n');
    if (err) console.log('--- stderr ---\n' + err);
    process.exit(0);
  }, 3000);
}
