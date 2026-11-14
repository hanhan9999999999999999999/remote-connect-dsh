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
}

/** 记一条被排除的文件，列表最多留 40 条（计数不受限）。 */
function noteExcluded(ctx, rel, reason) {
  ctx.excludedCount += 1
  const code = EXCLUDE_CODES[reason] ?? 'other'
  ctx.reasonCounts[code] = (ctx.reasonCounts[code] ?? 0) + 1
  if (ctx.excluded.length < 40) ctx.excluded.push({ rel, reason })
}

async function walk(rootAbs, relRoot, ctx, out) {
  let dir
  try {
    dir = await fsp.opendir(rootAbs)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  ctx.dirsScanned += 1
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
      await walk(abs, rel, ctx, out)
      continue
    }
    if (!dirent.isFile()) continue
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      continue
    }
    const reason = excludedFile(rel, stat.size, ctx.maxFileBytes, ctx.includeSecrets)
    if (reason) {
      noteExcluded(ctx, rel, reason)
      continue
    }
    out.push({ rel, size: stat.size, mtime: Math.round(stat.mtimeMs), mode: stat.mode & 0o777, abs })
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
