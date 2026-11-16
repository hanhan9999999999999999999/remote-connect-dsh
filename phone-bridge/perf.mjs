// 每轮耗时的分段记录：帮助回答「这轮为什么慢」——
// 是起进程慢（firstText 大）、模型在推理（firstText 大但 tools=0），还是工具调用多。
// 落盘到 runtime/perf.jsonl，重启后仍有样本（否则每次重启都显示「还没有样本」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime');
const FILE = path.join(RUNTIME, 'perf.jsonl');
const buf = [];
const MAX = 50;

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(-MAX)) {
      try {
        const r = JSON.parse(l);
        if (r && r.total) buf.push(r);
      } catch (_) {}
    }
  } catch (_) {}
}
load();

export function add(r) {
  if (!r || !r.total) return;
  const rec = {
    at: r.at || Date.now(),
    total: Math.round(r.total || 0),
    firstText: Math.round(r.firstText || 0),
    boot: Math.round(r.boot || 0),     // 进程启动到 session 就绪
    think: Math.round(r.think || 0),   // 模型开始请求到出第一个字（TTFT）
    tools: r.tools || 0,
    chars: r.chars || 0,
    model: String(r.model || ''),
    // 每轮提示词体积（input + cacheRead）。手机上最贵的就是这个数，
    // 记下来才能在 perf 面板里看出「哪天又胖回去了」。
    promptTokens: r.promptTokens == null ? null : Math.round(r.promptTokens),
    // 新算的部分 / 命中缓存的部分分开记：差值飙高说明缓存失效，重付了整段钱。
    newTokens: r.newTokens == null ? null : Math.round(r.newTokens),
    cacheTokens: r.cacheTokens == null ? null : Math.round(r.cacheTokens),
    error: !!r.error,
  };
  buf.push(rec);
  while (buf.length > MAX) buf.shift();
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.appendFile(FILE, JSON.stringify(rec) + '\n', () => {});
  } catch (_) {}
}

export function list(n = 8) {
  return buf.slice(-n).reverse();
}

function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

export function stats() {
  if (!buf.length) return null;
  const ok = buf.filter((x) => !x.error);
  const src = ok.length ? ok : buf;
  return {
    n: src.length,
    total: median(src.map((x) => x.total)),
    firstText: median(src.map((x) => x.firstText)),
    boot: median(src.map((x) => x.boot)),
    think: median(src.map((x) => x.think)),
    tools: median(src.map((x) => x.tools)),
    chars: median(src.map((x) => x.chars)),
    errors: buf.filter((x) => x.error).length,
  };
}

export function clear() {
  buf.length = 0;
  try {
    fs.writeFileSync(FILE, '');
  } catch (_) {}
}
