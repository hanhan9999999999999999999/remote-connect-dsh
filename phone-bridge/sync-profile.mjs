// 把 desktop profile 的插件清单自动镜像到手机端（phone profile）。
// 目标：以后在桌面装的任何插件，手机端下一条消息就能用，不用手动搬。
//
// 做法：
//   1. 读 %USERPROFILE%\.dsh\profiles\desktop\package.json
//   2. 过滤掉「headless 里没有意义 / 会出问题」的包
//   3. 写 phone\package.json（dependencies + dsh.profile.bundles）
//   4. 用 --dump-config 做健康检查；不通过就回滚到上一份好的清单
//
// 依赖共用：phone\node_modules 是指向 desktop\node_modules 的目录联接，
// 所以这里只维护「清单」，不复制任何文件。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILES = path.join(DSH_HOME, 'profiles');
const SRC = path.join(PROFILES, 'desktop');
// 注意：必须跟 server.mjs 用同一个默认值。以前这里写死 'phone'、server 用 'phone-lite'，
// 结果同步去校验一个根本没在用的 profile，还拿一条早就失效的 dsh 路径去 spawn，
// 于是每次启动都刷一条「新清单加载失败，且没有可回滚的备份」（2026-11-15 修）。
const PROFILE_NAME = process.env.PHONE_DSH_PROFILE || 'phone-lite';
const DST = path.join(PROFILES, PROFILE_NAME);
const DST_PKG = path.join(DST, 'package.json');
const BACKUP = path.join(DST, 'package.json.last-good');

// 同样必须用 fileURLToPath：pathname 会把目录名里的空格编码成 %20，
// 状态文件就会落到影子目录（2026-10-31 修）。
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(BRIDGE_DIR, 'runtime');
const SYNC_LOG = path.join(RUNTIME, 'profile-sync.json');

const BIN_CANDS = [
  process.env.DSH_BIN,
  'D:\\DSH\\DSH NEXT\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  path.join(process.env.DSH_APP_DIR || '', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  'D:\\deepseekharness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
].filter(Boolean);
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const DSH_BIN = BIN_CANDS.find(exists) || BIN_CANDS[BIN_CANDS.length - 1];
const DSH_NODE = process.env.DSH_NODE || process.execPath;

// 这些包只服务于桌面 GUI / 会跟手机端抢模型，不进 headless。
const SKIP = [
  // purge 是「给桌面 DSH 打提示词补丁」的工具，headless 下它启动时要扫宿主目录，
  // 每人每次冷启动白等 5.5 秒（日志：未定位到宿主 @deepseek-ai 目录）。手机端不需要它。
  /^dsh-purge-community$/,
  /^@deepseek-ai\/dsh-web-app$/,
  /^@deepseek-ai\/dsh-headless$/,        // 单独处理，永远放最前
  /^@linxin666\/dsh-web-all$/,
  /^@linxin666\/dsh-remote-web-ui$/,
  /^@linxin666\/dsh-client-ui-/,
  // 手机端用不到浏览器自动化；它启动时要 spawn bsk 探测，连 ENOENT 都白等 3.6 秒（实测 3718ms）。
  /browser-skill-dsh-plugin/,
  /^dsh-better-sidebar$/,
  /^dshmarket$/,
  /^dsh-our-free-model$/,                // 会覆盖 agent-default-model，破坏手机端切模型
];
const isSkipped = (name) => SKIP.some((re) => re.test(name));

