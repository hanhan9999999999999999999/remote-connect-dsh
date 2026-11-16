#!/usr/bin/env node
// 肥鱼本地语音服务自检：读 service.json → /health → 逐个风格合成一句 → 报告耗时与时长。
//
//   node phone-bridge/tools/feiyu-check.mjs                # 只查健康与风格
//   node phone-bridge/tools/feiyu-check.mjs --synth        # 每个风格都试一句
//   node phone-bridge/tools/feiyu-check.mjs --synth --style=cute --text="你好呀"
//
// 退出码 0 = 全部通过；1 = 服务没起/有风格合成失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = process.env.FEIYU_TTS_STATE || path.join(here, '..', 'runtime', 'feiyu-tts', 'service.json');
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const wantSynth = args.includes('--synth');
const onlyStyle = flag('style', '');
const text = String(flag('text', '你好呀，我是肥鱼，现在用本地引擎说话。'));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

const state = readState();
const base = process.env.PHONE_FEIYU_URL || (state && state.port ? `http://127.0.0.1:${state.port}` : 'http://127.0.0.1:8898');
const token = (state && state.token) || process.env.FEIYU_TTS_TOKEN || '';

function wavSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const channels = buf.readUInt16LE(22);
  let off = 12;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataLen = Math.min(size, buf.length - off - 8); break; }
    off += 8 + size + (size % 2);
  }
  const bytesPerSecond = rate * channels * (bits / 8 || 2);
  return bytesPerSecond ? dataLen / bytesPerSecond : 0;
}

const out = [];
let failed = 0;

async function main() {
  let health;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    health = await r.json();
  } catch (e) {
    console.error(`[x] 连不上本地语音服务 ${base}：${e.message}`);
    console.error('    先双击「启动肥鱼语音.bat」，或 node phone-bridge/tools/feiyu-tts-service.py --help');
    // 不用 process.exit()：Windows 上 undici 的 keep-alive 句柄还没关，强退会触发
    // libuv 的 UV_HANDLE_CLOSING 断言（退出码变成 0xC0000409）。交给事件循环自然收尾。
    process.exitCode = 1;
    return;
  }
  // 8898 可能被别的程序占着，它也会回 JSON。没有肥鱼身份就不是肥鱼，别继续往下读 version。
  const isFeiyu = health && (health.service === 'feiyu-tts'
    || (typeof health.ready === 'boolean' && Array.isArray(health.styles)));
  if (!isFeiyu) {
    console.error(`[x] ${base} 上不是肥鱼服务：${health && health.error ? health.error : '响应里没有 service/ready 字段'}`);
    console.error('    端口被别的程序占用了。重新运行「启动肥鱼语音.bat」，它会自动换到空闲端口。');
    process.exit(1);
  }
  console.log(`[ok] ${base} · v${health.version} · pid=${health.pid} · ${health.device} · ${health.sampleRate}Hz`);
  console.log(`     模型 ready=${health.ready} loading=${health.loading}${health.loadError ? ` error=${health.loadError}` : ''} · 默认风格=${health.defaultStyle}`);
  if (health.skipped && health.skipped.length) {
    for (const s of health.skipped) console.log(`[!] 跳过 ${s.file}：${s.reason}`);
  }
  const styles = (health.styles || []).filter((s) => !onlyStyle || s.id === onlyStyle);
  if (!styles.length) {
    console.error(`[x] 没有匹配的风格（--style=${onlyStyle}）`);
    process.exitCode = 1;
    return;
  }
  console.log(`     风格 ${styles.length} 个：${styles.map((s) => `${s.id}(${s.label})`).join('、')}`);
  if (!health.ready) {
    console.log('[..] 模型还在加载，等它就绪再合成');
    if (!wantSynth) { process.exitCode = 0; return; }
    for (let i = 0; i < 240; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
      if (h && h.ready) { health = h; break; }
      if (h && h.loadError) { console.error(`[x] 加载失败：${h.loadError}`); process.exitCode = 1; return; }
    }
    if (!health.ready) { console.error('[x] 等待超时'); process.exitCode = 1; return; }
  }
  if (!wantSynth) return;

  for (const s of styles) {
    const t0 = Date.now();
    let ok = false;
    let note = '';
    try {
      const r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Feiyu-Token': token },
        body: JSON.stringify({ text, style: s.id, format: 'wav' }),
        signal: AbortSignal.timeout(180000),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) throw new Error(`${r.status} ${buf.toString('utf8').slice(0, 200)}`);
      const sec = wavSeconds(buf);
      ok = sec > 0.2;
      note = `${(buf.length / 1024).toFixed(0)}KB · ${sec.toFixed(2)}s 音频`;
    } catch (e) {
      note = e.message;
    }
    const ms = Date.now() - t0;
    if (!ok) failed += 1;
    out.push({ style: s.id, label: s.label, ms, ok, note });
    console.log(`${ok ? '[ok]' : '[x]'} ${s.id.padEnd(8)} ${String(s.label).padEnd(6)} ${String(ms).padStart(6)}ms  ${note}`);
  }
}

await main();
if (wantSynth) {
  const slowest = out.reduce((a, b) => (b.ms > a.ms ? b : a), out[0] || { ms: 0 });
  console.log(`\n汇总：${out.length - failed}/${out.length} 通过，最慢 ${slowest.style || '-'} ${slowest.ms}ms`);
}
process.exitCode = failed ? 1 : 0;
