/**
 * dsh-device-link · applier
 *
 * Receives a tar stream, verifies every entry, backs up whatever it replaces,
 * and writes a journal so the whole batch can be rolled back as one unit.
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { TarParser } from './tar.mjs'
import { dshHome } from './config.mjs'
import { AppError, ensureDir, rid, safeJoin, writeJson } from './util.mjs'

const JOURNAL_VERSION = 1

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

export class Applier {
  constructor({ logger, dataHome, sync = {}, onEvent } = {}) {
    this.logger = logger
    this.dataHome = dataHome
    this.sync = sync
    this.onEvent = onEvent
    this.syncs = new Map()
  }

  #dir(syncId) {
    return path.join(this.dataHome, 'syncs', syncId)
  }

  async prepare({ from, meta = {} } = {}) {
    const syncId = `s_${Date.now().toString(36)}_${rid(4)}`
    const dir = this.#dir(syncId)
    await ensureDir(dir)
    const state = {
      id: syncId,
      from: from ?? null,
      createdAt: Date.now(),
      phase: 'receiving',
      files: 0,
      bytes: 0,
      totalBytes: Number(meta.totalBytes) || 0,
      totalFiles: Number(meta.totalFiles) || 0,
      skipped: 0,
      replaced: 0,
      created: 0,
      current: '',
      error: null,
      journal: [],
      dir,
    }
    this.syncs.set(syncId, state)
    await writeJson(path.join(dir, 'meta.json'), {
      version: JOURNAL_VERSION,
      id: syncId,
      from: state.from,
      createdAt: state.createdAt,
      totalBytes: state.totalBytes,
      totalFiles: state.totalFiles,
    })
    return state
  }

  get(syncId) {
    return this.syncs.get(syncId) ?? null
  }

  progress(syncId) {
    const s = this.syncs.get(syncId)
    if (!s) return null
    return {
      id: s.id,
      phase: s.phase,
      files: s.files,
      bytes: s.bytes,
      totalBytes: s.totalBytes,
      totalFiles: s.totalFiles,
      skipped: s.skipped,
      replaced: s.replaced,
      created: s.created,
      current: s.current,
      error: s.error,
      createdAt: s.createdAt,
      finishedAt: s.finishedAt,
    }
  }

  /**
   * Consume a tar byte stream (already decrypted and decompressed).
   * @param {import('node:stream').Readable} tarStream
   */
  async applyStream(syncId, tarStream) {
    const state = this.syncs.get(syncId)
    if (!state) throw new AppError('SYNC_UNKNOWN', '同步任务不存在或已过期')
    if (state.phase !== 'receiving') throw new AppError('SYNC_BUSY', '同步任务已在处理中')
    const root = dshHome()
    const dataHomeRoot = this.dataHome
    const backupRoot = path.join(dataHomeRoot, 'backups', syncId)
    const journalFile = path.join(state.dir, 'journal.jsonl')
    const maxBytes = (this.sync.maxTotalMb ?? 8192) * 1024 * 1024
    let pendingFlush = []
    let lastEvent = 0

    const flushJournal = async (force = false) => {
      if (!pendingFlush.length && !force) return
      const lines = pendingFlush.map((row) => JSON.stringify(row)).join('\n')
      pendingFlush = []
      if (lines) await fsp.appendFile(journalFile, lines + '\n')
    }

    const handler = async (meta) => {
      if (meta.type === 'dir') return null
      let abs
      try {
        abs = safeJoin(root, meta.rel)
      } catch (err) {
        throw new AppError('PATH_ESCAPE', `拒绝非法路径：${meta.rel}`, { rel: meta.rel })
      }
      state.current = meta.rel
      await ensureDir(path.dirname(abs))
      let existing = null
      try {
        existing = await fsp.lstat(abs)
      } catch {
        existing = null
      }
      if (existing && !existing.isFile()) {
        // Never overwrite a directory or a link with a file.
        state.skipped += 1
        return null
      }
      const hasher = createHash('sha256')
      let written = 0
      let reason = 'created'
      let backupPath = null
      if (existing?.isFile()) {
        const same = meta.size === existing.size && meta.hash
          ? await sha256FileQuiet(abs)
          : null
        if (same && same === meta.hash) {
          state.skipped += 1
          state.files += 1
          state.bytes += meta.size
          return null
        }
        backupPath = path.join(backupRoot, meta.rel)
        await ensureDir(path.dirname(backupPath))
        try {
          await fsp.copyFile(abs, backupPath)
        } catch (err) {
          throw new AppError('BACKUP_FAILED', `备份失败：${meta.rel}`, { reason: String(err) })
        }
        reason = 'replaced'
        state.replaced += 1
      } else {
        state.created += 1
      }
      const tmp = `${abs}.${process.pid}.${rid(3)}.dshlink`
      const stream = fs.createWriteStream(tmp)
      return {
        async write(chunk) {
          written += chunk.length
          state.bytes += chunk.length
          if (state.bytes > maxBytes) throw new AppError('TOO_LARGE', '超出本次同步的字节上限')
          hasher.update(chunk)
          if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r))
          const now = Date.now()
          if (now - lastEvent > 200) {
            lastEvent = now
            state.onTick?.()
          }
        },
        async end() {
          await new Promise((resolve, reject) => {
            stream.end((err) => (err ? reject(err) : resolve()))
          })
          const digest = hasher.digest('hex')
          if (meta.hash && digest !== meta.hash) {
            await fsp.rm(tmp, { force: true })
            throw new AppError('HASH_MISMATCH', `校验失败：${meta.rel}`, { expected: meta.hash, actual: digest })
          }
          if (written !== meta.size) {
            await fsp.rm(tmp, { force: true })
            throw new AppError('SIZE_MISMATCH', `大小不符：${meta.rel}`, { expected: meta.size, actual: written })
          }
          if (meta.op === 'merge-profile') {
            await mergeProfileJson(tmp, abs)
          }
          await fsp.rename(tmp, abs)
          state.files += 1
          pendingFlush.push({
            rel: meta.rel,
            cat: meta.cat || '',
            size: meta.size,
            reason,
            backup: backupPath ? path.relative(dataHomeRoot, backupPath).replace(/\\/g, '/') : null,
            at: Date.now(),
          })
          if (pendingFlush.length >= 64) await flushJournal()
        },
      }
    }

    const parser = new TarParser(handler)
    const sink = new Writable({
      async write(chunk, _enc, cb) {
        try {
          await parser.feed(chunk)
          cb()
        } catch (err) {
          cb(err)
        }
      },
    })
    try {
      await pipeline(tarStream, sink)
      await parser.end()
      await flushJournal(true)
      state.phase = 'done'
      state.finishedAt = Date.now()
      state.current = ''
      const journal = await readJournal(state.dir)
      await writeJson(path.join(state.dir, 'journal.json'), {
        version: JOURNAL_VERSION,
        id: syncId,
        from: state.from,
        createdAt: state.createdAt,
        finishedAt: state.finishedAt,
        files: state.files,
        bytes: state.bytes,
        skipped: state.skipped,
        replaced: state.replaced,
        created: state.created,
        entries: journal,
      })
      await pruneBackups(this.dataHome, this.sync.backupKeep ?? 5)
      this.onEvent?.({ type: 'apply-done', syncId, files: state.files, bytes: state.bytes })
      return this.progress(syncId)
    } catch (err) {
      state.phase = 'failed'
      state.error = err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? err)
      state.finishedAt = Date.now()
      await flushJournal(true).catch(() => {})
      this.logger?.error('apply', `应用失败 ${syncId}`, { error: state.error })
      throw err
    }
  }

  async listRecent(limit = 20) {
    const base = path.join(this.dataHome, 'syncs')
    let names = []
    try {
      names = await fsp.readdir(base)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      const metaFile = path.join(base, name, 'journal.json')
      try {
        const raw = JSON.parse(await fsp.readFile(metaFile, 'utf8'))
        rows.push({
          id: raw.id,
          from: raw.from,
          createdAt: raw.createdAt,
          finishedAt: raw.finishedAt,
          files: raw.files,
          bytes: raw.bytes,
          replaced: raw.replaced,
          created: raw.created,
          skipped: raw.skipped,
          rolledBackAt: raw.rolledBackAt ?? null,
        })
      } catch {
        /* incomplete sync (crash) — surfaced separately */
        const metaFile2 = path.join(base, name, 'meta.json')
        try {
          const meta = JSON.parse(await fsp.readFile(metaFile2, 'utf8'))
          rows.push({ ...meta, incomplete: true })
        } catch {
          /* ignore */
        }
      }
    }
    return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, limit)
  }

  async rollback(syncId) {
    const dir = this.#dir(syncId)
    const journalPath = path.join(dir, 'journal.json')
    let journal
    try {
      journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'))
    } catch {
      throw new AppError('NO_JOURNAL', '找不到该同步的记录，无法回滚')
    }
    if (journal.rolledBackAt) throw new AppError('ALREADY_ROLLED_BACK', '这次同步已经回滚过了')
    const root = dshHome()
    const entries = [...journal.entries].reverse()
    let restored = 0
    let removed = 0
    for (const entry of entries) {
      const abs = safeJoin(root, entry.rel)
      if (entry.backup) {
        const backupAbs = path.join(this.dataHome, ...entry.backup.split('/'))
        try {
          await ensureDir(path.dirname(abs))
          await fsp.copyFile(backupAbs, abs)
          restored += 1
        } catch (err) {
          this.logger?.warn('rollback', `恢复失败 ${entry.rel}`, { error: String(err) })
        }
      } else {
        try {
          await fsp.rm(abs, { force: true })
          removed += 1
        } catch {
          /* ignore */
        }
      }
    }
    journal.rolledBackAt = Date.now()
    journal.rollback = { restored, removed }
    await writeJson(journalPath, journal)
    this.onEvent?.({ type: 'rollback', syncId, restored, removed })
    return { syncId, restored, removed }
  }
}

