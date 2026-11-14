/**
 * dsh-remote-connect · pack
 *
 * Turns an inventory selection into a streamable tar.gz, hashing each file
 * first (pax carries the digest, so the receiver can verify end-to-end).
 * Hashes are cached by path+size+mtime to make repeated syncs cheap.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { Readable, pipeline } from 'node:stream'
import { tarEntries } from './tar.mjs'
import { scanAll, manifestId } from './inventory.mjs'
import { AppError, readJson, writeJson } from './util.mjs'

const CACHE_LIMIT = 20000
export { CACHE_LIMIT }


export class PackCache {
  constructor(file, { logger = null } = {}) {
    this.file = file
    this.logger = logger
    this.map = new Map()
    this.dirty = false
    this.timer = null
  }
  async load() {
    const raw = await readJson(this.file, null)
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
      // 缓存文件可能比上限大（比如上次是别的版本写的）：载入时就裁掉最老的
      if (this.map.size > CACHE_LIMIT) {
        let drop = this.map.size - CACHE_LIMIT
        for (const k of this.map.keys()) {
          this.map.delete(k)
          drop -= 1
          if (drop <= 0) break
        }
      }
    }
    return this
  }
  key(rel, size, mtime) {
    return `${rel}|${size}|${mtime}`
  }
  get(key) {
    return this.map.get(key)
  }
  set(key, hash) {
    this.map.set(key, hash)
    this.dirty = true
    if (this.map.size > CACHE_LIMIT) {
      const drop = this.map.size - CACHE_LIMIT
      let i = 0
      for (const k of this.map.keys()) {
        this.map.delete(k)
        i += 1
        if (i >= drop) break
      }
    }
    this.#schedule()
  }
  #schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch((err) => {
        this.logger?.warnOnce?.('pack-cache-write', 'cache', `哈希缓存写盘失败：${err?.message ?? err}`)
      })
    }, 1500)
    this.timer.unref?.()
  }
  async flush() {
    if (!this.dirty) return
    const obj = {}
    for (const [k, v] of this.map) obj[k] = v
    this.dirty = false
    try {
      await writeJson(this.file, obj)
    } catch (err) {
      // 写不进去不致命，但下次同步会白算一遍全部哈希——留条痕迹，别让人以为「缓存明明开了」。
      this.dirty = true
      this.logger?.warnOnce?.(
        'pack-cache-write',
        'cache',
        `哈希缓存写盘失败（${err?.code ?? err?.message ?? err}）：${this.file}。下次同步会重新计算一遍哈希。`,
      )
    }
  }
  async close() {
    if (this.timer) clearTimeout(this.timer)
    await this.flush()
  }
}

async function hashFile(file) {
  const hash = createHash('sha256')
  try {
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
    for await (const chunk of stream) hash.update(chunk)
  } catch (err) {
    // 扫描之后、读之前被人删了/锁了：给出可读的错误码，而不是裸 ENOENT 冒到 HTTP 层
    throw new AppError('READ_FAILED', `读不到 ${file}：${err?.code ?? err?.message ?? '未知错误'}`, { cause: err?.code })
  }
  return hash.digest('hex')
}

/**
 * @returns {Promise<{manifest: object, entries: Array, totalBytes: number}>}
 */
export async function preparePack({ cats, includeSecrets = false, maxFileMb = 512, maxTotalMb = 8192, cache, onProgress } = {}) {
  const inv = await scanAll({ cats, includeSecrets, maxFileMb })
  if (!inv.entries.length) throw new AppError('EMPTY', '选中的分类里没有可同步的文件')
  const maxTotal = maxTotalMb * 1024 * 1024
  // 清单已经有总大小了：先判总量，别把 8 GB 文件逐个哈希完了才说超限
  if (inv.totalBytes > maxTotal) {
    throw new AppError('TOO_LARGE', `选中内容共 ${inv.totalBytes} 字节，超过上限 ${maxTotal} 字节，请拆分同步`, {
      totalBytes: inv.totalBytes,
      maxTotalBytes: maxTotal,
    })
  }
  const entries = []
  let done = 0
  let bytes = 0
  const total = inv.entries.length
  for (const item of inv.entries) {
    const key = cache?.key(item.rel, item.size, item.mtime)
    let hash = cache?.get(key)
    if (!hash) {
      hash = item.virtual
        ? createHash('sha256').update(item.bytes).digest('hex')
        : await hashFile(item.abs)
      if (cache) cache.set(key, hash)
    }
    entries.push({ ...item, hash })
    done += 1
    bytes += item.size
    if (bytes > maxTotal) throw new AppError('TOO_LARGE', '选中内容超过 8 GB 上限，请拆分同步')
    onProgress?.({ done, total, bytes })
  }
  const clean = entries.map((e) => ({
    cat: e.cat,
    rel: e.rel,
    size: e.size,
    mtime: e.mtime,
    hash: e.hash,
    ...(e.op ? { op: e.op } : {}),
  }))
  const manifest = {
    id: manifestId(clean),
    createdAt: Date.now(),
    totalFiles: clean.length,
    totalBytes: bytes,
    summary: inv.summary,
    excluded: inv.excluded,
    entries: clean,
    includeSecrets,
  }
  return { manifest, entries, totalBytes: bytes }
}

/** Readable tar.gz from a prepared pack (virtual entries supported). */
export function packStream(entries, { signal } = {}) {
  // 必须用 pipeline 而不是 .pipe()：源上出错（打包途中有文件被删/被独占锁）时，
  // .pipe() 不会把错误传给 gzip，源上的 'error' 没人接 —— 整个进程会被抛死。
  return pipeline(Readable.from(tarEntries(entries.map(toTarEntry), { signal })), createGzip({ level: 6 }), () => {})
}

function toTarEntry(entry) {
  return {
    rel: entry.rel,
    filePath: entry.abs,
    bytes: entry.virtual ? entry.bytes : undefined,
    size: entry.size,
    mtime: entry.mtime,
    mode: entry.mode,
    hash: entry.hash,
    op: entry.op,
    cat: entry.cat,
  }
}
