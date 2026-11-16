#!/usr/bin/env node
/**
 * DSH Phone Bridge — MCP 服务端（stdio）。
 *
 * 注册进 DSH 后，模型这边会多出几个工具：
 *   mcp__phone__phone_start       启动手机通道，返回手机能打开的地址和配对码
 *   mcp__phone__phone_stop        关闭手机通道
 *   mcp__phone__phone_status      查看通道状态（地址、会话、消息数）
 *   mcp__phone__phone_new_session 给手机开一段新对话
 *
 * 只依赖 Node 内置模块；MCP over stdio，按行分隔的 JSON-RPC 2.0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime');
const PID_FILE = path.join(RUNTIME, 'bridge.pid');
const LOG_FILE = path.join(RUNTIME, 'daemon.log');
const STATE_FILE = path.join(RUNTIME, 'state.json');
const SYNC_SCRIPT = path.join(HERE, 'sync-profile.mjs');
const PORT = Number(process.env.PHONE_BRIDGE_PORT || 8899);

fs.mkdirSync(RUNTIME, { recursive: true });

/* --------------------------------------------------------------- helpers */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function lanIps() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function urlsWithToken() {
  const { token } = readState();
  if (!token) return [];
  const urls = lanIps().map((ip) => `http://${ip}:${PORT}/?t=${token}`);
  urls.push(`http://127.0.0.1:${PORT}/?t=${token}`);
  return urls;
}

function probe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(false));
  });
}

/** 选一个启动桥接用的 node。
 *  Windows 防火墙是按「程序路径」放行的；这里优先选已被放行的那个（codex 运行时自带的 node），
 *  否则就用当前进程的 node —— 后者可能让手机侧连不上，所以排第二。
 */
function pickNode() {
  if (process.env.PHONE_BRIDGE_NODE) return process.env.PHONE_BRIDGE_NODE;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const root = path.join(base, 'openai', 'codex', 'runtimes', 'cua_node');
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'bin', 'node.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return process.execPath;
}

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) });
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureRunning() {
  let h = await health();
  if (h) return { started: false, health: h };

  const serverPath = path.join(HERE, 'server.mjs');
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(pickNode(), [serverPath], {
    cwd: HERE,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    h = await health();
    if (h) return { started: true, health: h, pid: child.pid };
  }
  throw new Error(`手机通道启动超时，看看日志：${LOG_FILE}`);
}

/** 端口上到底是谁在监听。
 *  bridge.pid 只记「本 MCP 拉起的那一个」，而守护脚本（ensure-running.ps1）也会拉起桥接，
 *  两者的 pid 账本互不相通 —— 只按 pid 文件杀会留下一个还在跑的桥接（phone_stop 报失败）。 */
function portOwners(port) {
  const out = [];
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === Number(port)) out.push(Number(m[2]));
    }
  } catch {}
  return [...new Set(out)];
}

async function stopRunning() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  } catch {}
  const targets = new Set(portOwners(PORT));
  if (pid > 0) targets.add(pid);
  for (const p of targets) {
    if (!p || p === process.pid) continue;
    try {
      process.kill(p);
    } catch (_) {}
  }
  // 端口上若还有监听（不是我们记录的 pid），用健康接口确认是否已退出
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!(await probe(PORT))) {
      try {
        fs.unlinkSync(PID_FILE);
      } catch {}
      return { stopped: true, pid, killed: [...targets] };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { stopped: false, pid, killed: [...targets], note: '端口仍在监听，可能还有别的进程占用' };
}

