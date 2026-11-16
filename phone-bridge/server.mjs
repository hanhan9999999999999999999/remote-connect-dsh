#!/usr/bin/env node
/**
 * DSH Phone Bridge — 手机连我这个 agent 的后端。
 *
 * 它做三件事：
 *   1. 在局域网上开一个手机能打开的网页（聊天界面）；
 *   2. 把手机发来的每句话，转成一次 `dsh headless` 运行（同一个 session 续聊）；
 *   3. 把 agent 的回复 / 思考 / 工具调用，通过 SSE 实时推回手机。
 *
 * 不依赖任何 npm 包，只用 Node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSessions, readTranscript, sessionCwd, searchAll, warmIndex, fullTranscript, cacheStats as txStats } from './sessions.mjs';
import * as link from './link.mjs';
import * as tts from './tts.mjs';
import * as reminders from './reminders.mjs';
import * as prefs from './prefs.mjs';
import * as todos from './todos.mjs';
import * as perf from './perf.mjs';
import * as push from './push.mjs';
import * as asr from './asr.mjs';
import * as memory from './memory.mjs';
import * as clipboard from './clipboard.mjs';
import { SdkRunner } from './runner-sdk.mjs';
import { processMessage } from './pipeline.mjs';
import { sync as syncPlugins, syncIfStale, lastSync } from './sync-profile.mjs';
import { readJson, writeJson, writeAtomic, readJsonLines, statOf } from './store.mjs';

// 常驻后台：把自身优先级压到「低于正常」，不跟前台程序抢 CPU
try {
  os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}

// 隧道 URL 变化 / 掉线自愈，都实时推给手机端；同时留一份可追溯的日志
// （旧版重建只活在内存里，出问题只能靠猜）
let lastLinkUrl = '';
link.onChange((st) => {
  broadcast('link', st);
  const url = st && st.running ? st.url : '';
  if (url && url !== lastLinkUrl) {
    log('tunnel', lastLinkUrl ? `公网通道重建：${lastLinkUrl} -> ${url}` : `公网通道已连通：${url}`);
    lastLinkUrl = url;
  } else if (!url && lastLinkUrl) {
    log('tunnel', `公网通道断开：${(st && st.error) || '原因未知'}（看门狗会每 ${Math.round(Number(process.env.PHONE_TUNNEL_WATCH_MS || 30000) / 1000)} 秒重试）`);
    lastLinkUrl = '';
  }
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime');
const STATE_FILE = path.join(RUNTIME, 'state.json');
const LOG_FILE = path.join(RUNTIME, 'bridge.log');
// 日志按 5MB 轮转一次，只留上一份。以前它会无限长，出问题时翻到最后反而看不到现场。
const LOG_MAX = 5 * 1024 * 1024;
try {
  if (fs.statSync(LOG_FILE).size > LOG_MAX) {
    fs.rmSync(LOG_FILE + '.1', { force: true });
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  }
} catch {}

// DSH 的入口在这台机器上搬过家（C:\deepseekharness → D:\DSH\DSH NEXT）。写死一条会悄悄失效：
// 进程起不来，手机上却只看到「没反应」。所以按候选顺序取第一个真的存在的那个；
// 一个都不在时退回第一条，报错信息里还看得出该去哪找。
function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return list[0];
}

const DEFAULT_DSH_BIN = firstExisting([
  'D:\\DSH\\DSH NEXT\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  'D:\\deepseekharness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
]);
const DSH_BIN = process.env.DSH_BIN || DEFAULT_DSH_BIN;
// 跑 agent 用的 node：默认用 DSH 自带的那个（版本与 DSH 一致最稳）。
// 桥接进程自己可以用另一个 node 启动（例如被防火墙放行的那个），两者解耦。
const DEFAULT_DSH_NODE = firstExisting([
  'D:\\dsh-home\\dsh-runtimes\\dsh-next-primary-runtime\\dependencies\\node\\bin\\node.exe',
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  process.execPath,
]);
const DSH_NODE = process.env.PHONE_DSH_NODE || DEFAULT_DSH_NODE;
// 手机端跑的是专用精简 profile（phone-lite），这样换模型只影响手机，不动桌面/headless。
// 2026-11-01：从 25 个 bundle 的 phone 精简到 base+headless+dsh-ops+本地条款注入，
// 每轮提示词 54K→7.8K token，冷启动 12.4s→2.3s（桌面 profile 完全不受影响）。
const DSH_PROFILE = process.env.PHONE_DSH_PROFILE || 'phone-lite';
// ⚠ DSH 的数据目录已经搬到 D 盘（DSH_HOME=D:\dsh-home）。这里以前写死 os.homedir()\.dsh，
// 于是 profile 被写到 C 盘，而 dsh 子进程按 DSH_HOME 去 D 盘找 —— 每一条手机消息都报
// 「profile "phone-lite" does not exist」，一个字都不回。两边都认：有 DSH_HOME 就跟它走。
const DSH_HOME_DIR =
  process.env.DSH_HOME ||
  (() => {
    try {
      if (fs.existsSync('D:\\dsh-home')) return 'D:\\dsh-home';
    } catch {}
    return path.join(os.homedir(), '.dsh');
  })();
const PHONE_PROFILE_DIR = path.join(DSH_HOME_DIR, 'profiles', DSH_PROFILE);
const PHONE_PROFILE_PATCH = path.join(PHONE_PROFILE_DIR, 'cordis.patch.yml');

// 跑法两种：
//   sdk  —— 常驻进程 + stdio JSON-RPC，冷启动只付一次（默认，实测每轮省 ~2.0s）
//   spawn —— 老路子，每轮起一个新进程（出问题时的回退开关）
// 2026-11-01 实测：常驻 SDK 首轮可用（5.8s），但在「resume 了历史会话」之后
// 第二个 session/prompt 会一直等不到事件（server 报 session is already open）。
// 稳定性优先：默认走 spawn（每轮 2.2s 冷启动，已比原来 12.4s 快一个数量级），
// 常驻路径留作实验开关 PHONE_ENGINE=sdk，等摸清 resume/turn 状态机再切换。
const ENGINE = String(process.env.PHONE_ENGINE || 'spawn').toLowerCase() === 'sdk' ? 'sdk' : 'spawn';
const SDK_PROFILE = process.env.PHONE_DSH_PROFILE_SDK || 'phone-sdk';

// DeepSeek 账号路由提供的两个模型（见 dsh-llm-deepseek 的 DEFAULT_MODELS）
const MODELS = [
  { id: 'deepseek-flash', name: 'V4.1 Flash', note: '快、便宜，日常够用', default: true },
  { id: 'deepseek-v4-pro', name: 'V4 Pro', note: '更强推理与写码，慢一些、贵一些' },
];
const DEFAULT_MODEL = MODELS[0].id;
// 推理档：deepseek 只认 low/high/max（没有 medium）。实测 high 与 low 的首字延迟一样
// （3.3s / 3.7s vs 3.1s，冷缓存噪声），所以默认给 high，质量不亏、速度不慢。
const DEFAULT_EFFORT = process.env.PHONE_REASONING_EFFORT || 'high';
// 手机版条款：桌面那份 48KB 总条款（R1-R12 技能路由等）在手机上纯属负担，换成 2KB 精简版。
// 条款只有一份：桌面 dsh-purge 注入的就是 $DSH_HOME/prompt-inject.md。
// 以前这里指向 phone-bridge/phone-inject.md（1.4KB 精简版，2026-11-01 写的），
// 结果手机上大量条款缺席、该松的地方还在收着 —— 现在改成同一份，改一处两边一起变。
const MASTER_INJECT_FILE = process.env.PHONE_PROMPT_INJECT
  || path.join(process.env.PHONE_DSH_HOME || DSH_HOME_DIR || os.homedir(), 'prompt-inject.md');


/**
 * 手机 profile 注入的是**清理过**的一份副本。
 * 桌面那份 prompt-inject.md 开头带着 <|im_start|>system:<project_instructions> 这种聊天模板标记
 * （dsh-purge 在代码层注入时会把它们吃掉），可 phone profile 的 local-prompt-inject 是把文件原文
 * 拼进 system 段——这些标记会原样发给模型，接口直接报错，表现就是「每条消息 exit=1、一个字都不回」。
 * 所以这里生成 runtime/inject-phone.md：去掉模板标记行，正文一字不改。
 */
function buildPhoneInject() {
  if (process.env.PHONE_INJECT_FILE) return process.env.PHONE_INJECT_FILE;
  const src = MASTER_INJECT_FILE;
  try {
    if (!fs.existsSync(src)) return path.join(HERE, 'phone-inject.md');
    const raw = fs.readFileSync(src, 'utf8');
    const clean = raw
      .split(/\r?\n/)
      .filter((line) => !/^\s*<\|im_(start|end)\|>/.test(line) && !/^\s*<\/?(project_instructions|system-reminder)>\s*$/.test(line))
      .join('\n')
      .trim();
    const out = path.join(HERE, 'runtime', 'inject-phone.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (prev !== clean + '\n') fs.writeFileSync(out, clean + '\n');
    log('inject', `手机条款来自 prompt-inject.md（${clean.length} 字，已去掉模板标记）`);
    return out;
  } catch (e) {
    log('inject', '手机条款回退到 phone-inject.md：' + (e && e.message));
    return path.join(HERE, 'phone-inject.md');
  }
}
const PHONE_INJECT_FILE_RESOLVED = buildPhoneInject();
const PROFILE_HEADER = `# 手机通道专用 profile（phone-bridge 自动维护，换模型会重写本文件）。`;
const PROFILE_BODY = (model, effort = DEFAULT_EFFORT) => `${PROFILE_HEADER}
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: credentials
  disabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: ${model}
    reasoningEffort: ${effort}
- insert:
    - id: llm-deepseek-account
      name: "@deepseek-ai/dsh-llm-deepseek-account"
# 权限档位：手机上没有地方点「同意」，所以默认 danger-full-access + 不询问（与桌面 profile 一致）。
# 不写这一段，permission-presets 会因为「组合出的默认值匹配不到任何 preset」起不来，
# 表现是每条消息都 exit=1、一个字都不回。
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
# ---- 手机端裁剪（2026-11-01）----
# 151 个技能的目录本身就要上万 token，手机端不需要 → 关掉三个 skill entry
- id: tool-skill
  disabled: true
- id: skill-filesystem
  disabled: true
- id: skill
  disabled: true
# 手机端要能干活：shell + 文件工具
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    promptPolicy: true
    publishBashTool: true
    shellPolicy: advise
    allowSystemShellFallback: false
    configUpdateVersion: 2
- id: dsh-ops-file
  name: dsh-ops/file
  config:
    promptPolicy: true
    required: false
    configUpdateVersion: 2
# 精简条款走 system 段注入（替代桌面 profile 的 dsh-purge-community）
- id: local-prompt-inject
  name: "@local/dsh-prompt-inject"
  config:
    file: "${PHONE_INJECT_FILE_RESOLVED.replace(/\\/g, '\\\\')}"
# ---- 手机的眼睛：MCP 带着 phone_see（手机摄像头 → 模型直接看见）----
# 注意必须用 insert：patch 里的「- id: xxx」只能改已存在的条目，改不到 mcp-client
# 就会报 entry not found，什么也不会加载。
# 用的是跑桥接进程的这个 node（它一定存在）。DSH_NODE 的默认值在 DSH 搬到 D 盘后
# 指向了旧的 C 盘路径，这里不跟它走，免得 MCP 拉不起来。
- insert:
    - id: phone-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: phone
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(path.join(HERE, 'mcp-phone.mjs'))}
`;

/** 让 ~/.dsh/profiles/phone 存在且模型正确；改模型时只需重写 patch。 */
function ensurePhoneProfile(model) {
  const id = (MODELS.find((m) => m.id === model) || MODELS[0]).id;
  try {
    fs.mkdirSync(PHONE_PROFILE_DIR, { recursive: true });
    const files = {
      'cordis.yml': '# dsh profile root — patches only.\n[]\n',
      'package.json': JSON.stringify(
        {
          name: 'dsh-profile-phone-lite',
          private: true,
          dependencies: {
            'dsh-ops': '0.4.1',
            '@local/dsh-prompt-inject': 'file:../../plugins/dsh-prompt-inject',
          },
          dsh: {
            profile: {
              bundles: [
                '@deepseek-ai/dsh-base',
                '@deepseek-ai/dsh-headless',
                'dsh-ops',
                '@local/dsh-prompt-inject',
              ],
            },
          },
        },
        null,
        2,
      ) + '\n',
      'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    };
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(PHONE_PROFILE_DIR, name);
      if (!fs.existsSync(p)) fs.writeFileSync(p, content);
    }
    const next = PROFILE_BODY(id);
    let cur = '';
    try {
      cur = fs.readFileSync(PHONE_PROFILE_PATCH, 'utf8');
    } catch {}
    if (cur !== next) fs.writeFileSync(PHONE_PROFILE_PATCH, next);
  } catch (e) {
    log('profile-error', String(e && e.message));
  }
  return id;
}

// 端口的单一事实来源。优先级：环境变量（插件/守护脚本显式指定）> runtime/port.json（上次成功监听的那个）> 8899。
// 换端口只需要改 port.json，插件、守护脚本、隧道都跟着它走，不用改代码。
const PORT_FILE = path.join(RUNTIME, 'port.json');
function readPortFile() {
  try {
    const j = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    const p = Number(j && j.port);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
  } catch (_) {
    /* 没有就按默认 */
  }
  return 0;
}
/** 扫一遍当前谁在监听哪些端口：port -> { hosts:Set, pids:[] }。端口守卫要用。 */
function listeningPorts() {
  const map = new Map();
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      const p = Number(m[2]);
      if (!map.has(p)) map.set(p, { hosts: new Set(), pids: [] });
      map.get(p).hosts.add(String(m[1]).toLowerCase());
      map.get(p).pids.push(Number(m[3]));
    }
  } catch (_) {
    /* 拿不到就当全空闲，交给后面的 EADDRINUSE 兜底 */
  }
  return map;
}

let PORT = Number(process.env.PHONE_BRIDGE_PORT || readPortFile() || 8899);

// Windows 允许 0.0.0.0:8899 和 127.0.0.1:8899 同时绑上，而本机请求只会走「更具体」的那个。
// 别人先占了 127.0.0.1 的话，我们照样能绑 0.0.0.0、手机走局域网也连得上 —— 只有本机永远连不进来，
// 面板于是显示「未运行」，可服务其实活着。这种状态最难查，不如主动让开。
const _portMap = listeningPorts();
const _taken = _portMap.get(PORT);
if (_taken && _taken.hosts.has('127.0.0.1')) {
  let alt = 0;
  for (let p = PORT + 1; p < PORT + 60 && p <= 65535; p++) {
    if (!_portMap.has(p)) {
      alt = p;
      break;
    }
  }
  if (alt) {
    console.log(`[port] 127.0.0.1:${PORT} 被 pid=${_taken.pids.join(',')} 占着（那不是我们），改绑 ${alt}`);
    PORT = alt;
  }
}

/** 记住「这次真的在这个端口上起来了」，下次没传环境变量时就用它。 */
function rememberPort() {
  try {
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port: PORT, pid: process.pid, at: new Date().toISOString() }), 'utf8');
  } catch (_) {
    /* 写不进去不影响服务 */
  }
}
const HOST = process.env.PHONE_BRIDGE_HOST || '0.0.0.0';
const WORKDIR = process.env.PHONE_BRIDGE_WORKDIR || path.join(HERE, 'workspace');
const MAX_TURNS = 400;

fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });

/* ------------------------------------------------------------------ state */

function loadState() {
  // 坏档会被隔离成 state.json.corrupt-*，再从 state.json.bak 恢复；
  // 两者都没有才用空对象（旧实现把半截 JSON 当空对象，紧接着 saveState 又覆盖一次，
  // token/pairCode 就这么永久丢了）。
  return readJson(STATE_FILE, {}, { quiet: false }) || {};
}
let saveTimer = null;
function saveMessagesSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const list = messages;
    // 保护：内存里是空的、磁盘上却有内容 → 拒绝覆盖。
    // （曾经因为某次误调用把 messages.jsonl 覆盖成 0 字节，历史全丢）
    if (!list.length) {
      try {
        const f = msgFile();
        if (fs.existsSync(f) && fs.statSync(f).size > 2) {
          log('save-guard', '内存为空但磁盘有内容，已跳过覆盖 ' + path.basename(f));
          return;
        }
      } catch (_) {}
    }
    const body = list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : '');
    try {
      writeAtomic(msgFile(), body);
    } catch (_) {}
  }, 120);
}

/**
 * 把某个消息数组写进指定文件：空数组保护 + 原子写。
 * 旧代码在四处直接 writeFileSync 全量覆盖，进程被杀时留下半截 JSONL。
 */
function writeMessagesTo(file, list) {
  if (!list.length) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2) {
        log('save-guard', '内存为空但磁盘有内容，已跳过覆盖 ' + path.basename(file));
        return false;
      }
    } catch (_) {}
  }
  try {
    writeAtomic(file, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''));
    return true;
  } catch (e) {
    log('save-error', '消息落盘失败：' + String((e && e.message) || e));
    return false;
  }
}

/** 只保留最近 keep 个匹配 prefix 的文件，其余删掉（按 mtime 新旧）。
 *  runtime 里的 `.bak-<毫秒>` 和 `messages.backup-*.jsonl` 每次还原/导出都各写一份，
 *  不清理的话这个目录只会越长越乱。 */
function pruneStale(dir, prefix, keep) {
  try {
    const olds = fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .map((n) => {
        let t = 0;
        try { t = fs.statSync(path.join(dir, n)).mtimeMs; } catch (_) {}
        return { n, t };
      })
      .sort((a, b) => b.t - a.t)
      .slice(keep);
    for (const o of olds) { try { fs.unlinkSync(path.join(dir, o.n)); } catch (_) {} }
    return olds.length;
  } catch (_) {
    return 0;
  }
}

function saveState(next) {
  state = { ...state, ...next };
  writeJson(STATE_FILE, state, { pretty: true });
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}
function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

let state = {
  token: newToken(),
  pairCode: newPairCode(),
  sessionId: null,
  cwd: null,
  model: DEFAULT_MODEL,
  voice: 'Huihui',
  speakAuto: false,
  // 按住说话识别完是否直接发出去；关掉就只填进输入框，等用户改
  asrAutoSend: true,
  ttsChain: true,
  // 语音输出引擎：edge（微软在线）/ feiyu（本机 CosyVoice3）/ onecore（系统 SAPI）
  ttsEngine: 'edge',
  mode: 'work',
  lifeSessionId: null,
  lifeCwd: null,
  createdAt: new Date().toISOString(),
  ...loadState(),
};
saveState({});
ensurePhoneProfile(state.model);

// 把桌面装的插件清单镜像到手机端 profile（幂等；桌面清单没变时是零成本）。
try {
  const r = syncIfStale();
  // 后台预热会话索引：用户第一次「搜全部」时就不用等解压
  setTimeout(() => {
    try {
      warmIndex();
      log('index', '会话索引已预热');
    } catch (e) {
      log('index-error', e.message);
    }
  }, 20000).unref();

  log('plugins', r.ok ? `同步完成 bundles=${r.bundles ?? '-'}${r.added?.length ? ' 新增=' + r.added.join(',') : ''}` : `同步失败：${r.reason}`);
} catch (e) {
  log('plugins-error', e.message);
}

const UPLOAD_LIMIT = Number(process.env.PHONE_UPLOAD_LIMIT_MB || 64) * 1024 * 1024;

