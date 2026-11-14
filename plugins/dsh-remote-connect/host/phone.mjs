/**
 * dsh-remote-connect — host half（手机通道）.
 *
 * 给 DSH Web UI 提供三个接口，用来在页面里直接开关手机远程服务（phone-bridge）：
 *   GET  /dsh-phone-api/status  → { running, pid, paused, publicUrl, ... }
 *   POST /dsh-phone-api/start   → 清掉 paused.flag 并用 ensure-running.ps1 拉起桥接
 *   POST /dsh-phone-api/stop    → 写 paused.flag 并杀掉监听进程（守护脚本也就不会自动拉回）
 *
 * 守护脚本 DSH-Phone-Guard.vbs 每 60 秒探一次 /api/health 并调 ensure-running.ps1，
 * 所以“关闭”必须同时落一个 paused.flag，ensure-running.ps1 见到它就什么都不做。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const inject = ['webServer'];

// 给临时验证脚本用的内部出口（不影响插件本身的行为）
export const __test = {
  bridgePort,
  listenerPids,
  listenerPid,
  procInfo,
  probePort,
  clearStale,
  pickFreePort,
  netstatListeners,
  startBridgeOnce,
  spawnBridgeDirect,
};

/**
 * 桥接目录不写死。优先级：
 *   `configure({ bridgeDir })` > 环境变量 `DSH_PHONE_BRIDGE_DIR` > 自动探测 > 第一个候选目录。
 * 自动探测依次看：`$DSH_HOME/phone-bridge`、当前工作目录下的 `phone-bridge`、
 * 以及用户主目录下的 `phone-bridge`——谁先真的存在就用谁；都不用就落在第一个候选上，
 * 面板会显示「还没装手机通道」并给出它实际找过的路径，而不是抛一堆 ENOENT。
 */
function probeBridgeDir() {
  const fromEnv = process.env.DSH_PHONE_BRIDGE_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const looksInstalled = (dir) => {
    try {
      return existsSync(path.join(dir, 'ensure-running.ps1')) || existsSync(path.join(dir, 'server.mjs'));
    } catch {
      return false;
    }
  };
  const candidates = [];
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'phone-bridge'));
  candidates.push(path.join(process.cwd(), 'phone-bridge'));
  try {
    candidates.push(path.join(os.homedir(), 'phone-bridge'));
  } catch {
    // 拿不到主目录就少一个候选，不影响前面的
  }
  for (const dir of candidates) {
    if (looksInstalled(dir)) return path.resolve(dir);
  }
  return path.resolve(candidates[0]);
}

let BRIDGE_DIR = '';
let RUNTIME_DIR = '';
let PAUSE_FLAG = '';
let STATE_FILE = '';
let PORT_FILE = '';
let TUNNEL_FILE = '';
let ENSURE_PS1 = '';

/** 把内部路径全部指向 dir（configure 与首次探测共用）。 */
function useDir(dir) {
  BRIDGE_DIR = path.resolve(dir);
  RUNTIME_DIR = path.join(BRIDGE_DIR, 'runtime');
  PAUSE_FLAG = path.join(RUNTIME_DIR, 'paused.flag');
  STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
  PORT_FILE = path.join(RUNTIME_DIR, 'port.json');
  TUNNEL_FILE = path.join(BRIDGE_DIR, 'tunnel.json');
  ENSURE_PS1 = path.join(BRIDGE_DIR, 'ensure-running.ps1');
  return BRIDGE_DIR;
}

useDir(probeBridgeDir());

/** 改桥接目录（插件 config.bridgeDir / DSH_PHONE_BRIDGE_DIR），返回实际生效的路径。 */
export function configure(options = {}) {
  const dir = options.bridgeDir || options.dir;
  if (typeof dir !== 'string' || !dir.trim()) return BRIDGE_DIR;
  return useDir(dir.trim());
}

/** 当前生效的桥接目录。 */
export function bridgeDir() {
  return BRIDGE_DIR
}

/** 桥接在不在本机：看入口文件，不看进程。 */
export function installed() {
  try {
    return existsSync(ENSURE_PS1) || existsSync(path.join(BRIDGE_DIR, 'server.mjs'));
  } catch {
    return false;
  }
}

/**
 * 端口不写死。优先级：环境变量 > runtime/port.json（桥接上次成功监听的那个）> 8899。
 * 每次现读文件而不是模块级常量 —— 换端口之后这个插件不用重启就要看到新值。
 */
