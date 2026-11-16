// 公网通道：把本机桥接端口（默认读 runtime/port.json，退回 8899）映射到公网 https 地址，让手机在任意网络下都能连。
//
// 两个后端：
//   ssh        —— 用 Windows 自带 OpenSSH 连 localhost.run，零下载，秒开（默认）
//   cloudflare —— 用 cloudflared 快速隧道（需要那个 exe；本机网络下载很慢，一般不用）
//
// 环境变量：
//   PHONE_TUNNEL_PROVIDER=auto|ssh|cloudflare   默认 auto：有 cloudflared 就用它，否则用 ssh
//   PHONE_CLOUDFLARED=<路径>                     指定 cloudflared 可执行文件
//   PHONE_TUNNEL_HOST=<ssh 目标>                 默认 nokey@localhost.run
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(HERE, 'bin');
const LOCAL_BIN = path.join(BIN_DIR, 'cloudflared.exe');
const CF_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const SSH_TARGET = process.env.PHONE_TUNNEL_HOST || 'nokey@localhost.run';
const TUNNEL_JSON = path.join(HERE, 'tunnel.json');

// 自建服务器（例如自己的阿里云）反向隧道配置：phone-bridge/tunnel.json
// { "provider": "selfhost", "host": "1.2.3.4", "port": 22, "user": "root",
//   "key": "C:/Users/me/.ssh/key.pem", "remotePort": 18899,
//   "publicUrl": "https://example.com/dsh" }
function loadSelfHost() {
  let cfg = {};
  try {
    if (fs.existsSync(TUNNEL_JSON)) cfg = JSON.parse(fs.readFileSync(TUNNEL_JSON, 'utf8'));
  } catch (e) {
    cfg = {};
  }
  const host = process.env.PHONE_SELFHOST_HOST || cfg.host;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.PHONE_SELFHOST_SSH_PORT || cfg.port || 22),
    user: process.env.PHONE_SELFHOST_USER || cfg.user || 'root',
    key: process.env.PHONE_SELFHOST_KEY || cfg.key || '',
    remotePort: Number(process.env.PHONE_SELFHOST_REMOTE_PORT || cfg.remotePort || 18899),
    publicUrl: (process.env.PHONE_SELFHOST_PUBLIC_URL || cfg.publicUrl || '').replace(/\/$/, ''),
  };
}
const PROVIDER = String(process.env.PHONE_TUNNEL_PROVIDER || 'auto').toLowerCase();

const state = {
  running: false,
  url: null,
  since: null,
  error: null,
  downloading: false,
  named: false,
  binary: null,
  provider: null,
};

let proc = null;
let log = '';
let notify = () => {};
let watchdog = null;
// 默认端口跟着 runtime/port.json（桥接实际监听的那个）走：换端口后隧道重建不会还往老端口上连
let lastPort = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, 'runtime', 'port.json'), 'utf8'));
    const p = Number(j && j.port);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
  } catch (_) {
    /* 还没跑过桥接就按默认 */
  }
  return Number(process.env.PHONE_BRIDGE_PORT || 8899);
})();

// 「现在应该有一条隧道」的意图。和 state.running 的区别：
// state.running 表示此刻真的通了；desired 表示用户/自动流程要它通。
// 隧道进程死掉时 state 会被清空，但 desired 仍是 true —— 这才是能自愈的依据。
let desired = false;
let backoff = 0; // 重建失败后的退避毫秒
let nextAttemptAt = 0; // 下次允许尝试的时刻
const WATCH_INTERVAL = Number(process.env.PHONE_TUNNEL_WATCH_MS || 30000); // 30 秒探一次
const MAX_BACKOFF = 300000; // 退避上限 5 分钟

/** 注册状态变化回调（URL 变了 / 掉线了，让前端能立刻看到）。 */
export function onChange(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}
function emit() {
  try {
    notify(status());
  } catch {}
}

