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
import { RemotePeer, sessionUsable } from './peer.mjs'
import { PeerStore } from './peers.mjs'
import { Applier } from './apply.mjs'
import { PackCache, preparePack } from './pack.mjs'
import { CATEGORY_ORDER, CATEGORIES, listProfiles } from './inventory.mjs'
import { installPluginDeps, scanPluginDeps } from './deps.mjs'
import { TaskTable, newTask, taskView } from './tasks.mjs'

export class LinkService {
  constructor({ logger, store, peerStore } = {}) {
    this.logger = logger ?? new Logger({ file: path.join(dataHome(), 'remote-connect.log') })
    this.store = store ?? new ConfigStore()
    // 和 store 一样允许注入：测试要能看清到底写进了哪个文件
    this.peerStore = peerStore ?? new PeerStore()
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
    this.packCache = await new PackCache(path.join(dataHome(), 'hash-cache.json'), {
      logger: this.logger,
    }).load()
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
            .catch((err) => {
              // 记不下来就等于「对方连上过，但重启后列表里没有它」——留一条痕迹。
              this.logger.warnOnce(
                `inbound-upsert:${e.device.id}`,
                'service',
                `记下入站设备失败（${e.device.name}）：${err?.message ?? err}`,
              )
            })
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
      } catch (err) {
        // 对端离线是常态，但「恢复失败」和「本来就没连」不是一回事：
        // 前者要看得出来，否则用户只会觉得「明明勾了自动重连，却没连上」。
        this.logger.warnOnce(
          `restore:${item.id}`,
          'service',
          `恢复与「${item.name ?? item.id}」的会话失败：${err?.message ?? err}`,
        )
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
    // list() 给的是对外视图，里面没有 password；要拿旧密码必须走 raw()，
    // 否则「记住密码」会在每一次不重输密码的重连里被悄悄清空。
    const stored = existing ? await this.peerStore.raw(existing.id) : null
    const keepPassword = stored?.password || ''
    const record = await this.peerStore.upsert({
      id: existing?.id,
      name: target.name || existing?.name || target.host,
      host: target.host,
      port: p,
      scheme,
      insecure,
      password: rememberPassword ? target.password ?? keepPassword : keepPassword,
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
      password: rememberPassword ? target.password ?? keepPassword : '',
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
    this.#cancelTasksOf(id, '已断开')
    const peer = this.clients.get(id)
    // 先摘掉，再跟对端告别：告别这一步失败（对端没答话、连接已经烂了）不能把
    // 本地状态卡在「还连着」——token 会一直躺在 peers.json 里，界面也一直显示已连接。
    this.clients.delete(id)
    try {
      await peer?.disconnect?.()
    } catch (err) {
      this.logger.warn('peer', `跟对端告别时出错，按断开处理：${err?.message ?? err}`)
    }
    await this.peerStore.clearSession(id)
    return { ok: true }
  }

  async forget(id) {
    this.#cancelTasksOf(id, '已删除')
    const peer = this.clients.get(id)
    this.clients.delete(id)
    try {
      await peer?.disconnect?.()
    } catch (err) {
      this.logger.warn('peer', `删除前跟对端告别时出错，照常删除：${err?.message ?? err}`)
    }
    await this.peerStore.remove(id)
    return { ok: true }
  }

  async renamePeer(id, name) {
    return this.peerStore.patch(id, { name: String(name ?? '').slice(0, 48) })
  }

  async ensureConnected(id) {
    const peer = await this.#peer(id)
    if (sessionUsable(peer.session)) return peer
    // 手里那个 session 已经过期（或压根没有）：丢掉它再走「恢复 / 重新握手」，
    // 否则进程会一直拿作废的 token 撞 401，用户只能手动重连。
    if (peer.session) peer.session = null
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
    task.cancelRequested = false
    this.#runSync(task, { cats, includeSecrets })
      .then(() => this.#settle(task, null))
      .catch((err) => this.#settle(task, err))
    return taskView(task)
  }

  /**
   * 任务只有一个收尾点：无论成功、失败还是用户取消，都从这里落到终态。
   * 取消优先——用户点了取消，就不能再显示成「失败」或「完成」。
   */
  #settle(task, err) {
    if (task.finishedAt) return
    task.finishedAt = Date.now()
    if (task.cancelRequested) {
      task.phase = 'cancelled'
      task.error = undefined
      this.logger.info('sync', `同步已取消：${task.direction} ${task.peerId}`)
      return
    }
    if (err) {
      task.phase = 'failed'
      task.error = `${err.code ?? 'ERROR'}: ${err.message}`
      this.logger.error('sync', `同步失败：${task.error}`)
      return
    }
    task.phase = 'done'
    this.logger.info('sync', `同步完成：${task.direction} ${humanBytes(task.result?.bytes ?? task.bytes)}`)
  }

  async #runSync(task, { cats, includeSecrets }) {
    const cfg = await this.store.get()
    const peer = await this.ensureConnected(task.peerId)
    // 掐断这个任务的那条连接。任务一旦脱离 clients（对端被断开/删除），
    // 取消就找不到 peer 了，只能靠这里留下的一根线，否则任务会永远挂在「取消中」。
    task.abortNow = () => {
      try {
        peer.abort?.()
      } catch {
        /* 对端已经没了也算掐断成功 */
      }
    }
    task.phase = 'starting'
    // 两个方向的进度字段不一样：推送的对端把字节数放在 `remote.*` 里，
    // 拉取则由本地 applier 平铺在顶层。两种都认，否则拉取方向永远显示 0 字节、没有当前文件。
    const onProgress = (p) => {
      if (!p) return
      if (p.phase) task.phase = p.phase
      if (typeof p.total === 'number') task.total = p.total
      if (typeof p.done === 'number') task.done = p.done
      const totalBytes = p.totalBytes ?? p.remote?.totalBytes
      if (typeof totalBytes === 'number') task.totalBytes = totalBytes
      const bytes = p.bytes ?? p.remote?.bytes
      if (typeof bytes === 'number') task.bytes = bytes
      const current = p.current ?? p.remote?.current
      if (current) task.detail = current
      // 进度查询失败过几次：同步照样会成功，但界面上得说得出「进度可能不准」。
      if (typeof p.progressFailures === 'number' && p.progressFailures > 0) {
        task.progressFailures = p.progressFailures
      }
    }
    if (task.direction === 'push') {
      task.phase = 'hashing'
      const pack = await preparePack({
        cats,
        includeSecrets: includeSecrets && cfg.sync.includeCredentials,
        maxFileMb: cfg.sync.maxFileMb,
        maxTotalMb: cfg.sync.maxTotalMb,
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
  }

  task(id) {
    return this.tasks.view(id)
  }

  async cancelTask(id) {
    const t = this.tasks.get(id)
    if (!t) return null
    if (t.finishedAt || t.phase === 'done' || t.phase === 'failed' || t.phase === 'cancelled') {
      return taskView(t)
    }
    if (t.cancelRequested) return taskView(t)
    t.cancelRequested = true
    t.phase = 'cancelling'
    const peer = this.clients.get(t.peerId)
    try {
      // 对端可能已经从 clients 里摘掉了（断开 / 删除设备），那时只能靠任务自己留的那根线
      if (peer) peer.abort?.()
      else t.abortNow?.()
    } catch {
      /* 对端已经断开也算取消成功 */
    }
    this.logger.info('sync', `请求取消同步 ${t.id}`)
    return taskView(t)
  }

  /**
   * 断开或删除一台设备时，它正在跑的同步不能继续：既不踏实，也会让任务一直挂在「准备中」。
   * 这里把它名下的任务统一走取消路径（取消优先于失败），并掐断连接。
   */
  #cancelTasksOf(peerId, why) {
    // 注意用 listRefs()：recent() 返回的是视图拷贝，改它不会影响任务
    for (const task of this.tasks.listRefs()) {
      if (task.peerId !== peerId) continue
      if (task.finishedAt || task.phase === 'done' || task.phase === 'failed' || task.phase === 'cancelled') continue
      if (!task.cancelRequested) {
        task.cancelRequested = true
        task.phase = 'cancelling'
      }
      try {
        task.abortNow?.()
      } catch {
        /* 已经没了就算了 */
      }
      this.logger.info('sync', `同步已取消（${why}）：${task.direction} ${peerId}`)
    }
  }

  /* ---------------------------------------------------------------- */
  /* diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  /** 磁盘余量探测：抽成方法，路径选择只有一处，测试也能替换掉真实磁盘。 */
  async freeSpaceAt(dir) {
    return await freeSpace(dir)
  }

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
    // 同步写的是 DSH 数据目录，不是用户主目录——两者常常根本不在同一块盘上（本机就是 C: 与 D:）。
    // 看错盘会让用户以为还有空间，实际在下一个大文件上失败。
    const free = await this.freeSpaceAt(dshHome())
    add(
      'disk',
      '可用磁盘',
      free == null ? 'warn' : free > 2 * 1024 ** 3 ? 'ok' : 'warn',
      free == null ? `未知（${dshHome()}）` : `${humanBytes(free)} 可用（${dshHome()}）`,
    )
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