// 手机端专属、桌面清单里没有的本地包（放在 D:\document\Remote Connect DSH\plugins 下维护）。
// 同步逻辑每次会用 desktop 清单整体重写 phone/package.json，所以这些必须显式追加，
// 否则会被「同步」静默抹掉（2026-10-31 踩过：加了 @local/dsh-prompt-inject，重启就没了）。
const EXTRA_BUNDLES = ['@local/dsh-prompt-inject'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonIfChanged(file, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  let prev = null;
  try { prev = fs.readFileSync(file, 'utf8'); } catch {}
  if (prev === next) return false;
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/** 期望的 phone/package.json 内容 */
function desired() {
  const src = readJson(path.join(SRC, 'package.json'));
  const srcBundles = (src.dsh?.profile?.bundles) || [];
  const srcDeps = src.dependencies || {};

  const deps = {};
  for (const [name, ver] of Object.entries(srcDeps)) {
    if (isSkipped(name)) continue;
    deps[name] = ver;
  }

  const bundles = [];
  const push = (name) => { if (name && !bundles.includes(name)) bundles.push(name); };
  push('@deepseek-ai/dsh-base');
  push('@deepseek-ai/dsh-headless');
  for (const name of srcBundles) {
    if (isSkipped(name)) continue;
    if (name === '@deepseek-ai/dsh-headless') continue;
    push(name);
  }
  for (const name of EXTRA_BUNDLES) push(name);

  return {
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  };
}

/** 用 --dump-config 验证这份清单能不能被 headless 真正加载 */
function validate() {
  if (!exists(DSH_BIN)) {
    return { ok: false, status: -1, skipped: [], tail: `找不到 dsh 入口：${DSH_BIN}` };
  }
  const cwd = path.join(BRIDGE_DIR, 'workspace');
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
  const r = spawnSync(DSH_NODE, [DSH_BIN, '--profile', PROFILE_NAME, '--dump-config'], {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && /^\s*-\s+id:\s*\S+/m.test(out);
  const skipped = (out.match(/skipping profile bundle "([^"]+)"/g) || []).map((s) => s.replace(/.*"([^"]+)".*/, '$1'));
  return { ok, status: r.status, skipped, tail: out.slice(-1200) };
}

function logSync(info) {
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.writeFileSync(SYNC_LOG, JSON.stringify({ ...info, at: Date.now() }, null, 2), 'utf8');
  } catch {}
}

export function lastSync() {
  try { return readJson(SYNC_LOG); } catch { return null; }
}

/**
 * 同步。force=true 时即使 desktop 的 package.json 没变也重新校验。
 * 返回 { ok, changed, added, removed, skipped, reason? }
 */
export function sync({ force = false } = {}) {
  // phone-lite 是「静态精简 profile」：清单由 server.mjs 的 ensurePhoneProfile 维护，
  // 不再镜像 desktop —— 镜像一次就会把 25 个 bundle 全塞回来，等于把这个优化抹掉。
  if (PROFILE_NAME === 'phone-lite') {
    let bundles = 0;
    try { bundles = (readJson(DST_PKG).dsh?.profile?.bundles || []).length; } catch {}
    const info = { ok: true, changed: false, added: [], removed: [], skipped: [], bundles, reason: 'phone-lite 为静态精简 profile，跳过镜像' };
    logSync(info);
    return info;
  }
  let srcStat;
  try {
    srcStat = fs.statSync(path.join(SRC, 'package.json'));
  } catch {
    return { ok: false, changed: false, reason: '找不到 desktop profile 的 package.json' };
  }

  let want;
  try { want = desired(); }
  catch (e) { return { ok: false, changed: false, reason: `读取 desktop 清单失败：${e.message}` }; }

  let have = null;
  try { have = readJson(DST_PKG); } catch {}

  const haveBundles = new Set(have?.dsh?.profile?.bundles || []);
  const wantBundles = new Set(want.dsh.profile.bundles);
  const added = [...wantBundles].filter((b) => !haveBundles.has(b));
  const removed = [...haveBundles].filter((b) => !wantBundles.has(b));
  const same = have && JSON.stringify(have) === JSON.stringify(want);

  if (same && !force) {
    const prev = lastSync();
    if (prev?.ok) return { ok: true, changed: false, added: [], removed: [], skipped: prev.skipped || [] };
  }

  // 写新的
  try { fs.mkdirSync(DST, { recursive: true }); } catch {}
  writeJsonIfChanged(DST_PKG, want);

  const v = validate();
  if (!v.ok) {
    // 回滚
    let restored = null;
    try {
      if (fs.existsSync(BACKUP)) {
        fs.copyFileSync(BACKUP, DST_PKG);
        restored = 'package.json.last-good';
      }
    } catch {}
    const info = {
      ok: false, changed: true, added, removed, skipped: v.skipped,
      reason: restored
        ? `新清单加载失败，已回滚到 ${restored}：${(v.tail || '').slice(-300)}`
        : `新清单加载失败，且没有可回滚的备份：${(v.tail || '').slice(-300)}`,
    };
    logSync(info);
    return info;
  }

  try { fs.copyFileSync(DST_PKG, BACKUP); } catch {}
  const info = { ok: true, changed: !same, added, removed, skipped: v.skipped, bundles: want.dsh.profile.bundles.length };
  logSync(info);
  return info;
}

/** 需要时才同步（desktop 清单比上次同步更新） */
let lastSrcMtime = 0;
export function syncIfStale() {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(SRC, 'package.json')).mtimeMs; } catch {}
  if (mtime && mtime === lastSrcMtime) return { ok: true, changed: false, cached: true };
  lastSrcMtime = mtime;
  return sync({ force: true });
}

if (process.argv[1] && process.argv[1].endsWith('sync-profile.mjs')) {
  const r = sync({ force: true });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
