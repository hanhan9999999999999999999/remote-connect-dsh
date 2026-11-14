/**
 * dsh-remote-connect · service
 *
 * One instance per DSH process. Owns configuration, the sync server, the peer
 * book, and the in-memory task table that the settings page polls.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppError, Logger, VERSION, humanBytes, lanAddresses } from './util.mjs'
import { ConfigStore, buildConnectUri, dataHome, dshHome, parseConnectUri } from './config.mjs'
import { LinkServer } from './server.mjs'
import { RemotePeer } from './peer.mjs'
import { PeerStore } from './peers.mjs'
import { Applier } from './apply.mjs'
import { PackCache, preparePack } from './pack.mjs'
import { CATEGORY_ORDER, CATEGORIES, listProfiles } from './inventory.mjs'
import { installPluginDeps, scanPluginDeps } from './deps.mjs'
import { TaskTable, newTask, taskView } from './tasks.mjs'

export class LinkService {
  constructor({ logger, store } = {}) {
    this.logger = logger ?? new Logger({ file: path.join(dataHome(), 'remote-connect.log') })
    this.store = store ?? new ConfigStore()
    this.peerStore = new PeerStore()
    this.server = null
    this.localApplier = null
    this.packCache = null
    this.clients = new Map()
    this.tasks = new TaskTable()
    this.ready = null
  }

  init() {
    if (!this.ready) this.ready = this.#init()
    return this.ready
  }

  async #init() {
    const cfg = await this.store.load()
    await this.peerStore.load()
    await fsp.mkdir(dataHome(), { recursive: true }).catch(() => {})
    this.packCache = await new PackCache(path.join(dataHome(), 'hash-cache.json')).load()
    this.localApplier = new Applier({
      logger: this.logger,
      dataHome: dataHome(),
      sync: cfg.sync,
      onEvent: (e) => this.logger.info('apply', `事件 ${e.type}`),
    })
    this.server = new LinkServer({
      store: this.store,
      logger: this.logger,
      onEvent: (e) => {
        if (e.type === 'peer-connected') {
          this.peerStore
            .upsert({
              id: `in_${e.device.id}`,
              name: e.device.name,
              host: e.ip,
              port: this.server?.port ?? cfg.server.port,
              deviceId: e.device.id,
              platform: e.device.platform,
              lastSeen: Date.now(),
              direction: 'inbound',
            })
            .catch(() => {})
        }
      },
    })
    if (cfg.server.enabled) {
      try {
        await this.server.start()
      } catch (err) {
        this.logger.error('service', `互联服务未能启动：${err.message}`)
      }
    }
    this.logger.info('service', `远程互联已就绪 v${VERSION}`)
    // Restore remembered sessions in the background — never block startup.
    setTimeout(() => this.#restoreAll().catch(() => {}), 1500).unref?.()
    return this
  }

  async #restoreAll() {
    const list = await this.peerStore.list()
    for (const item of list) {
      if (!item.connected) continue
      try {
        const peer = await this.#peer(item.id)
        await peer.restore()
      } catch {
        /* offline peers are expected */
      }
    }
  }

  async #peer(id) {
    if (this.clients.has(id)) return this.clients.get(id)
    const record = await this.peerStore.raw(id)
    if (!record) throw new AppError('PEER_UNKNOWN', '找不到这台设备')
    const cfg = await this.store.get()
    const peer = new RemotePeer({
      record,
      logger: this.logger,
      device: { id: cfg.device.id, name: cfg.device.name, platform: cfg.device.platform, version: VERSION },
    })
    this.clients.set(id, peer)
    return peer
  }

  /* ---------------------------------------------------------------- */
  /* state                                                            */
  /* ---------------------------------------------------------------- */

  async publicConfig() {
    const cfg = await this.store.get()
    const addresses = lanAddresses()
    return {
      device: { ...cfg.device },
      server: { ...cfg.server, addresses },
      auth: { hasPassword: Boolean(cfg.auth.password), password: cfg.auth.password, changedAt: cfg.auth.changedAt },
      sync: { ...cfg.sync, categories: { ...cfg.sync.categories } },
      ui: { ...cfg.ui },
      connectUri: buildConnectUri(cfg, addresses[0]?.address),
      categories: CATEGORY_ORDER.map((id) => ({
        id,
        label: CATEGORIES[id].label,
        desc: CATEGORIES[id].desc,
        defaultOn: CATEGORIES[id].defaultOn,
      })),
    }
  }

  async status() {
    await this.init()
    const cfg = await this.store.get()
    const server = this.server ? await this.server.status() : { running: false }
    return {
      app: { version: VERSION, dataHome: dataHome(), dshHome: dshHome() },
      device: { ...cfg.device },
      server,
      config: await this.publicConfig(),
      peers: await this.peerStore.list(),
      recent: await this.localApplier.listRecent(8).catch(() => []),
      tasks: this.tasks.recent(10),
    }
  }

  async updateConfig(patch = {}) {
    await this.init()
    const before = await this.store.get()
    const next = await this.store.patch(patch)
    const serverChanged =
      before.server.port !== next.server.port ||
      before.server.bind !== next.server.bind ||
      before.server.enabled !== next.server.enabled ||
      before.server.discovery !== next.server.discovery
    if (serverChanged) {
      if (next.server.enabled) {
        try {
          await this.server.restart({ port: next.server.port, bind: next.server.bind })
        } catch (err) {
          this.logger.error('service', `重启互联服务失败：${err.message}`)
        }
      } else {
        await this.server.stop().catch(() => {})
      }
    }
    if (this.localApplier) this.localApplier.sync = next.sync
    return this.publicConfig()
  }

  async setPassword(password) {
    await this.init()
    const cfg = await this.store.setPassword(password)
    // Password change invalidates pairings.
    this.server.sessions.clear()
    this.server.masterKey = null
    this.server.masterKeyFor = null
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
    this.logger.info('service', '连接密码已更新，旧会话全部失效')
    return { ok: true, password: cfg.auth.password }
  }

  async rotatePassword() {
    await this.init()
    const { generatePassword } = await import('./crypto.mjs')
    return this.setPassword(generatePassword())
  }

  async setDeviceName(name) {
    return this.updateConfig({ device: { name } })
  }

  async serverStart() {
    await this.init()
    const cfg = await this.store.get()
    return this.server.start({ port: cfg.server.port, bind: cfg.server.bind })
  }

  async serverStop() {
    await this.init()
    return this.server.stop()
  }

  /* ---------------------------------------------------------------- */
  /* discovery / connect                                              */
  /* ---------------------------------------------------------------- */

  async discover({ timeoutMs = 1600, extraHosts = [] } = {}) {
    await this.init()
    const cfg = await this.store.get()
    if (!this.server.discovery) {
      // start a temporary scanner even when this machine's own service is off
      const { Discovery } = await import('./discovery.mjs')
      const scanner = new Discovery({ port: cfg.server.port, logger: this.logger, enabled: true, getInfo: () => cfg.device })
      const found = await scanner.scan({ timeoutMs, extraHosts })
      return found.map((f) => ({ ...f, self: f.id === cfg.device.id }))
    }
    const found = await this.server.discovery.scan({ timeoutMs, extraHosts })
    return found.map((f) => ({ ...f, self: f.id === cfg.device.id }))
  }

  async connect({ host, port, password, name, scheme = 'http', insecure = false, rememberPassword = true, uri }) {
    await this.init()
    let target = { host, port, password, name }
    if (uri) target = { ...parseConnectUri(uri), ...target }
    if (!target.host) throw new AppError('NO_HOST', '请填写对端地址')
    const p = Number(target.port) || 8788
    const cfg = await this.store.get()
    const existing = (await this.peerStore.list()).find((x) => x.host === target.host && x.port === p)
    const record = await this.peerStore.upsert({
      id: existing?.id,
      name: target.name || existing?.name || target.host,
      host: target.host,
      port: p,
      scheme,
      insecure,
      password: rememberPassword ? target.password ?? existing?.password ?? '' : existing?.password ?? '',
      lastSeen: Date.now(),
    })
    const peer = await this.#peer(record.id)
    peer.record = { ...peer.record, ...record }
    let result
    try {
      result = await peer.connect({ password: target.password, rememberPassword })
    } catch (err) {
      await this.peerStore.patch(record.id, { lastError: err.message, lastSeen: Date.now() })
      throw err
    }
    await this.peerStore.patch(record.id, {
      name: peer.record.name,
      deviceId: peer.record.deviceId,
      platform: peer.record.platform,
      version: peer.record.version,
      token: peer.record.token,
      sk: peer.record.sk,
      expiresAt: peer.record.expiresAt,
      password: rememberPassword ? target.password ?? record.password : '',
      lastOkAt: Date.now(),
      lastError: null,
    })
    return {
      ok: true,
      peer: (await this.peerStore.list()).find((x) => x.id === record.id),
      server: result.server,
      self: cfg.device,
    }
  }

  async disconnect(id) {
    const peer = this.clients.get(id)
    if (peer) {
      await peer.disconnect()
      this.clients.delete(id)
    }
    await this.peerStore.clearSession(id)
    return { ok: true }
  }

  async forget(id) {
    const peer = this.clients.get(id)
    if (peer) {
      await peer.disconnect().catch(() => {})
      this.clients.delete(id)
    }
    await this.peerStore.remove(id)
    return { ok: true }
  }

  async renamePeer(id, name) {
    return this.peerStore.patch(id, { name: String(name ?? '').slice(0, 48) })
  }

  async ensureConnected(id) {
    const peer = await this.#peer(id)
    if (peer.session) return peer
    if (await peer.restore()) return peer
    const record = await this.peerStore.raw(id)
    if (!record?.password) throw new AppError('NEED_PASSWORD', '会话已过期，请重新输入连接密码')
    await peer.connect({ password: record.password, rememberPassword: true })
    await this.peerStore.patch(id, {
      token: peer.record.token,
      sk: peer.record.sk,
      expiresAt: peer.record.expiresAt,
      lastOkAt: Date.now(),
    })
    return peer
  }

  async remoteInventory(id, { cats, includeSecrets = false } = {}) {
    await this.init()
    const peer = await this.ensureConnected(id)
    return peer.inventory({ cats, includeSecrets })
  }

  async probePeer(id) {
    await this.init()
    const peer = await this.ensureConnected(id)
    const result = await peer.probe()
    await this.peerStore.patch(id, {
      lastOkAt: result.ok ? Date.now() : undefined,
      lastError: result.ok ? null : result.error,
      lastSeen: Date.now(),
    })
    return { ...result, peer: (await this.peerStore.list()).find((x) => x.id === id) }
  }

  async remoteSyncs(id) {
    const peer = await this.ensureConnected(id)
    return peer.listSyncs()
  }

  /** Syncs this machine received, newest first. */
  async localSyncs(limit = 20) {
    await this.init()
    return this.localApplier.listRecent(limit)
  }

  /** Undo a sync this machine applied earlier. */
  async rollbackLocal(syncId) {
    await this.init()
    const result = await this.localApplier.rollback(syncId)
    this.logger.info('sync', `已回滚本机同步 ${syncId}`)
    return result
  }

  /** Plugins whose declared dependencies are not installed locally. */
  async pluginDeps() {
    await this.init()
    return scanPluginDeps(dshHome())
  }

  /** Explicit, user-triggered dependency repair for local plugin directories. */
  async installPluginDeps(ids) {
    await this.init()
    const result = await installPluginDeps(ids, {
      onLine: (line) => this.logger.info('deps', line),
    })
    this.logger.info('deps', `依赖补齐完成：${result.results.map((r) => `${r.id}=${r.code}`).join(', ') || '无待处理项'}`)
    return result
  }

  async remoteRollback(id, syncId) {
    const peer = await this.ensureConnected(id)
    return peer.rollback(syncId)
  }

  /* ---------------------------------------------------------------- */
  /* tasks                                                            */
  /* ---------------------------------------------------------------- */

  startSync({ peerId, direction = 'push', cats, includeSecrets = false }) {
    const task = this.tasks.add(newTask({ direction, peerId }))
    this.#runSync(task, { cats, includeSecrets }).catch((err) => {
      task.phase = 'failed'
      task.error = `${err.code ?? 'ERROR'}: ${err.message}`
      task.finishedAt = Date.now()
      this.logger.error('sync', `同步失败：${task.error}`)
    })
    return taskView(task)
  }

  async #runSync(task, { cats, includeSecrets }) {
    const cfg = await this.store.get()
    const peer = await this.ensureConnected(task.peerId)
    task.phase = 'starting'
    const onProgress = (p) => {
      if (p.phase) task.phase = p.phase
      if (typeof p.total === 'number') task.total = p.total
      if (typeof p.done === 'number') task.done = p.done
      if (typeof p.totalBytes === 'number') task.totalBytes = p.totalBytes
      if (p.remote?.bytes) task.bytes = p.remote.bytes
      if (p.remote?.current) task.detail = p.remote.current
    }
    if (task.direction === 'push') {
      task.phase = 'hashing'
      const pack = await preparePack({
        cats,
        includeSecrets: includeSecrets && cfg.sync.includeCredentials,
        maxFileMb: cfg.sync.maxFileMb,
        cache: this.packCache,
        onProgress: (p) => onProgress({ phase: 'hashing', done: p.done, total: p.total, totalBytes: p.bytes }),
      })
      task.totalBytes = pack.totalBytes
      const summary = await peer.push({
        entries: pack.entries,
        manifest: pack.manifest,
        onProgress,
      })
      task.result = {
        direction: 'push',
        files: pack.manifest.totalFiles,
        bytes: pack.totalBytes,
        manifestId: pack.manifest.id,
        remote: summary,
      }
    } else {
      task.phase = 'preparing'
      const result = await peer.pull({
        cats,
        includeSecrets: includeSecrets && cfg.sync.includeCredentials,
        applier: this.localApplier,
        onProgress,
      })
      task.result = { direction: 'pull', ...result }
    }
    task.phase = 'done'
    task.finishedAt = Date.now()
    this.logger.info('sync', `同步完成：${task.direction} ${humanBytes(task.result?.bytes ?? task.bytes)}`)
  }

  task(id) {
    return this.tasks.view(id)
  }

  async cancelTask(id) {
    const t = this.tasks.get(id)
    if (!t) return null
    if (t.phase === 'done' || t.phase === 'failed') return taskView(t)
    const peer = this.clients.get(t.peerId)
    peer?.abort?.()
    t.phase = 'cancelled'
    t.finishedAt = Date.now()
    return taskView(t)
  }

  /* ---------------------------------------------------------------- */
  /* diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  async diagnostics() {
    await this.init()
    const cfg = await this.store.get()
    const checks = []
    const add = (id, label, status, detail) => checks.push({ id, label, status, detail })
    add('node', 'Node 运行时', process.versions.node ? 'ok' : 'fail', `v${process.versions.node}`)
    add('dshHome', 'DSH 数据目录', await exists(dshHome()) ? 'ok' : 'fail', dshHome())
    add('dataHome', '插件数据目录', await exists(dataHome()) ? 'ok' : 'warn', dataHome())
    const serverStatus = await this.server.status()
    add(
      'server',
      '互联服务',
      serverStatus.running ? 'ok' : 'warn',
      serverStatus.running ? `监听 ${serverStatus.port}` : '未启动',
    )
    const deps = await scanPluginDeps(dshHome())
    add(
      'pluginDeps',
      '插件依赖',
      deps.missing.length === 0 ? 'ok' : 'warn',
      deps.missing.length === 0 ? '全部就绪' : `${deps.missing.length} 个插件缺依赖：${deps.missing.join(', ')}`,
    )
    add(
      'lan',
      '局域网地址',
      lanAddresses().length ? 'ok' : 'warn',
      lanAddresses().map((a) => `${a.iface} ${a.address}`).join('，') || '没有可用网卡',
    )
    const profiles = await listProfiles()
    add('profiles', 'DSH Profile', profiles.length ? 'ok' : 'warn', profiles.map((p) => p.name).join('，'))
    const udpOk = this.server.discovery ? true : false
    add('discovery', '局域网发现', udpOk ? 'ok' : 'warn', udpOk ? 'UDP 已监听' : '未启用（不影响手动连接）')
    const free = await freeSpace(os.homedir())
    add('disk', '可用磁盘', free == null ? 'warn' : free > 2 * 1024 ** 3 ? 'ok' : 'warn', free == null ? '未知' : humanBytes(free))
    add('password', '连接密码', cfg.auth.password ? 'ok' : 'fail', cfg.auth.password ? '已设置' : '未设置')
    return {
      checks,
      env: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        hostname: os.hostname(),
        dshHome: dshHome(),
        dataHome: dataHome(),
        version: VERSION,
      },
    }
  }

  async logs(limit = 200) {
    return this.logger.list(limit)
  }
}


async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function freeSpace(p) {
  try {
    const stat = await fsp.statfs(p)
    return stat.bavail * stat.bsize
  } catch {
    return null
  }
}