function errLine(s) {
  // 去掉 ANSI 颜色码，否则 localhost.run 的横幅会把地址切碎
  const clean = String(s).replace(/\[[0-9;?]*[a-zA-Z]/g, '');
  log = (log + clean).slice(-20000);
  return log;
}

function clearState() {
  state.running = false;
  state.url = null;
  state.since = null;
  state.provider = null;
}

export function status() {
  return {
    running: state.running,
    url: state.url,
    since: state.since,
    error: state.error,
    downloading: state.downloading,
    named: state.named,
    binary: state.binary,
    provider: state.provider,
    desired,
    retryIn: nextAttemptAt ? Math.max(0, Math.round((nextAttemptAt - Date.now()) / 1000)) : 0,
    log: state.error ? log.slice(-600) : undefined,
  };
}

function cloudflaredBin() {
  const custom = process.env.PHONE_CLOUDFLARED;
  if (custom && fs.existsSync(custom)) return custom;
  if (fs.existsSync(LOCAL_BIN)) return LOCAL_BIN;
  return null;
}

function pickProvider() {
  if (PROVIDER === 'selfhost') return 'selfhost';
  if (PROVIDER === 'ssh' || PROVIDER === 'cloudflare') return PROVIDER;
  // auto：配了自己的服务器就优先用它（最稳最快），否则 cloudflared > 免费 ssh
  if (loadSelfHost()) return 'selfhost';
  return cloudflaredBin() ? 'cloudflare' : 'ssh';
}

export async function start(port) {
  desired = true;
  if (state.running && state.url) {
    startWatch();
    return status();
  }
  state.error = null;
  clearState();
  lastPort = port;
  const provider = pickProvider();
  try {
    if (provider === 'cloudflare') {
      const bin = cloudflaredBin() || (await ensureBinary());
      state.binary = bin;
      state.provider = 'cloudflare';
      if (process.env.PHONE_TUNNEL_TOKEN) {
        state.named = true;
        await runCloudflared(bin, ['tunnel', '--no-autoupdate', 'run', '--token', process.env.PHONE_TUNNEL_TOKEN]);
      } else {
        await runCloudflared(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]);
      }
    } else if (provider === 'selfhost') {
      state.provider = 'selfhost';
      await runSelfHost(port);
    } else {
      state.provider = 'ssh';
      await runSsh(port);
    }
  } catch (e) {
    state.error = e && e.message ? e.message : String(e);
    clearState();
    killProc();
  }
  if (state.running && state.url) {
    backoff = 0;
    nextAttemptAt = 0;
  }
  // 首次失败也要起看门狗，否则这台机器就再也不会自己重试了
  startWatch();
  emit();
  return status();
}

export function stop() {
  desired = false;
  backoff = 0;
  nextAttemptAt = 0;
  stopWatch();
  killProc();
  clearState();
  state.error = null;
  return status();
}

function killProc() {
  const p = proc;
  proc = null;
  if (!p || !p.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true, stdio: 'ignore' });
    } else {
      p.kill('SIGKILL');
    }
  } catch {}
}

