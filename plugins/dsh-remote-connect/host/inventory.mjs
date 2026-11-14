/**
 * dsh-remote-connect · inventory
 *
 * Maps the DSH home directory onto six transfer categories. Scanning is
 * read-only, never follows symlinks/junctions, and excludes the things that
 * must never travel between machines (credentials, dependencies, caches).
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataHome, dshHome } from './config.mjs'
import { AppError } from './util.mjs'

export const CATEGORY_ORDER = ['skills', 'rules', 'plugins', 'config', 'sessions', 'plugin-data']

export const CATEGORIES = {
  skills: {
    label: '技能',
    desc: 'skills/ 目录与技能索引、同步脚本',
    defaultOn: true,
    roots: ['skills', 'skills-index.md', 'skills-manifest.json', 'skills-sync.mjs'],
  },
  rules: {
    label: '规则与预设',
    desc: 'prompt-inject.md、cordis.patch.yml、.agent-presets/',
    defaultOn: true,
    roots: ['prompt-inject.md', 'prompt-reminder.md', 'cordis.patch.yml', '.agent-presets'],
  },
  plugins: {
    label: '插件',
    desc: 'plugins/ 源码 + profile 的依赖与 bundles',
    defaultOn: true,
    roots: ['plugins'],
    profileDeps: true,
  },
  config: {
    label: '设置',
    desc: 'profiles 的 cordis 配置、storages 偏好、顶层 JSON',
    defaultOn: true,
    roots: [
      'profiles',
      'storages',
      'task-board',
      'pet.json',
      'tts.json',
      'voice.json',
      'asr.json',
      'watch.json',
      'see-now.json',
      'dsh.json',
      'dsh.config.json',
      'settings.json',
    ],
  },
  sessions: {
    label: '对话记录',
    desc: 'sessions/ 会话存档（按工作区编码）',
    defaultOn: true,
    roots: ['sessions'],
  },
  'plugin-data': {
    label: '插件数据',
    desc: 'plugins-data/、tiny 记忆库等（体积不可控）',
    defaultOn: false,
    roots: ['plugins-data', 'meow-memory', 'memory-nebula', 'dsh-see-now'],
  },
}

const ALWAYS_EXCLUDE_DIR = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
])
const ALWAYS_EXCLUDE_FILE = [
  /\.log$/i,
  /\.tmp$/i,
  /\.part$/i,
  /\.swp$/i,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /\.map$/i,
  /\.lock$/i,
]
const SECRET_FILE = [
  /(^|\/)\.credentials\.yaml$/i,
  /(^|\/)\.dshw-api\.json$/i,
  /(^|\/)model_config\.json$/i,
  // `.env`、`prod.env`、`.env.local` 都按凭据算：真实项目里三种写法都有人用，
  // 只认「文件名正好是 .env」会漏掉后两种。
  /\.env(\.[a-z0-9_-]+)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)cookies?(\.txt)?$/i,
]

/**
 * Why one file must not travel. Secrets are only dropped when the caller has
 * not opted in: 「包含凭据」在界面上是个明确开关，勾了就该真的带上，而不是
 * 只对分类根目录下那几个直接文件生效、目录深处照样悄悄丢掉。
 */
function excludedFile(rel, size, maxFileBytes, includeSecrets = false) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (ALWAYS_EXCLUDE_FILE.some((re) => re.test(base))) return '日志/临时文件'
  if (!includeSecrets && SECRET_FILE.some((re) => re.test(rel))) return '凭据/密钥'
  if (size > maxFileBytes) return `超过单文件上限`
  return null
}

/**
 * 排除理由的稳定代号：明细里给人看的是中文，跨进程报统计时用代号，
 * 界面才能按自己的语言去翻译，而不用去匹配中文串。
 */