async function sha256FileQuiet(file) {
  try {
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  } catch {
    return null
  }
}

async function readJournal(dir) {
  try {
    const text = await fsp.readFile(path.join(dir, 'journal.jsonl'), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Merge a sender's profile package.json into the local one, keeping the
 * receiver's own identity fields and only adopting dependencies + bundles.
 */
async function mergeProfileJson(tmpFile, target) {
  let incoming
  try {
    incoming = JSON.parse(await fsp.readFile(tmpFile, 'utf8'))
  } catch {
    return
  }
  let local = {}
  try {
    local = JSON.parse(await fsp.readFile(target, 'utf8'))
  } catch {
    local = {}
  }
  const merged = {
    ...local,
    ...incoming,
    name: local.name ?? incoming.name,
    dependencies: { ...(local.dependencies ?? {}), ...(incoming.dependencies ?? {}) },
    dsh: {
      ...(local.dsh ?? {}),
      ...(incoming.dsh ?? {}),
      profile: {
        ...(local.dsh?.profile ?? {}),
        ...(incoming.dsh?.profile ?? {}),
        bundles: Array.from(
          new Set([
            ...(local.dsh?.profile?.bundles ?? []),
            ...(incoming.dsh?.profile?.bundles ?? []),
          ]),
        ),
      },
    },
  }
  await fsp.writeFile(tmpFile, JSON.stringify(merged, null, 2))
}

async function pruneBackups(dataHome, keep) {
  const base = path.join(dataHome, 'backups')
  let names = []
  try {
    names = await fsp.readdir(base)
  } catch {
    return
  }
  const stats = []
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(base, name))
      stats.push({ name, mtime: stat.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  stats.sort((a, b) => b.mtime - a.mtime)
  for (const old of stats.slice(Math.max(1, keep))) {
    await fsp.rm(path.join(base, old.name), { recursive: true, force: true }).catch(() => {})
  }
}
