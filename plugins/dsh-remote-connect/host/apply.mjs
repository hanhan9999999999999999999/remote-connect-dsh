/**
 * dsh-remote-connect · applier
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
/** 内存里最多保留多少个批次状态（再老的只留在磁盘上的 syncs/ 里） */
const MAX_STATES = 20

/** 本地批次列表的缓存时长：面板轮询很密，但 2 秒内重复翻目录没有必要 */
const RECENT_TTL_MS = 2000

/** 批次编号会拼进路径，格式必须是本插件自己生成的那种（`rid()` 产出的十六进制串） */
const SYNC_ID = /^[A-Za-z0-9_-]{1,64}$/


export class Applier {
  constructor({ logger, dataHome, sync = {}, onEvent } = {}) {
    this.logger = logger
    this.dataHome = dataHome
    this.sync = sync
    this.onEvent = onEvent
    this.syncs = new Map()
    this.recentCache = { at: 0, rows: null }
    this.recentReads = 0
    // 落地时往 *.dshlink 临时文件里写，这里留一个注入点：
    // 磁盘满 / 配额超了这些情况本机造不出来，测试要能替成一条会出错的流。
    this.createWriteStream = (file) => fs.createWriteStream(file)
  }

  #dir(syncId) {
    // 这个编号是从对端的请求里来的（`/rollback`、`/progress` 都带着它），
    // 以前直接拼进路径：`../../…` 就能让回滚去读别处的 journal。
    if (!SYNC_ID.test(String(syncId ?? ''))) {
      throw new AppError('BAD_INPUT', `同步批次编号不合法：${String(syncId ?? '').slice(0, 40)}`)
    }
    return path.join(this.dataHome, 'syncs', String(syncId))
  }

  /**
   * 内存里的批次状态只留最近这些条：DSH 一开就是几天，每同步一次就多一个 state，
   * 以前这个 Map 只进不出，跑到几百次同步就一直挂着。
   */
  #trimStates(max = MAX_STATES) {
    if (this.syncs.size <= max) return
    const finished = [...this.syncs.values()]
      .filter((s) => s.phase === 'done' || s.phase === 'failed')
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
    for (const state of finished) {
      if (this.syncs.size <= max) break
      this.syncs.delete(state.id)
    }
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
    this.#trimStates()
    this.#invalidateRecent()
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

  /**
   * 扔掉一个还没真正开始的批次（对端 prepare 完就走了，或我在开流之前失败）。
   * 不落终态的话，这条记录会永远停在「接收中」：`#trimStates` 只收 done/failed，
   * 于是面板上一直挂着一个永远不动的批次，用户也没有地方取消它。
   */
  discard(syncId, reason = '对端取消了这次同步') {
    const state = this.syncs.get(syncId)
    if (!state) return { ok: false, code: 'SYNC_UNKNOWN', syncId }
    if (state.phase === 'done' || state.phase === 'failed') {
      return { ok: true, already: true, syncId, phase: state.phase }
    }
    state.phase = 'failed'
    state.error = String(reason).slice(0, 200)
    state.finishedAt = Date.now()
    this.onEvent?.({ type: 'apply-discarded', syncId, reason: state.error })
    this.#invalidateRecent()
    return { ok: true, syncId, phase: state.phase }
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
    // 字节数有上限，但「条数」以前没有：对端可以发几百万个 0 字节文件，
    // 一样能把 backups/ 和 journal 撑爆，只是不走字节这条路。
    const maxFiles = Number.isFinite(this.sync.maxFiles) && this.sync.maxFiles > 0 ? this.sync.maxFiles : 200000
    let handled = 0
    let pendingFlush = []
    let lastEvent = 0
    // 半途失败时可能留下 *.dshlink 临时文件：记下来，退出前清掉。
    const tmpFiles = new Set()
    // 还开着的写流也记下来：盘满、配额超了、连接半路断开时，流不关就删不掉文件
    // （Windows 上删除会 EBUSY/EPERM），一个句柄还挂在那儿。
    const openStreams = new Map()
    const writeErr = (rel, err) =>
      new AppError('WRITE_FAILED', `写入临时文件失败：${rel}`, { reason: String(err?.message ?? err) })

    const flushJournal = async (force = false) => {
      if (!pendingFlush.length && !force) return
      const lines = pendingFlush.map((row) => JSON.stringify(row)).join('\n')
      pendingFlush = []
      if (lines) await fsp.appendFile(journalFile, lines + '\n')
    }

    const handler = async (meta) => {
      handled += 1
      if (handled > maxFiles) {
        throw new AppError('TOO_MANY_FILES', `这次同步的条目数超过上限 ${maxFiles}`)
      }
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
      tmpFiles.add(tmp)
      const stream = this.createWriteStream(tmp)
      openStreams.set(tmp, stream)
      // 写流上必须有人接 error：`createWriteStream` 的错是异步的，没人接就会升级成
      // 未捕获异常（整个 DSH 退出），而只等 drain 的那条路则会一直等下去。
      let streamErr = null
      stream.on('error', (err) => {
        streamErr = err
      })
      return {
        async write(chunk) {
          if (streamErr) throw writeErr(meta.rel, streamErr)
          written += chunk.length
          state.bytes += chunk.length
          if (state.bytes > maxBytes) throw new AppError('TOO_LARGE', '超出本次同步的字节上限')
          hasher.update(chunk)
          if (!stream.write(chunk)) {
            await new Promise((resolve, reject) => {
              const done = () => {
                stream.off('drain', onDrain)
                stream.off('error', onError)
              }
              const onDrain = () => {
                done()
                resolve()
              }
              const onError = (err) => {
                done()
                reject(writeErr(meta.rel, err))
              }
              stream.once('drain', onDrain)
              stream.once('error', onError)
            })
          }
          const now = Date.now()
          if (now - lastEvent > 200) {
            lastEvent = now
            state.onTick?.()
          }
        },
        async end() {
          if (streamErr) throw writeErr(meta.rel, streamErr)
          await new Promise((resolve, reject) => {
            stream.end((err) => (err ? reject(writeErr(meta.rel, err)) : resolve()))
          })
          // 有的实现（尤其是已经销毁的流）不会把错误交给 end 的回调，只会 emit：
          // 这一句是最后一道闸门，没有它就会一路走到 rename，报一个和真正原因无关的 ENOENT。
          if (streamErr) throw writeErr(meta.rel, streamErr)
          openStreams.delete(tmp)
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
            // 对端发来的 profile 不是合法 JSON 时，宁可不写也不能把本机的 profile 覆盖成坏文件
            const merged = await mergeProfileJson(tmp, abs)
            if (!merged) {
              await fsp.rm(tmp, { force: true })
              tmpFiles.delete(tmp)
              state.skipped += 1
              this.logger?.warn('apply', `对端的 profile 不是合法 JSON，跳过合并：${meta.rel}`)
              return
            }
          }
          await fsp.rename(tmp, abs)
          tmpFiles.delete(tmp)
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
      this.#invalidateRecent()
      this.onEvent?.({ type: 'apply-done', syncId, files: state.files, bytes: state.bytes })
      return this.progress(syncId)
    } catch (err) {
      state.phase = 'failed'
      state.error = err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? err)
      state.finishedAt = Date.now()
      await flushJournal(true).catch(() => {})
      // 先把还开着的写流关掉，再删临时文件：句柄没放，Windows 上 rm 一定失败，
      // 那个 *.dshlink 就会一直留在用户的目录里，而且每失败一次多漏一个句柄。
      for (const [tmp, stream] of openStreams) {
        await new Promise((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            resolve()
          }
          try {
            stream.once('close', done)
            stream.destroy()
          } catch {}
          // 有的实现不会发 close（比如已经在销毁中），最多等 300ms 就往下走。
          setTimeout(done, 300).unref?.()
        })
        openStreams.delete(tmp)
      }
      for (const tmp of tmpFiles) await fsp.rm(tmp, { force: true }).catch(() => {})
      tmpFiles.clear()
      this.logger?.error('apply', `应用失败 ${syncId}`, { error: state.error })
      throw err
    }
  }

  async listRecent(limit = 20) {
    // 面板每隔几秒就会调一次状态，而这里要逐个批次读 journal.json：
    // 批次一多，等于每次轮询都把整个 syncs/ 目录翻一遍。2 秒内的重复调用直接给缓存，
    // 新增批次、回滚之后立刻失效，读到的一定是新的。
    const ttl = Number.isFinite(this.recentTtlMs) ? this.recentTtlMs : RECENT_TTL_MS
    const now = Date.now()
    if (this.recentCache.rows && now - this.recentCache.at < ttl) {
      return this.recentCache.rows.slice(0, limit)
    }
    const base = path.join(this.dataHome, 'syncs')
    let names = []
    try {
      names = await fsp.readdir(base)
    } catch {
      this.recentCache = { at: now, rows: [] }
      return []
    }
    this.recentReads += 1
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
    const sorted = rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 100)
    this.recentCache = { at: now, rows: sorted }
    return sorted.slice(0, limit)
  }

  /** 本地有批次变化（新增、落地、回滚）时调一下，别让面板看到缓存里的旧列表。 */
  #invalidateRecent() {
    this.recentCache = { at: 0, rows: null }
  }

  async rollback(syncId) {
    const dir = this.#dir(syncId)
    const journalPath = path.join(dir, 'journal.json')
    let journal
    let partial = false
    try {
      journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'))
    } catch {
      // journal.json 只在正常收尾时写；没有它多半说明这次同步半途失败了（phase='failed'）。
      // 而这正是用户最想撤销的时候——journal.jsonl 是逐行落盘的，正好能拿来还原已经落地的文件。
      const rows = await readJournal(dir)
      if (!rows.length) throw new AppError('NO_JOURNAL', '找不到该同步的记录，无法回滚')
      journal = { id: syncId, entries: rows, partial: true }
      partial = true
    }
    if (journal.rolledBackAt) throw new AppError('ALREADY_ROLLED_BACK', '这次同步已经回滚过了')
    const root = dshHome()
    const entries = [...journal.entries].reverse()
    let restored = 0
    let removed = 0
    // 备份目录按 backupKeep 轮转，老批次的备份可能已经没了。
    // 以前这种情况被当成「恢复失败」默默吞掉，回滚却报成功——文件还停在新内容上，用户以为撤回了。
    let missing = 0
    for (const entry of entries) {
      const abs = safeJoin(root, entry.rel)
      if (entry.backup) {
        // 备份路径写在 journal 里，也当不可信输入：出了数据目录就当成「备份没了」
        let backupAbs = null
        try {
          backupAbs = safeJoin(this.dataHome, entry.backup)
        } catch {
          backupAbs = null
        }
        try {
          if (!backupAbs) throw Object.assign(new Error('备份路径越界'), { code: 'ENOENT' })
          await ensureDir(path.dirname(abs))
          await fsp.copyFile(backupAbs, abs)
          restored += 1
        } catch (err) {
          if (err?.code === 'ENOENT') {
            missing += 1
            this.logger?.warn('rollback', `备份已被轮转清掉，无法还原：${entry.rel}`)
          } else {
            this.logger?.warn('rollback', `恢复失败 ${entry.rel}`, { error: String(err) })
          }
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
    journal.rollback = { restored, removed, partial, missing }
    await writeJson(journalPath, journal)
    this.#invalidateRecent()
    this.onEvent?.({ type: 'rollback', syncId, restored, removed, partial, missing })
    return { syncId, restored, removed, partial, missing }
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
    // 解析不出来就别往下写：写下去等于用法本机的 profile 换一份坏文件
    return false
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return false
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
    // private 也属于「这台机器自己的身份」：对端把 profile 打包成可发布的，不该顺手把接收方也变成可发布
    private: local.private ?? incoming.private,
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
  return true
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