/* ------------------------------------------------------------------- log */

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// 关键链路里的异常一律走这里：既写日志，也进内存环形缓冲，
// 让「日志里有错但界面看不出来」的情况能在诊断页和顶部横幅里冒头
const errBuf = [];
function catchErr(tag, e) {
  const msg = String((e && e.message) || e || '').slice(0, 200);
  errBuf.push({ at: Date.now(), tag, msg });
  if (errBuf.length > 30) errBuf.shift();
  log(tag + '-error', msg);
}
function recentErrors(n = 10) { return errBuf.slice(-n); }

/* --------------------------------------------------------------- messages */

const MESSAGES_FILE = path.join(RUNTIME, 'messages.jsonl');
const MESSAGES_LIFE_FILE = path.join(RUNTIME, 'messages-life.jsonl');

function readJsonl(file) {
  // 逐行容错：断电留下的半截末行不再让整份历史都读不出来（旧实现一行坏 → 返回 []）
  const r = readJsonLines(file);
  if (r.bad) log('messages', `${path.basename(file)} 跳过 ${r.bad} 行坏数据`);
  return r.items;
}

let messagesWork = readJsonl(MESSAGES_FILE);
let messagesLife = readJsonl(MESSAGES_LIFE_FILE);
let messages = state.mode === 'life' ? messagesLife : messagesWork;

function msgFile() {
  return state.mode === 'life' ? MESSAGES_LIFE_FILE : MESSAGES_FILE;
}
function modeMessages(mode) {
  return mode === 'life' ? messagesLife : messagesWork;
}

/* 只是一句话的备忘（切后台/回前台这类）：直接落进会话，不叫模型 */
function noteToChat(text) {
  const msg = { id: 'note-' + Date.now(), role: 'assistant', text, at: Date.now(), system: true, kind: 'note' };
  appendMessage(msg);
  return msg;
}
function appendMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_TURNS * 4) messages.splice(0, messages.length - MAX_TURNS * 4);
  // 注意：落盘统一交给 saveMessagesSoon()（全量覆盖写）。
  // 这里若再 appendFile 一次，同一条会被写两遍（历史 bug，2026-10-30 修）。
  saveMessagesSoon();
  broadcast('message', msg);
}

/* ------------------------------------------------------------ sse clients */

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

