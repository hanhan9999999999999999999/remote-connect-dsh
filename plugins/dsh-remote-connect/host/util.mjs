/**
 * dsh-remote-connect · shared helpers
 * Zero dependencies. Node >= 20.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const APP_ID = 'dsh-remote-connect'
export const APP_NAME = '远程互联'
export const PROTOCOL = 'dsh-link/v1'
export const VERSION = '1.0.69'

/** @returns {string} */
export function rid(bytes = 12) {
  return randomBytes(bytes).toString('hex')
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256File(file, { signal } = {}) {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file)
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('aborted')
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}

export function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Resolve a client-supplied relative path inside `root`. Rejects traversal. */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('空路径')
  if (rel.length > 1024) throw new Error('路径过长')
  if (rel.includes('\0')) throw new Error('路径含非法字符')
  const norm = rel.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new Error('禁止绝对路径')
  const parts = norm.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new Error('路径含非法段')
    if (/[<>:"|?*]/.test(part) && process.platform === 'win32') throw new Error('路径含非法字符')
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(part) && process.platform === 'win32') {
      throw new Error('路径为 Windows 保留名')
    }
  }
  const abs = path.resolve(root, ...parts)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('路径越界')
  return abs
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function pathExists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Atomic JSON write: tmp + rename, 0600. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${rid(4)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, file)
  return value
}

export async function writeFileAtomic(file, data) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${rid(4)}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function nowIso() {
  return new Date().toISOString()
}

/** Simple TTL cache. */
export class TtlCache {
  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs
    this.map = new Map()
  }
  get(key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.exp) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }
  set(key, value, ttlMs = this.ttlMs) {
    this.map.set(key, { value, exp: Date.now() + ttlMs })
    return value
  }
  delete(key) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

export function clampInt(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function parseBool(v, fallback = false) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true
  if (v === false || v === 'false' || v === 0 || v === '0') return false
  return fallback
}

/** LAN IPv4 addresses (no internal). */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ iface: name, address: item.address })
    }
  }
  return out
}

export function hostname() {
  return os.hostname() || 'dsh-device'
}

export function platformLabel() {
  const map = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return `${map[process.platform] ?? process.platform} ${os.release()}`
}

/** Error carrying a stable machine-readable code for the UI. */
export class AppError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.extra = extra
  }
}

export class Logger {
  constructor({ ring = 500, file = null, maxPendingBytes = 4 * 1024 * 1024 } = {}) {
    this.ring = ring
    this.file = file
    this.entries = []
    this.stream = null
    this.seenOnce = new Set()
    /** 首次写盘失败的原因；有值之后不再尝试打开文件，只留内存。 */
    this.fileBroken = null
    /** 还没真正落到盘上的字节数，用来给背压兜底。 */
    this.pendingBytes = 0
    this.maxPendingBytes = Number.isFinite(maxPendingBytes) && maxPendingBytes > 0 ? maxPendingBytes : 4 * 1024 * 1024
    /** 因为背压/写不进去被丢掉的条数。 */
    this.dropped = 0
    this.closed = false
  }
  #noteInMemory(level, scope, msg) {
    const entry = { t: Date.now(), level, scope, msg: String(msg) }
    this.entries.push(entry)
    if (this.entries.length > this.ring) this.entries.splice(0, this.entries.length - this.ring)
    return entry
  }
  #ensureStream() {
    if (this.closed || !this.file || this.fileBroken) return null
    if (this.stream) return this.stream
    let stream
    try {
      stream = fs.createWriteStream(this.file, { flags: 'a' })
    } catch (err) {
      this.fileBroken = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
      this.#noteInMemory('warn', 'log', `日志文件打不开（${this.fileBroken}），之后只留在内存里：${this.file}`)
      return null
    }
    // 写盘的错误是异步抛的：不挂 error 监听，Node 会把它升级成未捕获异常，
    // 整个 DSH 跟着一起退出——「日志写不进去」不该是致命错误。
    stream.on('error', (err) => {
      this.fileBroken = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
      this.pendingBytes = 0
      try {
        stream.destroy()
      } catch {
        /* ignore */
      }
      if (this.stream === stream) this.stream = null
      this.#noteInMemory('warn', 'log', `日志文件写不进去（${this.fileBroken}），之后只留在内存里：${this.file}`)
    })
    this.stream = stream
    return stream
  }
  #push(level, scope, msg, extra) {
    const entry = { t: Date.now(), level, scope, msg: String(msg), ...(extra ? { extra } : {}) }
    this.entries.push(entry)
    if (this.entries.length > this.ring) this.entries.splice(0, this.entries.length - this.ring)
    const stream = this.#ensureStream()
    if (stream) {
      let line = ''
      try {
        line = `${JSON.stringify(entry)}\n`
      } catch {
        // 循环引用之类的 extra：退回只有基本字段的一行
        line = `${JSON.stringify({ t: entry.t, level: entry.level, scope: entry.scope, msg: entry.msg })}\n`
      }
      if (this.pendingBytes + line.length > this.maxPendingBytes) {
        // 盘写得比产生的慢（或卡住）时，宁可丢日志也不能把内存吃光
        this.dropped += 1
        if (this.dropped === 1) {
          this.#noteInMemory('warn', 'log', `日志积压超过 ${Math.round(this.maxPendingBytes / 1024)} KB，后续写不进去的行会被丢弃`)
        }
      } else {
        this.pendingBytes += line.length
        try {
          stream.write(line, () => {
            this.pendingBytes = Math.max(0, this.pendingBytes - line.length)
          })
        } catch {
          this.pendingBytes = Math.max(0, this.pendingBytes - line.length)
        }
      }
    }
    return entry
  }
  info(scope, msg, extra) {
    return this.#push('info', scope, msg, extra)
  }
  warn(scope, msg, extra) {
    return this.#push('warn', scope, msg, extra)
  }
  error(scope, msg, extra) {
    return this.#push('error', scope, msg, extra)
  }
  /**
   * 同一个 key 只记一条警告。
   *
   * 「尽力而为」的分支（进度查询、缓存写盘、恢复会话…）出错时不该刷屏，
   * 但也不该像以前那样彻底静默——一次 401 就这样藏了两个版本，
   * 现场只表现为「进度条一直不动」。第一次出错必须留下痕迹。
   */
  warnOnce(key, scope, msg, extra) {
    if (this.seenOnce.has(key)) return null
    this.seenOnce.add(key)
    return this.#push('warn', scope, msg, extra)
  }
  list(limit = 200) {
    return this.entries.slice(-limit)
  }
  close() {
    this.closed = true
    const stream = this.stream
    this.stream = null
    try {
      stream?.end()
    } catch {
      /* ignore */
    }
  }
}