const EXCLUDE_CODES = {
  '凭据/密钥': 'secret',
  '日志/临时文件': 'log',
  '超过单文件上限': 'big',
  // 这两种不是「按规则跳过」，而是「读不到」：权限不够、层级太深。
  // 它们的计入方式与前者一致（进总数、进原因分组、明细也能展开），
  // 这样界面只需一句话就能说清「有多少东西没进清单、为什么」。
  '读不了（权限不足）': 'denied',
  '目录层级太深': 'deep',
}

/**
 * 目录递归的深度上限。正常项目不会超过十几层，但目录树是可以被人为
 * 造到几千层的（或者被某个同步工具造出来），一路递归下去会先撞上
 * 系统路径长度上限、再撞上调用栈。到了上限就把这一支整体算作「没进清单」，
 * 而不是让整个分类扫描失败。
 */
export const MAX_DEPTH = 64

/** 记一条被排除的文件，列表最多留 40 条（计数不受限）。 */
function noteExcluded(ctx, rel, reason) {
  ctx.excludedCount += 1
  const code = EXCLUDE_CODES[reason] ?? 'other'
  ctx.reasonCounts[code] = (ctx.reasonCounts[code] ?? 0) + 1
  if (ctx.excluded.length < 40) ctx.excluded.push({ rel, reason, code })
}