function readPortJson() {
  const j = readJsonFile(PORT_FILE);
  const p = Number(j && j.port);
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : 0;
}
function bridgePort() {
  const env = Number(process.env.DSH_PHONE_PORT);
  if (Number.isInteger(env) && env >= 1024 && env <= 65535) return env;
  return readPortJson() || 8899;
}
/** 把端口记下来：桥接下次起来会读它，守护脚本和隧道也读它。 */
function writePortJson(port) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(PORT_FILE, JSON.stringify({ port: Number(port), at: new Date().toISOString(), by: 'dsh-remote-connect' }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bridgeToken() {
  const s = readJsonFile(STATE_FILE);
  return s && typeof s.token === 'string' ? s.token : '';
}

function mtimeIso(file) {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

async function health(timeoutMs = 3000, port = bridgePort()) {
  const t = bridgeToken();
  const url = `http://127.0.0.1:${port}/api/health${t ? `?t=${encodeURIComponent(t)}` : ''}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * 一次 netstat 拿全部 LISTENING 端口（缓存 2 秒），**同一个端口可能有多个 pid**。
 * 这在 Windows 上是常态：别人绑 127.0.0.1:8899、桥接绑 0.0.0.0:8899 并不冲突，
 * 但本机请求会走更具体的那条绑定 —— 所以「端口有人听」不等于「桥接能用」。
 */
let netstatCache = { at: 0, map: new Map() };
function netstatListeners() {
  return new Promise((resolve) => {
    if (Date.now() - netstatCache.at < 2000 && netstatCache.map.size) return resolve(netstatCache.map);
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const map = new Map();
      if (!err && stdout) {
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
          if (!m) continue;
          const port = Number(m[1]);
          const pid = Number(m[2]);
          if (!(port > 0) || !(pid > 0)) continue;
          const arr = map.get(port);
          if (arr) {
            if (!arr.includes(pid)) arr.push(pid);
          } else {
            map.set(port, [pid]);
          }
        }
      }
      netstatCache = { at: Date.now(), map };
      resolve(map);
    });
  });
}

/** 这个端口的全部 LISTENING pid。 */
async function listenerPids(port) {
  const map = await netstatListeners();
  return (map.get(Number(port)) || []).slice();
}

function isOurBridge(cmdline) {
  return /server\.mjs/i.test(String(cmdline || ''));
}

/**
 * 这个端口上「自己的桥接」的 pid —— killPid 只该杀这个，绝不能碰别人的程序。
 * 认不出命令行时，只有「这个端口确实在服务我的请求」才敢认领；否则一律返回 null。
 */
async function listenerPid(port = bridgePort()) {
  const pids = await listenerPids(port);
  if (!pids.length) return null;
  for (const pid of pids) {
    const info = await procInfo(pid);
    if (info && isOurBridge(info.cmdline)) return pid;
  }
  if (await health(1200, port)) return pids[0];
  return null;
}

/** 占用者的名字与命令行，用来告诉用户「到底是谁占着这个端口」。 */
function procInfo(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    const ps =
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue;` +
      `if($p){$p.Name + '|' + $p.CommandLine}`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const raw = String(stdout).trim().replace(/\r?\n.*$/s, '');
        const i = raw.indexOf('|');
        if (i < 0) return resolve({ name: raw, cmdline: '' });
        resolve({ name: raw.slice(0, i).trim(), cmdline: raw.slice(i + 1).trim() });
      },
    );
  });
}

/**
 * 探一个端口现在是什么状况：
 *   free    —— 没人监听，可以起
 *   self    —— 自己的桥接已经在里面且能连（/api/health 通）
 *   stale   —— 自己的老桥接占着但已经不响应（杀掉就能复用这个端口）
 *   foreign —— 被别的程序占着，而且我从本机连不通（这才需要提示 / 换端口）
 */
async function probePort(port) {
  const pids = await listenerPids(port);
  const h = await health(1200, port);
  if (h) return { port, state: 'self', pid: pids[0] || null, pids, health: h };
  if (!pids.length) return { port, state: 'free', pid: null, pids: [] };

  const infos = [];
  for (const pid of pids) {
    const i = await procInfo(pid);
    infos.push({ pid, name: (i && i.name) || '', cmdline: (i && i.cmdline) || '' });
  }
  const mine = infos.filter((x) => isOurBridge(x.cmdline));
  const others = infos.filter((x) => !isOurBridge(x.cmdline));

  // 只有自己人（半死不活）：清掉就能继续用这个端口
  if (mine.length && !others.length) return { port, state: 'stale', pid: mine[0].pid, pids, mine, others: [] };

  const owner = others[0] || { pid: pids[0], name: '', cmdline: '' };
  return { port, state: 'foreign', pid: owner.pid, name: owner.name, cmdline: owner.cmdline, pids, mine, others };
}

