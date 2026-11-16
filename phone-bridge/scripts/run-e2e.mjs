// `npm run test:e2e` 的入口：默认从 runtime 里读端口和 token，
// 省得每次手拼 `http://127.0.0.1:8899/?t=...`（忘了带 URL 会得到一张空白页，全是假失败）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
};
const state = readJson(path.join(ROOT, 'runtime', 'state.json'), {});
const portFile = readJson(path.join(ROOT, 'runtime', 'port.json'), {});
const port = Number(process.env.PHONE_BRIDGE_PORT || portFile.port || 8899);
const token = String(state.token || '');
const explicit = process.argv[2];
const url = explicit || ('http://127.0.0.1:' + port + '/?t=' + encodeURIComponent(token));
if (!explicit && !token) {
  console.error('runtime/state.json 里没有 token；先启动一次桥接，或把 URL 作为第一个参数传进来。');
  process.exit(2);
}
const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e.mjs'), url], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