async function walk(rootAbs, relRoot, ctx, out, depth = 1) {
  // 太深的目录不再往下走：路径长度迟早撞上限，递归也会先爆栈。
  // 这一支整体算作「没进清单」，而不是让整个分类扫描失败。
  if (depth > MAX_DEPTH) {
    noteExcluded(ctx, relRoot || '.', '目录层级太深')
    return
  }
  let dir
  try {
    dir = await fsp.opendir(rootAbs)
  } catch (err) {
    if (err.code === 'ENOENT') return
    // 一个读不了的子目录（权限、被别的程序锁住、路径过长）不该拖垮整次扫描：
    // 记一笔「读不了」，继续扫别的。
    noteExcluded(ctx, relRoot || '.', '读不了（权限不足）')
    ctx.unreadable = (ctx.unreadable ?? 0) + 1
    return
  }
  ctx.dirsScanned += 1
  try {
    for await (const dirent of dir) {
      const rel = relRoot ? `${relRoot}/${dirent.name}` : dirent.name
      const abs = path.join(rootAbs, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (ALWAYS_EXCLUDE_DIR.has(dirent.name)) continue
        if (rel === 'storages/session_projcache') continue
        if (/^\.git/.test(dirent.name)) continue
        // Never ship our own state: config.json holds the connection password,
        // peers.json holds session keys, and backups hold everyone's old files.
        const dirAbs = path.resolve(abs)
        if (dirAbs === ctx.ownData || dirAbs.startsWith(ctx.ownData + path.sep)) continue
        await walk(abs, rel, ctx, out, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      let stat
      try {
        stat = await fsp.stat(abs)
      } catch {
        // 列得出来但 stat 不了（刚被删、被锁）——以前是静默跳过，
        // 于是「清单里少了一个文件」这件事没人知道。
        noteExcluded(ctx, rel, '读不了（权限不足）')
        ctx.unreadable = (ctx.unreadable ?? 0) + 1
        continue
      }
      const reason = excludedFile(rel, stat.size, ctx.maxFileBytes, ctx.includeSecrets)
      if (reason) {
        noteExcluded(ctx, rel, reason)
        continue
      }
      out.push({ rel, size: stat.size, mtime: Math.round(stat.mtimeMs), mode: stat.mode & 0o777, abs })
    }
  } catch {
    // 迭代途中出错（目录在扫描过程中被删、权限被改）也只记一笔，不打断整次扫描。
    noteExcluded(ctx, relRoot || '.', '读不了（权限不足）')
    ctx.unreadable = (ctx.unreadable ?? 0) + 1
  }
}

/** Collect a single category (files only, symlinks skipped). */
export async function scanCategory(cat, { includeSecrets = false, maxFileMb = 512 } = {}) {
  const def = CATEGORIES[cat]
  if (!def) throw new AppError('CATEGORY', `未知分类：${cat}`)
  const root = dshHome()
  const ctx = {
    maxFileBytes: maxFileMb * 1024 * 1024,
    includeSecrets,
    excluded: [],
    excludedCount: 0,
    reasonCounts: {},
    dirsScanned: 0,
    ownData: path.resolve(dataHome()),
  }
  const out = []
  for (const rel of def.roots) {
    const abs = path.join(root, rel)
    let stat = null
    try {
      stat = await fsp.lstat(abs)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await walk(abs, rel, ctx, out)
    } else if (stat.isFile()) {
      const reason = excludedFile(rel, stat.size, ctx.maxFileBytes, includeSecrets)
      if (reason) {
        noteExcluded(ctx, rel, reason)
      } else {
        out.push({ rel, size: stat.size, mtime: Math.round(stat.mtimeMs), mode: stat.mode & 0o777, abs })
      }
    }
  }
  if (def.profileDeps) {
    const profiles = await listProfiles()
    for (const p of profiles) {
      if (!p.packageJson) continue
      const rel = `profiles/${p.name}/package.json`
      const raw = JSON.stringify(p.packageJson, null, 2)
      out.push({
        rel,
        size: Buffer.byteLength(raw),
        mtime: Math.round(p.mtime),
        mode: 0o644,
        virtual: 'profile-package',
        bytes: Buffer.from(raw),
        op: 'merge-profile',
      })
    }
  }
  return { entries: out, stats: ctx }
}

export async function listProfiles() {
  const root = path.join(dshHome(), 'profiles')
  let names = []
  try {
    names = await fsp.readdir(root)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const file = path.join(root, name, 'package.json')
    try {
      const stat = await fsp.stat(file)
      const text = await fsp.readFile(file, 'utf8')
      out.push({ name, path: file, mtime: stat.mtimeMs, packageJson: JSON.parse(text) })
    } catch {
      out.push({ name, path: file, mtime: Date.now(), packageJson: null })
    }
  }
  return out
}

export async function scanAll({ cats, includeSecrets = false, maxFileMb = 512 } = {}) {
  const selected = (cats && cats.length ? cats : CATEGORY_ORDER).filter((c) => CATEGORIES[c])
  const excluded = []
  const excludedReasons = {}
  let excludedTotal = 0
  const started = Date.now()
  // The same relative path can be produced by two categories (a profile
  // package.json is both a config file and a virtual merged entry for the
  // plugins category). Keep exactly one entry per path, and always prefer the
  // virtual entry that carries an operation, otherwise the plain copy would
  // overwrite the merge result later in the tar stream.
  const unique = new Map()
  for (const cat of selected) {
    const { entries: list, stats } = await scanCategory(cat, { includeSecrets, maxFileMb })
    for (const item of list) {
      item.cat = cat
      const key = String(item.rel).replace(/\\/g, '/')
      const prev = unique.get(key)
      if (!prev || (!prev.op && item.op)) unique.set(key, item)
    }
    for (const ex of stats.excluded) excluded.push({ cat, ...ex })
    excludedTotal += stats.excludedCount ?? 0
    for (const [reason, n] of Object.entries(stats.reasonCounts ?? {})) {
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + n
    }
  }
  const entries = [...unique.values()]
  const summary = {}
  for (const item of entries) {
    const slot = (summary[item.cat] ??= { files: 0, bytes: 0 })
    slot.files += 1
    slot.bytes += item.size
  }
  for (const cat of selected) summary[cat] ??= { files: 0, bytes: 0 }
  return {
    entries,
    summary,
    excluded,
    excludedTotal,
    excludedReasons,
    totalFiles: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    ms: Date.now() - started,
    at: Date.now(),
  }
}

/** Stable manifest id: independent of ordering and mtimes. */
export function manifestId(entries) {
  const hash = createHash('sha256')
  for (const row of entries.map((e) => `${e.cat}:${e.rel}:${e.size}`).sort()) {
    hash.update(row)
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 32)
}