/** 端口的自己人半死进程先清掉，再看这个端口到底还剩什么。 */
async function clearStale(port) {
  const probe = await probePort(port);
  if (probe.state !== 'stale') return probe;
  for (const m of probe.mine || []) await killPid(m.pid);
  await sleep(500);
  netstatCache.at = 0; // 缓存作废，重新看一遍真实情况
  return probePort(port);
}

/** 从 from 往后找第一个没人监听的端口（跳过桥接自己的那些惯例端口段）。 */
async function pickFreePort(from) {
  const map = await netstatListeners();
  const start = Math.max(1024, Math.min(65535, Number(from) || 8899));
  for (let p = start; p <= Math.min(65535, start + 60); p++) {
    if (!map.get(p)) return p;
  }
  return 0;
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

function runEnsureScript() {
  return new Promise((resolve) => {
    if (!existsSync(ENSURE_PS1)) return resolve({ ok: false, error: `缺少 ${ENSURE_PS1}` });
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ENSURE_PS1],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
      child.unref();
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
    }
  });
}

async function snapshot() {
  const port = bridgePort();
  const h = await health(3000, port);
  const pid = h ? await listenerPid(port) : null;
  const tunnel = readJsonFile(TUNNEL_FILE) || {};
  const st = readJsonFile(STATE_FILE) || {};
  const addrs = h && Array.isArray(h.addresses) ? h.addresses : [];
  const urls = addrs.map((a) => (a && (a.url || (a.host ? `http://${a.host}:${port}` : ''))) || '').filter(Boolean);
  const recommendedAddr = addrs.find((a) => a && a.recommended);

  // 没跑起来时顺手看一眼端口被谁占着：面板要能直接说出「谁」，而不是只报一句「启动失败」
  let conflict = null;
  if (!h) {
    const probe = await probePort(port);
    if (probe.state === 'foreign') {
      conflict = {
        port,
        pid: probe.pid,
        name: probe.name || '未知程序',
        cmdline: probe.cmdline || '',
        suggestPort: await pickFreePort(port === 8899 ? 8900 : port + 1),
      };
    }
  }

  return {
    ok: true,
    bridgeDir: BRIDGE_DIR,
    installed: installed(),
    port,
    running: !!h,
    pid: pid || null,
    paused: existsSync(PAUSE_FLAG),
    pausedAt: existsSync(PAUSE_FLAG) ? mtimeIso(PAUSE_FLAG) : null,
    conflict,
    publicUrl: tunnel.publicUrl || null,
    pairCode: st.pairCode || null,
    recommended: (recommendedAddr && (recommendedAddr.url || `http://${recommendedAddr.host}:${port}`)) || urls[0] || null,
    addresses: urls,
    mode: h ? h.mode : null,
    model: h ? h.model : null,
    voice: h ? h.voice : null,
    sessionId: h ? h.sessionId : null,
    uiVersion: h ? h.uiVersion : null,
    checkedAt: new Date().toISOString(),
  };
}

function candidateNodes() {
  const home = process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  ];
  try {
    const base = path.join(local, 'openai', 'codex', 'runtimes', 'cua_node');
    for (const d of readdirSync(base)) list.push(path.join(base, d, 'bin', 'node.exe'));
  } catch {
    /* ignore */
  }
  list.push('node.exe');
  return list;
}