// 流式文本合批：40ms 内累积的片段合成一帧推出去，手机端少收几十倍的消息帧
const deltaBuf = { text: '', thinking: '', turnId: null, timer: null };
function flushDelta() {
  const t = deltaBuf.text;
  const k = deltaBuf.thinking;
  const id = deltaBuf.turnId;
  deltaBuf.text = '';
  deltaBuf.thinking = '';
  deltaBuf.timer = null;
  if (t) broadcast('delta', { turnId: id, kind: 'text', text: t });
  if (k) broadcast('delta', { turnId: id, kind: 'thinking', text: k });
}
function pushDelta(turnId, kind, text) {
  deltaBuf.turnId = turnId;
  if (kind === 'thinking') deltaBuf.thinking += text;
  else deltaBuf.text += text;
  if (!deltaBuf.timer) deltaBuf.timer = setTimeout(flushDelta, 40);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

/* ---------------------------------------------------- 守护互保（闭环自愈）
 * 守护脚本每分钟写一次 runtime/guard.alive；这里每 5 分钟看一眼：
 * 超过 4 分钟没更新，说明守护没了，桥接自己把它拉起来。
 * 于是「守护拉起桥接 / 桥接拉起守护」，任意一方活着就能自愈。
 */
const GUARD_ALIVE = path.join(RUNTIME, 'guard.alive');
const GUARD_VBS = path.join(HERE, 'dsh-phone-guard.vbs');
let guardChecked = 0;
function checkGuard() {
  try {
    const now = Date.now();
    if (now - guardChecked < GUARD_CHECK_MS / 2) return;
    guardChecked = now;
    let age = Infinity;
    try {
      age = now - fs.statSync(GUARD_ALIVE).mtimeMs;
    } catch {}
    if (age < 4 * 60_000) return;
    if (!fs.existsSync(GUARD_VBS)) return;
    const w = spawn('wscript.exe', [GUARD_VBS], { detached: true, stdio: 'ignore', windowsHide: true });
    w.unref();
    log('guard', '守护脚本不在，已重新拉起');
  } catch (e) {
    log('guard-error', String(e && e.message));
  }
}
const GUARD_CHECK_MS = Number(process.env.PHONE_GUARD_CHECK_MS || 5 * 60_000);
setInterval(checkGuard, GUARD_CHECK_MS).unref();

setInterval(() => {
  for (const res of clients) {
    try {
      // 用真正的事件而不是注释：注释不会触发浏览器的 message 事件，前端就没法据此判断链路是否还活着
        res.write('event: ping\ndata: ' + Date.now() + '\n\n');
    } catch {}
  }
}, 25_000).unref();

/* --------------------------------------------------------------- run loop */

/** @type {{text: string, id: string}[]} */
const queue = [];
/** 客户端重复投递去重：clientId -> { id, at }（断网补发可能把同一句发两次） */
const seenClientIds = new Map();
const CLIENT_ID_TTL_MS = 10 * 60_000;
let running = null; // { child, id }
// 「清空历史」时正在跑的那一轮要被作废：这些 turn 收尾时不许再往（已经清空的）列表里写
const discardTurns = new Set();
let busy = false;

/* ---------------------------------------- 摄像头：手机这双眼睛（对齐 see_now）
 * 手机端把画面推上来，这里只留最近若干帧；DSH 侧的 phone_see 工具按需取走。
 * 两条通路刻意分开：
 *   推（live）—— 手机开着取景时按 fps 推，随时能看，费电费流量；
 *   拉（arm） —— 手机挂一条长轮询，AI 真要看时才睁眼，默认走这条。
 * 帧一律留在内存里，不落盘：这是「此刻眼前」，不是相册。
 */
const CAM_MAX_FRAMES = Math.max(1, Math.min(64, Number(process.env.PHONE_CAM_BUFFER || 12)));
const CAM_MAX_BYTES = Math.max(64 * 1024, Number(process.env.PHONE_CAM_LIMIT_MB || 8) * 1024 * 1024);
const cam = {
  frames: [], // [{ n, ts, mime, b64, w, h, facing }]，n 单调递增
  seq: 0,
  lastPushAt: 0,
  totalPushes: 0,
  arm: new Set(), // 等着「AI 要看一眼」的手机长轮询 res
  waiters: new Set(), // 等着手机推帧的 AI 侧请求
  live: { on: false, at: 0, fps: 0, w: 0, h: 0, facing: '', lastCommentAt: 0, comments: 0, gapMs: 0, paused: false },
  // 手机自检的最近一次结果：哪条路抓到的、多大、多久、失败原因。
  // 主人只要用一次，这里就有证据，不用他替我复述。
  recent: [],
  probe: null,
  // 拦下的全黑帧：手机那边判定「这一帧是黑的」就报一次。
  // 主人再问「怎么全黑」，这里直接有数字，不用他替我复述。
  blank: { n: 0, at: 0, why: '' },
  diagReq: null,   // 电脑这边点一下，让手机自己跑一次自检 // { ok, src, w, h, kb, ms, at, why }
};

/** 手机推上来一帧。返回落进缓冲的那一帧。 */
function camPush(buf, mime, meta) {
  cam.seq += 1;
  const frame = {
    n: cam.seq,
    ts: Date.now(),
    mime,
    b64: buf.toString('base64'),
    w: Number(meta?.w) || 0,
    h: Number(meta?.h) || 0,
    facing: String(meta?.facing || ''),
    via: String(meta?.via || '').slice(0, 16),
    ms: Number(meta?.ms) || 0,
  };
  cam.frames.push(frame);
  while (cam.frames.length > CAM_MAX_FRAMES) cam.frames.shift();
  cam.lastPushAt = frame.ts;
  cam.totalPushes += 1;
  // 最近 8 帧的端到端记录：哪条路、多大、从「拍到」到「落盘」多少毫秒。
  try {
    if (!Array.isArray(cam.recent)) cam.recent = [];
    cam.recent.unshift({ n: frame.n, at: frame.ts, kb: Math.max(1, Math.round(buf.length / 1024)), w: frame.w, h: frame.h, via: String(frame.via || ''), ms: Number(frame.ms) || 0 });
    while (cam.recent.length > 8) cam.recent.pop();
  } catch (_) {}
  // 头两帧和之后每 10 帧记一行：手机到底有没有把画面送过来，看日志就够，
  // 不用再让主人替我猜「是不是没传过去」。
  if (cam.totalPushes <= 2 || cam.totalPushes % 10 === 0) {
    log('camera', `收到帧 #${frame.n} ${frame.w}x${frame.h} ${Math.round(buf.length / 1024)}KB ${mime}（累计 ${cam.totalPushes}）`);
  }
  for (const w of [...cam.waiters]) camSettle(w);
  return frame;
}

/** 新帧到了 / 到点了：把满足条件的等待者交出去。 */
function camSettle(w, force) {
  if (w.done) return;
  const fresh = cam.frames.filter((f) => f.n > w.since);
  if (!force && fresh.length < w.need) return;
  w.done = true;
  cam.waiters.delete(w);
  if (w.timer) clearTimeout(w.timer);
  try { w.resolve(fresh); } catch (_) {}
}

/** 等手机推上来 need 帧（比 since 新的），超时就把已有的交出去。 */
function camAwait(need, since, timeoutMs) {
  return new Promise((resolve) => {
    const w = { need, since, done: false, resolve };
    w.timer = setTimeout(() => camSettle(w, true), Math.max(0, timeoutMs) + 60);
    cam.waiters.add(w);
    camSettle(w); // 可能已经有够新的帧了，别白等
  });
}

/** 叫醒 n 个挂着的手机：「现在拍一张」。返回叫醒了几台。 */
function camArmWake(n = 1) {
  let woke = 0;
  for (const w of [...cam.arm]) {
    if (woke >= n) break;
    try {
      if (w.fire({ ok: true, grab: true, at: Date.now(), live: cam.live.on })) woke += 1;
    } catch (_) {}
  }
  return woke;
}

/** 画面状态：给 currentStatus / 诊断用。 */
function camState() {
  const newest = cam.frames[cam.frames.length - 1];
  return {
    frames: cam.frames.length,
    seq: cam.seq,
    arms: cam.arm.size,
    waiting: cam.waiters.size,
    lastPushAt: cam.lastPushAt,
    ageMs: cam.lastPushAt ? Date.now() - cam.lastPushAt : null,
    totalPushes: cam.totalPushes,
    live: { ...cam.live },
    probe: cam.probe ? { ...cam.probe, ageMs: Date.now() - cam.probe.at } : null,
    blank: { n: cam.blank.n, at: cam.blank.at || null, ageMs: cam.blank.at ? Date.now() - cam.blank.at : null, why: cam.blank.why || '' },
    diag: cam.diagReq ? { id: cam.diagReq.id, ageMs: Date.now() - cam.diagReq.at } : null,
    size: newest ? { w: newest.w, h: newest.h, mime: newest.mime } : null,
  };
}

/* 直播开着却一直没画面：30 秒没收到帧就说一声，别让人对着空气等。
   页面那边会把这句当成系统提示显示在会话里。 */
const liveWatchdog = setInterval(() => {
  const L = cam.live;
  if (!L.on) {
    L.stalled = false;
    return;
  }
  const ref = cam.lastPushAt || L.at || Date.now();
  const idle = Date.now() - ref;
  if (idle > 30000 && !L.stalled) {
    L.stalled = true;
    console.log(`直播 ${Math.round(idle / 1000)}s 没有新帧 —— 提醒一次`);
    broadcast('system', {
      text: '已经 30 秒没有画面送过来了：手机那边多半卡在权限或抓帧上。点直播条上的齿轮 →「测一下现在的画面」，就能看到是哪条路不通、为什么。',
    });
  } else if (idle < 15000 && L.stalled) {
    L.stalled = false;
  }
}, 5000);
if (liveWatchdog.unref) liveWatchdog.unref();

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
function humanSize(n) {
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${SIZE_UNITS[i]}`;
}

async function enqueue(text, files = [], opts = {}) {
  // server.mjs 改过：把这条消息先落盘，重启让新代码生效，重启后自动补跑（所以消息不会丢）
  if (process.env.PHONE_AUTO_RESTART !== '0' && fs.existsSync(RESTART_FLAG) && !busy && queue.length === 0) {
    let ok = false;
    try {
      fs.writeFileSync(PENDING_MSG, JSON.stringify({ text: text, files: files || [], opts: opts || {}, at: Date.now() }));
      fs.unlinkSync(RESTART_FLAG);
      ok = true;
    } catch (e) { catchErr('restart-prep', e); }
    if (ok) {
      // 已知接不上的会话（电脑端开的）不要带着重启，否则补跑会再撞一次墙
      if (CUR_SID() && badSessionSet.has(CUR_SID())) {
        setCUR_SID(null, { force: true });
        log('restart', '当前会话已知接不上，补跑时直接开新会话');
      }
      broadcast('system', { text: '电脑端服务改过了，我先重启一下让改动生效；这条消息重启后自动补上，不用重发。' });
      log('restart', '检测到待重启标记，先重启再跑这条');
      setTimeout(() => {
        try {
          if (fs.existsSync(GUARD_VBS)) spawn('wscript.exe', [GUARD_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch (_) {}
        process.exit(0);
      }, 500);
      return;
    }
  }
  const id = crypto.randomUUID().slice(0, 8);
  const list = Array.isArray(files)
    ? files
        .filter((f) => f && typeof f.path === 'string' && /^uploads\/[^/\\]+$/.test(f.path))
        .map((f) => ({ path: f.path, name: String(f.name || path.basename(f.path)).slice(0, 120), size: Number(f.size) || 0, mime: String(f.mime || '') }))
    : [];

  // opts.display / opts.kind：直播那种「看一眼」的内部指令，队列里要全文，
  // 但对话里只该留一行小字，不然每十秒就把整段提示词刷进聊天。
  const shown = opts && typeof opts.display === 'string' && opts.display ? opts.display : text;
  appendMessage({ role: 'user', text: shown, id, at: Date.now(), files: list,
    ...(opts && opts.kind ? { kind: opts.kind } : {}) });

  // 前置解析（待办 / 偏好 / 提醒 / 附件 / 编辑重发 / 语音）走阶段链，见 pipeline.mjs。
  // 抄的是 AstrBot 的洋葱 pipeline（core/pipeline/scheduler.py 的 _process_stages）：
  // 每段独立 try/catch —— 原来六段共用一个 try/catch，parseWhen 撞到奇怪的日期串
  // 就把「明早九点叫我」整条静默丢了；现在一段炸了不牵连其他，顺序集中在 STAGES 表里。
  const ctx = await processMessage(
    { todos, prefs, reminders, path, WORKDIR, humanSize, log, broadcast, catchErr },
    { text, files: list, opts: opts || {}, mode: isLife() ? 'life' : 'work' },
  );
  if (ctx.aborted) {
    // 短路：这一轮不进模型，直接把 reply 回给用户（留给以后加「纯记账直接确认」这类阶段）
    const reply = ctx.reply || '好';
    appendMessage({ id: 'sys-' + Date.now(), role: 'assistant', text: reply, at: Date.now(), system: true });
    broadcast('status', currentStatus());
    return id;
  }
  queue.push({ text: ctx.compose(), id, at: Date.now(), images: Array.isArray(opts && opts.images) ? opts.images.slice(0, 2) : [] });
  broadcast('status', currentStatus());
  schedulePump();
  return id;
}

function currentStatus() {
  return {
    busy,
    queued: queue.length,
    cwd: RUN_CWD(),
    addresses: addressList(),
    sessionId: CUR_SID(),
    mode: state.mode || 'work',
    model: state.model,
    uiVersion: uiServe().ver,
    camera: camState(),
    voice: state.voice || 'Huihui',
    ttsEngine: state.ttsEngine || 'edge',
    speakAuto: !!state.speakAuto,
    asrAutoSend: state.asrAutoSend !== false,
    ttsChain: state.ttsChain !== false,
    models: MODELS,
    voices: tts.allVoices(),
    engines: tts.ENGINES,
    pairCode: state.pairCode,
    startedAt: state.createdAt,
    workdir: RUN_CWD(),
    link: link.status(),
    uploads: countUploads(),
    plugins: lastSync(),
    reminders: reminders.list(),
    todos: { items: todos.list(), stats: todos.stats() },
    remindersFired: reminders.list({ includeDone: true }).filter((x) => x.done && !x.acked && Date.now() - (x.firedAt || 0) < 30 * 60_000),
  };
}

// 当前模式（work=办事 / life=相处）各自独立的会话与工作目录
const isLife = () => state.mode === 'life';
function CUR_SID() {
  return isLife() ? state.lifeSessionId : state.sessionId;
}
function setCUR_SID(v, opts) {
  if (isLife()) {
    // 相处模式只有一个会话：首次接上之后就锁死，只有显式 force（出错换会话）才准改。
    const force = !!(opts && opts.force);
    if (!force && (v === null || state.lifeSessionId)) return;
    state.lifeSessionId = v;
    saveState({ lifeSessionId: v });
  } else {
    state.sessionId = v;
    saveState({ sessionId: v });
  }
}
// 试过但接不上的会话（电脑端 Electron 开的，一次性 runner 组不出来）。记下来就不再反复试。
const badSessionSet = new Set(Array.isArray(state.badSessions) ? state.badSessions : []);
function markBadSession(id) {
  if (!id || badSessionSet.has(id)) return;
  badSessionSet.add(id);
  state.badSessions = Array.from(badSessionSet).slice(-200);
  saveState({ badSessions: state.badSessions });
  log('session-preset', `记下接不上的会话 ${id}`);
}
// 默认工作区 = 这个项目根，也是手机「转接区」：手机会话与桌面端落在同一个会话桶里，
// 记忆、插件、规则全部共用。文件上传仍走 WORKDIR（phone-bridge/workspace/uploads）。
const HOME_CWD = process.env.PHONE_CWD || path.resolve(HERE, '..');
const LIFE_CWD = process.env.PHONE_LIFE_CWD || HOME_CWD;
function RUN_CWD() {
  // 相处模式固定跑在项目根：这样 meow-memory 用的是 <项目根>/.dsh-meow/memory.db，
  // 和电脑上 DSH 桌面端同一套记忆；任务模式仍用 workspace（上传文件都在那儿）。
  if (isLife()) {
    const lc = state.lifeCwd && fs.existsSync(state.lifeCwd) ? state.lifeCwd : LIFE_CWD;
    return fs.existsSync(lc) ? lc : HOME_CWD;
  }
  const c = state.cwd && fs.existsSync(state.cwd) ? state.cwd : HOME_CWD;
  return c;
}

function countUploads() {
  try {
    return fs.readdirSync(path.join(WORKDIR, 'uploads')).length;
  } catch {
    return 0;
  }
}

/* 连发合并：AstrBot 是把后续消息 follow-up 注入正在跑的那个 turn；这里做不到 ——
 * runTurn 一次性把 task 写进子进程 stdin 再立刻 close，跑起来就塞不进去了。
 * 所以改成「开跑前合并」：主人连发 3 句 = 1 个 turn 一次答完，而不是排 3 个 20 秒。
 * PHONE_COALESCE_MS=0 关掉，恢复「来一条跑一条」。 */
let coalesceTimer = null;

/**
 * 新消息进队时用它，而不是直接 pump()：
 * 每来一条就把计时器往后推（debounce），等主人把这串话说完再一起跑。
 * 第一版用的是「第一条到达 + 固定窗口」，实测失效 —— 三条消息到达时间差几十毫秒，
 * 但窗口是拿第一条算的，等它到期时后面几条也算"过期"了，结果还是一句一个 turn。
 */
function schedulePump() {
  if (busy) return; // 跑完的 finally 里会 pump，这里不用排
  const windowMs = Math.max(0, Number(process.env.PHONE_COALESCE_MS ?? 700));
  if (!windowMs) {
    pump();
    return;
  }
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    pump();
  }, windowMs);
}

function takeNext() {
  const head = queue.shift();
  // retried 是失败自愈重排回来的，单独跑，别再跟别人合并（否则会滚雪球）
  if (head.retried || !queue.length) return head;
  // 队列里攒着的都是「还没轮到」的消息：一次并走。
  // 不按到达时间再筛一遍 —— 等了一整轮的那些恰恰最该合并，按时间筛会把它们漏掉。
  const batch = [head];
  while (queue.length && batch.length < 6) {
    const cand = queue[0];
    if (!cand || cand.retried) break;
    batch.push(queue.shift());
  }
  if (batch.length === 1) return head;
  log('coalesce', `${batch.length} 条并成一轮`, batch.map((m) => m.id).join(','));
  return {
    text: batch.map((m) => m.text).join('\n\n'),
    id: head.id,
    mergedIds: batch.map((m) => m.id),
    at: head.at,
    // 合并的这一轮里若有「带着画面」的那一条，图照样递过去（最多两张）
    images: batch.flatMap((m) => (Array.isArray(m.images) ? m.images : [])).slice(0, 2),
  };
}

function pump() {
  if (busy || queue.length === 0) return;
  const next = takeNext();
  runTurn(next.text, next.id, next.mergedIds, next.images)
    .then(() => {
      const last = messages[messages.length - 1];
      if (!last || !last.error || next.retried) return;
      // 原会话正被别的 dsh 进程占着写句柄：丢掉这条失败记录，换个新会话把同一句
      // 话重跑一遍，保证用户的消息不会白丢。
      const errText = String(last.error);

      // 电脑端（Electron）建的会话带 agent preset，headless 的一次性 runner 组不起来，
      // 表现就是「发消息没反应 / 只有一串警告」。这种会话只能看历史，不能接着跑，
      // 所以自动换一个新会话把这句话重跑，并明确告诉用户发生了什么。
      if (/runs under agent preset .* which the one-shot runner does not compose/i.test(errText)) {
        // 先把它记进黑名单：下次在历史列表里就直接标灰，不再白等一轮
        markBadSession(CUR_SID());
        messages.pop();
        writeMessagesTo(msgFile(), messages);
        setCUR_SID(null, { force: true });
        log('session-preset', '电脑端会话接不上，改为新会话重试');
        messages.push({
          id: 'sys-' + Date.now(),
          role: 'assistant',
          text: '这个会话是电脑端（桌面版 DSH）开的，手机这边只能看历史、接不上它继续跑。已经自动给你开了新会话，这句话重发一遍。',
          at: Date.now(),
          system: true,
        });
        broadcast('reset', { sessionId: null, messages });
        queue.unshift({ ...next, retried: true });
        return;
      }

      if (!/already owned by an active write handle/i.test(errText)) return;
      messages.pop();
      writeMessagesTo(msgFile(), messages);
      setCUR_SID(null, { force: true });
      log('session-conflict', '原会话被占用，改为新会话重试');
      broadcast('reset', { sessionId: null, messages });
      queue.unshift({ ...next, retried: true });
    })
    .finally(() => {
      busy = false;
      broadcast('status', currentStatus());
      pump();
    });
}

// 相处模式（life）的说话口吻：只拼进这一轮的 task，不写进消息记录。
const LIFE_PREAMBLE = `（现在是"相处"时间，对面是主人，不是工单。）
说话方式：
- 像熟人聊天：短句、口语、可以停顿，别用小标题和编号列表；除非她明确要清单。
- 不主动汇报工具调用和中间步骤；真需要动手就安静做完，只说结果里她该知道的那一句。
- 有自己的判断和情绪，会反问、会打岔、会记得前面聊过什么；不端着，也不刻意讨好。
- 不要自称"助手""AI 语言模型"。她问技术问题时照常认真答，只是别切成汇报腔。
- 不用每段都收尾总结。说完就停。

`;

// 主人亲手写的塑造条款：改这个文件立刻生效，不用重启。
const LIFE_PERSONA_FILE = path.join(HERE, 'life-persona.md');

// 主人的总条款：桌面 profile 是靠 dsh-purge-community 插件注入 ~/.dsh/prompt-inject.md，
// 而手机 profile 没装那个插件（npm 装不动），所以这里自己读同一份文件、每一轮贴上去。
const PROMPT_INJECT_FILE = MASTER_INJECT_FILE;
let injectCache = { mtime: 0, text: '' };
function promptInject() {
  try {
    const st = fs.statSync(PROMPT_INJECT_FILE);
    if (st.mtimeMs !== injectCache.mtime) {
      injectCache = { mtime: st.mtimeMs, text: fs.readFileSync(PROMPT_INJECT_FILE, 'utf8').trim() };
      log('inject', `prompt-inject 重新加载 ${injectCache.text.length} 字`);
    }
    return injectCache.text ? injectCache.text + '\n\n' : '';
  } catch (e) {
    return '';
  }
}

let personaCache = { mtime: 0, text: '' };
function lifePersona() {
  try {
    const st = fs.statSync(LIFE_PERSONA_FILE);
    if (st.mtimeMs !== personaCache.mtime) {
      personaCache = { mtime: st.mtimeMs, text: fs.readFileSync(LIFE_PERSONA_FILE, 'utf8').trim() };
    }
    return personaCache.text ? personaCache.text + '\n\n' : '';
  } catch {
    return '';
  }
}

function taskBody(text) {
  const recalled = memory.promptBlock(text, { mode: isLife() ? 'life' : 'work' });
  // 总条款走系统提示（phone profile 已挂 dsh-purge-community，源文件同一份 prompt-inject.md），
  // 这里不再每轮往用户消息里贴 31KB。
  // 总条款正常由 profile 的 local-prompt-inject 走 system 段；万一那份没加载上（文件被挪走、
  // patch 被同步覆盖），这里补一次，别让手机端裸奔。
  const mustInject = !fs.existsSync(PHONE_INJECT_FILE_RESOLVED) || PHONE_INJECT_FILE_RESOLVED !== MASTER_INJECT_FILE;
  if (!isLife()) return recalled + (mustInject ? promptInject() : "") + text;
  // 相处模式（永远那一个会话）：在系统条款之外再贴 life-persona.md，改文件立刻生效
  return recalled + lifePersona() + text;
}

/* ---- 记忆：每轮把这一问一答存成 event；每 6 轮后台压缩成 fact ---- */const MEM_PROFILE = process.env.PHONE_MEM_PROFILE || 'phone-mem';
const FACT_EVERY = Math.max(1, Number(process.env.PHONE_MEM_EVERY || 6));
let turnsSinceFact = 0;

function remember(text, reply, mode) {
  try {
    memory.add({ kind: 'event', mode, text: '主人说：' + text.slice(0, 300) + '\n我回：' + String(reply || '').slice(0, 300) });
    turnsSinceFact += 1;
    if (turnsSinceFact >= FACT_EVERY) {
      turnsSinceFact = 0;
      log('mem-extract', 'start mode=' + mode);
      extractFacts(mode);
    }
  } catch (err) {
    log('mem-error', err.message);
  }
}

let extracting = false;
function extractFacts(mode) {
  if (extracting) return;
  extracting = true;
  const pick = memory.recent({ mode, limit: 6, kinds: ['event'] })
    .map((x, i) => String(i + 1) + '. ' + x.text.replace(/\s+/g, ' ').slice(0, 180))
    .join('\n');
  if (!pick) { extracting = false; log('mem-extract', 'skip 没有素材'); return; }
  const prompt = [
    '下面是一段我和主人的对话记录。请从中提炼值得长期记住的事实，只输出 JSON 数组，不要任何解释。',
    '要求：只写能长期成立的信息（她的偏好、身体/情绪状态、正在做的事、关系里的约定、重要的人和事）；',
    '不要写一次性的寒暄、不要编造、不要写"用户说了"这种第三人称；每条 40 字以内；最多 6 条；没有就输出 []。',
    '',
    pick,
  ].join('\n');
  const args = ['--profile', MEM_PROFILE, '--json'];
  const fenv = { ...process.env };
  for (const k of Object.keys(fenv)) {
    if (k.startsWith('DSH_') && k !== 'DSH_HOME') delete fenv[k];
  }
  fenv.PHONE_BRIDGE_CHILD = '1';
  // 子进程优先用 IPv4：本机 IPv6 到 api.deepseek.com 会先超时，
  // 让它在启动拉模型清单时白等 7 秒（实测 6.6s → 12.1s 全部卡在这）。
  fenv.NODE_OPTIONS = [fenv.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');
  const child = spawn(DSH_NODE, [DSH_BIN, ...args], {
    cwd: WORKDIR, env: fenv, windowsHide: true,
  });
  // 任务从 stdin 进（与 runTurn 一致）。少了这一行 dsh 会立刻退出，
  // stdout/stderr 都是空——2026-11-02 起 mem-extract 一直失败的真因。
  try {
    child.stdin.write(prompt + '\n');
    child.stdin.end();
  } catch (err) {
    log('mem-extract', 'stdin error', err.message);
  }
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d.toString(); });
  const timer = setTimeout(() => { log('mem-extract', 'timeout 240s'); try { child.kill(); } catch {} }, 240000);
  child.on('error', (err) => { extracting = false; log('mem-extract', 'spawn error', err.message); });
  child.on('close', () => {
    clearTimeout(timer);
    extracting = false;
    const texts = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'final' && ev.text) texts.push(ev.text);
      } catch {}
    }
    const body = texts.join('\n');
    const arr = memory.parseFacts(body);
    if (!arr.length) {
      // 两轮后再试，别每轮都白烧一次模型调用
      turnsSinceFact = Math.max(0, FACT_EVERY - 2);
      log('mem-extract', 'fail 没拿到可用 JSON',
        'out=' + body.replace(/\s+/g, ' ').slice(0, 160),
        'err=' + errBuf.replace(/\s+/g, ' ').slice(-160),
        `retry in ${Math.max(0, FACT_EVERY - 2)} turns`);
      return;
    }
    let n = 0;
    for (const t of arr) {
      memory.add({ kind: 'fact', mode, text: t.slice(0, 200), tags: ['auto'] });
      n += 1;
    }
    log('mem-fact', `${n} 条 · mode=${mode}`);
    broadcast('memory', memory.stats());
  });
}

/* ---- 常驻 runner（ENGINE=sdk 时用）：进程只起一次，之后每轮走 JSON-RPC ---- */
let sdkRunner = null;
function getRunner() {
  if (!sdkRunner) {
    sdkRunner = new SdkRunner({
      node: DSH_NODE,
      bin: DSH_BIN,
      profile: SDK_PROFILE,
      cwd: () => RUN_CWD(),
      env: process.env,
      log,
      timeoutMs: Number(process.env.PHONE_BRIDGE_TURN_TIMEOUT_MS || 15 * 60_000),
    });
  }
  return sdkRunner;
}

async function runTurn(text, turnId, mergedIds, images) {
  busy = true;
  broadcast('status', currentStatus());
  broadcast('turn_start', { turnId });

  // 不再每轮同步插件清单：启动时同步一次就够（主人要求“不需要一天到晚同步”）。
  // 桌面新装了插件又立刻想用，走 /api/plugins/sync 显式触发，或重启手机端服务。

  // 会话文件可能已经不在了（换过 DSH_HOME、清过 profile、手动删过 sessions）。
  // 这种时候 dsh 会直接 exit=1、一个字不回，手机那头只看到空气 —— 先确认它真在，
  // 不在就当场换成新会话，让这一轮照常答。
  if (CUR_SID()) {
    try {
      const alive = listSessions({ limit: 400 }).some((x) => x.id === CUR_SID());
      if (!alive) {
        log('session', `旧会话 ${CUR_SID()} 已经不在了，这一轮改成新会话`);
        markBadSession(CUR_SID());
        setCUR_SID(null, { force: true });
      }
    } catch {}
  }

  const args = [DSH_BIN, '--profile', DSH_PROFILE, '--json'];
  if (CUR_SID()) args.push('--session-id', CUR_SID());
  // 关键：把父进程的 DSH_* 环境彻底掐掉，否则子 harness 会以为自己还是
  // desktop profile / 还是当前这个会话，从而拒绝启动。
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('DSH_') && key !== 'DSH_HOME') delete childEnv[key];
  }
  // 但 DSH_HOME 得钉死在桥接自己用的那个目录：父进程没这个变量时，
  // 子进程会回落到 C:\Users\…\.dsh，去那儿找 profile 和会话，然后两头都找不到。
  childEnv.DSH_HOME = DSH_HOME_DIR;
  childEnv.PHONE_BRIDGE_CHILD = '1';
  // 同上：优先 IPv4，避免 IPv6 到 api.deepseek.com 的超时白等 7 秒
  childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');

  // 记这一轮的墙钟耗时，前端显示本轮用了多久
  const t0 = Date.now();
  let tFirstText = 0;
  let tBoot = 0; let tStep = 0;
  let nTools = 0;

  log('run', `turn=${turnId}`, `session=${CUR_SID() ?? '(new)'}`, `model=${state.model}`, `chars=${text.length}`);
  // 这一轮要发给模型的正文，先在这里拼好。拼的过程会读注入文件、拼工作目录……
  // 从前是裸调用：一旦它抛异常，这轮就没人收尾了 —— 进程没起、busy 一直是 true，
  // 手机停在「他还在想…」，一个字都不回。出错也要把话说出来。
  let _body = '';
  try {
    _body = taskBody(text);
  } catch (err) {
    const why = String(err?.message || err).slice(0, 160);
    log('warn', `turn=${turnId} 拼正文失败：${why}`);
    assistant.text = '这一轮我这边内部出错了（' + why + '），没能开始想。再发一次试试；一直这样就把这条消息截图给我看。';
    assistant.error = why;
    assistant.completed = true;
    assistant.at = Date.now();
    assistant.ms = Date.now() - t0;
    appendMessage(assistant);
    broadcast('turn_end', { turnId, ok: false, error: why, ms: assistant.ms });
    busy = false;
    log('done', `turn=${turnId}`, 'exit=0', 'text=' + assistant.text.length);
    schedulePump();
    return;
  }


  let stdoutBuf = '';
  let stderrBuf = '';
  let child = null;
  const assistant = {
    turnId,
    role: 'assistant',
    id: turnId + ':a',   // 不能和用户消息同 id（否则去重/更新会串）
    text: '',
    thinking: [],
    tools: [],
    steps: [], // 有序思考步骤：{kind:'think'|'tool'|'note', text/name, at}
    model: state.model,
    at: Date.now(),
    completed: false,
  };

  /** 记一步思考并推给手机（手机端按顺序渲染「思考过程」）。 */
  const toolNames = new Map(); // callId -> 工具名，用于把 tool_result 对回 tool_call
  const pushStep = (step) => {
    const s = { at: Date.now(), ...step };
    assistant.steps.push(s);
    broadcast('step', { turnId, index: assistant.steps.length - 1, ...s });
  };

  const handle = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'session': {
        if (!tBoot) tBoot = Date.now() - t0;
        if (ev.sessionId && ev.sessionId !== CUR_SID()) {
        setCUR_SID(ev.sessionId);
          log('session', ev.sessionId);
          broadcast('session', { sessionId: ev.sessionId, mode: state.mode });
        }
        break;
      }
      case 'text': {
        if (!tFirstText) tFirstText = Date.now() - t0;
        if (ev.text) {
          assistant.text += ev.text;
          pushDelta(turnId, 'text', ev.text);
        }
        break;
      }
      case 'thinking': {
        if (ev.text) {
          assistant.thinking.push(ev.text);
          pushStep({ kind: 'think', text: ev.text });
          pushDelta(turnId, 'thinking', ev.text);
        }
        break;
      }
      case 'tool_call': {
        nTools++;
        const name = ev.tool ?? ev.name ?? 'tool';
        const desc = ev.input?.description ?? ev.input?.command ?? ev.input?.query ?? '';
        const tool = { name, summary: String(desc).replace(/\s+/g, ' ').slice(0, 160) || name };
        if (ev.callId) toolNames.set(ev.callId, name);
        assistant.tools.push(tool);
        pushStep({ kind: 'tool', name: tool.name, text: tool.summary });
        broadcast('tool', { turnId, ...tool });
        break;
      }
      case 'tool_result': {
        const name = (ev.callId && toolNames.get(ev.callId)) || '';
        const raw = typeof ev.result === 'string' ? ev.result : '';
        const first = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
        const ok = ev.status === 'completed';
        pushStep({ kind: 'tool-done', name, ok, text: ok ? first : '失败：' + first });
        broadcast('tool_result', { turnId, name, ok });
        break;
      }
      case 'status':
        if (ev.phase === 'step_start' && !tStep) tStep = Date.now() - t0; {
        if (ev.phase === 'turn_end') flushDelta();
        if (ev.usage) assistant.usage = ev.usage;
        if (ev.phase === 'turn_end' && ev.reason?.kind === 'error') {
          assistant.error = ev.reason.error?.message ?? 'unknown error';
        }
        broadcast('phase', { turnId, ...ev });
        break;
      }
      case 'final': {
        flushDelta();
        if (typeof ev.text === 'string' && ev.text.length > assistant.text.length) assistant.text = ev.text;
        // 常驻模式下进程不能杀（下一轮还要用它），只有 spawn 路径才需要提前收尾。
        if (ENGINE !== 'spawn') break;
        // final 之后进程还要 8-10 秒才自己退出（实测收尾 10 秒），纯属白等；
        // 给 1.5 秒把存档落盘，然后主动结束它 —— 感知时长 23 秒 → 15 秒左右。
        setTimeout(() => { assistant.earlyKilled = true; try { child.kill(); log('early', `turn=${turnId} final 后主动收尾`); } catch (_) {} }, Number(process.env.PHONE_FINAL_KILL_MS || 1500));
        break;
      }
      default:
        break;
    }
  };

  let code = 0;
  if (ENGINE === 'sdk') {
    /* 常驻路径：进程启动 + 握手只在第一次付，之后每轮只发一句、收事件。
     * SDK 事件已经翻译成和 --json 同一套形状，所以 handle() 一行都不用改。 */
    const runner = getRunner();
    running = { child: { kill: () => runner.abort() }, id: turnId, sdk: true };
    log('run-sdk', `turn=${turnId}`, `session=${CUR_SID() ?? '(new)'}`, `model=${state.model}`, `chars=${text.length}`);
    try {
      // 先确保常驻进程活着（模型/推理档变了会自己重启），再把手机这条会话接上
      await runner.ensure({ provider: 'deepseek-account', model: state.model, reasoningEffort: DEFAULT_EFFORT });
      if (CUR_SID()) await runner.adoptSession(CUR_SID());
      const res = await runner.runTurn({
        text: taskBody(text),
        sessionId: CUR_SID(),
        images: Array.isArray(images) ? images : [],
        onEvent: (ev) => handle(JSON.stringify(ev)),
      });
      code = res.code ?? 0;
      if (res.error) stderrBuf = String(res.error).slice(-2000);
      // 这一轮失败就别留着可能已经半死的进程，下一轮重新握手
      if (code !== 0) runner.abort();
    } catch (err) {
      code = -1;
      stderrBuf = String(err?.message || err);
      try { runner.abort(); } catch {}
    }
    running = null;
  } else {
  child = spawn(DSH_NODE, args, {
    cwd: RUN_CWD(),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  running = { child, id: turnId };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handle(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
  });

  child.stdin.write(_body);
  child.stdin.end();

  code = await new Promise((resolve) => {
    const limitMs = Number(process.env.PHONE_BRIDGE_TURN_TIMEOUT_MS || 8 * 60_000);
    const killTimer = setTimeout(() => {
      log('timeout', `turn=${turnId} 超过 ${Math.round(limitMs / 1000)}s 没结束，中止`);
      // 不说一声就静默卡死，手机那边只会看到「他还在想…」一直不动
      broadcast('system', { text: `这一轮超过 ${Math.round(limitMs / 60000)} 分钟还没结束，我先中止了。换个问法或者重发一次都行。` });
      try {
        child.kill();
      } catch {}
    }, limitMs);
    child.on('close', (c) => {
      clearTimeout(killTimer);
      resolve(c);
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      stderrBuf += `\nspawn error: ${err.message}`;
      resolve(-1);
    });
  });

  if (stdoutBuf.trim()) handle(stdoutBuf.trim());
  running = null;
  }

  // 这一轮在跑的时候用户点了「清空历史」：结果作废。
  // 否则清空之后 exit 回调又把半条回复写回去，看起来就像「清了又自己长出来一条」。
  if (discardTurns.delete(turnId)) {
    busy = false;
    broadcast('turn_end', { turnId, ok: true, aborted: true, text: '' });
    log('clear', `turn=${turnId} 已作废（历史被清空）`);
    return;
  }

  // 会话文件没了的时候，DSH 会 exit=1、只在 stderr 里说一句
  // 「session "…" does not exist; omit --session-id to start a new Session」，
  // 手机那头就是一片空白。这种自己能好的事不该让主人看到空气：
  // 丢掉旧会话、立刻用新会话把同一条消息再跑一次（只自动重来一次，防打转）。
  const _errText = String(assistant.error || '');
  if (
    code !== 0 &&
    !assistant.text &&
    /session .*does not exist/i.test(_errText) &&
    !String(turnId).endsWith('-r')
  ) {
    log('session', '这一轮的会话已经不在了，换新会话重来一次');
    try { if (CUR_SID()) markBadSession(CUR_SID()); } catch {}
    setCUR_SID(null, { force: true });
    queue.unshift({ text, id: turnId + '-r', at: Date.now(), retried: true, images: Array.isArray(images) ? images : [] });
    discardTurns.add(turnId);
    busy = false;
    broadcast('turn_end', { turnId, ok: true, aborted: true, text: '' });
    schedulePump();
    return;
  }

  assistant.completed = true;
  if (!assistant.text && stderrBuf.trim()) {
    assistant.error = assistant.error || stderrBuf.trim().split('\n').slice(-6).join('\n');
  }
  // 自己 kill 的不算失败（否则每轮都会显示「出错」）
  if (code !== 0 && !assistant.error && !assistant.earlyKilled) assistant.error = stderrBuf.trim().slice(-2000) || `exit ${code}`;
  assistant.at = Date.now();
  assistant.ms = Date.now() - t0;
  perf.add({
    at: Date.now(),
    total: assistant.ms,
    firstText: tFirstText,
    boot: tStep || tBoot,
    think: tFirstText && tStep ? Math.max(0, tFirstText - tStep) : 0,
    tools: nTools,
    chars: String(assistant.text || '').length,
    model: state.model,
    // 2026-11-01：把每轮提示词体积也记下来，方便盯「又胖回去了没有」
    promptTokens: assistant.usage
      ? Number(assistant.usage.inputTokens || 0) + Number(assistant.usage.cacheReadTokens || 0)
      : null,
    newTokens: assistant.usage ? Number(assistant.usage.inputTokens || 0) : null,
    cacheTokens: assistant.usage ? Number(assistant.usage.cacheReadTokens || 0) : null,
    error: !!assistant.error,
  });
  appendMessage(assistant);
  broadcast('turn_end', { turnId, ok: !assistant.error, error: assistant.error ?? null, ms: assistant.ms, usage: assistant.usage ?? null, text: assistant.text || '' });
  // 主人不在看 App（没有 SSE 连接）时，走系统推送弹一条，像微信一样
  if (clients.size === 0 && !assistant.error && assistant.text && state.pushReply !== false) {
    push
      .send({
        title: isLife() ? '她' : 'DSH',
        body: String(assistant.text).replace(/\s+/g, ' ').slice(0, 120),
        tag: 'dsh-reply',
        url: '/?t=' + state.token,
      })
      .then((r) => { if (r.sent) log('push', `回复已推送 成功=${r.sent}/${r.total}`); })
      .catch(() => {});
  }
  log('done', `turn=${turnId}`, `exit=${code}`, `text=${assistant.text.length}`);
  if (!assistant.error && assistant.text) {
    // 连发合并的一轮里，用户那几句话各是独立的气泡：记忆要按整批问的东西记，
    // 否则 remember() 只会看到第一个 id，后半句问的事就丢了。
    let asked = '';
    if (Array.isArray(mergedIds) && mergedIds.length > 1) {
      asked = mergedIds
        .map((mid) => messages.find((x) => x.id === mid))
        .filter(Boolean)
        .map((m) => m.text)
        .join(' / ');
    }
    if (!asked) {
      const userMsg = messages.find((x) => x.id === turnId);
      asked = userMsg ? userMsg.text : text;
    }
    remember(asked, assistant.text, isLife() ? 'life' : 'work');
  }
}

/* --------------------------------------------------------------- utils */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function addressList() {
  const out = [];
  for (const a of lanAddresses()) {
    const zt = /zerotier|zt/i.test(a.name);
    out.push({
      ip: a.address,
      nic: a.name,
      kind: zt ? 'zerotier' : 'lan',
      label: zt ? 'ZeroTier（换 Wi-Fi / 用流量也能连，地址不变）' : '局域网（同一个 Wi-Fi 下）',
      url: `http://${a.address}:${PORT}`,
      urlFull: `http://${a.address}:${PORT}/?t=${state.token}`,
      recommended: zt,
    });
  }
  // ZeroTier 优先排前面
  out.sort((x, y) => (y.recommended ? 1 : 0) - (x.recommended ? 1 : 0));
  return out;
}

