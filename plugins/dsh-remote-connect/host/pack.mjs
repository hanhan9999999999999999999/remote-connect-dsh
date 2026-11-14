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
import { Readable } from 'node:stream'
import { tarEntries } from './tar.mjs'
import { scanAll, manifestId } from './inventory.mjs'
import { AppError, readJson, writeJson } from './util.mjs'

const CACHE_LIMIT = 20000

export class PackCache {
  constructor(file) {
    this.file = file
    this.map = new Map()
    this.dirty = false
    this.timer = null
  }
  async load() {
    const raw = await readJson(this.file, null)
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
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
      this.flush().catch(() => {})
    }, 1500)
    this.timer.unref?.()
  }
  async flush() {
    if (!this.dirty) return
    this.dirty = false
    const obj = {}
    for (const [k, v] of this.map) obj[k] = v
    await writeJson(this.file, obj).catch(() => {})
  }
  async close() {
    if (this.timer) clearTimeout(this.timer)
    await this.flush()
  }
}

async function hashFile(file) {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * @returns {Promise<{manifest: object, entries: Array, totalBytes: number}>}
 */
export async function preparePack({ cats, includeSecrets = false, maxFileMb = 512, cache, onProgress } = {}) {
  const inv = await scanAll({ cats, includeSecrets, maxFileMb })
  if (!inv.entries.length) throw new AppError('EMPTY', '选中的分类里没有可同步的文件')
  const entries = []
  let done = 0
  let bytes = 0
  const total = inv.entries.length
  const maxTotal = 8192 * 1024 * 1024
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
export function packStream(entries) {
  return Readable.from(tarEntries(entries.map(toTarEntry))).pipe(createGzip({ level: 6 }))
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