/** 直接拉起桥接进程（不依赖 ensure-running.ps1，省掉它那套 90 秒锁与 30 秒等待）。 */
async function spawnBridgeDirect(port) {
  const node = candidateNodes().find((p) => p === 'node.exe' || existsSync(p));
  if (!node) return { ok: false, error: '找不到 node.exe' };
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const out = openSync(path.join(RUNTIME_DIR, 'daemon.log'), 'a');
    const err = openSync(path.join(RUNTIME_DIR, 'daemon.err.log'), 'a');
    const child = spawn(node, ['server.mjs'], {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      // 端口必须显式传下去：不传的话子进程会读 port.json，而这次可能正是要换到别的端口
      env: { ...process.env, PHONE_BRIDGE_CHILD: '1', PHONE_BRIDGE_PORT: String(port || bridgePort()) },
    });
    child.unref();
    return { ok: true, node, port: Number(port) || bridgePort() };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

let startingPromise = null;

async function startBridge(opts = {}) {
  // 连点两下不要拉起两个进程：同一时刻只跑一份启动流程
  if (startingPromise) return startingPromise;
  startingPromise = startBridgeOnce(opts).finally(() => {
    startingPromise = null;
  });
  return startingPromise;
}

/**
 * 启动。核心保证：**只要机器上有空端口，就一定起得来**。
 *   端口空着       → 直接起在它上面
 *   自己的桥接在跑 → 直接返回成功
 *   被别的程序占着 → autoPort（默认开）就自动顺延到空闲端口，并在返回值里标明 portChanged，
 *                    让面板能明确告诉主人「端口从 8899 变成 8900 了，手机要换地址」；
 *                    autoPort:false 则原样报错，把占用者信息一起带回去。
 */
async function startBridgeOnce(opts = {}) {
  if (existsSync(PAUSE_FLAG)) {
    try {
      unlinkSync(PAUSE_FLAG);
    } catch {
      /* ignore */
    }
  }
  const t0 = Date.now();
  const wantPort = Number(opts.port) || bridgePort();
  let port = wantPort;

  if (await health(1200, port)) return { started: true, waitedMs: 0, port, portChanged: false, fromPort: wantPort };

  let probe = await clearStale(port);
  if (probe.state === 'foreign') {
    const alt = await pickFreePort(port === 8899 ? 8900 : port + 1);
    const info = {
      port,
      pid: probe.pid,
      name: probe.name || '未知程序',
      cmdline: probe.cmdline || '',
      suggestPort: alt || 0,
    };
    if (opts.autoPort === false || !alt) {
      return {
        started: false,
        conflict: info,
        error: `端口 ${port} 被 ${info.name}（PID ${probe.pid}）占用`,
      };
    }
    port = alt;
  }

  // 换端口这件事必须先落盘：守护脚本、隧道、下次启动都靠 port.json 找过来
  if (port !== wantPort) {
    // 同一份 state.json 撑不起两个桥接进程：老端口上要是还站着自己那个，先请它下来
    const oldPid = await listenerPid(wantPort);
    if (oldPid) {
      await killPid(oldPid);
      await sleep(600);
      netstatCache.at = 0;
    }
    writePortJson(port);
  }

  const direct = await spawnBridgeDirect(port);
  let how = direct.ok ? 'direct' : 'ensure';
  if (!direct.ok) await Promise.race([runEnsureScript(), sleep(6000)]);
  // 首屏体验优先：最多等 8 秒就先把「启动中」返给面板，剩下的交给前端 5 秒轮询。
  while (Date.now() - t0 < 8000) {
    if (await health(1200, port)) {
      return {
        started: true,
        waitedMs: Date.now() - t0,
        how,
        node: direct.node,
        port,
        fromPort: wantPort,
        portChanged: port !== wantPort,
      };
    }
    await sleep(400);
  }
  return {
    started: false,
    starting: true,
    how,
    waitedMs: Date.now() - t0,
    port,
    fromPort: wantPort,
    portChanged: port !== wantPort,
  };
}

/**
 * 换端口：停掉旧端口上的桥接 → 把新端口写进 port.json → 在新端口起来。
 * 和「关闭」不同，这里不留 paused.flag —— 这是搬家，不是关机。
 */
async function switchPort(target) {
  const p = Number(target);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return { switched: false, error: '端口要填 1024–65535 之间的整数' };
  const cur = bridgePort();
  const curAlive = await health(1200, cur);
  if (p === cur && curAlive) return { switched: true, unchanged: true, port: p };

  const probe = await clearStale(p);
  if (probe.state === 'foreign') {
    return {
      switched: false,
      port: p,
      conflict: { port: p, pid: probe.pid, name: probe.name || '未知程序', cmdline: probe.cmdline || '' },
      error: `端口 ${p} 已被 ${probe.name || '别的程序'}（PID ${probe.pid}）占用`,
    };
  }

  // listenerPid 只认「自己的桥接」：端口上只有别人的程序时它返回 null，不会误杀
  const oldPid = await listenerPid(cur);
  if (oldPid) {
    await killPid(oldPid);
    const t1 = Date.now();
    while (Date.now() - t1 < 6000) {
      if (!(await health(600, cur))) break;
      await sleep(300);
    }
  }
  if (existsSync(PAUSE_FLAG)) {
    try {
      unlinkSync(PAUSE_FLAG);
    } catch {
      /* ignore */
    }
  }

  writePortJson(p);
  const r = await startBridge({ port: p, autoPort: false });
  return { switched: !!r.started, port: p, from: cur, ...r };
}

async function stopBridge() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(PAUSE_FLAG, JSON.stringify({ at: new Date().toISOString(), by: 'dsh-remote-connect' }), 'utf8');
  } catch (e) {
    return { stopped: false, error: `写 paused.flag 失败: ${String(e && e.message)}` };
  }
  const pid = await listenerPid();
  const killed = pid ? await killPid(pid) : false;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (!(await health(800))) return { stopped: true, pid: pid || null, killed, waitedMs: Date.now() - t0 };
    await sleep(400);
  }
  return { stopped: false, pid: pid || null, killed, error: '进程仍在响应' };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

