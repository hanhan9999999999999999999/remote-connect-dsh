/**
 * dsh-device-link · tar (ustar + pax) writer/reader
 *
 * Why hand-rolled: the plugin must run inside DSH with zero installed
 * dependencies, and paths are frequently Chinese / longer than 100 bytes,
 * which plain ustar cannot carry. We emit PAX extended headers for those.
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'

const BLOCK = 512
const ZERO = Buffer.alloc(BLOCK)

function octal(value, width) {
  const s = value.toString(8)
  return s.padStart(width - 1, '0') + '\0'
}

function paxRecord(key, value) {
  const body = Buffer.from(` ${key}=${value}\n`, 'utf8')
  let len = body.length + 1
  // length field includes itself; iterate until stable
  while (String(len).length + body.length !== len) {
    len = String(len).length + body.length
  }
  return Buffer.concat([Buffer.from(String(len), 'ascii'), body])
}

function paxBlock(records) {
  const data = Buffer.concat(records.map(([k, v]) => paxRecord(k, v)))
  const header = makeHeader({
    name: 'PaxHeaders/dsh-device-link',
    size: data.length,
    mtime: Math.floor(Date.now() / 1000),
    mode: 0o644,
    type: 'x',
  })
  const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

export function makeHeader({ name, size = 0, mtime = 0, mode = 0o644, type = '0', uid = 0, gid = 0 }) {
  const block = Buffer.alloc(BLOCK)
  block.write(name.slice(0, 100), 0, 100, 'utf8')
  block.write(octal(mode & 0o7777, 8), 100, 8, 'ascii')
  block.write(octal(uid, 8), 108, 8, 'ascii')
  block.write(octal(gid, 8), 116, 8, 'ascii')
  if (size > 0o77777777777) {
    // base-256 encoding for very large files
    block[124] = 0x80
    block.writeUInt32BE(Math.floor(size / 0x100000000), 128)
    block.writeUInt32BE(size >>> 0, 132)
  } else {
    block.write(octal(size, 12), 124, 12, 'ascii')
  }
  block.write(octal(mtime, 12), 136, 12, 'ascii')
  block.fill(0x20, 148, 156)
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write('dsh', 265, 32, 'ascii')
  block.write('dsh', 297, 32, 'ascii')
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += block[i]
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return block
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i += 1) if (buf[i] !== 0) return false
  return true
}

function readOctal(buf, offset, length) {
  if (buf[offset] & 0x80) {
    // base-256
    let value = 0
    for (let i = offset + 1; i < offset + length; i += 1) value = value * 256 + buf[i]
    return value
  }
  const raw = buf.toString('ascii', offset, offset + length).replace(/\0.*$/, '').trim()
  if (!raw) return 0
  const n = Number.parseInt(raw, 8)
  return Number.isFinite(n) ? n : 0
}

function parsePax(buf) {
  const out = {}
  let offset = 0
  while (offset < buf.length) {
    let space = buf.indexOf(0x20, offset)
    if (space < 0) break
    const len = Number.parseInt(buf.toString('ascii', offset, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = buf.toString('utf8', space + 1, offset + len - 1)
    const eq = record.indexOf('=')
    if (eq > 0) {
      const key = record.slice(0, eq)
      const value = record.slice(eq + 1)
      out[key] = value
    }
    offset += len
  }
  return out
}

/**
 * Build a tar byte stream from entries.
 * entry: { rel, filePath, size, mtime, mode, hash, op }
 */