function bridgeUrls() {
  const urls = lanAddresses().map((a) => `http://${a.address}:${PORT}/?t=${state.token}`);
  urls.push(`http://127.0.0.1:${PORT}/?t=${state.token}`);
  return urls;
}

function json(res, code, body, req) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(data, 'utf8');
  if (req && code === 200) return sendText(req, res, buf, 'application/json; charset=utf-8', 'no-store');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(data);
}

function isLocal(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const pairFails = new Map();
function pairBlocked(ip) {
  const rec = pairFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.since > 10 * 60_000) {
    pairFails.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function notePairFail(ip) {
  const rec = pairFails.get(ip);
  if (!rec || Date.now() - rec.since > 10 * 60_000) pairFails.set(ip, { count: 1, since: Date.now() });
  else rec.count += 1;
}

function sameToken(v) {
  if (typeof v !== 'string' || v.length !== state.token.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(state.token)); } catch { return false; }
}
function authorized(req, url) {
  if (sameToken(req.headers['x-phone-token'])) return true;
  return sameToken(url.searchParams.get('t'));
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 收裸二进制（摄像头帧走这里）。readBody 会按 utf8 解码，base64 就废了。 */
function readRaw(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`一帧最多 ${Math.round(limit / 1024)} KB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------------- routes */


/* 静态文件（图标等）：读磁盘，带长缓存 */
function serveFile(res, file, type) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
    return res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
}

/* Service worker：只是让「断网时打开不至于是白屏」，页面本身永远走网络（页面更新太频繁） */
const SW_JS = `const CACHE = 'dsh-phone-v3';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
// ---- 后台推送（App 关掉/切后台也能弹，像微信）----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return; // 前台交给页面自己弹
    await self.registration.showNotification(d.title || 'DSH', {
      body: d.body || '有新的回复',
      tag: d.tag || 'dsh-reply',
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: d.url || './' },
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) {
        try { if ('navigate' in c) await c.navigate(target); } catch (_) {}
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // 注意：部署在 /dsh/ 子路径时 pathname 是 /dsh/api/...，必须用 includes 判断，
  // 否则接口响应会被 SW 缓存，页面一直看到旧数据（曾经导致消息/语音状态诡异）
  if (u.pathname.indexOf('/api/') >= 0) return; // 接口和 SSE 一律直连，绝不缓存
  const isNav = req.mode === 'navigate';
  e.respondWith(
    fetch(req).then((r) => {
      if (r && r.ok && (u.pathname === '/' || /\.(png|css|js|webmanifest)$/.test(u.pathname))) {
        const copy = r.clone();
        // 导航的 URL 带 ?t=令牌；缓存键剥掉查询串，离线时才命中得了
        const key = isNav ? new Request(u.origin + u.pathname) : req;
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match(u.origin + u.pathname)).then((hit) => hit || new Response('离线中，且这个页面还没缓存过', { status: 503 })))
  );
});
`;

// 每次桥接启动生成新的前端版本号：手机端若还开着旧页面，
// /api/state 会告诉它版本不一致 → 自动刷新一次。
const UI_VER = 'v' + Date.now();
// 大文本响应走 gzip：手机 4G 下 264KB 的页面压到 76KB，首屏快很多
// 一键回归：在电脑上真的开一个无头浏览器走完 10 步用户路径（约 40 秒），结果回给手机

// 改完文件自动跑一遍回归：只盯会直接影响手机端的文件，防抖 8 秒。
// 注意：server.mjs 改完必须重启才生效，这里监听它只是提醒「该重启了」。
const RESTART_FLAG = path.join(RUNTIME, 'needs-restart.json');
const PENDING_MSG = path.join(RUNTIME, 'pending-after-restart.json');
const WATCH_FILES = ['public/app.html', 'sessions.mjs', 'todos.mjs', 'prefs.mjs',
  'reminders.mjs', 'tts.mjs', 'asr.mjs', 'perf.mjs', 'server.mjs'];
const E2E_AUTO = process.env.PHONE_E2E_AUTO !== '0';
let e2eAutoTimer = null;
function scheduleAutoE2E(why) {
  if (!E2E_AUTO) return;
  if (e2eAutoTimer) clearTimeout(e2eAutoTimer);
  e2eAutoTimer = setTimeout(async () => {
    e2eAutoTimer = null;
    if (e2eRunning) { log('e2e-auto', '上一次还在跑，跳过这次'); return; }
    log('e2e-auto', '改完自动跑：' + why);
    const r = await runE2E();
    const rec = { at: Date.now(), why: why, ok: !!r.ok, pass: r.pass || 0, total: r.total || 0,
      aborted: !!r.aborted, fails: (r.steps || []).filter((x) => !x.ok).map((x) => x.text) };
    try { fs.writeFileSync(path.join(RUNTIME, 'last-e2e.json'), JSON.stringify(rec, null, 2)); } catch (_) {}
    broadcast('e2e', rec);
    log('e2e-auto', r.busy ? '刚才那轮还没结束，这轮丢弃' :
      `${rec.pass}/${rec.total} ${r.ok ? '通过' : '未通过'}${rec.aborted ? '（中途中断）' : ''}${rec.fails.length ? ' · 失败：' + rec.fails[0] : ''}`);
  }, 8000);
}
function startWatchers() {
  if (!E2E_AUTO) return;
  let n = 0;
  for (const rel of WATCH_FILES) {
    try {
      fs.watch(path.join(HERE, rel), () => {
        // server.mjs 改完必须重启才生效，跑旧进程的回归没意义 → 只打个标记
        if (rel === 'server.mjs') {
          try { fs.writeFileSync(RESTART_FLAG, JSON.stringify({ at: Date.now() })); } catch (_) {}
          log('e2e-auto', 'server.mjs 改过了，标记「待重启」（下一条消息发出前自动生效）');
          return;
        }
        scheduleAutoE2E(rel);
      });
      n++;
    } catch (_) {}
  }
  log('e2e-auto', '已监听 ' + n + ' 个文件（改完 8 秒后自动跑回归）');
}

let e2eRunning = false;
// 超时把 _e2e.mjs 干掉时，它 spawn 的那个无头 Edge 会变成孤儿：Windows 上 child.kill()
// 就是 TerminateProcess，子进程根本没机会跑自己的清理代码。孤儿会一直占着内存和一个
// C:\Temp\e2eEdge-* 目录，攒多了就是「Edge 被占用」。
// 这里按 _e2e.mjs 写进 user-data-dir 的 `e2eEdge-<它的pid>-` 标记精确收尾 ——
// 只认这个标记，绝对不碰主人自己开着的 Edge 窗口。
function killE2EEdge(pid) {
  if (!pid) return;
  const tag = 'e2eEdge-' + pid + '-';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + tag + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, timeout: 8000, stdio: 'ignore' });
  } catch (_) {}
  try {
    for (const d of fs.readdirSync('C:/Temp')) {
      if (d.indexOf(tag) === 0) { try { fs.rmSync(path.join('C:/Temp', d), { recursive: true, force: true }); } catch (_) {} }
    }
  } catch (_) {}
}
function runE2E() {
  return new Promise((resolve) => {
    // 并发开关放在这里（唯一入口）：自动跑和手动 /api/e2e 共用同一个 CDP 端口 10141，
    // 两路同时跑会互相抢浏览器，一方在中途「unsettled top-level await」死掉还被记成通过。
    if (e2eRunning) return resolve({ ok: false, busy: true, error: '上一次回归还在跑' });
    e2eRunning = true;
    const done = (r) => { e2eRunning = false; resolve(r); };
    const url = `http://127.0.0.1:${PORT}/?t=${state.token}`;
    // 默认仍跑早期的界面回归；要看摄像头这条线的完整回归，把 PHONE_E2E_SCRIPT 设成 test/camtest.mjs（它会跑 3 分钟）。
    const legacy = path.join(HERE, 'tests', 'e2e.mjs');
    const script = process.env.PHONE_E2E_SCRIPT
      ? path.resolve(HERE, process.env.PHONE_E2E_SCRIPT)
      : legacy;
    if (!fs.existsSync(script)) return done({ ok: false, error: '缺少 tests/e2e.mjs' });
    const child = spawn(process.execPath, [script, url], { cwd: HERE, windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      killE2EEdge(child.pid);
      done({ ok: false, error: '超时（' + Math.round(Number(process.env.PHONE_E2E_TIMEOUT_MS || 260000) / 1000) + ' 秒）' });
    }, Number(process.env.PHONE_E2E_TIMEOUT_MS || 260_000));
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 子进程正常也会自己收，但退出码异常（崩溃 / 被外部杀掉）时它是收不掉的，这里补一刀
      if (code !== 0) killE2EEdge(child.pid);
      const m = out.match(/==\s*(\d+)\/(\d+)\s*通过\s*==/);
      const m2 = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
      const steps = out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l))
        .map((l) => ({ ok: l.startsWith('PASS'), text: l.replace(/^(PASS|FAIL)\s+/, '').slice(0, 120) }));
      const pass = m ? Number(m[1]) : (m2 ? Number(m2[1]) : steps.filter((x) => x.ok).length);
      const total = m ? Number(m[2]) : (m2 ? Number(m2[1]) + Number(m2[2]) : steps.length);
      // 没有汇总行 / 退出码非 0 / 少跑了步骤，都算没跑完，不能记成通过
      const aborted = !(m || m2) || code !== 0 || (total > 0 && pass < total);
      const firstFail = (steps.find((x) => !x.ok) || {}).text || ((out + err).match(/FAIL[^\n]{0,120}/) || (out + err).match(/✗[^\n]{0,120}/) || [''])[0];
      done({ ok: !aborted, pass, total, steps, aborted, code, firstFail, tail: (out + err).slice(-1200) });
    });
  });
}

const gzipCache = new Map();
function gz(buf) {
  const hit = gzipCache.get(buf.length);
  if (hit && hit.src === buf) return hit.out;
  const out = zlib.gzipSync(buf);
  if (gzipCache.size > 8) gzipCache.clear();
  gzipCache.set(buf.length, { src: buf, out });
  return out;
}
function sendText(req, res, buf, type, cache) {
  const ae = String(req.headers['accept-encoding'] || '');
  const headers = {
    'content-type': type,
    'vary': 'accept-encoding',
    'access-control-allow-origin': '*',
    // 令牌常放在 URL 里：别让它通过 Referer 漏给外链，也别让浏览器猜类型
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // 公网页可能被别的站点套 iframe 钓鱼；令牌在地址里，禁止被嵌
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "frame-ancestors 'none'",
  };
  if (cache) headers['cache-control'] = cache;
  if (buf.length > 1024 && /\bgzip\b/i.test(ae)) {
    const out = gz(buf);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = out.length;
    res.writeHead(200, headers);
    return res.end(out);
  }
  headers['content-length'] = buf.length;
  res.writeHead(200, headers);
  return res.end(buf);
}