/**
 * 同进程直连出口：remote-connect 的「手机通道」页直接调这些函数读状态。
 * 走 127.0.0.1 HTTP 的话，宿主侧 fetch 不带 renderer token，会被
 * 「Browser access is disabled」策略 403 掉，页面就一直显示"没有检测到插件"。
 */
export const api = Object.freeze({
  status: () => snapshot(),
  start: async (body) => {
    const r = await startBridge({ port: body && body.port, autoPort: !(body && body.autoPort === false) });
    return { ...(await snapshot()), ...r };
  },
  stop: async () => {
    const r = await stopBridge();
    return { ...(await snapshot()), ...r };
  },
  port: async (body) => {
    const r = await switchPort(body && body.port);
    return { ...(await snapshot()), ...r };
  },
  paircode: async () => {
    const st = readJsonFile(STATE_FILE) || {};
    return { ok: true, pairCode: st.pairCode || null, token: st.token ? true : false };
  },
});

export function apply(ctx, config = {}) {
  configure(config);
  const webServer = ctx.get('webServer');
  // 供同进程内的其它插件（remote-connect）直连；插件卸载时撤掉
  globalThis.__dshPhoneBridge = api;
  ctx.effect?.(() => () => {
    if (globalThis.__dshPhoneBridge === api) delete globalThis.__dshPhoneBridge;
  });
  const dispose = [];
  const reg = (opts) => {
    const d = webServer.register(opts);
    if (typeof d === 'function') dispose.push(d);
    return d;
  };

  reg({
    kind: 'exact',
    path: '/dsh-phone-api/status',
    async handler(req, res) {
      try {
        writeJson(res, 200, await snapshot());
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  });

  reg({
    kind: 'exact',
    path: '/dsh-phone-api/start',
    async handler(req, res) {
      try {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        // autoPort 默认 true：端口被陌生人占着也要把服务弄起来，宁可换端口并明确告知
        const r = await startBridge({ port: body.port, autoPort: body.autoPort !== false });
        writeJson(res, r.started ? 200 : 504, { ...(await snapshot()), ...r });
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  });

  // 换端口：换个能用的端口重新起桥接（面板上「换端口」按钮走这里）
  reg({
    kind: 'exact',
    path: '/dsh-phone-api/port',
    async handler(req, res) {
      try {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        const r = await switchPort(body.port);
        writeJson(res, r.switched ? 200 : 400, { ...(await snapshot()), ...r });
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  });

  reg({
    kind: 'exact',
    path: '/dsh-phone-api/stop',
    async handler(req, res) {
      try {
        await readBody(req);
        const r = await stopBridge();
        writeJson(res, r.stopped ? 200 : 500, { ...(await snapshot()), ...r });
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  });

  reg({
    kind: 'exact',
    path: '/dsh-phone-api/paircode',
    async handler(req, res) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const code = String(body.code ?? '').trim();
        if (!/^\d{4,8}$/.test(code)) {
          writeJson(res, 400, { ok: false, error: '配对码只能是 4-8 位数字' });
          return;
        }
        const st = readJsonFile(STATE_FILE) || {};
        if (!st.token) {
          writeJson(res, 409, { ok: false, error: '手机桥接还没初始化（state.json 无 token），先点「开启远程服务」' });
          return;
        }
        // 交给桥接改：它把新码写进内存 + state.json，否则下一轮会被内存值回写覆盖
        const r = await fetch(`http://127.0.0.1:${bridgePort()}/api/pair-code?t=${encodeURIComponent(st.token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(6000),
        }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
        if (r.json && r.json.ok) writeJson(res, 200, { ...(await snapshot()), ok: true, pairCode: r.json.pairCode });
        else writeJson(res, r.status || 502, { ok: false, error: (r.json && r.json.error) || '桥接拒绝修改', pairCode: st.pairCode || null });
      } catch (e) {
        const msg = String((e && e.message) || e);
        writeJson(res, 500, {
          ok: false,
          error: msg.includes('fetch') || msg.includes('ECONN') ? '手机桥接没在运行，先点「开启远程服务」' : msg,
        });
      }
    },
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      while (dispose.length) {
        try {
          dispose.pop()();
        } catch {
          /* ignore */
        }
      }
    });
  }
}