/* ----------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'phone_start',
    description:
      '启动手机通道：在电脑上开一个局域网服务，手机装好 App 后填入地址+配对码即可直接和本 agent 对话（同一个会话可持续续聊）。返回手机可打开的地址、配对码、本机网卡地址。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_stop',
    description: '关闭手机通道，断开手机端连接。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_status',
    description: '查看手机通道状态：是否在跑、手机地址、当前会话 id、已存消息数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_new_session',
    description: '给手机端开一段全新的对话（清空手机界面与续聊上下文）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_sync_plugins',
    description:
      '把手机关联的 phone profile 与桌面插件清单重新对齐：桌面新装的插件/技能会立刻在手机端可用（手机端下一条消息即生效，不用重装 App）。返回新增/移除的 bundle 与校验结果。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_see',
    description:
      '看一眼手机摄像头里的画面——手机就是你的眼睛。'
      + '手机端打开「让他看」（或用 APK 里的相机按钮）之后，这个工具会把手机眼前的世界直接变成图像给你看：'
      + '主人说「你看一下」「这是什么」「帮我看看这个」「前面有什么」而手机就在旁边时，用它。'
      + '默认等手机现拍一帧（最多等 timeoutMs）；手机正在连续取景时立刻就有新帧。'
      + '返回里若写「不是刚取的」，说明手机此刻没在取景，你看到的是缓冲里最近的一次画面，应当如实告诉主人。'
      + '手机端没打开时取不到画面，这时直接说明，不要编造你看到了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: '要几帧（1–9），默认 1。想看动作/变化时给 2–3。' },
        fresh: { type: 'boolean', description: 'true（默认）= 要现拍的；false = 手上最近的一帧就够，会快很多。' },
        timeoutMs: { type: 'number', description: '等手机推帧的上限，默认 9000，最大 30000。' },
      },
      additionalProperties: false,
    },
  },
];

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

async function callTool(name, args) {
  if (name === 'phone_start') {
    const { started, health: h } = await ensureRunning();
    const urls = urlsWithToken();
    return text(
      [
        started ? '手机通道已启动。' : '手机通道本来就在跑。',
        '',
        '手机打开（同一 Wi-Fi）：',
        ...urls.map((u) => '  ' + u),
        '',
        `配对码：${h.pairCode}`,
        `会话：${h.sessionId ?? '(还没开始，手机发第一句时自动建)'}`,
        '',
        '手机端 App 里填 http://<上面那个 IP>:' + PORT + '，再输入配对码即可。',
        `日志：${LOG_FILE}`,
      ].join('\n'),
    );
  }
  if (name === 'phone_stop') {
    const r = await stopRunning();
    return text(r.stopped ? `手机通道已关闭（pid ${r.pid || '-'}）。` : `关闭未完成：${r.note}`);
  }
  if (name === 'phone_status') {
    const h = await health();
    if (!h) return text('手机通道没在跑。用 phone_start 启动。');
    return text(
      [
        '手机通道运行中。',
        `地址端口：${PORT}`,
        ...urlsWithToken().map((u) => '  ' + u),
        `配对码：${h.pairCode}`,
        `会话：${h.sessionId ?? '(未开始)'}`,
        `忙碌：${h.busy ? '是' : '否'}　排队：${h.queued}`,
        `工作目录：${h.workdir}`,
      ].join('\n'),
    );
  }
  if (name === 'phone_new_session') {
    const h = await health();
    if (!h) return text('手机通道没在跑，先 phone_start。');
    const { token } = readState();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/new-session?t=${token}`, { method: 'POST' });
    return text(res.ok ? '已为手机端开启新会话。' : '开启新会话失败。');
  }
  if (name === 'phone_sync_plugins') {
    const h = await health();
    const base = h ? '手机通道在跑。' : '手机通道没在跑（同步仍会写入清单，启动后生效）。';
    const { token } = readState();
    let r = null;
    if (h) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/sync-plugins?t=${token}`, { method: 'POST' });
      r = await res.json().catch(() => null);
    } else {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync(process.execPath, [SYNC_SCRIPT], { encoding: 'utf8', timeout: 180000 });
      try { r = JSON.parse(out.stdout || '{}'); } catch { r = { ok: false, reason: out.stderr }; }
    }
    if (!r) return text(base + '\n同步请求没有返回结果。');
    const lines = [
      base,
      r.ok ? '同步成功。' : `同步失败：${r.reason ?? '未知原因'}`,
      `bundle 数：${r.bundles ?? '-'}`,
      r.added?.length ? `新增：${r.added.join(', ')}` : '新增：无',
      r.removed?.length ? `移除：${r.removed.join(', ')}` : '移除：无',
      r.skipped?.length ? `加载失败被跳过：${r.skipped.join(', ')}` : '',
      '',
      '手机端不用重装 App，下一条消息就用到新插件。',
    ].filter((x) => x !== '');
    return text(lines.join('\n'));
  }
  if (name === 'phone_see') return seeFrames(args || {});
  throw new Error(`unknown tool ${name}`);
}

/**
 * 手机的眼睛：向桥接要帧，把 base64 直接包成 MCP image content。
 * DSH 的 mcp-client 会做 canonical-base64 校验、要求当前模型声明 image 输入，
 * 然后把图片存成 attachment —— 模型下一句就真能看见画面。
 */