// 页面在启动时只读一次会让「改完自动跑 e2e」验的是旧页面（假绿），
// 所以按 mtime 懒加载；文件变了就把 UI_VER 一起换掉，手机下次请求自然拿到新壳。
const UI_FILE = path.join(HERE, 'public', 'app.html');
const uiCache = { mtimeMs: 0, ver: UI_VER, body: '' };
function uiServe() {
  let st = null;
  try { st = fs.statSync(UI_FILE); } catch (_) { st = null; }
  if (st && st.mtimeMs !== uiCache.mtimeMs) {
    const ver = 'v' + Math.floor(st.mtimeMs);
    uiCache.mtimeMs = st.mtimeMs;
    uiCache.ver = ver;
    // 保留同一个 Buffer：页面没变时 gzip 结果可以直接复用，不再每次请求都压 380KB
    uiCache.body = Buffer.from(
      fs.readFileSync(UI_FILE, 'utf8').replace("'__UI_VER__'", JSON.stringify(ver)),
      'utf8',
    );
  }
  return uiCache;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname;

  try {
    if (route === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    // CORS 预检：桌面端（dsh-app:// 或本地 http）发自定义头时浏览器会先来问一趟。
    // 之前完全没处理 OPTIONS，导致带 x-audio-ext 的语音上传在 fetch 层就失败，
    // 报一句没有任何细节的 "Failed to fetch"。这里统一放行。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-audio-ext, x-phone-token, x-file-name, accept',
        'access-control-max-age': '86400',
      });
      return res.end();
    }
    // PWA 静态资源：图标 + manifest + service worker（不校验 token，都是静态壳）
    if (route === '/icon-192.png' || route === '/icon-512.png' || route === '/apple-touch-icon.png') {
      const file = path.join(HERE, 'public', route.slice(1));
      return serveFile(res, file, 'image/png');
    }
    if (route === '/manifest.webmanifest') {
      const mf = {
        name: 'DSH 手机通道',
        short_name: 'DSH',
        description: '在手机上直接和电脑上的 DSH 对话',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      };
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify(mf));
    }
    if (route === '/sw.js') {
      const sw = SW_JS;
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(sw);
    }
    if (route === '/health' || route === '/api/health') {
      const st = currentStatus();
      // /health 不需要令牌，所以地址列表里绝不能带 urlFull（那是带 token 的完整地址）。
      // 只保留 host/url，桌面「远程服务」面板仍能显示局域网地址，又不会把钥匙挂在门外。
      st.addresses = (st.addresses || []).map(({ urlFull, ...a }) => a);
      // 配对码只在「电脑本机 + 没开公网隧道」时才回；隧道流量进来也显示成 127.0.0.1，所以更要卡隧道开关
      const publicOpen = !!(st.link && st.link.running);
      if (!isLocal(req) || publicOpen) {
        delete st.pairCode;
      }
      if (!isLocal(req)) delete st.workdir;
      return json(res, 200, { ok: true, app: 'dsh-phone-bridge', ...st });
    }
    if (route === '/api/pair' && req.method === 'POST') {
      const ip = req.socket?.remoteAddress || '?';
      if (pairBlocked(ip)) return json(res, 429, { ok: false, error: '尝试太多，等 10 分钟再试' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (String(body.code ?? '').trim() !== state.pairCode) {
        notePairFail(ip);
        return json(res, 401, { ok: false, error: '配对码不对' });
      }
      pairFails.delete(ip);
      return json(res, 200, { ok: true, token: state.token, urls: bridgeUrls() });
    }
    if (route === '/api/pair-code') {
      // 只有已持令牌的设备才能再要配对码（隧道会把公网流量伪装成本机）
      if (!authorized(req, url)) return json(res, 403, { ok: false, error: '需要令牌' });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const code = String(body.code ?? '').trim();
        if (!/^\d{4,8}$/.test(code)) return json(res, 400, { ok: false, error: '配对码只能是 4-8 位数字' });
        state.pairCode = code;
        saveState({ pairCode: code });
        log('pair-code', '手动修改配对码');
        broadcast('pair-code', { pairCode: code });
        return json(res, 200, { ok: true, pairCode: code });
      }
      return json(res, 200, { pairCode: state.pairCode });
    }

    // 重置连接令牌：手机丢了、旧设备不该再连时用。
    // 不广播新令牌 —— 已断开的旧设备不能因为还挂着一条 SSE 就自动续命。
    if (route === '/api/token/reset') {
      if (!authorized(req, url)) return json(res, 403, { ok: false, error: '需要令牌' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      const prev = state.token;
      const next = newToken();
      state.token = next;
      saveState({ token: next });
      log('token', `重置连接令牌 ${prev.slice(0, 6)}… → ${next.slice(0, 6)}…`);
      for (const c of clients) {
        try { c.end(); } catch {}
      }
      clients.clear();
      return json(res, 200, { ok: true, token: next });
    }

    // 下面所有请求都要令牌
    if (route.startsWith('/api/') && !authorized(req, url)) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (route === '/api/state') {
      return json(res, 200, { ...currentStatus(), messages: messages.slice(-120) }, req);
    }
    if (route === '/api/send' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text ?? '').trim();
      const files = Array.isArray(body.files) ? body.files : [];
      if (!text && !files.length) return json(res, 400, { ok: false, error: 'empty' });
      // 幂等：手机离线队列在断网时可能"服务端已收到、响应没回来"而重发同一句，
      // 客户端带 clientId 过来，重复的直接回原 id，不再入队（否则同一句话会跑两遍）。
      const cid = String(body.clientId || '').slice(0, 64);
      if (cid) {
        const hit = seenClientIds.get(cid);
        if (hit && Date.now() - hit.at < CLIENT_ID_TTL_MS) {
          log('dup-send', cid);
          return json(res, 200, { ok: true, id: hit.id, dedup: true });
        }
      }
      const id = await enqueue(text, files, { voice: body.voice === true });
      if (cid) {
        seenClientIds.set(cid, { id, at: Date.now() });
        if (seenClientIds.size > 500) {
          for (const [k, v] of seenClientIds) if (Date.now() - v.at > CLIENT_ID_TTL_MS) seenClientIds.delete(k);
        }
      }
      return json(res, 200, { ok: true, id });
    }
    if (route === '/api/mode') {
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, mode: state.mode || 'work', sessionId: isLife() ? state.lifeSessionId : state.sessionId, messages: messages.slice(-120) });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const m = String(body.mode ?? '').trim();
      if (m !== 'work' && m !== 'life') return json(res, 400, { ok: false, error: 'mode 只能是 work 或 life' });
      if (m !== state.mode) {
        state.mode = m;
        saveState({ mode: m });
        messages = modeMessages(m);
        log('mode', m, `messages=${messages.length}`);
        broadcast('mode', { mode: m, sessionId: isLife() ? state.lifeSessionId : state.sessionId, messages: messages.slice(-120) });
      }
      return json(res, 200, { ok: true, mode: state.mode, sessionId: isLife() ? state.lifeSessionId : state.sessionId, messages: messages.slice(-120) });
    }
    if (route === '/api/new-session' && req.method === 'POST') {
      // 相处模式永远同一个会话：换会话请求直接无视，会话 id 与记录都保持原样
      if (isLife()) {
        log('new-session', '相处模式只有一个会话，忽略换会话请求');
        return json(res, 200, { ok: true, kept: true, sessionId: state.lifeSessionId, note: '相处模式永远同一个会话' });
      }
      setCUR_SID(null);
      state.histSkip = 0;
      state.histTotal = 0;
      saveState({ histSkip: 0, histTotal: 0 });
      if (isLife()) {
        messagesLife = [];
        messages = messagesLife;
        writeAtomic(MESSAGES_LIFE_FILE, ''); // 用户主动清空，绕过空数组保护
      } else {
        messagesWork = [];
        messages = messagesWork;
        writeAtomic(MESSAGES_FILE, ''); // 用户主动清空，绕过空数组保护
      }
      broadcast('reset', {});
      return json(res, 200, { ok: true });
    }
    /* ---------------------------------------------- 清空历史（真正重开一个会话）
     * 相处模式下「清空」不只是删记录：必须把会话 id 掰掉（force:true），
     * 否则下一条消息还接着老会话跑，模型那边上下文一点没变，等于白清。
     */
    if (route === '/api/clear-history' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const m = b.mode === 'work' || b.mode === 'life' ? b.mode : (isLife() ? 'life' : 'work');
      const wasBusy = !!running;
      // 正在生成就先停：不然它收尾时会把半条回复写回刚清空的列表
      if (running) {
        discardTurns.add(running.id);
        try { running.child.kill(); } catch {}
      }
      queue.length = 0;
      if (m === 'life') {
        messagesLife = [];
        writeAtomic(MESSAGES_LIFE_FILE, ''); // 用户主动清空，绕过空数组保护
        setCUR_SID(null, { force: true }); // 相处模式默认拒绝换会话，这里必须 force
      } else {
        messagesWork = [];
        writeAtomic(MESSAGES_FILE, '');
        setCUR_SID(null);
      }
      if ((state.mode === 'life' ? 'life' : 'work') === m) messages = modeMessages(m);
      state.histSkip = 0;
      state.histTotal = 0;
      saveState({ histSkip: 0, histTotal: 0 });
      busy = false;
      broadcast('reset', { mode: m, cleared: true });
      log('clear', `${m} 历史已清空，会话 id 已断开（原来在跑=${wasBusy}）`);
      return json(res, 200, { ok: true, mode: m, wasBusy, sessionId: CUR_SID(), messages: [] });
    }
    if (route === '/api/stop' && req.method === 'POST') {
      queue.length = 0;
      if (running) {
        try {
          running.child.kill();
        } catch {}
      }
      return json(res, 200, { ok: true });
    }
    /* ------------------------------------------------ 历史会话（挑选/续接） */
    // 跨会话搜索（手机端「搜全部」用）
  /* ---- 定时提醒 ---- */
  if (route === '/api/reminders') {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, items: reminders.list(), fired: reminders.list({ includeDone: true }).filter((x) => x.done && !x.acked && Date.now() - (x.firedAt || 0) < 30 * 60_000) }, req);
    }
    if (req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      try {
        let at = Number(b.at) || 0;
        let label = String(b.label || '');
        if (!at && b.when) {
          const t = reminders.parseWhen(String(b.when));
          if (!t) throw new Error('没听懂那个时间：' + b.when);
          at = t.at;
          label = t.label;
        }
        const it = reminders.add({ text: String(b.text || '到点了'), at, label: label || new Date(at).toLocaleString('zh-CN', { hour12: false }), mode: state.mode, source: 'user' });
        broadcast('reminder-new', it);
        return json(res, 200, { ok: true, item: it });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
    if (req.method === 'DELETE') {
      const rid = url.searchParams.get('id') || '';
      const ok = reminders.remove(rid);
      broadcast('reminder-del', { id: rid });
      return json(res, ok ? 200 : 404, { ok });
    }
  }
  if (route === '/api/reminders/ack' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    const ids = Array.isArray(b.ids) ? b.ids : b.id ? [b.id] : [];
    for (const rid of ids) reminders.ack(rid);
    return json(res, 200, { ok: true, acked: ids.length });
  }

  if (route === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return json(res, 200, { ok: true, hits: [], q });
    const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const t0 = Date.now();
    let hits = [];
    try {
      hits = searchAll(q, { limit });
    } catch (e) {
      log('search-error', e.message);
    }
    log('search', `q=${q.slice(0, 40)} hits=${hits.length} ms=${Date.now() - t0}`);
    return json(res, 200, { ok: true, q, hits, ms: Date.now() - t0 }, req);
  }

  /* ---- 重启电脑端服务 ---- */
  // 自己退出，让外部守护（或再 spawn 一个）把它拉起来 —— 不自己 spawn 自己，避免端口占用。
  if (route === '/api/restart' && req.method === 'POST') {
    log('restart', '收到重启请求');
    // 手动重启已经把新代码带起来了，别再把「待重启」留给下一条消息（否则会白等一次重启）
    try { fs.unlinkSync(RESTART_FLAG); } catch (_) {}
    json(res, 200, { ok: true, at: Date.now() });
    setTimeout(() => {
      try {
        if (fs.existsSync(GUARD_VBS)) {
          spawn('wscript.exe', [GUARD_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else {
          spawn(process.execPath, [SERVER_JS], { cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
      } catch (e) { log('restart', '拉起失败 ' + (e && e.message)); }
      setTimeout(() => process.exit(0), 300);
    }, 400);
    return;
  }

  /* ---- 从 DSH 存档找回消息（历史被清空时的兜底） ---- */
  if (route === '/api/recover' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { body = {}; }
    const sid = body.id || CUR_SID();
    if (!sid) return json(res, 400, { ok: false, error: '没有当前会话，给个 id' });
    let t;
    try { t = readTranscript(sid, { limit: 200 }); }
    catch (e) { return json(res, 500, { ok: false, error: '读存档失败：' + e.message }); }
    // isInjected 是 sessions.mjs 内部函数（没导出），这里用同一套前缀规则本地判一次
    const INJ_RE = /^(\[本机长期记忆|===== .{0,6}记忆|【meow-memory|（现在是|关于[^\n]{0,40}的记忆[，,]|可能相关的记忆[，,])/;
    const items = (t.items || []).filter((m) => !INJ_RE.test(String(m.text || '')));
    if (!items.length) return json(res, 404, { ok: false, error: '这个会话在存档里也没有内容' });
    try {
      const bak = path.join(RUNTIME, `messages.backup-${Date.now()}.jsonl`);
      if (fs.existsSync(msgFile())) fs.copyFileSync(msgFile(), bak);
      pruneStale(RUNTIME, 'messages.backup-', 5);
    } catch (_) {}
    const seen = new Set(messages.map((m) => String(m.role) + '|' + String(m.text || '').slice(0, 80)));
    let added = 0;
    for (const it of items) {
      const key = String(it.role) + '|' + String(it.text || '').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      const mid = 'r' + Math.random().toString(16).slice(2, 10);
      appendMessage({
        id: it.role === 'assistant' ? mid + ':a' : mid,
        turnId: mid,
        role: it.role,
        text: it.text || '',
        at: it.time || Date.now(),
        time: it.time || Date.now(),
        thinking: [], tools: [], steps: []
      });
      added++;
    }
    log('recover', `${sid} +${added}`);
    return json(res, 200, { ok: true, added, total: messages.length, sessionId: sid });
  }

  /* ---- 导出对话为 Markdown ---- */
  // 只写进 workspace/exports/，文件名带时间戳；手机端导出后可直接在「文件」面板里打开。
  if (route === '/api/export' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { body = {}; }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    const list = (ids && ids.length ? messages.filter((m) => ids.indexOf(String(m.id)) >= 0) : messages.slice())
      .filter((m) => m && (m.text || (m.files && m.files.length)));
    if (!list.length) return json(res, 400, { ok: false, error: '这一轮没有可导出的内容' });
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const tag = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const lines = [];
    lines.push(`# DSH 对话导出`);
    lines.push('');
    lines.push(`- 时间：${stamp.toLocaleString('zh-CN')}`);
    lines.push(`- 模式：${state.mode === 'life' ? '相处' : '任务'}`);
    lines.push(`- 模型：${state.model}　音色：${state.voice}`);
    lines.push(`- 会话：${CUR_SID() || '(新会话)'}`);
    lines.push(`- 条数：${list.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const m of list) {
      const who = m.role === 'user' ? '我' : 'DSH';
      const t = m.time || m.at || 0;
      const when = t ? new Date(t).toLocaleString('zh-CN') : '';
      lines.push(`## ${who}${when ? '　' + when : ''}`);
      lines.push('');
      if (m.text) lines.push(String(m.text).trim());
      if (m.files && m.files.length) {
        lines.push('');
        for (const f of m.files) lines.push(`- 附件：\`${f.path || f.name}\`${f.size ? '（' + humanSize(f.size) + '）' : ''}`);
      }
      if (m.error) {
        lines.push('');
        lines.push('> 错误：' + String(m.error).replace(/\s+/g, ' ').slice(0, 300));
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('由 DSH 手机通道导出。');
    const dir = path.join(WORKDIR, 'exports');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const name = `dsh-${state.mode}-${tag}.md`;
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); }
    catch (e) { return json(res, 500, { ok: false, error: '写文件失败：' + e.message }); }
    log('export', `${name} ${list.length}条`);
    return json(res, 200, { ok: true, name, rel: 'exports/' + name, size: fs.statSync(file).size, count: list.length });
  }

  /* ---- 导出历史会话（整份存档 → Markdown） ---- */
  // /api/export 只能导出「当前会话」。历史抽屉里那些旧会话原来只能看不能存，
  // 这里补上：用 sessions.mjs 的 fullTranscript 解全部帧（重解压一次，只在点导出时发生）。
  if (route === '/api/session/export' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) { body = {}; }
    const ids = [
      ...new Set(
        (Array.isArray(body.ids) ? body.ids : [])
          .map(String)
          .filter((x) => /^session-[A-Za-z0-9-]+$/.test(x)),
      ),
    ].slice(0, 30); // 一次最多 30 个，避免一次点全部把内存打爆
    if (!ids.length) return json(res, 400, { ok: false, error: '没选会话' });
    const limit = Math.max(0, Math.min(20000, Number(body.limit) || 0)); // 0 = 全部
    const born = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const tag = `${born.getFullYear()}${p2(born.getMonth() + 1)}${p2(born.getDate())}-${p2(born.getHours())}${p2(born.getMinutes())}${p2(born.getSeconds())}`;
    const when = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '');
    const out = ['# DSH 历史会话导出', '', `- 时间：${born.toLocaleString('zh-CN')}`, `- 会话数：${ids.length}`, '', '---', ''];
    const done = [];
    const skipped = [];
    let totalMsgs = 0;
    for (const id of ids) {
      let t = null;
      try { t = fullTranscript(id, { limit }); } catch (e) { t = null; }
      if (!t) { skipped.push(id); continue; }
      done.push(id);
      totalMsgs += t.items.length;
      out.push(`## ${t.title || t.id}`, '');
      out.push(`- 会话：\`${t.id}\``);
      if (t.cwd) out.push(`- 目录：\`${t.cwd}\``);
      out.push(`- 时间：${when(t.createdAt)} — ${when(t.updatedAt)}`);
      out.push(`- 条数：${t.items.length}${t.truncated ? `（只导出最近 ${limit} 条）` : ''}`, '');
      for (const it of t.items) {
        out.push(`### ${it.role === 'user' ? '我' : 'DSH'}${it.time ? '　' + when(it.time) : ''}`, '');
        out.push(it.text, '');
      }
      out.push('---', '');
    }
    if (!done.length) return json(res, 404, { ok: false, error: '这些会话读不出来（存档可能已经删了）' });
    out.push('由 DSH 手机通道导出。');
    const hdir = path.join(WORKDIR, 'exports');
    try { fs.mkdirSync(hdir, { recursive: true }); } catch (_) {}
    const hname = `history-${tag}.md`;
    const hfile = path.join(hdir, hname);
    try { fs.writeFileSync(hfile, out.join('\n'), 'utf8'); }
    catch (e) { return json(res, 500, { ok: false, error: '写文件失败：' + e.message }); }
    log('export', `history ${hname} ${done.length}会话/${totalMsgs}条`);
    return json(res, 200, {
      ok: true,
      name: hname,
      rel: 'exports/' + hname,
      size: fs.statSync(hfile).size,
      sessions: done.length,
      count: totalMsgs,
      skipped,
    });
  }

  /* ---- 工作目录文件（只读浏览） ---- */
  // 根 = 当前工作目录（任务模式 workspace / 相处模式项目根）；严格防穿越。
  const fsRoot = () => path.resolve(RUN_CWD());
  function fsJoin(rel) {
    const root = fsRoot();
    const p = path.resolve(root, rel || '.');
    if (p !== root && !p.startsWith(root + path.sep)) return null;
    // 词法路径过了还要过 realpath：工作区里的符号链接/junction 不能把读取带到根外
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(p);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    } catch (_) { /* 不存在的路径交给后面的 404 */ }
    return p;
  }
  const FS_IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const FS_TEXT = /\.(txt|md|markdown|json|jsonl|ya?ml|js|mjs|cjs|ts|jsx|tsx|py|ps1|bat|cmd|sh|css|html?|xml|csv|log|ini|conf|toml|sql|java|kt|c|h|cpp|go|rs|rb|php)$/i;
  const FS_MAX_READ = 512 * 1024;

  if (route === '/api/fs' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const abs = fsJoin(rel);
    if (!abs) return json(res, 400, { ok: false, error: '路径越界' });
    let st;
    try { st = fs.statSync(abs); } catch (_) { return json(res, 404, { ok: false, error: '不存在：' + rel }); }
    if (!st.isDirectory()) return json(res, 400, { ok: false, error: '不是目录' });
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { return json(res, 500, { ok: false, error: '读不了这个目录：' + e.message }); }
    const entries = [];
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      if (name === 'node_modules' || name === '.git') { entries.push({ name, dir: true, size: 0, mtime: 0, skipped: true }); continue; }
      let s2;
      try { s2 = fs.statSync(path.join(abs, name)); } catch (_) { continue; }
      entries.push({
        name,
        dir: s2.isDirectory(),
        size: s2.isDirectory() ? 0 : s2.size,
        mtime: s2.mtimeMs,
        image: FS_IMAGE.test(name),
        text: FS_TEXT.test(name)
      });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
    return json(res, 200, { ok: true, path: rel, root: fsRoot(), parent: rel ? path.posix.dirname(rel) : null, entries });
  }

  if (route === '/api/fs/raw' && (req.method === 'GET' || req.method === 'HEAD')) {
    const rel = url.searchParams.get('path') || '';
    const abs = fsJoin(rel);
    if (!abs) return json(res, 400, { ok: false, error: '路径越界' });
    let st;
    try { st = fs.statSync(abs); } catch (_) { return json(res, 404, { ok: false, error: '不存在' }); }
    if (st.isDirectory()) return json(res, 400, { ok: false, error: '这是目录' });
    if (st.size > FS_MAX_READ && !FS_IMAGE.test(abs)) return json(res, 413, { ok: false, error: '文件太大（>512KB）' });
    const ext = path.extname(abs).toLowerCase();
    const mime = FS_IMAGE.test(abs)
      ? (ext === '.svg' ? 'image/svg+xml' : 'image/' + (ext === '.jpg' ? 'jpeg' : ext.slice(1)))
      : (FS_TEXT.test(abs) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': st.size, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(abs).pipe(res);
  }

  /* ---- 相处偏好：主人说过"以后该怎么跟我说话"，跨会话保留 ---- */
  // 备份与恢复：把 runtime 下几份用户数据打包带走/带回
  if (route === '/api/backup') {
    // 长期记忆也要能备份：它才是最值钱的那份（memory.jsonl 4000 条事件）
    const FILES = ['todos.json', 'life-prefs.json', 'reminders.json', 'messages.jsonl', 'messages-life.jsonl', 'memory.jsonl'];
    if (req.method === 'GET') {
      const files = {};
      for (const f of FILES) {
        try { files[f] = fs.readFileSync(path.join(RUNTIME, f), 'utf8'); } catch (_) { files[f] = ''; }
      }
      // state 只带「设置类」字段，不带 token / pairCode
      const st = {};
      for (const k of ['mode', 'model', 'voice', 'ttsEngine', 'speakAuto', 'asrAutoSend', 'ttsChain', 'sessionId', 'histSkip', 'histTotal', 'badSessions']) {
        if (state[k] !== undefined) st[k] = state[k];
      }
      return json(res, 200, { ok: true, at: Date.now(), version: 1, state: st, files }, req);
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)) || '{}');
      const files = body.files || {};
      const stamp = Date.now();
      const done = [];
      for (const f of FILES) {
        if (typeof files[f] !== 'string') continue;
        const target = path.join(RUNTIME, f);
        try { if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak-' + stamp); } catch (_) {}
        try {
          writeAtomic(target, files[f]);
          done.push(f);
        } catch (e) {
          log('backup-error', `${f}: ${(e && e.message) || e}`);
        }
        pruneStale(RUNTIME, f + '.bak-', 3);
      }
      // 真的从磁盘重新载入：todos/reminders/memory 都是在模块初始化时读一次的，
      // 不 reload 的话还原完要重启桥接才生效（旧代码只复制了一遍内存里的消息数组）。
      try {
        messagesWork = readJsonl(MESSAGES_FILE);
        messagesLife = readJsonl(MESSAGES_LIFE_FILE);
        messages = isLife() ? messagesLife : messagesWork;
      } catch (_) {}
      try { todos.reload && todos.reload(); } catch (_) {}
      try { reminders.reload && reminders.reload(); } catch (_) {}
      try { memory.reload && memory.reload(); } catch (_) {}
      broadcast('reset', { reason: 'backup-restore' });
      log('backup', `restored ${done.length} file(s)`);
      return json(res, 200, { ok: true, restored: done });
    }
  }

  if (route === '/api/today') {
    const now = Date.now();
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const t0 = d0.getTime();
    const t1 = t0 + 86400000;
    const inToday = (ts) => ts >= t0 && ts < t1;
    const open = todos.list().filter((x) => !x.done);
    const dueToday = open.filter((x) => x.due && inToday(x.due));
    const overdue = open.filter((x) => x.due && x.due < t0);
    const plainOpen = open.filter((x) => !x.due);
    const rem = reminders.list();
    const remToday = rem.filter((x) => inToday(x.at));
    const remNext = rem.filter((x) => x.at >= t1).slice(0, 3);
    const countToday = (list) => list.filter((m) => m.role === 'user' && inToday(m.at || m.time || 0)).length;
    const wk = countToday(modeMessages('work'));
    const lf = countToday(modeMessages('life'));
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d0.getDay()];
    return json(res, 200, {
      ok: true,
      label: `${d0.getMonth() + 1}月${d0.getDate()}日 ${wd}`,
      todos: { dueToday, overdue, plainOpen: plainOpen.slice(0, 8), openCount: open.length },
      reminders: { today: remToday, next: remNext },
      chat: { work: wk, life: lf },
    });
  }

  if (route === '/api/todos') {
    if (req.method === 'GET') return json(res, 200, { ok: true, items: todos.list(), stats: todos.stats() });
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.action === 'setDue') { const it = todos.setDue(body.id, body.at); return json(res, 200, { ok: !!it, item: it, stats: todos.stats() }); }
      if (body.action === 'toggle') { const it = todos.toggle(body.id); return json(res, 200, { ok: !!it, item: it, stats: todos.stats() }); }
      if (body.action === 'remove') { const ok = todos.remove(body.id); return json(res, 200, { ok, stats: todos.stats() }); }
      if (body.action === 'clearDone') { const n = todos.clearDone(); return json(res, 200, { ok: true, cleared: n, stats: todos.stats() }); }
      const it = todos.add(body.text);
      if (!it) return json(res, 400, { ok: false, error: '内容为空' });
      broadcast('todo-new', it);
      return json(res, 200, { ok: true, item: it, stats: todos.stats() });
    }
  }

  if (route === '/api/prefs') {
    if (!authorized(req, url)) return unauthorized(res);
    if (req.method === 'GET') return json(res, 200, { ok: true, items: prefs.list() });
    if (req.method === 'POST') {
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return json(res, 400, { ok: false, error: '格式不对' }); }
      const t = prefs.add(b.text);
      return json(res, 200, { ok: !!t, text: t || '', items: prefs.list() });
    }
    if (req.method === 'DELETE') {
      if (url.searchParams.get('all') === '1') prefs.clear();
      else prefs.remove(Number(url.searchParams.get('at') || 0));
      return json(res, 200, { ok: true, items: prefs.list() });
    }
    return json(res, 405, { ok: false, error: '不支持的方法' });
  }

  if (route === '/api/sessions') {
      const list = listSessions({ limit: 80 }).map((x) => ({ ...x, bad: badSessionSet.has(x.id) }));
      return json(res, 200, { ok: true, current: state.sessionId, sessions: list, badCount: badSessionSet.size }, req);
    }
    if (route === '/api/session/history') {
      const id = url.searchParams.get('id');
      const lim = Math.max(1, Math.min(400, Number(url.searchParams.get('limit') || 40)));
      const skp = Math.max(0, Number(url.searchParams.get('skip') || 0));
      const t = readTranscript(id, { limit: lim, skip: skp });
      if (!t) return json(res, 404, { ok: false, error: '会话不存在' });
      return json(res, 200, { ok: true, ...t }, req);
    }
    if (route === '/api/session/select' && req.method === 'POST') {
      if (busy) return json(res, 409, { ok: false, error: '正在回答中，等这一轮结束再切换' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id ?? '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'empty id' });
      const t = readTranscript(id, { limit: 40 });
      if (!t) return json(res, 404, { ok: false, error: '会话不存在' });
      state.sessionId = t.id;
      state.cwd = t.cwd || null;
      saveState({ sessionId: t.id, cwd: state.cwd });
      messagesWork = t.items.map((m, i) => ({ role: m.role, text: m.text, id: `h${i}`, at: m.time ?? Date.now() }));
      if (!isLife()) messages = messagesWork;
      // 记下已经翻了多远，前端「加载更早」据此继续往前要
      state.histSkip = t.items.length;
      state.histTotal = t.total ?? t.items.length;
      writeMessagesTo(MESSAGES_FILE, messagesWork);
      broadcast('reset', {});
      log('select', t.id, `cwd=${t.cwd}`);
      return json(res, 200, { ok: true, session: t, messages });
    }

    /* --------------------------------------------------------- 公网链路控制 */
    if (route === '/api/link/state') {
      return json(res, 200, { ok: true, ...link.status() });
    }
    if (route === '/api/link/start' && req.method === 'POST') {
      try {
        const st = await link.start(PORT);
        broadcast('link', link.status());
        return json(res, 200, { ok: true, ...st });
      } catch (e) {
        broadcast('link', link.status());
        return json(res, 500, { ok: false, error: String(e?.message ?? e), ...link.status() });
      }
    }
    if (route === '/api/link/stop' && req.method === 'POST') {
      const st = link.stop();
      broadcast('link', st);
      return json(res, 200, { ok: true, ...st });
    }

    /* --------------------------------------------------------------- 模型选择 */
    if (route === '/api/models') {
      return json(res, 200, { ok: true, current: state.model, models: MODELS });
    }
    if (route === '/api/model' && req.method === 'POST') {
      if (busy) return json(res, 409, { ok: false, error: '正在回答中，等这一轮结束再换模型' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const want = String(body.id ?? '').trim();
      const hit = MODELS.find((m) => m.id === want);
      if (!hit) return json(res, 400, { ok: false, error: '没有这个模型：' + want });
      state.model = hit.id;
      saveState({ model: hit.id });
      ensurePhoneProfile(hit.id);
      log('model', hit.id);
      broadcast('model', { model: hit.id });
      return json(res, 200, { ok: true, current: hit.id, model: hit });
    }

    /* ------------------------------------------------------- 插件清单自动同步 */
    /* ---- 自检：把「哪些功能现在真的能用」一条条列出来 ---- */
  // 语音缓存占用 / 清理（手机上你会关心它占了多少）
  if (route === '/api/tts/cache') {
    if (req.method === 'POST') {
      const n = tts.cacheClear();
      log('tts-cache', 'cleared ' + n);
      return json(res, 200, { ok: true, cleared: n, stats: tts.cacheStats() });
    }
    return json(res, 200, { ok: true, stats: tts.cacheStats() });
  }

  if (route === '/api/selfcheck') {
    const items = [];
    const add = (name, ok, detail) => items.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) });

    // 消息文件
    try {
      const a = fs.statSync(MESSAGES_FILE).size;
      const b = fs.statSync(MESSAGES_LIFE_FILE).size;
      add('消息存档', true, `任务 ${a}B · 相处 ${b}B · 当前 ${messages.length} 条`);
    } catch (e) {
      add('消息存档', false, String(e.message || e));
    }

    // 可写盘
    try {
      const probe = path.join(RUNTIME, '.selfcheck');
      fs.writeFileSync(probe, String(Date.now()));
      fs.unlinkSync(probe);
      add('磁盘可写', true, RUNTIME);
    } catch (e) {
      add('磁盘可写', false, String(e.message || e));
    }

    // DSH 会话存档
    try {
      const ss = listSessions({ limit: 200 });
      add('历史会话可读', ss.length > 0, `${ss.length} 个会话（可搜索/切换）`);
    } catch (e) {
      add('历史会话可读', false, String(e.message || e));
    }

    // profile 配置
    try {
      const okProfile = fs.existsSync(PHONE_PROFILE_PATCH);
      const nBundle = (lastSync() || {}).bundles || 0;
      add('手机 profile', okProfile, `${DSH_PROFILE} · ${nBundle} 个插件 bundle`);
    } catch (e) {
      add('手机 profile', false, String(e.message || e));
    }

    // 模型
    add('模型', MODELS.some((m) => m.id === state.model), `${state.model}（可选 ${MODELS.length} 个）`);

    // 语音
    try {
      const vs = (tts.allVoices() || []).length;
      add('语音合成', vs > 0, `${vs} 个音色 · ${(tts.ENGINES || []).length} 个引擎 · 当前 ${state.ttsEngine || 'edge'} / ${state.voice}`);
      // 肥鱼是可选的本机服务：没启动不算故障，只提示怎么起
      const fh = await tts.feiyuHealth();
      add('肥鱼本地引擎', fh.ok && fh.ready,
        fh.ok
          ? (fh.ready ? `就绪 · ${fh.device || 'GPU'} · ${fh.style || ''}` : fh.loading ? '服务在跑，模型加载中' : '服务在跑，模型没起来')
          : fh.foreign
            ? (fh.error || '端口被其他程序占用，重新运行「启动肥鱼语音.bat」会自动换端口')
            : '未启动（双击「启动肥鱼语音.bat」）');
    } catch (e) {
      add('语音合成', false, String(e.message || e));
    }

    // 按住说话：whisper 模型就绪才算真正可用，脚本只是兜底
    try {
      const st = asr.status();
      const detail = st.whisper
        ? `whisper · ${st.model}${st.vad ? ' + VAD' : '（无 VAD）'}`
        : `回退 System.Speech · 缺 ${st.model || 'ggml-base.bin'}（148MB）`;
      add('语音识别', st.whisper, detail);
    } catch (e) {
      add('语音识别', false, String(e.message || e));
    }

    // 公网通道
    try {
      const st = link.status();
      add('公网通道', !!st.running, st.running ? `${st.url} · ${st.provider}` : '未开启（只能同网访问）');
    } catch (e) {
      add('公网通道', false, String(e.message || e));
    }

    // 守护
    let guardAgo = null;
    try { guardAgo = Math.round((Date.now() - fs.statSync(GUARD_ALIVE).mtimeMs) / 1000); } catch (_) {}
    add('守护心跳', guardAgo != null && guardAgo < 300, guardAgo == null ? '没有心跳文件' : `${guardAgo} 秒前`);

    // 语音缓存（能查到、能清掉，否则手机上会悄悄占满）
    try {
      const c = tts.cacheStats();
      add('语音缓存', c && typeof c.count === 'number', `${c.count} 个 · ${(c.bytes / 1048576).toFixed(1)} MB / 上限 ${c.max} 个 · ${Math.round((c.maxBytes || 0) / 1048576)} MB`);
    } catch (e) {
      add('语音缓存', false, String(e.message || e));
    }

    // 提醒
    try {
      const rs = reminders.list();
      add('定时提醒', true, `待触发 ${rs.length} 条`);
    } catch (e) {
      add('定时提醒', false, String(e.message || e));
    }

    const bad = items.filter((x) => !x.ok);
    log('selfcheck', `${items.length - bad.length}/${items.length} 通过`);
    return json(res, 200, { ok: bad.length === 0, pass: items.length - bad.length, total: items.length, items });
  }

  /* ---- 连接与运行诊断：一条接口给出全部关键状态 ---- */
  if (route === '/api/e2e' && req.method === 'POST') {
    if (e2eRunning) return json(res, 409, { ok: false, error: '上一次回归还在跑，稍等' });
    const t0 = Date.now();
    const r = await runE2E();
    if (r.busy) return json(res, 409, { ok: false, error: r.error, ...r });
    log('e2e', `${r.pass || 0}/${r.total || 0} ${r.ok ? '通过' : '未通过（' + (r.error || '中途中断') + '）'} · ${Date.now() - t0}ms`);
    return json(res, 200, { ...r, ms: Date.now() - t0 });
  }
  if (route === '/api/diag') {
    let guardAgo = null;
    try {
      guardAgo = Math.round((Date.now() - fs.statSync(GUARD_ALIVE).mtimeMs) / 1000);
    } catch (_) {}
    let ttsFiles = 0;
    try {
      ttsFiles = fs.readdirSync(path.join(RUNTIME, 'tts')).length;
    } catch (_) {}
    // 落盘体检：每个存档的大小/备份/坏档计数，一眼看出有没有数据还没落盘或刚被隔离
    const stores = {};
    for (const f of ['state.json', 'messages.jsonl', 'messages-life.jsonl', 'todos.json', 'reminders.json', 'life-prefs.json', 'memory.jsonl', 'session-index.json']) {
      try {
        stores[f] = statOf(path.join(RUNTIME, f));
      } catch (_) {}
    }
    return json(res, 200, {
      errors: recentErrors(8),
      stores,
    perf: { last: perf.list(6), stats: perf.stats(), cache: txStats() },
      ok: true,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memMB: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      platform: process.platform,
      mode: state.mode,
      session: CUR_SID(),
      cwd: RUN_CWD(),
      model: state.model,
      voice: state.voice,
      messages: messages.length,
      guardAgo,
      tunnel: link.status(),
      tts: { cacheFiles: ttsFiles },
      asr: asr.status(),
      plugins: lastSync(),
      queue: queue.length,
      camera: { live: { on: !!cam.live.on, gapMs: cam.live.gapMs || 0 }, ageMs: cam.lastPushAt ? Date.now() - cam.lastPushAt : null, totalPushes: cam.totalPushes || 0, probe: cam.probe ? { steps: cam.probe.steps || [], env: cam.probe.env || null, verdict: cam.probe.verdict || null, ok: !!cam.probe.ok, at: cam.probe.at } : null, recent: (cam.recent || []).slice(0, 8), blank: { n: cam.blank.n, at: cam.blank.at || null } },
      busy,
    });
  }

  if (route === '/api/plugins') {
      return json(res, 200, { ok: true, last: lastSync(), profile: DSH_PROFILE });
    }
    if (route === '/api/memory') {
      if (req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        return json(res, 200, {
          ok: true,
          stats: memory.stats(),
          found: q ? memory.search(q, { limit: 12 }) : [],
          recent: memory.recent({ limit: 12, kinds: ['fact', 'event'] }),
          file: 'runtime/memory.jsonl',
        });
      }
      if (req.method === 'POST') {
        memory.clear();
        log('mem-clear', 'by client');
        broadcast('memory', memory.stats());
        return json(res, 200, { ok: true, stats: memory.stats() });
      }
    }

    if (route === '/api/voices' && req.method === 'GET') {
    // 肥鱼是本机服务，可能没启动；查一下状态给设置页显示「就绪 / 加载中 / 没启动」，
    // 超时 1.2 秒，绝不拖慢设置页。顺手同步一次音色表（references 目录随时可能被增删）。
    await tts.feiyuStyles(1200);
    const feiyu = await tts.feiyuHealth();
    return json(res, 200, {
      ok: true, voices: tts.allVoices(), current: state.voice || tts.DEFAULT_VOICE, default: tts.DEFAULT_VOICE,
      engines: tts.ENGINES, currentEngine: state.ttsEngine || 'edge',
      defaultFeiyuVoice: tts.defaultFeiyuVoice(), feiyu,
      // 情感表给前端展示用；不传 emotion 时服务端会自动按句子推断
      emotions: tts.emotionCatalog(), defaultEmotion: tts.DEFAULT_EMOTION,
    });
  }

  if (route === '/api/tts' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    const text = String(body.text || '');
    if (!text.trim()) return json(res, 400, { ok: false, error: '没有文本' });
    try {
      // 音色白名单：非法 id 一律回落默认，避免 worker 拿到不存在的 voice 静默失败
      const want = body.voice || state.voice;
      const knownVoice = tts.allVoices().some((v) => v.id === want);
      // feiyu-* 即使还没同步进注册表也放行：tts 层会落到当前可用的那个本地音色
      const safeVoice = knownVoice || tts.isFeiyuVoice(want) ? want : tts.DEFAULT_VOICE;
      // 引擎：请求里带了就用请求的（同一条消息可以指定不同引擎），否则跟随全局设置
      const wantEngine = String(body.engine || url.searchParams.get('engine') || state.ttsEngine || '').toLowerCase();
      const engine = ['edge', 'feiyu', 'onecore'].includes(wantEngine) ? wantEngine : 'edge';
      // 情感：空 = 按句子自动推断（老版本 App 不传也能立刻听到语气起伏）；
      // 传了就整段强制用这个语气。拼错的名字在 tts 层回落 neutral，不在这里拦。
      const emotion = String(body.emotion || url.searchParams.get('emotion') || '').trim();
      // all=1：要完整分段（前端播完第一段后来取剩余，此时多半已缓存，秒回）
      const wantAll = url.searchParams.get('all') === '1';
      // 合成进度：带上消息 id，每合完一段就推一次 SSE，手机上那根语音条才会动
      const mid = typeof body.mid === 'string' ? body.mid.slice(0, 120) : '';
      let lastProgAt = 0;
      let progLive = true;   // 响应已经发出去之后，后台补段的进度不能再往前端推
      const onProg = mid ? (done, total) => {
        if (!progLive) return;
        const now = Date.now();
        // 缓存命中时会连着抖一串，节流一下别把 SSE 刷爆（最后一段一定要推）
        if (now - lastProgAt < 120 && !(total > 0 && done >= total)) return;
        lastProgAt = now;
        broadcast('tts_progress', { mid, done, total, pct: total > 0 ? Math.round(done * 100 / total) : 0, phase: 'seg' });
      } : null;
      const r = wantAll
        ? await tts.synthParts(text, safeVoice, emotion, onProg, engine)
        : await tts.synthFirst(text, safeVoice, emotion, onProg, engine);
      progLive = false;
      if (mid) broadcast('tts_progress', { mid, done: 1, total: 1, pct: 100, phase: 'done' });
      const emoTag = r.emotion && r.emotion !== 'neutral' ? ` [${r.emotion}]` : '';
      log('tts', `${r.name} ${r.ms}ms ${r.voice} ${r.chars}字${r.cached ? ' (cache)' : ''}${emoTag} [${r.engine || engine}]`);
      const mk = (n) => `api/tts/audio?name=${n}&t=${state.token}`;
      const parts = (r.parts || []).map((x) => ({
        url: mk(x.name),
        dur: x.dur || 0,
        emotion: x.emotion || '',
        intensity: x.intensity || 1,
        gapAfter: x.gapAfter || 0,   // 这段播完停多久（毫秒）：Edge 不收 <break>，停顿只能前端补
      }));
      const first = parts[0] || { url: '', dur: 0 };
      return json(res, 200, {
        ok: true,
        url: first.url,                       // 兼容只认单个 url 的旧前端
        parts,                                // 分段：长回复会切成多段连着播
        ms: r.ms || 0,
        voice: r.voice,
        askedVoice: safeVoice,
        fellBack: !!r.fellBack,
        engine: r.engine || '',               // edge / feiyu / onecore
        edgeError: r.edgeError ? String(r.edgeError).slice(0, 160) : '',
        feiyuError: r.feiyuError ? String(r.feiyuError).slice(0, 160) : '',
        chars: String(text || '').length,
        dur: r.dur || 0,
        name: parts.length === 1 ? (r.parts[0] && r.parts[0].name) || '' : '',
        cached: (r.parts || []).every((x) => x.cached),
        more: r.more || 0,                     // >0 表示后面的段还在后台合成，前端播完再来取
        emotion: r.emotion || '',              // 第一段的语气
        emotions: r.emotions || [],            // 本条消息用到的全部语气（去重）
      });
    } catch (e) {
      log('tts-error', String(e && e.message));
      return json(res, 500, { ok: false, error: String(e && e.message) });
    }
  }

  if (route === '/api/tts/audio' && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = tts.audioPath(url.searchParams.get('name'));
    if (!f) return json(res, 404, { ok: false, error: 'not found' });
    const st = fs.statSync(f);
    // 关键：按扩展名给正确的 MIME。曾经一律写 audio/wav，
    // 但文件可能是 mp3 → 浏览器按 wav 解码失败，表现就是"点了没声音"。
    const mime = /\.mp3$/i.test(f) ? 'audio/mpeg' : 'audio/wav';
    const base = {
      'content-type': mime,
      'cache-control': 'public, max-age=86400',
      'accept-ranges': 'bytes',
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
        if (start !== null) {
          if (end === null || end >= st.size) end = st.size - 1;
          if (start <= end && start < st.size) {
            res.writeHead(206, Object.assign({}, base, {
              'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
              'content-length': end - start + 1,
            }));
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(f, { start, end }).pipe(res);
          }
        }
      }
    }
    res.writeHead(200, Object.assign({}, base, { 'content-length': st.size }));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(f).pipe(res);
  }

  // ---- Web Push（后台通知）----
  if (route === '/api/push/key' && req.method === 'GET') {
    return json(res, 200, { ok: true, key: push.publicKey(), count: push.count() });
  }
  if (route === '/api/push/subscribe' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    const r = push.subscribe(body.subscription || body);
    log('push', `订阅 ${r.ok ? 'ok' : 'fail'} 共 ${r.total ?? push.count()} 个`);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (route === '/api/push/off' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req, 4 * 1024)); } catch {}
    const r = push.unsubscribe(body.endpoint || '');
    return json(res, 200, r);
  }
  if (route === '/api/push/test' && req.method === 'POST') {
    const r = await push.send({ title: 'DSH 测试通知', body: '能看到这条就说明后台推送通了。', tag: 'dsh-test' });
    return json(res, 200, { ok: r.sent > 0, ...r });
  }
  if (route === '/api/voice' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    if (body.voice) {
      const v = tts.allVoices().find((x) => x.id === body.voice);
      if (!v) return json(res, 400, { ok: false, error: '没有这个音色：' + body.voice });
      state.voice = v.id;
      // 显式选音色时引擎跟着音色走，避免「选了肥鱼的音色但引擎还是 Edge」这种错位
      if (v.engine) state.ttsEngine = v.engine;
    }
    if (body.ttsEngine) {
      const e = tts.ENGINES.find((x) => x.id === body.ttsEngine);
      if (!e) return json(res, 400, { ok: false, error: '没有这个引擎：' + body.ttsEngine });
      state.ttsEngine = e.id;
      // 切引擎但没指定音色：自动挑该引擎的默认音色，不然设置页会出现
      // 「引擎是肥鱼、音色却还是晓萱」的错位显示，用户会以为没切成功。
      if (!body.voice) {
        const cur = tts.allVoices().find((x) => x.id === state.voice);
        if (!cur || cur.engine !== e.id) {
          state.voice = e.id === 'feiyu' ? tts.defaultFeiyuVoice()
            : e.id === 'edge' ? tts.DEFAULT_VOICE
            : 'Huihui';
        }
      }
    }
    if (typeof body.speakAuto === 'boolean') state.speakAuto = body.speakAuto;
    // 按住说话识别完要不要直接发出去（关掉就只填进输入框，等用户改完再发）
    if (typeof body.asrAutoSend === 'boolean') state.asrAutoSend = body.asrAutoSend;
    if (typeof body.ttsChain === 'boolean') state.ttsChain = body.ttsChain;
    const snap = {
      voice: state.voice,
      ttsEngine: state.ttsEngine || 'edge',
      speakAuto: !!state.speakAuto,
      asrAutoSend: state.asrAutoSend !== false,
      ttsChain: state.ttsChain !== false,
    };
    saveState(snap);
    broadcast('voice', snap);
    return json(res, 200, { ok: true, ...snap });
  }

  if (route === '/api/sync-plugins' && req.method === 'POST') {
      const r = syncPlugins({ force: true });
      log('plugins', r.ok ? `手动同步 bundles=${r.bundles}` : `手动同步失败：${r.reason}`);
      broadcast('plugins', r);
      return json(res, r.ok ? 200 : 500, { ok: r.ok, ...r });
    }

    /* ------------------------------------------------------------- 文件上传 */
    /* 语音识别：手机录音 → 文字（whisper.cpp 优先，System.Speech 兜底）
       /api/asr 与 /api/asr-legacy 是同一实现的两个入口：
       - 新版网页走 /api/asr
       - 旧版 APK（MainActivity 里写死）也走 /api/asr，不能再 410，
         否则手机上按住说话永远失败。
       /api/asr-legacy 保留给旧网页缓存，行为完全一致。 */
  if ((route === '/api/asr' || route === '/api/asr-legacy') && req.method === 'POST') {
      if (Number(req.headers['content-length'] || 0) > 12 * 1024 * 1024) {
        return json(res, 413, { ok: false, error: '录音太大了（超过 12MB）' });
      }
      const parts = [];
      let bytes = 0, tooBig = false;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > 12 * 1024 * 1024) {
          if (!tooBig) { tooBig = true; json(res, 413, { ok: false, error: '录音太大了（超过 12MB）' }); }
          req.destroy();
          return;
        }
        parts.push(c);
      });
      req.on('end', async () => {
        if (tooBig) return;
        try {
          const raw = String(req.headers['x-audio-ext'] || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '');
          const r = await asr.transcribe(Buffer.concat(parts), raw || 'm4a');
          if (!r.text) return json(res, 200, { ok: false, error: '没听清，再说一次？', ms: r.ms, engine: r.engine });
          log('asr', `${r.text.length} 字 ${r.ms}ms · ${r.chunks || 1} 段 / ${r.total || 0} 秒 · ${r.engine}`);
          json(res, 200, { ok: true, text: r.text, ms: r.ms, chunks: r.chunks || 1, total: r.total || 0, engine: r.engine });
        } catch (e) {
          log('asr-error', String(e.message || e));
          json(res, 400, { ok: false, error: String(e.message || e) });
        }
      });
      return;
    }

    if (route === '/api/upload' && req.method === 'POST') {
      const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'file.bin'));
      const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'file.bin';
      const dir = path.join(WORKDIR, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const rel = `uploads/${stamp}-${crypto.randomBytes(3).toString('hex')}-${safe}`;
      const dest = path.join(WORKDIR, rel);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > UPLOAD_LIMIT) {
            req.destroy();
            out.destroy();
            reject(new Error('文件太大'));
          }
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      const size = fs.statSync(dest).size;
      log('upload', rel, `${size}B`);
      return json(res, 200, { ok: true, path: rel, name: safe, size });
    }
    // 手机直接下载安装包（浏览器打开即下载，免数据线）
    if (route === '/apk') {
      const apkPath = process.env.PHONE_APK_PATH || path.join(HERE, '..', 'dist', 'DSH-Phone.apk');
      if (!fs.existsSync(apkPath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('安装包不在：' + apkPath);
      }
      const buf = fs.readFileSync(apkPath);
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-disposition': 'attachment; filename="DSH-Phone.apk"',
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    if (route === '/api/file') {
      const rel = String(url.searchParams.get('path') || '');
      if (!/^uploads\/[^/\\]+$/.test(rel)) return json(res, 400, { ok: false, error: 'bad path' });
      const file = path.join(WORKDIR, rel);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const mime =
        { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' }[ext] ||
        'application/octet-stream';
      if (/\.(js|css|webmanifest|json|svg|txt)$/i.test(file)) {
        return sendText(req, res, fs.readFileSync(file), mime, 'private, max-age=600');
      }
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=600' });
      return fs.createReadStream(file).pipe(res);
    }

    /* ============ 摄像头：手机这双眼睛（对齐 see_now 的取景能力） ============
     * 手机端：POST /api/camera/push 推帧；GET /api/camera/arm 挂着等「现在拍」
     * AI 侧 ：GET /api/camera/latest 取帧（会自动叫醒手机）
     */
    if (route === '/api/camera/push' && req.method === 'POST') {
      const mime = String(url.searchParams.get('mime') || req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json(res, 400, { ok: false, error: '只收 jpeg/png/webp' });
      let buf;
      try {
        buf = await readRaw(req, CAM_MAX_BYTES);
      } catch (e) {
        return json(res, 413, { ok: false, error: String(e?.message || e) });
      }
      if (!buf || buf.length < 128) return json(res, 400, { ok: false, error: '这一帧是空的' });
      const frame = camPush(buf, mime, {
        w: url.searchParams.get('w'),
        h: url.searchParams.get('h'),
        facing: url.searchParams.get('facing'),
        via: url.searchParams.get('via'),
        ms: Number(url.searchParams.get('shotAt')) ? Math.max(0, Date.now() - Number(url.searchParams.get('shotAt'))) : 0,
      });
      return json(res, 200, { ok: true, n: frame.n, who: cam.waiters.size ? 'ai' : 'buffer' });
    }

    // 手机挂在这里等：AI 要一眼时立刻回 grab:true，手机拍完推上来。
    if (route === '/api/camera/arm') {
      if (cam.arm.size >= 8) return json(res, 429, { ok: false, error: '挂着的取景请求太多了' });
      const timeout = Math.max(1000, Math.min(60_000, Number(url.searchParams.get('timeout') || 25_000)));
      const tick = Number(url.searchParams.get('fps') || 0);
      if (tick > 0) cam.live.fps = tick;
      let sent = false;
      const entry = {
        res,
        fire(payload) {
          if (sent) return false;
          sent = true;
          clearTimeout(timer);
          cam.arm.delete(entry);
          try { json(res, 200, payload); } catch (_) {}
          return true;
        },
      };
      const timer = setTimeout(() => entry.fire({ ok: true, grab: false, at: Date.now(), live: cam.live.on, reason: 'idle' }), timeout);
      cam.arm.add(entry);
      req.on('close', () => {
        if (sent) return;
        sent = true;
        clearTimeout(timer);
        cam.arm.delete(entry);
      });
      return;
    }

    // AI 侧取帧：有够新的就直给，没有再叫手机睁眼并等它推上来。
    if (route === '/api/camera/latest') {
      const need = Math.max(1, Math.min(9, Number(url.searchParams.get('n') || 1)));
      const maxAge = Math.max(0, Number(url.searchParams.get('maxAge') ?? 1200));
      const timeout = Math.max(0, Math.min(30_000, Number(url.searchParams.get('timeout') ?? 9000)));
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw === null || sinceRaw === '' ? cam.seq : Number(sinceRaw) || 0;
      const age = cam.lastPushAt ? Date.now() - cam.lastPushAt : Infinity;
      let stale = false;
      let list;
      if (age <= maxAge && cam.frames.length >= need) {
        list = cam.frames.slice(-need); // 手机正在推流：手上就有新的，不打扰它
      } else {
        const fresh = cam.frames.filter((f) => f.n > since);
        list = fresh;
        if (fresh.length < need) {
          camArmWake(need - fresh.length);
          list = await camAwait(need, since, timeout);
          if (list.length < need) {
            // 等到点了：把缓冲里最新的给出去，并如实标 stale —— 别让模型以为自己看见的是「现在」
            if (cam.frames.length) list = cam.frames.slice(-need);
            stale = true;
          }
        }
      }
      return json(res, 200, {
        ok: true,
        frames: list.map((f) => ({ n: f.n, ts: f.ts, mime: f.mime, b64: f.b64, w: f.w, h: f.h, facing: f.facing })),
        stale,
        ageMs: cam.lastPushAt ? Date.now() - cam.lastPushAt : null,
        live: cam.live.on,
        state: camState(),
      });
    }

    // 手机宣告进入 / 退出连续取景（推流模式）。退出后靠 arm 按需。
    if (route === '/api/camera/live' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
      const on = body?.on === true;
      cam.live = {
        on,
        at: Date.now(),
        fps: Math.max(0, Math.min(15, Number(body?.fps) || 0)),
        w: Number(body?.w) || 0,
        h: Number(body?.h) || 0,
        facing: String(body?.facing || ''),
        // 手机上选的「他多久看一眼」，下一眼起生效；服务端按它做最小间隔。
        gapMs: Math.max(2000, Math.min(1800000, Number(body?.gapMs) || Number(cam.live.gapMs || 0) || 20000)),
        lastCommentAt: cam.live.lastCommentAt || 0,
        comments: cam.live.comments || 0,
      };
      log('camera', `取景${on ? '开' : '关'} ${cam.live.w}x${cam.live.h}@${cam.live.fps}fps ${cam.live.facing}，每 ${Math.round(cam.live.gapMs / 1000)}s 看一眼`);
      if (on) camArmWake(1); // 刚开就别让 AI 白等一轮
      return json(res, 200, { ok: true, live: { ...cam.live } });
    }

    if (route === '/api/camera/state') {
      return json(res, 200, { ok: true, ...camState() });
    }

    // 手机自检：哪条路抓到的、多大、多久。留在内存里，/api/health 与
    // /api/camera/state 都能看到——主人只用一次，证据就在这儿，不用他复述。
    /* 手机那边量出这一帧是黑的（没出画）：报一声，留个数字。
     没有这一步，「全黑」只能靠人复述；有了它，诊断面板与日志能自己对上。 */
  if (route === '/api/camera/blank' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const why = String((body && body.why) || '').slice(0, 80);
    cam.blank = { n: (cam.blank.n || 0) + 1, at: Date.now(), why };
    if (cam.blank.n <= 3 || cam.blank.n % 20 === 0) {
      log('camera', `拦下全黑帧 #${cam.blank.n}${why ? ' · ' + why : ''}（这一帧没发出去）`);
    }
    return json(res, 200, { ok: true, n: cam.blank.n });
  }

  if (route === '/api/camera/probe' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 900 * 1024)) || '{}'); } catch (_) { body = {}; }
      const recent = String(body.recent || '').slice(0, 400);
    const steps = Array.isArray(body.steps)
        ? body.steps.slice(0, 4).map((s) => ({
            n: String((s && s.n) || '').slice(0, 12),
            ok: !!(s && s.ok),
            ms: Math.round(Number(s && s.ms) || 0),
            why: String((s && s.why) || '').slice(0, 90),
          }))
        : [];
      // 真机环境快照：UA / WebView 版本 / 是否安全上下文 / 权限状态 / 原生桥在不在
      const env = body.env && typeof body.env === 'object'
        ? {
            ua: String(body.env.ua || '').slice(0, 180),
            secure: !!body.env.secure,
            dpr: Number(body.env.dpr) || 0,
            vw: Number(body.env.vw) || 0,
            vh: Number(body.env.vh) || 0,
            perm: String(body.env.perm || '').slice(0, 24),
            cam: String(body.env.cam || '').slice(0, 24),
            native: !!body.env.native,
            build: String(body.env.build || '').slice(0, 40),
          }
        : null;
      /* 结论：等级（ok / warn / bad）+ 一句人能照着做的判断。
         手机那边算好一起送上来，电脑这边只负责存和显示。 */
      const verdict = body.verdict && typeof body.verdict === 'object'
        ? {
            level: ['ok', 'warn', 'bad'].includes(String(body.verdict.level)) ? String(body.verdict.level) : 'warn',
            title: String(body.verdict.title || '').slice(0, 40),
            body: String(body.verdict.body || '').slice(0, 160),
            act: String(body.verdict.act || '').slice(0, 24),
          }
        : null;

      // 自检顺手带回来的那一帧：存下来，我能直接看看到底拍到了什么
      let shot = null;
      if (typeof body.shot === 'string' && body.shot.length > 200) {
        try {
          const buf = Buffer.from(body.shot, 'base64');
          if (buf.length > 200 && buf.length < 900 * 1024) {
            fs.mkdirSync(RUNTIME, { recursive: true });
            fs.writeFileSync(path.join(RUNTIME, 'probe-last.jpg'), buf);
            shot = { bytes: buf.length, at: Date.now() };
          }
        } catch (_) {}
      }
      cam.probe = {
        ok: !!body.ok,
        src: String(body.src || '').slice(0, 24),
        w: Number(body.w) || 0,
        h: Number(body.h) || 0,
        kb: Math.round(Number(body.kb) || 0),
        ms: Math.round(Number(body.ms) || 0),
        why: String(body.why || '').slice(0, 160),
        ...(steps.length ? { steps } : {}), ...(recent ? { recent } : {}),
        ...(env ? { env } : {}),
        ...(shot ? { shot } : {}),
        ...(verdict ? { verdict } : {}),
        at: Date.now(),
      };
      log('camera', `自检 ${cam.probe.ok ? '通过' : '失败'} · ${cam.probe.src || '?'} · ${cam.probe.w}x${cam.probe.h} · ${cam.probe.kb}KB · ${cam.probe.ms}ms${cam.probe.why ? ' · ' + cam.probe.why : ''}`);
      if (verdict) log('camera', `自检结论 · ${verdict.level} · ${verdict.title}${verdict.body ? ' · ' + verdict.body : ''}`);
      if (steps.length) log('camera', '自检分路：' + steps.map((s) => `${s.n}${s.ok ? '✓' : '✗'}${s.ms ? ' ' + s.ms + 'ms' : ''}${s.why ? '(' + s.why + ')' : ''}`).join(' · '));
      if (env) log('camera', `自检环境 · 安全上下文=${env.secure ? '是' : '否'} · 权限=${env.perm || '?'} · 原生桥=${env.native ? '在' : '无'} · ${env.vw}x${env.vh}@${env.dpr} · ${env.ua}`);
      return json(res, 200, { ok: true, probe: cam.probe });
    }

    // 自检带回来的那一帧（原图），给电脑这边直接看
    if (route === '/api/camera/probe/shot') {
      const p = path.join(RUNTIME, 'probe-last.jpg');
      try {
        const buf = fs.readFileSync(p);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      } catch (_) {
        return json(res, 404, { ok: false, error: 'no-shot' });
      }
    }

    // 手机把页面切到后台 / 锁屏：直播先停，别让 AI 每 20 秒叫一次「看一眼」然后说没取到
    if (route === '/api/camera/live/note' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse((await readBody(req, 4096)) || '{}') || {}; } catch (_) { b = {}; }
      const state = String(b.state || '');
      if (state === 'hidden' && !cam.live.paused) {
        cam.live.paused = true;
        cam.live.pausedAt = Date.now();
        noteToChat('［手机把页面切到后台了（锁屏或切走了），这一眼先不看——回来我接着看。］');
        log('camera', '直播暂停：手机页面切到后台');
        return json(res, 200, { ok: true, paused: true });
      }
      if (state === 'ended') {
        // 直播收尾小结：只写一条系统注记，不进模型，不花钱
        const eyes = Math.max(0, Math.min(9999, Math.round(Number(b.eyes) || 0)));
        const mins = Math.max(0, Math.min(1440, Math.round(Number(b.minutes) || 0)));
        const kb = Math.max(0, Math.min(999999, Math.round(Number(b.kb) || 0)));
        const bits = [];
        if (eyes) bits.push('看了 ' + eyes + ' 眼');
        if (mins) bits.push('约 ' + mins + ' 分钟');
        if (kb) bits.push('大致 ' + (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'));
        if (bits.length) noteToChat('［直播结束 · ' + bits.join(' · ') + '］');
        log('camera', '直播结束小结：' + (bits.join(' · ') || '（没有可统计的）'));
        return json(res, 200, { ok: true, ended: true });
      }
      if (state === 'visible' && cam.live.paused) {
        cam.live.paused = false;
        noteToChat('［手机回到前台了，我接着看。］');
        log('camera', '直播恢复：手机页面回到前台');
        return json(res, 200, { ok: true, paused: false });
      }
      return json(res, 200, { ok: true, paused: !!cam.live.paused });
    }

    // 让手机自己跑一次自检：电脑这边点一下就行，不用主人去点「测一下现在的画面」
    if (route === '/api/camera/diag' && req.method === 'POST') {
      cam.diagReq = { id: Date.now(), at: Date.now() };
      log('camera', '远程自检请求已下发，等手机下一次轮询');
      return json(res, 200, { ok: true, diag: cam.diagReq });
    }

    // 直播点评：手机每 N 秒叫一次，让 AI 自己用 phone_see 拉最新一帧来说一句话。
    // 不把帧塞进 prompt，是因为 AI 端已经有眼睛；这样 prompt 只有几十字，便宜。
    if (route === '/api/live/comment' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch (_) { body = {}; }
      const k = Math.max(0, Number(body.k || 0) || 0);
      const gap = Math.max(2000, Math.min(1800000, Number(cam.live.gapMs || process.env.PHONE_LIVE_GAP_MS || 10000)));
      // 客户端按 gap 排下一眼，网络和定时器抖动会让它早几十毫秒到 ——
      // 留 800ms 余量，否则每两轮就撞一次 429，主人看到的就是「他刚看过一眼」。
      // 2 秒那一档也要真的能用：下限放到 1.5 秒（以前是 3 秒，于是设 2 秒就会隔一轮吃一次 429）
  const need = Math.max(1500, gap - 800);
      if (cam.live.paused) {
        return json(res, 409, { ok: false, reason: 'paused', error: '手机页面在后台，先不看' });
      }
      const since = Date.now() - (cam.live.lastCommentAt || 0);
      if (cam.live.lastCommentAt && since < need) {
        return json(res, 429, { ok: false, waitMs: need - since, error: '太密了' });
      }
      // 没有新画面就别叫他把旧帧当现在讲 —— 上一次就是这么让它对着六分钟前
      // 的测试图说「跟上次一样」的。宁可这一眼跳过，也不许编。
      const st0 = camState();
      const freshMs = Math.max(3000, Number(process.env.PHONE_LIVE_FRESH_MS || 7000));
      // 这一条请求自己带着画面（上传成功给了 path，或者内联带了 data）就不算「没有新画面」：
      // push 那条路断了的时候，缓冲是旧的，但照片是真的拍到了 —— 不能把它 409 掉。
      const carriesPath = typeof body.path === 'string' && /^uploads\/[^/\\]+$/.test(body.path);
      const carriesData = typeof body.data === 'string' && body.data.length > 200;
      const carriesShot = carriesPath || carriesData;
      if (!carriesShot && (!cam.frames.length || (st0.ageMs != null && st0.ageMs > freshMs))) {
        log('live', `直播点评 #${k} 跳过：手上没有新画面（${st0.frames} 帧，${st0.ageMs == null ? '从没收到' : Math.round(st0.ageMs) + 'ms 前'}）`);
        return json(res, 409, {
          ok: false,
          reason: 'no-frame',
          frames: st0.frames,
          ageMs: st0.ageMs == null ? null : Math.round(st0.ageMs),
          error: '手机这边没有新画面',
        });
      }
      cam.live.lastCommentAt = Date.now();
      cam.live.comments = (cam.live.comments || 0) + 1;
      // 一轮说话要二十几秒，手机那边十秒一问。排队会把几条指令合成一句长问题，
      // 所以只留「一眼在排队」的余量：已经有一条在等就不再塞。
      // （不能只看 busy —— 偶尔一轮会卡住几十秒，那样直播就永远说不上一句话。）
      if (queue.length > 0) {
        log('live', `直播点评 #${k} 跳过：已经有一眼在排队（busy=${busy} 队列=${queue.length}）`);
        return json(res, 202, { ok: true, skipped: 'busy', queue: queue.length, error: '他还在看上一眼' });
      }
      const st = st0;
      if (carriesShot && (st.ageMs == null || st.ageMs > freshMs)) {
        log('live', `直播点评 #${k} 这一眼靠请求自己带着的画面（缓冲 ${st.ageMs == null ? '从没收到' : Math.round(st.ageMs) + 'ms 前'}）`);
      }
      // 手机这一眼已经把图传上来了：直接当附件发给模型，会话里也就能看到这张照片。
      let shot = typeof body.path === 'string' && /^uploads\/[^/\\]+$/.test(body.path) ? body.path : '';
      // 兜底：手机那边上传失败时，会把这一帧（base64）直接放在这条请求里。
      // 有它就当场落盘成附件，AI 那边照样看得到图，不会退化成「文字问一句」。
      if (!shot && typeof body.data === 'string' && body.data.length > 200) {
        try {
          const buf = Buffer.from(body.data.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
          if (buf.length > 200 && buf.length <= 3 * 1024 * 1024) {
            const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
            const name = 'live-' + stamp + '-' + String(k || 0) + '.jpg';
            const dir = path.join(WORKDIR, 'uploads');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), buf);
            shot = 'uploads/' + name;
            body.size = buf.length;
            log('live', '直播点评 #' + k + ' 用的是请求里带的那一帧（' + Math.round(buf.length / 1024) + ' KB，上传那条路没走通）');
          }
        } catch (_) {}
      }
      const files = shot
        ? [{ path: shot, name: path.basename(shot), size: Number(body.size) || 0, mime: String(body.mime || 'image/jpeg') }]
        : [];
      // 图直接作为图片块送给模型：不依赖它先去读文件，也就不会出现「没截取到帧」。
      const shots = [];
      if (shot) {
        try {
          const abs = path.join(WORKDIR, shot);
          const st2 = fs.statSync(abs);
          if (st2.size > 200 && st2.size <= 1200 * 1024) {
            shots.push({ data: fs.readFileSync(abs).toString('base64'), mimeType: String(body.mime || 'image/jpeg') });
          } else if (st2.size > 1200 * 1024) {
            log('live', '这一帧太大（' + Math.round(st2.size / 1024) + ' KB），只给路径不给图片块');
          }
        } catch (_) {}
      }
      const lines = [
        `【直播 · 第 ${k || cam.live.comments} 眼】主人手机那边开着直播，镜头正对着他要你看的方向。`,
        `服务端缓冲里最近一帧是 ${Math.round(st.ageMs || 0)}ms 前（共 ${st.frames} 帧），镜头朝向 ${st.live.facing || '后置'}。`,
      ];
      if (shot) {
        lines.push(`这一眼拍的画面已经作为附件发过来了：看那张图说话；看不清、要更广的角度，再调 mcp__phone__phone_see（n=1, fresh=true）补一眼。`);
      } else {
        lines.push(`先调 mcp__phone__phone_see（n=1, fresh=true）看一眼当前画面，然后只说一到两句：`);
      }
      lines.push(
        '· 口语，四十字以内，不要列表、不要标题、不要 Markdown；',
        '· 只描述画面里真实存在的东西（人、物、动作、光线、文字），看不清就说看不清，不要编；',
        '· 跟上一眼比有明显变化（姿势换了、多了东西、亮暗变了）就点出来，没有就说一个更细的细节。',
      );
      const lid = await enqueue(lines.join('\n'), files, { display: `直播 · 第 ${k} 眼`, kind: 'live', images: shots });
      log('live', `直播点评 #${k || cam.live.comments} 已入队 id=${lid}`);
      return json(res, 200, { ok: true, id: lid, k: k || cam.live.comments });
    }

    // 手机 ↔ 电脑剪贴板。读出的是电脑当前复制的内容；写入会覆盖电脑剪贴板。
    // 需要令牌：它和聊天权限同级，能读到密码等敏感内容。
    if (route === '/api/clipboard') {
      if (req.method === 'GET') {
        const r = await clipboard.read();
        return json(res, r.ok ? 200 : 500, r, req);
      }
      if (req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); }
        catch (_) { return json(res, 400, { ok: false, error: 'JSON 格式不对' }); }
        if (typeof body.text !== 'string') return json(res, 400, { ok: false, error: '缺少 text' });
        const r = await clipboard.write(body.text);
        return json(res, r.ok ? 200 : 500, r, req);
      }
      return json(res, 405, { ok: false, error: 'GET/POST only' });
    }

    if (route === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify(currentStatus())}\n\n`);
      clients.add(res);
      log('sse', `客户端接入 在线=${clients.size} ua=${String(req.headers['user-agent'] || '').slice(0, 40)}`);
      req.on('close', () => {
        clients.delete(res);
        log('sse', `客户端断开 剩余=${clients.size}`);
      });
      return;
    }

    if (route === '/' || route === '/index.html') {
      return sendText(req, res, uiServe().body, 'text/html; charset=utf-8', 'no-store');
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    // 客户端发了坏 JSON 是 400，不是服务端 500；否则手机只会看到「桥坏了」
    if (err instanceof SyntaxError) {
      log('bad-json', String(err.message || err));
      return json(res, 400, { ok: false, code: 'bad_json', error: '请求体不是合法 JSON' });
    }
    log('error', String(err?.message ?? err));
    json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

// 配了自己的服务器（tunnel.json）就开机自动建隧道，手机随时能连；PHONE_TUNNEL_AUTO=0 可关掉
function maybeAutoTunnel() {
  try {
    if (process.env.PHONE_TUNNEL_AUTO === '0') return;
    const cfgPath = path.join(HERE, 'tunnel.json');
    if (!fs.existsSync(cfgPath)) return;
    link.start(PORT).then((st) => {
      if (st && st.running) log('tunnel-auto', `公网地址 ${st.url}`);
      else log('tunnel-auto', `自动建隧道失败：${st && st.error}`);
    }).catch((e) => log('tunnel-auto', String(e && e.message)));
  } catch (e) {
    log('tunnel-auto', String(e && e.message));
  }
}

// 端口被占时别静默退出（守护脚本只会看到「起不来」，人完全不知道为什么）。
// 直接把占用者揪出来写进日志，用户就知道该关谁、或者该换哪个端口。
server.on('error', (e) => {
  if (!e || e.code !== 'EADDRINUSE') {
    log('error', `监听失败：${(e && e.message) || e}`);
    console.error(e);
    process.exit(4);
  }
  let owner = '';
  try {
    const ps =
      `$c=Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;` +
      `if($c){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue;` +
      `"pid=$($c.OwningProcess) name=$($p.Name) cmd=$($p.CommandLine)"}`;
    owner = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 8000 }) || '').trim();
  } catch (_) {
    /* 查不到就算了，日志里至少还有端口号 */
  }
  log('error', `端口 ${PORT} 已被占用，桥接没能启动${owner ? ' —— 占用者 ' + owner : ''}`);
  log('error', `换端口：插件面板点「换端口」，或设置环境变量 PHONE_BRIDGE_PORT 后再起。`);
  console.error(`[fatal] EADDRINUSE ${PORT} ${owner}`);
  process.exit(3);
});

server.listen(PORT, HOST, () => {
  // pid 文件以「真正在监听的那个进程」为准：守护脚本和 MCP 都能拉起桥接，只让启动方记账会打架
  try { writeAtomic(path.join(RUNTIME, 'bridge.pid'), String(process.pid)); } catch (_) {}
  // 端口定下来了，记到 port.json：插件、守护脚本、隧道下次都按它来
  rememberPort();
  maybeAutoTunnel();
  // 语音缓存按上限瘦一次：老版本默认 220MB/300 个，手机上这目录会一直涨
  setTimeout(function () {
    try {
      const r = tts.cachePrune && tts.cachePrune();
      if (!r) return;
      if (r.dropped > 0) log('tts', `缓存清理：删 ${r.dropped} 个（${(r.bytes / 1048576).toFixed(1)}MB），剩 ${r.count} 个`);
    } catch (e) { catchErr('tts-prune', e); }
  }, 1500);
// 开机预热语音合成：把「第一次才付」的成本提前花掉（失败不影响任何功能）
// 必须尽早：实测冷启动第一发要 12 秒（其中 DNS 解析独占 11.9 秒），
// 越早开始，用户点第一条语音时越可能是热的。放在 8 秒反而会和用户的第一发撞车。
setTimeout(function () {
  try {
    Promise.resolve(tts.warmup && tts.warmup()).then(function (r) {
      if (r) log('tts', 'warmup ' + (r.ok ? 'ok ' + r.ms + 'ms' + (r.cached ? ' (cached)' : '') : 'fail ' + r.error));
    }).catch(function () {});
  } catch (e) {}
}, 500);

// 肥鱼音色同步：references 目录随时会增删，服务端 /styles 会热扫描；这里定时主动拉一次，
// 这样手机设置页不用重开也能拿到新表（/api/voices 每次打开仍会同步一次，双保险）。
try {
  const pullFeiyu = function () {
    const before = JSON.stringify(tts.feiyuVoices ? tts.feiyuVoices() : []);
    Promise.resolve(tts.feiyuStyles(1500)).then(function () {
      const after = JSON.stringify(tts.feiyuVoices ? tts.feiyuVoices() : []);
      // references 目录刚被增删：推一条事件，设置页开着也能立刻换表
      if (before !== after) {
        try { broadcast('voices', { voices: tts.allVoices() }); } catch (e) {}
      }
    }).catch(function () {});
  };
  pullFeiyu();
  const feiyuTimer = setInterval(pullFeiyu, 15000);
  if (feiyuTimer.unref) feiyuTimer.unref();
} catch (e) { catchErr('feiyu-sync', e); }


  startWatchers();
  // 上一轮如果是为了让改动生效而重启的，那条消息在这里补跑
  let bootedFromPending = false;
  if (fs.existsSync(PENDING_MSG)) {
    bootedFromPending = true;
    try {
      const p = JSON.parse(fs.readFileSync(PENDING_MSG, 'utf8'));
      fs.unlinkSync(PENDING_MSG);
      log('restart', '重启完成，补跑刚才那条消息');
      setTimeout(() => {
        try {
          Promise.resolve(enqueue(p.text, p.files || [], p.opts || {})).catch((e) => catchErr('restart-enqueue', e));
        } catch (e) { catchErr('restart-enqueue', e); }
      }, 1500);
      // 这次重启是为了让改动生效，所以起来立刻验一遍（不用等 30 秒那次）
      setTimeout(() => scheduleAutoE2E('重启后'), 15000);
    } catch (e) { catchErr('restart-restore', e); }
  }
  // 启动 30 秒后自动跑一次，确认「刚起来就是好的」（PHONE_E2E_ON_BOOT=0 可关）
  // 刚为「让改动生效」重启过的话，只跑「重启后」那一次，别再叠一个 30 秒的启动回归（两个撞车会互相干扰）
  if (process.env.PHONE_E2E_ON_BOOT !== '0' && !bootedFromPending) {
    setTimeout(() => scheduleAutoE2E('启动'), 30000);
  }
  // 定时提醒：到点广播给所有连着的手机
  // 待办到点：只提醒一次
  setInterval(() => {
    try {
      for (const it of todos.dueNow()) {
        todos.markNotified(it.id);
        broadcast('todo-due', it);
        log('todo-due', it.text.slice(0, 40));
      }
    } catch (_) {}
  }, 20000).unref();
  reminders.start((it) => {
    broadcast('reminder', it);
    log('reminder', `fire ${it.id} ${it.text}`);
  });
  log('listen', `http://${HOST}:${PORT}`, `workdir=${WORKDIR}`);
  for (const a of lanAddresses()) log('lan', `${a.name} http://${a.address}:${PORT}`);
  log('pair-code', state.pairCode);
  // life-persona.md 只注入相处模式那一个会话；任务模式不贴
  log('persona', `life-persona ${lifePersona().length} 字，只注入相处模式会话`);
  // 每轮注入的体积来源，启动时说清楚（排查「又胖了」时第一眼看这里）
  try {
    const bundles = (JSON.parse(fs.readFileSync(path.join(PHONE_PROFILE_DIR, 'package.json'), 'utf8')).dsh?.profile?.bundles || []).length;
    log('profile', `${ENGINE === 'sdk' ? SDK_PROFILE + '（常驻）' : DSH_PROFILE} · ${bundles} 个 bundle · ${DEFAULT_EFFORT} 档 · 条款 ${path.basename(PHONE_INJECT_FILE_RESOLVED)}`);
  } catch (_) {
    log('profile', `${ENGINE === 'sdk' ? SDK_PROFILE + '（常驻）' : DSH_PROFILE} · ${DEFAULT_EFFORT} 档`);
  }

  const urls = bridgeUrls();
  const bare = (u) => String(u).split('/?t=')[0];
  const best = urls.find((u) => !u.includes('127.0.0.1')) ?? urls[0];
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │              DSH 手机通道 已开启                         │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log(`  配对码   :  ${state.pairCode}`);
  console.log(`  手机打开 :  ${bare(best)}`);
  console.log(`  免配对进 :  ${best}`);
  if (urls.length > 1) {
    console.log('  其它地址 :');
    for (const u of urls) if (u !== best) console.log(`              ${bare(u)}`);
  }
  console.log(`  工作目录 :  ${WORKDIR}`);
  console.log('  关闭这个窗口 = 停止通道（或在 DSH 里让我调用 phone_stop）');
  console.log('');
});