export async function* tarEntries(entries, { signal } = {}) {
  for (const entry of entries) {
    if (signal?.aborted) throw new Error('aborted')
    const name = entry.rel
    const nameBytes = Buffer.byteLength(name, 'utf8')
    const needPax =
      nameBytes > 100 ||
      /[^\x00-\x7F]/.test(name) ||
      Boolean(entry.hash) ||
      Boolean(entry.op) ||
      entry.size > 0o77777777777
    if (needPax) {
      const records = [['path', name]]
      if (entry.size > 0o77777777777) records.push(['size', String(entry.size)])
      if (entry.hash) records.push(['DSH.sha256', entry.hash])
      if (entry.op) records.push(['DSH.op', entry.op])
      if (entry.cat) records.push(['DSH.cat', entry.cat])
      yield paxBlock(records)
    }
    const fallbackName = needPax ? name.slice(-90).replace(/^.*\//, '_/') + name.slice(-40) : name
    yield makeHeader({
      name: Buffer.byteLength(fallbackName) > 100 ? 'entry' : fallbackName,
      size: entry.size,
      mtime: Math.floor((entry.mtime ?? Date.now()) / 1000),
      mode: entry.mode ?? 0o644,
      type: '0',
    })
    let written = 0
    if (entry.bytes) {
      if (entry.bytes.length !== entry.size) {
        throw new Error(`虚拟条目大小不符：${name}`)
      }
      yield entry.bytes
      written = entry.bytes.length
    } else {
      const stream = fs.createReadStream(entry.filePath, { highWaterMark: 1024 * 1024 })
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.destroy()
          throw new Error('aborted')
        }
        written += chunk.length
        yield chunk
      }
    }
    if (written !== entry.size) {
      throw new Error(`文件在打包期间发生变化：${name} (${written}/${entry.size})`)
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK
    if (pad) yield Buffer.alloc(pad)
  }
  yield Buffer.alloc(BLOCK * 2)
}

export function tarReadable(entries, opts) {
  return Readable.from(tarEntries(entries, opts))
}

/**
 * Streaming tar parser.
 *
 * handler(meta) -> null | { write(chunk): Promise<void>, end(): Promise<void> }
 * meta: { rel, size, mtime, mode, type, pax, op, hash }
 */
export class TarParser {
  constructor(handler) {
    this.handler = handler
    this.buf = Buffer.alloc(0)
    this.state = 'header'
    this.remaining = 0
    this.pad = 0
    this.paxSize = 0
    this.paxBuf = Buffer.alloc(0)
    this.pax = null
    this.current = null
    this.currentMeta = null
    this.zeroBlocks = 0
    this.finished = false
    this.entries = 0
    this.bytes = 0
  }

