/**
 * 把本插件装进 desktop profile。
 *
 * 为什么不用 `dsh plugin install`：desktop profile 被 Electron 独占，命令行那条路会被顶回来。
 * 所以照 dsh-see-now 的开发装法：
 *   1. cp 源码目录 → <DSH_HOME>/profiles/desktop/node_modules/<包名>
 *   2. <DSH_HOME>/profiles/desktop/package.json 的 dependencies[<包名>] = "file:<源码路径>"
 *   3. 同一个 package.json 的 dsh.profile.bundles 里加上包名
 *
 * 改 package.json 之前一定先备份 —— 那是 DSH 自己的文件，改坏了整台机器都起不来。
 *
 *   node scripts/install-dev.mjs           安装 / 覆盖更新
 *   node scripts/install-dev.mjs --check   只对账，不写盘
 *   node scripts/install-dev.mjs --remove  卸载（同样先备份）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));
const NAME = PKG.name;

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const REMOVE = args.has('--remove');

const DSH_HOME = process.env.DSH_HOME
  || (existsSync('D:\\dsh-home') ? 'D:\\dsh-home' : join(homedir(), '.dsh'));
const PROFILE = join(DSH_HOME, 'profiles', 'desktop');
const PROFILE_PKG = join(PROFILE, 'package.json');
const TARGET = join(PROFILE, 'node_modules', NAME);

const SKIP = new Set(['node_modules', '.git', '.out', '.probe', '.tmp', 'test', 'debug']);

function say(msg) { console.log(msg); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

if (!existsSync(PROFILE_PKG)) {
  die(`没找到 profile：${PROFILE_PKG}\n  用 DSH_HOME=<你的 DSH 数据目录> 指定一下。`);
}

const profileText = readFileSync(PROFILE_PKG, 'utf8');
let profileJson;
try { profileJson = JSON.parse(profileText); } catch (e) { die(`profile package.json 不是合法 JSON：${e.message}`); }

const bundles = profileJson.dsh?.profile?.bundles ?? profileJson.dsh?.bundles ?? null;
const deps = profileJson.dependencies ?? (profileJson.dependencies = {});
const inDeps = Object.prototype.hasOwnProperty.call(deps, NAME);
const inBundles = Array.isArray(bundles) && bundles.includes(NAME);
const installed = existsSync(join(TARGET, 'package.json'));

say(`源码     ${SRC}`);
say(`包名     ${NAME}@${PKG.version}`);
say(`profile  ${PROFILE}`);
say(`目标     ${TARGET}`);
say(`当前     dependencies ${inDeps ? '有' : '无'} · bundles ${inBundles ? '有' : '无'} · 目录 ${installed ? '在' : '不在'}`);

if (CHECK) {
  if (!installed) die('还没装。');
  const dist = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'));
  say(`已装版本 ${dist.version}`);
  const srcTime = statSync(join(SRC, 'client.js')).mtimeMs;
  const dstTime = existsSync(join(TARGET, 'client.js')) ? statSync(join(TARGET, 'client.js')).mtimeMs : 0;
  say(`client.js  ${dstTime >= srcTime ? '已是最新' : '比源码旧，需要重装'}`);
  say(`dependencies ${inDeps ? '✓' : '✗ 缺'} · bundles ${inBundles ? '✓' : '✗ 缺'}`);
  process.exit(0);
}

// ── 备份 ────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = `D:\\备份\\${stamp}-see-world-${REMOVE ? 'remove' : 'install'}`;
mkdirSync(backupDir, { recursive: true });
const backupPkg = join(backupDir, 'package.json');
writeFileSync(backupPkg, profileText, 'utf8');
say(`\n已备份 profile package.json → ${backupPkg}`);
say(`  （要还原：copy "${backupPkg}" "${PROFILE_PKG}"）`);

if (REMOVE) {
  if (installed) {
    rmSync(TARGET, { recursive: true, force: true });
    say(`已删除 ${TARGET}`);
  }
  delete deps[NAME];
  if (Array.isArray(bundles)) {
    const next = bundles.filter((b) => b !== NAME);
    if (next.length !== bundles.length) {
      if (profileJson.dsh?.profile?.bundles) profileJson.dsh.profile.bundles = next;
      else profileJson.dsh.bundles = next;
      say('已从 bundles 里移除');
    }
  }
  writeFileSync(PROFILE_PKG, `${JSON.stringify(profileJson, null, 2)}\n`, 'utf8');
  say(`已从 dependencies 里移除\n\n重启 DSH 后生效。`);
  process.exit(0);
}

// ── 拷源码 ──────────────────────────────────────────────
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
let copied = 0;
cpSync(SRC, TARGET, {
  recursive: true,
  filter: (from) => {
    const base = from.slice(SRC.length + 1).split(/[\\/]/)[0];
    if (!base) return true;
    if (SKIP.has(base)) return false;
    if (base.endsWith('.log')) return false;
    copied += 1;
    return true;
  },
});
say(`\n已拷源码 → ${TARGET}`);

// ── 改 profile package.json ─────────────────────────────
let touched = 0;
if (deps[NAME] !== `file:${SRC}`) {
  deps[NAME] = `file:${SRC}`;
  touched += 1;
}
if (Array.isArray(bundles) && !inBundles) {
  bundles.push(NAME);
  touched += 1;
}
if (touched) {
  writeFileSync(PROFILE_PKG, `${JSON.stringify(profileJson, null, 2)}\n`, 'utf8');
  say(`已更新 profile package.json（${touched} 处）`);
} else {
  say('profile package.json 已经是想要的形状，没动');
}

say([
  '',
  '装好了。接下来：',
  '  1. 重启 DSH（设置里那个「重启」，或者退出再打开）—— 我没有替你重启。',
  '  2. 起来之后：侧栏「设置 → 看世界」选摄像头；会话输入框上方点「看世界」看实时画面。',
  `  3. ffmpeg 没被找到的话，写 ${join(DSH_HOME, 'see-world.json')} 的 ffmpegPath，或用环境变量 DSH_FFMPEG_PATH。`,
  `  卸载：node scripts/install-dev.mjs --remove`,
].join('\n'));