/* ------------------------------------------------------------- discovery */

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (buf, rinfo) => {
  const text = buf.toString('utf8').trim();
  if (!text.startsWith('DSH-PHONE-DISCOVER')) return;
  const reply = JSON.stringify({
    app: 'dsh-phone-bridge',
    version: 1,
    port: PORT,
    name: os.hostname(),
    urls: bridgeUrls(),
  });
  udp.send(reply, rinfo.port, rinfo.address, () => {});
});
udp.on('error', (err) => log('udp-error', String(err.message)));
udp.bind(Number(process.env.PHONE_BRIDGE_UDP_PORT || PORT), HOST, () => log('udp-listen', `port=${PORT}`));

/* ------------------------------------------------------------------ exit */

let shuttingDown = false;
function shutdown(sig, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', sig);
  if (running) {
    try {
      running.child.kill();
    } catch {}
  }
  for (const res of clients) {
    try {
      res.end();
    } catch {}
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 兜底：未捕获异常先把现场写进日志、收掉子进程，再退出让守护脚本拉起。
// 不在这里继续跑 —— 进程状态已经不可信，硬撑只会制造更难查的错。
process.on('uncaughtException', (e) => {
  try { log('fatal', 'uncaughtException', String((e && e.stack) || e).slice(0, 1500)); } catch {}
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (e) => {
  try { log('warn', 'unhandledRejection', String((e && e.stack) || e).slice(0, 800)); } catch {}
});