// ------------------------------------------------------------- 掉线自愈
function stopWatch() {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

// 重建一条隧道。调用前 state 里可能已经是空的（进程死了），所以 provider 必须先取出来。
async function rebuild(reason) {
  const provider = state.provider || pickProvider();
  const named = state.named;
  const oldUrl = state.url;
  killProc();
  clearState();
  state.error = null;
  log += `\n[${reason}，重建隧道]`;
  try {
    if (provider === 'cloudflare') {
      const bin = cloudflaredBin() || LOCAL_BIN;
      if (named && process.env.PHONE_TUNNEL_TOKEN) {
        await runCloudflared(bin, ['tunnel', '--no-autoupdate', 'run', '--token', process.env.PHONE_TUNNEL_TOKEN]);
      } else {
        await runCloudflared(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${lastPort}`]);
      }
    } else if (provider === 'selfhost') {
      await runSelfHost(lastPort);
    } else {
      await runSsh(lastPort);
    }
    backoff = 0;
    nextAttemptAt = 0;
    log += `\n[隧道已重建：${oldUrl || '-'} -> ${state.url}]`;
    emit();
    return true;
  } catch (e) {
    state.error = `隧道重建失败：${e && e.message ? e.message : e}`;
    backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF) : WATCH_INTERVAL;
    nextAttemptAt = Date.now() + backoff;
    log += `\n[隧道重建失败：${state.error}，${Math.round(backoff / 1000)} 秒后重试]`;
    emit();
    return false;
  }
}

function startWatch() {
  stopWatch();
  if (!desired) return;
  let fails = 0;
  watchdog = setInterval(async () => {
    if (!desired) return;
    // 没有可用隧道：按退避直接重建（这是旧版的死区——state 被清空后永远 return）
    if (!state.running || !state.url) {
      if (Date.now() < nextAttemptAt) return;
      await rebuild(state.error ? '上次重建失败，再试一次' : '隧道进程已退出');
      return;
    }
    const ok = await ping(state.url);
    if (ok) {
      fails = 0;
      backoff = 0;
      nextAttemptAt = 0;
      return;
    }
    fails += 1;
    if (fails < 2) return;
    fails = 0;
    await rebuild('公网健康检查连续失败');
  }, WATCH_INTERVAL);
  watchdog.unref?.();
}

async function ping(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return false;
    const t = await r.text();
    // localhost.run 在没有反向隧道时会回一段文字 "no tunnel"
    return !/no tunnel/i.test(t);
  } catch {
    return false;
  }
}

// ------------------------------------------------------- 自建服务器后端
// ssh -N -R 127.0.0.1:remotePort:127.0.0.1:localPort user@host
// 服务器上用 nginx 把 /dsh/ 反代到 127.0.0.1:remotePort，就不用开任何新端口。
/* 服务器上那个远端端口，常常被上一次没断干净的 sshd 会话占着：
   客户端早没了（连接全是 CLOSE-WAIT），监听却还在 —— 这时 ssh 会报
   "remote port forwarding failed for listen port"，隧道永远起不来。
   起之前先让服务器把这个端口上的旧 sshd 会话清掉，只杀监听该端口的 sshd，
   不碰 nginx 和别的服务。 */
async function freeRemotePort(cfg) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(cfg.port),
  ];
  if (cfg.key) args.push('-i', cfg.key);
  // 只清 sshd：万一这个端口上蹲着别的东西（用户自己起的服务），
  // 清掉它就成了破坏，宁可让 ssh 报错、让人看见。
  const cmd = [
    `for p in $(ss -ltnpH 'sport = :${cfg.remotePort}' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do`,
    '  name=$(ps -p "$p" -o comm= 2>/dev/null)',
    '  case "$name" in',
    '    sshd*) echo "free:$p"; kill "$p" 2>/dev/null ;;',
    '    *) echo "skip:$p:$name" ;;',
    '  esac',
    'done',
    'sleep 1',
    `ss -ltnH 'sport = :${cfg.remotePort}' 2>/dev/null | wc -l`,
  ].join('; ');
  args.push(`${cfg.user}@${cfg.host}`, cmd);

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(out.trim()); };
    let p;
    try {
      p = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      resolve('');
      return;
    }
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('error', () => finish());
    p.on('exit', () => finish());
    setTimeout(() => { try { p.kill(); } catch (_) {} finish(); }, 20000);
  });
}

async function attemptSelfHost(cfg, port) {
  const args = [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(cfg.port),
    '-R', `127.0.0.1:${cfg.remotePort}:127.0.0.1:${port}`,
  ];
  if (cfg.key) args.push('-i', cfg.key);
  args.push(`${cfg.user}@${cfg.host}`);

  const url = cfg.publicUrl || `http://${cfg.host}:${cfg.remotePort}`;
  log = '';
  proc = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (b) => errLine(b.toString()));
  proc.stderr.on('data', (b) => errLine(b.toString()));
  proc.on('exit', (code) => {
    if (state.running) {
      state.error = `自建隧道进程退出（code ${code}）`;
      state.running = false;
      state.url = null;
      state.since = null;
      // 进程自己死了：清掉退避，让看门狗下一拍立刻重建，不用等 5 分钟
      backoff = 0;
      nextAttemptAt = 0;
      emit();
    }
  });

  // 自己服务器没有输出去抓地址，用公网地址反复探活确认隧道通了
  const deadline = Date.now() + 30000;
  let ok = false;
  while (Date.now() < deadline) {
    if (await ping(url)) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!ok) {
    const busy = /remote port forwarding failed/i.test(log);
    try { proc.kill(); } catch (_) {}
    throw new Error(busy
      ? `服务器上远端端口 ${cfg.remotePort} 被占着（上一次的隧道没断干净），已经试着清掉它`
      : `隧道已建立但 ${url} 仍访问不通（检查服务器 nginx 反代 / sshd）`);
  }
  state.running = true;
  state.url = url;
  state.since = Date.now();
  return url;
}

async function runSelfHost(port) {
  const cfg = loadSelfHost();
  if (!cfg) throw new Error('没有配置自建服务器（phone-bridge/tunnel.json）');

  // 第一遍：先清远端残留端口，再连
  try { await freeRemotePort(cfg); } catch (_) {}
  try {
    return await attemptSelfHost(cfg, port);
  } catch (e1) {
    // 端口被占 / 隧道没通：清一次再试一遍，还是不行才把错误抛出去
    state.error = String((e1 && e1.message) || e1);
    emit();
    log('tunnel', '第一遍没通，清掉远端残留端口再来一次');
    try { await freeRemotePort(cfg); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
    return await attemptSelfHost(cfg, port);
  }
}

// ---------------------------------------------------------------- ssh 后端
function runSsh(port) {
  return new Promise((resolve, reject) => {
    log = '';
    const args = [
      '-T',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${port}`,
      SSH_TARGET,
    ];
    const p = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('SSH 隧道 60 秒内没拿到公网地址（网络可能拦了 22 端口）'));
      }
    }, 60000);

    const onData = (d) => {
      errLine(d.toString('utf8'));
      if (state.url) return;
      const m = log.match(/https:\/\/([a-z0-9]{6,})\.(?:lhr\.life|localhost\.run)/i);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        state.url = m[0];
        state.running = true;
        state.since = Date.now();
        resolve(state.url);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`启动 ssh 失败：${e.message}`));
      }
    });
    p.on('exit', (code) => {
      if (proc === p) proc = null;
      const wasRunning = state.running;
      clearState();
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`ssh 退出（code ${code}）：${log.slice(-300)}`));
      } else if (wasRunning) {
        state.error = `隧道已断开（code ${code}）`;
      }
    });
  });
}

// --------------------------------------------------------- cloudflared 后端
function runCloudflared(bin, args) {
  return new Promise((resolve, reject) => {
    log = '';
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(
          new Error(
            state.named
              ? 'cloudflared 已启动，但具名隧道不会打印公网地址，请到 Cloudflare 面板查看域名'
              : 'cloudflared 40 秒内没拿到公网地址',
          ),
        );
      }
    }, 40000);

    const onData = (d) => {
      errLine(d.toString('utf8'));
      if (state.url) return;
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        state.url = m[0];
        state.running = true;
        state.since = Date.now();
        resolve(state.url);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`启动 cloudflared 失败：${e.message}`));
      }
    });
    p.on('exit', (code) => {
      if (proc === p) proc = null;
      const wasRunning = state.running;
      clearState();
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared 退出（code ${code}）：${log.slice(-300)}`));
      } else if (wasRunning) {
        state.error = `隧道已断开（code ${code}）`;
      }
    });
  });
}

async function ensureBinary() {
  state.downloading = true;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = `${LOCAL_BIN}.partial`;
  try {
    await fetchToFile(CF_URL, tmp);
    const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (size < 5 * 1024 * 1024) throw new Error(`下载文件大小异常（${size} 字节）`);
    fs.renameSync(tmp, LOCAL_BIN);
    return LOCAL_BIN;
  } finally {
    state.downloading = false;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  }
}

/** 用系统 curl 下载（自己拼 https 重定向在 Windows 上不稳）。 */
function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const c = spawn('curl', ['-L', '--fail', '--max-time', '600', '-o', dest, url], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    c.stderr.on('data', (b) => (err += b.toString('utf8')));
    c.on('error', reject);
    c.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`下载 cloudflared 失败（${(err || 'exit ' + code).slice(-200)}）；本机网络下载很慢，建议直接用 SSH 隧道`)),
    );
  });
}
