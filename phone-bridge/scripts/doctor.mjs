#!/usr/bin/env node
/**
 * 一次把「这台机器上的手机通道到底好不好」查完。
 * 不启动服务、不改任何状态，只读：
 *   node scripts/doctor.mjs
 * 退出码 0 = 全绿，1 = 有红灯（方便守护脚本/CI 用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
function row(name, ok, detail, warn) {
  rows.push({ name, ok: !!ok, detail: detail || '', warn: !!warn });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { return fallback; }
}

// 1. Node 与入口文件
const major = Number(process.versions.node.split('.')[0]);
row('Node 版本', major >= 20, process.versions.node + (major >= 20 ? '' : '（需要 ≥20）'));
row('入口文件', fs.existsSync(path.join(ROOT, 'server.mjs')), 'server.mjs');
row('页面文件', fs.existsSync(path.join(ROOT, 'public', 'app.html')), 'public/app.html');

// 2. 语音模型（ASR 的硬依赖）
const model = path.join(ROOT, 'models', 'ggml-base.bin');
const vad = path.join(ROOT, 'models', 'ggml-silero.bin');
row('ASR 模型', fs.existsSync(model), fs.existsSync(model) ? 'ggml-base.bin' : '缺少 models/ggml-base.bin', !fs.existsSync(model));
row('VAD 模型', fs.existsSync(vad), fs.existsSync(vad) ? 'ggml-silero.bin' : '缺少 models/ggml-silero.bin', !fs.existsSync(vad));

// 3. 运行中的桥
const st = readJson('runtime/state.json', {});
const port = readJson('runtime/port.json', {}).port || 8899;
const token = st.token || '';
let health = null;
try {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3500) });
  health = await r.json();
} catch (e) {}
row('桥进程', !!health, health ? `127.0.0.1:${port} · ${health.app || 'ok'}` : `127.0.0.1:${port} 没响应（先 npm start / 守护脚本）`, !health);

// 3b. DSH 桌面 profile 里的「远程服务」宿主插件。
// 它只在 bundles 里出现过、没写进 dependencies 时，pnpm install 会把它当多余的包清掉；
// 表现就是面板还能打开，但 /dsh-phone-api/status 变成 404，前端只报一句 bad json。
const profileDir = process.env.DSH_DESKTOP_PROFILE || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const profilePkgFile = path.join(profileDir, 'package.json');
if (fs.existsSync(profilePkgFile)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(profilePkgFile, 'utf8'));
    const bundles = pkg?.dsh?.profile?.bundles || [];
    const name = '@local/dsh-phone-bridge';
    if (bundles.includes(name)) {
      const declared = !!(pkg.dependencies && pkg.dependencies[name]);
      const installed = fs.existsSync(path.join(profileDir, 'node_modules', '@local', 'dsh-phone-bridge', 'index.js'));
      row(
        '桌面服务插件',
        declared && installed,
        declared
          ? installed
            ? '已声明并安装'
            : '依赖已声明，但 node_modules 里没有（先在 profile 里 pnpm install）'
          : 'bundles 里有、dependencies 没声明（下次 pnpm install 会被清掉）',
        !declared || !installed,
      );
    } else {
      row('桌面服务插件', true, '桌面 profile 未启用（不影响手机直连）');
    }
  } catch (e) {
    row('桌面服务插件', false, '读不了 profile: ' + String((e && e.message) || e), true);
  }
}

// 3c. 肥鱼本地语音（可选引擎）：没起不算故障，起了就核对它认得的音色。
// 这里必须校验服务身份：8898 是热门端口，被别的程序占着时它也会回 JSON，
// 早期版本把那种响应当成「模型还在加载」，把「端口被占」误诊成「模型没起来」。
const feiyuState = readJson('runtime/feiyu-tts/service.json', null);
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 进程在，只是没权限发信号
  }
}
function winPortPid(portNum) {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (m && Number(m[1]) === Number(portNum)) return Number(m[2]);
    }
  } catch {}
  return 0;
}
if (feiyuState && feiyuState.port) {
  const fport = feiyuState.port;
  let fh = null;
  let ferr = '';
  try {
    const r = await fetch(`http://127.0.0.1:${fport}/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json().catch(() => null);
    if (j && (j.service === 'feiyu-tts' || (typeof j.ready === 'boolean' && Array.isArray(j.styles)))) fh = j;
    else ferr = (j && j.error) ? String(j.error) : `HTTP ${r.status}`;
  } catch (e) {
    ferr = String((e && e.message) || e);
  }
  if (fh) {
    if (!fh.ready) {
      row('肥鱼语音引擎', false, `加载中/失败：${fh.loadError || '等待模型'}`, true);
    } else {
      const styles = Array.isArray(fh.styles) ? fh.styles.length : 0;
      row('肥鱼语音引擎', true, `127.0.0.1:${fport} · ${styles} 个音色 · 当前 ${fh.styleLabel || fh.style || '?'}`, false);
    }
  } else if (ferr && !/fetch failed|ECONN|aborted|timeout/i.test(ferr)) {
    const owner = winPortPid(fport);
    row(
      '肥鱼语音引擎',
      false,
      `端口 ${fport} 被其他程序占用${owner ? `（pid ${owner}）` : ''}，不是肥鱼服务（${ferr.slice(0, 60)}）· 肥鱼会自动换端口，重新运行「启动肥鱼语音.bat」即可`,
      true,
    );
  } else if (!pidAlive(feiyuState.pid)) {
    row('肥鱼语音引擎', true, `state 过期：pid ${feiyuState.pid || '?'} 已退出 · 双击「启动肥鱼语音.bat」`, true);
  } else {
    row('肥鱼语音引擎', true, `pid ${feiyuState.pid} 没响应 · 双击「启动肥鱼语音.bat」`, true);
  }
} else {
  row('肥鱼语音引擎', true, '未配置（可选引擎；要用就双击「启动肥鱼语音.bat」）', true);
}

// 4. 带令牌的自检（11 项，含存档/profile/隧道/语音）
if (health && token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/selfcheck?t=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    row('服务端自检', j.ok, `${j.pass || 0}/${j.total || 0}`);
    for (const it of j.items || []) if (!it.ok) row('  × ' + it.name, false, it.detail || '', true);
  } catch (e) {
    row('服务端自检', false, String((e && e.message) || e), true);
  }
} else if (health) {
  row('服务端自检', false, 'runtime/state.json 里没有令牌，无法带鉴权自检', true);
}

// 5. 公网链路（有 tunnel.json 才查）
const tun = readJson('tunnel.json', null);
if (tun && (tun.publicUrl || tun.url)) {
  const url = tun.publicUrl || tun.url;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(6000) });
    row('公网入口', r.ok, url + ' · HTTP ' + r.status, !r.ok);
  } catch (e) {
    row('公网入口', false, url + ' · 连不上（隧道可能断了）', true);
  }
}

// 6. 最近的 e2e 结果（有就展示，不强制）
const e2e = readJson('../dist/e2e.json', null);
if (e2e && e2e.total) {
  const ago = Math.round((Date.now() - (e2e.at || 0)) / 60000);
  row('最近回归', e2e.pass === e2e.total, `${e2e.pass}/${e2e.total} · ${ago} 分钟前`, e2e.pass !== e2e.total);
}

// 7. 遗留标记
const pending = ['runtime/needs-restart.json', 'runtime/bridge.pid'];
for (const f of pending) {
  if (fs.existsSync(path.join(ROOT, f))) row('运行时标记', true, f + ' 存在（正常）', false);
}

const pad = Math.max(...rows.map((r) => [...r.name].length), 8);
console.log('\nDSH 手机通道 · 体检\n' + '─'.repeat(pad + 34));
for (const r of rows) {
  const mark = r.ok ? (r.warn ? '!' : '✓') : '×';
  console.log(`${mark} ${r.name.padEnd(pad, ' ')}  ${r.detail}`);
}
const bad = rows.filter((r) => !r.ok).length;
console.log('─'.repeat(pad + 34));
console.log(bad === 0 ? '全部正常。' : `${bad} 项需要处理。`);
process.exit(bad === 0 ? 0 : 1);