async function seeFrames(args) {
  const { token } = readState();
  if (!token) return text('手机通道还没有过令牌（从没启动）。先调 phone_start。');
  const h = await health();
  if (!h) return text('手机通道没在跑。先 phone_start，再让手机打开那个链接。');

  const n = Math.max(1, Math.min(9, Number(args.n) || 1));
  const timeout = Math.max(0, Math.min(30_000, args.timeoutMs === undefined ? 9000 : Number(args.timeoutMs) || 0));
  const fresh = args.fresh !== false;
  const maxAge = fresh ? 1200 : 3_600_000;
  const qs = `t=${encodeURIComponent(token)}&n=${n}&timeout=${timeout}&maxAge=${maxAge}`;

  let r = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/camera/latest?${qs}`, {
      signal: AbortSignal.timeout(timeout + 10_000),
    });
    r = await res.json().catch(() => null);
  } catch (e) {
    return text(`向手机取帧失败：${e?.message || e}。手机端可能断开了。`);
  }

  const frames = Array.isArray(r?.frames) ? r.frames : [];
  if (!frames.length) {
    return text(
      [
        '手机现在没有画面。',
        `取景状态：${r?.state?.live?.on ? '连续取景开着' : '没在取景'}；缓冲帧数 ${r?.state?.frames ?? 0}。`,
        '让主人打开手机页面里「让他看」那个 📷，把镜头对着要看的东西，然后再调一次 phone_see。',
      ].join('\n'),
    );
  }

  const kb = (b64) => Math.round((String(b64).length * 3) / 4 / 1024);
  const lines = [
    `手机这边 ${frames.length} 帧${frames[0].facing ? `（朝向：${frames[0].facing === 'user' ? '前置，大概是主人自己' : '后置，镜头朝着外面'}）` : ''}：`,
    ...frames.map((f, i) => `  第${i + 1}帧 #${f.n} · ${f.w || '?'}×${f.h || '?'} · ${kb(f.b64)}KB`),
    r?.stale
      ? '⚠ 这些不是刚拍的：手机此刻没在取景，给的是缓冲里最近一次的画面。转述时要说清「这是刚才那一眼」。'
      : '这些是刚取的。',
  ];
  if (typeof r?.ageMs === 'number') lines.push(`距上一次推帧 ${Math.max(0, Math.round(r.ageMs))} ms。`);

  const content = [{ type: 'text', text: lines.join('\n') }];
  for (const f of frames) {
    // 只传规范 base64（server 用 buf.toString('base64') 生成，天然合规）
    content.push({ type: 'image', data: f.b64, mimeType: f.mime || 'image/jpeg' });
  }
  return { content };
}

/* ------------------------------------------------------------ MCP 循环 */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

let buf = '';
let pending = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notification，不回应
    pending += 1;
    try {
      if (method === 'initialize') {
        reply(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-phone-bridge', version: '1.0.0' },
          instructions:
            '手机通道：phone_start 让手机（同一 Wi-Fi）连上本 harness 直接对话；phone_status 查看地址与配对码；phone_see 借用手机摄像头看一眼手机眼前的世界（手机端需打开「让他看」）。',
        });
      } else if (method === 'tools/list') {
        reply(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const result = await callTool(params?.name, params?.arguments);
        reply(id, result);
      } else if (method === 'ping') {
        reply(id, {});
      } else if (method === 'resources/list') {
        reply(id, { resources: [] });
      } else if (method === 'prompts/list') {
        reply(id, { prompts: [] });
      } else {
        fail(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      fail(id, -32603, String(err?.message ?? err));
    } finally {
      pending -= 1;
      maybeExit();
    }
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