  async #finishEntry() {
    if (this.current?.end) await this.current.end()
    this.current = null
    this.currentMeta = null
    this.remaining = 0
    this.pad = 0
    this.state = 'header'
  }

  async feed(chunk) {
    if (this.finished) return
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.state === 'header') {
        if (this.buf.length < BLOCK) return
        const block = this.buf.subarray(0, BLOCK)
        if (isZeroBlock(block)) {
          this.buf = this.buf.subarray(BLOCK)
          this.zeroBlocks += 1
          if (this.zeroBlocks >= 2) {
            this.finished = true
            return
          }
          continue
        }
        this.zeroBlocks = 0
        this.buf = this.buf.subarray(BLOCK)
        let name = block.toString('utf8', 0, 100).replace(/\0.*$/s, '')
        const prefix = block.toString('utf8', 345, 500).replace(/\0.*$/s, '')
        const magic = block.toString('ascii', 257, 262)
        if (magic === 'ustar' && prefix) name = `${prefix}/${name}`
        const size = readOctal(block, 124, 12)
        const mtime = readOctal(block, 136, 12) * 1000
        const mode = readOctal(block, 100, 8)
        const type = String.fromCharCode(block[156] || 0x30)
        if (type === 'x' || type === 'g') {
          this.paxSize = size
          this.paxBuf = Buffer.alloc(0)
          this.state = 'pax'
          continue
        }
        if (type === 'L') {
          // GNU long name: next block(s) hold the name
          this.state = 'gnu'
          this.remaining = size
          this.pad = 0
          this.gnuBuf = Buffer.alloc(0)
          continue
        }
        if (type === '5') {
          // directory entry: create via handler, no data
          await this.handler({ rel: name, size: 0, mtime, mode, type: 'dir', pax: this.pax ?? {} })
          this.pax = null
          this.remaining = 0
          this.pad = 0
          continue
        }
        if (type !== '0' && type !== '\0' && type !== '7') {
          // skip unknown types safely
          this.remaining = size
          this.pad = (BLOCK - (size % BLOCK)) % BLOCK
          this.current = null
          this.state = 'data'
          continue
        }
        const pax = this.pax ?? {}
        this.pax = null
        const rel = pax.path || name
        const meta = {
          rel,
          size: pax.size ? Number(pax.size) : size,
          mtime: pax.mtime ? Math.round(Number(pax.mtime) * 1000) : mtime,
          mode,
          type: 'file',
          pax,
          op: pax['DSH.op'] || '',
          hash: pax['DSH.sha256'] || '',
          cat: pax['DSH.cat'] || '',
        }
        this.remaining = meta.size
        this.pad = (BLOCK - (meta.size % BLOCK)) % BLOCK
        this.currentMeta = meta
        this.current = await this.handler(meta)
        this.entries += 1
        if (this.remaining === 0) {
          await this.#finishEntry()
          continue
        }
        this.state = 'data'
        continue
      }

      if (this.state === 'pax') {
        const need = this.paxSize - this.paxBuf.length
        if (this.buf.length < need) {
          this.paxBuf = Buffer.concat([this.paxBuf, this.buf])
          this.buf = Buffer.alloc(0)
          return
        }
        this.paxBuf = Buffer.concat([this.paxBuf, this.buf.subarray(0, need)])
        this.buf = this.buf.subarray(need)
        this.pax = parsePax(this.paxBuf)
        const pad = (BLOCK - (this.paxSize % BLOCK)) % BLOCK
        if (this.buf.length < pad) {
          this.state = 'paxpad'
          this.pad = pad
          return
        }
        this.buf = this.buf.subarray(pad)
        this.state = 'header'
        continue
      }

      if (this.state === 'paxpad') {
        if (this.buf.length < this.pad) {
          this.pad -= this.buf.length
          this.buf = Buffer.alloc(0)
          return
        }
        this.buf = this.buf.subarray(this.pad)
        this.pad = 0
        this.state = 'header'
        continue
      }

      if (this.state === 'gnu') {
        if (this.buf.length < this.remaining) {
          this.gnuBuf = Buffer.concat([this.gnuBuf, this.buf])
          this.remaining -= this.buf.length
          this.buf = Buffer.alloc(0)
          return
        }
        this.gnuBuf = Buffer.concat([this.gnuBuf, this.buf.subarray(0, this.remaining)])
        this.buf = this.buf.subarray(this.remaining)
        this.pax = { ...(this.pax ?? {}), path: this.gnuBuf.toString('utf8').replace(/\0.*$/s, '') }
        this.state = 'header'
        continue
      }

      if (this.state === 'data') {
        if (this.remaining > 0) {
          if (!this.buf.length) return
          const take = Math.min(this.remaining, this.buf.length)
          const slice = this.buf.subarray(0, take)
          this.buf = this.buf.subarray(take)
          this.remaining -= take
          this.bytes += take
          if (this.current?.write) await this.current.write(slice)
          if (this.remaining > 0) continue
        }
        if (this.buf.length < this.pad) {
          this.pad -= this.buf.length
          this.buf = Buffer.alloc(0)
          this.state = 'datapad'
          return
        }
        this.buf = this.buf.subarray(this.pad)
        this.pad = 0
        await this.#finishEntry()
        continue
      }

      if (this.state === 'datapad') {
        if (this.buf.length < this.pad) {
          this.pad -= this.buf.length
          this.buf = Buffer.alloc(0)
          return
        }
        this.buf = this.buf.subarray(this.pad)
        this.pad = 0
        await this.#finishEntry()
        continue
      }

      return
    }
  }

  async end() {
    if (!this.finished) {
      // Tolerate archives without the two-zero-block terminator (some writers omit it)
      if (this.state === 'header' && this.buf.length === 0) {
        this.finished = true
        return
      }
      throw new Error('tar 流不完整')
    }
  }
}
