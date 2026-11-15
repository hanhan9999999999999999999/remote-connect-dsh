/**
 * dsh-remote-connect · sync server (the side that gets connected to)
 */
import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import {
  APP_NAME,
  PROTOCOL,
  VERSION,
  AppError,
  lanAddresses,
  rid,
  sha256,
} from './util.mjs'
import {
  deriveSessionKey,
  encryptJson,
  decryptJson,
  handshakeProof,
  hmacHex,
  randomNonce,
  safeEqualBuf,
  sessionReadyProof,
} from './crypto.mjs'
import { buildConnectUri, dataHome } from './config.mjs'
import { Applier } from './apply.mjs'
import { PackCache, packStream, preparePack } from './pack.mjs'
import { Discovery } from './discovery.mjs'
import { FrameEncoderTransform, decodeFrames } from './frames.mjs'
import { listProfiles } from './inventory.mjs'
import { CLOCK_SKEW_MS, FailureTracker, NonceStore, clientIp, sanitizeDevice } from './guard.mjs'
import { signatureBase } from './sign.mjs'
import { statusFor } from './status.mjs'

const BASE = '/dsh-link/v1'
const MAX_JSON = 4 * 1024 * 1024
const SESSION_TTL = 12 * 60 * 60 * 1000
const CHALLENGE_TTL = 60 * 1000
// 空闲（没有数据往来）多久就断开；大文件传输期间一直有数据，不受影响。
const IDLE_MS = 120 * 1000
// 同时挂着的连接数上限。这是个给别人连的 P2P 服务，正常人只开几条。
const MAX_CONNECTIONS = 128
// 同时挂着的握手挑战票上限。正常人的握手是「进来一次、验证一次」，
// 一两张票就够；512 是给手动重试与多设备留的余量。
const MAX_CHALLENGES = 512

function jsonBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new AppError('BODY_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export class LinkServer {
  constructor({ store, logger, onEvent, idleMs, maxConnections, nonceMax, failureMax, maxChallenges } = {}) {
    this.store = store
    this.logger = logger
    this.onEvent = onEvent
    // 大文件同步可能要传很久，所以按「空闲」而不是「总时长」掐：只要还有数据在走就不算超时。
    this.idleMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : IDLE_MS
    this.maxConnections =
      Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : MAX_CONNECTIONS
    this.http = null
    this.port = null
    this.sessions = new Map()
    this.challenges = new Map()
    // 握手是公开路由：谁能连上谁就能要一张挑战票。不封顶的话，一分钟几千次
    // 就能把这张表灌满（每张票带设备信息与两个随机数），而且每次进门都要全表扫一遍过期的。
    this.maxChallenges =
      Number.isInteger(maxChallenges) && maxChallenges > 0 ? maxChallenges : MAX_CHALLENGES
    this.guard = new FailureTracker(Number.isInteger(failureMax) && failureMax > 0 ? { max: failureMax } : {})
    this.nonces = new NonceStore(Number.isInteger(nonceMax) && nonceMax > 0 ? { max: nonceMax } : {})
    this.prunedAt = 0
    this.packs = new Map()
    this.discovery = null
    this.startedAt = 0
    this.bytesOut = 0
    this.bytesIn = 0
    this.applier = null
    this.packCache = null
  }

  async status() {
    const cfg = await this.store.get()
    return {
      running: Boolean(this.http),
      port: this.port,
      bind: cfg.server.bind,
      addresses: lanAddresses(),
      discovery: Boolean(this.discovery?.socket),
      sessions: [...this.sessions.values()].filter((s) => s.expiresAt > Date.now()).length,
      startedAt: this.startedAt,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      connectUri: this.http ? buildConnectUri(cfg, lanAddresses()[0]?.address) : null,
      hasPassword: Boolean(cfg.auth.password),
    }
  }

  async start({ port, bind } = {}) {
    if (this.http) return this.status()
    const cfg = await this.store.get()
    const desired = Number(port ?? cfg.server.port) || 8788
    const host = bind ?? cfg.server.bind ?? '0.0.0.0'
    this.packCache = await new PackCache(`${dataHome()}/hash-cache.json`).load()
    this.applier = new Applier({ logger: this.logger, dataHome: dataHome(), sync: cfg.sync, onEvent: this.onEvent })
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => this.#fail(res, err, req))
    })
    server.requestTimeout = 0
    server.headersTimeout = 60_000
    server.keepAliveTimeout = 65_000
    server.maxConnections = this.maxConnections
    // requestTimeout=0 是故意的（大包要传很久），所以用空闲超时兜住「连上来什么都不发」这类占着不放。
    server.setTimeout(this.idleMs, (socket) => {
      this.logger?.warn?.('server', `连接空闲超过 ${Math.round(this.idleMs / 1000)} 秒，已断开`)
      socket.destroy()
    })
    server.on('drop', (data) => {
      this.logger?.warn?.(
        'server',
        `连接数已到上限 ${this.maxConnections}，拒绝新连接（${data?.remoteAddress ?? '未知地址'}）`,
      )
    })
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
    })
    let actual = desired
    let lastErr = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      actual = desired + attempt
      if (actual > 65535) break
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => {
            server.off('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(actual, host)
        })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        if (err.code !== 'EADDRINUSE') break
      }
    }
    if (lastErr) {
      this.logger?.error('server', `监听失败：${lastErr.message}`)
      throw new AppError('PORT_IN_USE', `端口 ${desired} 无法监听：${lastErr.message}`)
    }
    this.http = server
    this.port = actual
    this.startedAt = Date.now()
    if (actual !== desired) {
      this.logger?.warn('server', `端口 ${desired} 被占用，已改用 ${actual}`)
      await this.store.patch({ server: { port: actual } })
    }
    this.logger?.info('server', `互联服务已启动 http://${host}:${actual}`)
    if (cfg.server.discovery) {
      this.discovery = new Discovery({
        port: actual,
        logger: this.logger,
        enabled: true,
        getInfo: () => {
          const c = this.store.value ?? cfg
          return { id: c.device.id, name: c.device.name, platform: c.device.platform, version: VERSION }
        },
      })
      try {
        await this.discovery.start()
      } catch (err) {
        this.logger?.warn('discovery', `UDP 发现未启动：${err.message}`)
        this.discovery = null
      }
    }
    return this.status()
  }

  async stop() {
    if (this.discovery) {
      await this.discovery.stop().catch(() => {})
      this.discovery = null
    }
    if (!this.http) return { running: false }
    const server = this.http
    this.http = null
    this.sessions.clear()
    this.challenges.clear()
    await this.packCache?.close().catch(() => {})
    await new Promise((resolve) => server.close(() => resolve()))
    this.logger?.info('server', '互联服务已停止')
    return { running: false }
  }

  async restart(opts) {
    await this.stop()
    return this.start(opts)
  }

  /* ---------------------------------------------------------------- */
  /* routing                                                          */
  /* ---------------------------------------------------------------- */

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    if (!route.startsWith(BASE)) return this.#plain(res, 404, { error: { code: 'NOT_FOUND', message: '未知接口' } })
    const sub = route.slice(BASE.length) || '/'
    const ip = clientIp(req)
    if (sub !== '/health' && this.guard.blocked(ip)) {
      return this.#plain(res, 429, { error: { code: 'LOCKED', message: '尝试次数过多，请稍后再试' } })
    }

    if (req.method === 'GET' && sub === '/health') return this.#health(res)
    if (req.method === 'POST' && sub === '/hello') return this.#hello(req, res, ip)
    if (req.method === 'POST' && sub === '/hello/verify') return this.#helloVerify(req, res, ip)

    // everything below requires a valid session + signature
    const isStreamUpload =
      (req.method === 'PUT' || req.method === 'POST') && sub.startsWith('/apply/') && sub !== '/apply/prepare'
    // 先看令牌本身：没有令牌、会话过期、被锁，就没必要把几 MB 的 body 读进来再拒绝
    // （128 条连接 × 4 MB 就是半 GB 的内存，谁都能凑出来）。
    const early = this.#lookupSession(req, res)
    if (!early) return
    const body = req.method === 'GET' || isStreamUpload ? Buffer.alloc(0) : await jsonBody(req, MAX_JSON)
    const session = this.#authorize(req, url, body, res, early)
    if (!session) return

    if (req.method === 'GET' && sub === '/ping') {
      return this.#enc(res, session, { ok: true, t: Date.now(), device: await this.#selfInfo() })
    }
    if (req.method === 'POST' && sub === '/inventory') {
      const payload = this.#decryptBody(session, body)
      const result = await this.#inventory(payload)
      return this.#enc(res, session, result)
    }
    if (req.method === 'POST' && sub === '/export/prepare') {
      const payload = this.#decryptBody(session, body)
      const result = await this.#prepareExport(payload)
      return this.#enc(res, session, result)
    }
    if (req.method === 'GET' && sub.startsWith('/export/')) {
      const packId = sub.slice('/export/'.length)
      return this.#streamExport(res, packId, session)
    }
    if (req.method === 'POST' && sub === '/apply/prepare') {
      const payload = this.#decryptBody(session, body)
      // 对端要推多少，先算账：等它把几个 GB 传上来再报超限，等于白占带宽和磁盘。
      const cfg = await this.store.get()
      const maxTotalBytes = (cfg.sync.maxTotalMb ?? 8192) * 1024 * 1024
      const maxFiles = Number.isFinite(cfg.sync.maxFiles) && cfg.sync.maxFiles > 0 ? cfg.sync.maxFiles : 200000
      const want = Number(payload?.totalBytes ?? 0)
      if (Number.isFinite(want) && want > maxTotalBytes) {
        return this.#error(
          res,
          session,
          413,
          'TOO_LARGE',
          `对端要传 ${want} 字节，超过本机上限 ${maxTotalBytes} 字节（改「同步上限」或分批）`,
        )
      }
      // 条数也要在开传之前对账：一个 0 字节文件也占一条记录、一个备份位，
      // 五百万条传完才发现超限，等于把 backups/ 和 journal 先撑一遍。
      const wantFiles = Number(payload?.totalFiles ?? 0)
      if (Number.isFinite(wantFiles) && wantFiles > maxFiles) {
        return this.#error(
          res,
          session,
          413,
          'TOO_MANY_FILES',
          `对端要传 ${wantFiles} 个文件，超过本机上限 ${maxFiles} 个（改「单次文件数」或分批）`,
        )
      }
      const state = await this.applier.prepare({ from: payload.from ?? session.device, meta: payload })
      return this.#enc(res, session, { syncId: state.id, maxTotalBytes, maxFiles })
    }
    if ((req.method === 'PUT' || req.method === 'POST') && sub.startsWith('/apply/')) {
      const syncId = sub.slice('/apply/'.length)
      return this.#receiveApply(req, res, syncId, session)
    }
    if (req.method === 'DELETE' && sub.startsWith('/apply/')) {
      // 对端建了批次却一个字节都没发：让它把这条落成终态，
      // 否则面板上会挂着一个永远停在「接收中」的批次。
      const syncId = sub.slice('/apply/'.length)
      const reason = (url.searchParams.get('reason') ?? '').slice(0, 200) || '对端取消了这次同步'
      const r = this.applier.discard(syncId, reason)
      if (!r.ok) return this.#error(res, session, 404, 'SYNC_UNKNOWN', '同步任务不存在')
      return this.#enc(res, session, r)
    }
    if (req.method === 'GET' && sub === '/progress') {
      const syncId = url.searchParams.get('syncId') ?? ''
      const p = this.applier.progress(syncId)
      if (!p) return this.#error(res, session, 404, 'SYNC_UNKNOWN', '同步任务不存在')
      return this.#enc(res, session, p)
    }
    if (req.method === 'GET' && sub === '/syncs') {
      return this.#enc(res, session, { items: await this.applier.listRecent(20) })
    }
    if (req.method === 'POST' && sub === '/rollback') {
      const payload = this.#decryptBody(session, body)
      const result = await this.applier.rollback(payload.syncId)
      return this.#enc(res, session, result)
    }
    if (req.method === 'POST' && sub === '/bye') {
      this.sessions.delete(session.token)
      return this.#enc(res, session, { ok: true })
    }
    return this.#error(res, session, 404, 'NOT_FOUND', `未知接口 ${req.method} ${sub}`)
  }

  async #selfInfo() {
    const cfg = await this.store.get()
    return { id: cfg.device.id, name: cfg.device.name, platform: cfg.device.platform, version: VERSION }
  }

  #plain(res, status, payload) {
    if (res.writableEnded) return
    const text = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  #enc(res, session, payload) {
    if (res.writableEnded) return
    const envelope = encryptJson(session.sk, payload)
    this.#plain(res, 200, envelope)
  }

  #error(res, session, status, code, message, extra) {
    if (res.writableEnded) return
    const payload = { error: { code, message, ...(extra ? { extra } : {}) } }
    if (session) this.#plain(res, status, encryptJson(session.sk, payload))
    else this.#plain(res, status, payload)
  }

  #fail(res, err, req) {
    const code = err?.code && typeof err.code === 'string' ? err.code : 'INTERNAL'
    const message = err?.message ?? '内部错误'
    if (code !== 'PATH_ESCAPE' && code !== 'NOT_FOUND') {
      this.logger?.error('server', `${req?.method} ${req?.url} → ${code}: ${message}`)
    }
    if (res.writableEnded) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    this.#plain(res, code === 'BODY_TOO_LARGE' ? 413 : 500, { error: { code, message } })
  }

  /* ---------------------------------------------------------------- */
  /* handshake                                                        */
  /* ---------------------------------------------------------------- */

  async #health(res) {
    const cfg = await this.store.get()
    const profiles = await listProfiles()
    this.#plain(res, 200, {
      ok: true,
      app: APP_NAME,
      protocol: PROTOCOL,
      version: VERSION,
      device: { id: cfg.device.id, name: cfg.device.name, platform: cfg.device.platform },
      requiresPassword: Boolean(cfg.auth.password),
      dsh: { profiles: profiles.map((p) => p.name) },
      time: Date.now(),
    })
  }

  async #hello(req, res, ip) {
    const raw = await jsonBody(req, 16 * 1024)
    let data
    try {
      data = JSON.parse(raw.toString('utf8'))
    } catch {
      return this.#plain(res, 400, { error: { code: 'BAD_JSON', message: '请求不是合法 JSON' } })
    }
    const device = sanitizeDevice(data?.device)
    if (!device) return this.#plain(res, 400, { error: { code: 'BAD_DEVICE', message: '缺少设备信息' } })
    let clientNonce
    try {
      clientNonce = Buffer.from(String(data.clientNonce ?? ''), 'base64')
    } catch {
      clientNonce = Buffer.alloc(0)
    }
    if (clientNonce.length < 16) {
      return this.#plain(res, 400, { error: { code: 'BAD_NONCE', message: '握手随机数不合法' } })
    }
    const cfg = await this.store.get()
    const challengeId = rid(12)
    const serverNonce = randomNonce(16)
    this.challenges.set(challengeId, {
      serverNonce,
      clientNonce,
      device,
      ip,
      expiresAt: Date.now() + CHALLENGE_TTL,
    })
    this.#trimChallenges()
    this.#maybePrune()
    this.logger?.info('auth', `收到来自 ${device.name} (${ip}) 的连接请求`)
    this.#plain(res, 200, {
      challengeId,
      serverNonce: serverNonce.toString('base64'),
      salt: cfg.auth.salt,
      kdf: cfg.auth.kdf,
      server: { id: cfg.device.id, name: cfg.device.name, platform: cfg.device.platform, version: VERSION },
      protocol: PROTOCOL,
    })
  }

  async #helloVerify(req, res, ip) {
    const raw = await jsonBody(req, 16 * 1024)
    let data
    try {
      data = JSON.parse(raw.toString('utf8'))
    } catch {
      return this.#plain(res, 400, { error: { code: 'BAD_JSON', message: '请求不是合法 JSON' } })
    }
    const challenge = this.challenges.get(String(data.challengeId ?? ''))
    if (!challenge || challenge.expiresAt < Date.now() || challenge.ip !== ip) {
      return this.#plain(res, 400, { error: { code: 'CHALLENGE_EXPIRED', message: '握手已过期，请重试' } })
    }
    this.challenges.delete(data.challengeId)
    const cfg = await this.store.get()
    const expected = handshakeProof(
      // Derive once per attempt; scrypt is intentionally slow.
      await this.#masterKey(cfg),
      challenge.clientNonce,
      challenge.serverNonce,
      challenge.device.id,
    )
    const given = Buffer.from(String(data.proof ?? ''), 'base64')
    if (!safeEqualBuf(expected, given)) {
      this.guard.register(ip, { logger: this.logger })
      this.logger?.warn('auth', `密码错误：${challenge.device.name} (${ip})`)
      return this.#plain(res, 401, { error: { code: 'BAD_PASSWORD', message: '连接密码不正确' } })
    }
    this.guard.clear(ip)
    const sk = deriveSessionKey(await this.#masterKey(cfg), challenge.clientNonce, challenge.serverNonce)
    const token = rid(32)
    const session = {
      token,
      sk,
      device: challenge.device,
      ip,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL,
      lastUsed: Date.now(),
    }
    this.sessions.set(token, session)
    this.logger?.info('auth', `${challenge.device.name} 已连接`)
    this.onEvent?.({ type: 'peer-connected', device: challenge.device, ip })
    this.#plain(res, 200, {
      token,
      expiresAt: session.expiresAt,
      ready: sessionReadyProof(sk).toString('base64'),
      server: { id: cfg.device.id, name: cfg.device.name, platform: cfg.device.platform, version: VERSION },
    })
  }

  async #masterKey(cfg) {
    if (!this.masterKey || this.masterKeyFor !== cfg.auth.salt) {
      const { deriveMasterKey } = await import('./crypto.mjs')
      this.masterKey = await deriveMasterKey(cfg.auth.password, Buffer.from(cfg.auth.salt, 'base64'), cfg.auth.kdf)
      this.masterKeyFor = cfg.auth.salt
    }
    return this.masterKey
  }

  /* ---------------------------------------------------------------- */
  /* auth for data endpoints                                          */
  /* ---------------------------------------------------------------- */

  // 只验证令牌子（有没有这个会话、过没过期），不碰请求体、不验签名。
  // 目的是在把 body 读进内存之前就能拒掉无令牌的请求。
  #lookupSession(req, res) {
    const token = String(req.headers['x-dl-token'] ?? '')
    const session = this.sessions.get(token)
    if (!session) {
      this.#plain(res, 401, { error: { code: 'UNAUTHORIZED', message: '未连接或会话已过期' } })
      return null
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      this.#plain(res, 401, { error: { code: 'SESSION_EXPIRED', message: '会话已过期，请重新连接' } })
      return null
    }
    return session
  }

  #authorize(req, url, body, res, known) {
    const token = String(req.headers['x-dl-token'] ?? '')
    const session = known ?? this.sessions.get(token)
    if (!session) {
      this.#plain(res, 401, { error: { code: 'UNAUTHORIZED', message: '未连接或会话已过期' } })
      return null
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      this.#plain(res, 401, { error: { code: 'SESSION_EXPIRED', message: '会话已过期，请重新连接' } })
      return null
    }
    const ts = Number(req.headers['x-dl-ts'] ?? 0)
    const nonce = String(req.headers['x-dl-nonce'] ?? '')
    const mac = String(req.headers['x-dl-mac'] ?? '')
    if (!ts || !nonce || !mac) {
      this.#plain(res, 401, { error: { code: 'MISSING_SIGNATURE', message: '缺少签名头' } })
      return null
    }
    // nonce 会被记进重放表，太长就是一个能撑内存的把手
    if (nonce.length > 128 || mac.length > 128) {
      this.#plain(res, 401, { error: { code: 'BAD_SIGNATURE', message: '签名头过长' } })
      return null
    }
    if (Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) {
      this.#plain(res, 401, { error: { code: 'CLOCK_SKEW', message: '两端时间相差超过 5 分钟' } })
      return null
    }
    const expected = hmacHex(
      session.sk,
      signatureBase(
        req.method,
        // 查询串也要算进签名：客户端签的是 `/progress?syncId=…` 整段，
        // 以前这里只取 pathname，带查询串的请求签名永远对不上（而调用方把 401 吞了）。
        `${url.pathname}${url.search ?? ''}`,
        ts,
        nonce,
        req.headers['x-dl-stream'] === '1' ? 'stream' : sha256(body),
      ),
    )
    if (!safeEqualBuf(expected, mac)) {
      this.#plain(res, 401, { error: { code: 'BAD_SIGNATURE', message: '请求签名不合法' } })
      return null
    }
    const replayKey = `${token}:${nonce}`
    if (this.nonces.take(replayKey) === 'replay') {
      this.#plain(res, 401, { error: { code: 'REPLAY', message: '请求重复' } })
      return null
    }
    this.#maybePrune()
    session.lastUsed = Date.now()
    return session
  }

  #decryptBody(session, body) {
    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      throw new AppError('BAD_JSON', '请求体不是合法 JSON')
    }
    try {
      return decryptJson(session.sk, parsed)
    } catch {
      throw new AppError('BAD_ENVELOPE', '请求体解密失败')
    }
  }

  /* ---------------------------------------------------------------- */
  /* inventory / export                                               */
  /* ---------------------------------------------------------------- */

  async #inventory(payload) {
    const { scanAll, CATEGORY_ORDER } = await import('./inventory.mjs')
    const cfg = await this.store.get()
    const cats = normalizeCats(payload?.cats, cfg)
    const inv = await scanAll({
      cats,
      includeSecrets: Boolean(payload?.includeSecrets && cfg.sync.includeCredentials),
      maxFileMb: cfg.sync.maxFileMb,
    })
    return {
      categories: cats,
      summary: inv.summary,
      totalFiles: inv.totalFiles,
      totalBytes: inv.totalBytes,
      excluded: inv.excluded,
      // 扫描时按规则跳过了多少、各是什么原因：`scanAll()` 早就算好了，
      // 可这里以前只挑固定几个字段回给对端，于是界面那句「有 N 个文件没进清单」
      // 在对端看永远是 0（自己扫自己时才正常）。
      excludedTotal: inv.excludedTotal ?? inv.excluded?.length ?? 0,
      excludedReasons: inv.excludedReasons ?? {},
      entries: inv.entries.map((e) => ({
        cat: e.cat,
        rel: e.rel,
        size: e.size,
        mtime: e.mtime,
        ...(e.op ? { op: e.op } : {}),
      })),
      ms: inv.ms,
      available: CATEGORY_ORDER,
      at: inv.at,
    }
  }

  async #prepareExport(payload) {
    const cfg = await this.store.get()
    const cats = normalizeCats(payload?.cats, cfg)
    const pack = await preparePack({
      cats,
      includeSecrets: Boolean(payload?.includeSecrets && cfg.sync.includeCredentials),
      maxFileMb: cfg.sync.maxFileMb,
      maxTotalMb: cfg.sync.maxTotalMb,
      cache: this.packCache,
    })
    const packId = rid(12)
    this.packs.set(packId, { ...pack, packId, createdAt: Date.now(), session: payload?.sessionId })
    // bound memory: at most 3 prepared packs
    if (this.packs.size > 3) {
      const oldest = [...this.packs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      this.packs.delete(oldest.packId)
    }
    return {
      packId,
      manifest: pack.manifest,
      totalBytes: pack.totalBytes,
      files: pack.entries.length,
    }
  }

  async #streamExport(res, packId, session) {
    const pack = this.packs.get(packId)
    if (!pack) return this.#error(res, session, 404, 'PACK_UNKNOWN', '清单已过期，请重新准备')
    res.writeHead(200, {
      'content-type': 'application/x-dsh-link-frames',
      'x-dl-pack': packId,
      'x-dl-compression': 'gzip',
      'x-dl-manifest-id': pack.manifest.id,
    })
    try {
      await pipeline(packStream(pack.entries), new FrameEncoderTransform(session.sk), res)
      this.bytesOut += pack.totalBytes
      this.logger?.info('export', `已发送 ${pack.entries.length} 个文件`)
    } catch (err) {
      this.logger?.warn('export', `发送中断：${err.message}`)
    } finally {
      this.packs.delete(packId)
    }
  }

  async #receiveApply(req, res, syncId, session) {
    const headerTotal = Number(req.headers['x-dl-total'] ?? 0)
    this.logger?.info('apply', `开始接收 ${syncId}`)
    const link = decodeFrames(req, session.sk)
    try {
      const progress = await this.applier.applyStream(syncId, link.stream)
      this.bytesIn += progress.bytes
      this.logger?.info('apply', `应用完成 ${syncId}：${progress.files} 个文件`)
      this.#enc(res, session, { ok: true, ...progress, headerTotal })
    } catch (err) {
      this.logger?.error('apply', `应用失败 ${syncId}：${err.message}`)
      const p = this.applier.progress(syncId)
      // 走同一张错误码表：路径越界是 400、内容超限是 413、批次不存在是 404，
      // 一律回 500 会让对端以为是「服务端坏了」，而其实它该改的是自己的参数或分批。
      this.#error(res, session, statusFor(err.code ?? 'APPLY_FAILED'), err.code ?? 'APPLY_FAILED', err.message, p ? { progress: p } : undefined)
    } finally {
      // 落地失败（路径越界、超限……）时对端还在往外传：不关掉的话这条上传流会一直挂着。
      link.destroy()
    }
  }

  /* ---------------------------------------------------------------- */
  /* throttling                                                       */
  /* ---------------------------------------------------------------- */

  #prune() {
    const now = Date.now()
    this.prunedAt = now
    for (const [k, v] of this.challenges) if (v.expiresAt < now) this.challenges.delete(k)
    this.nonces.prune(now, { force: true })
    for (const [k, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(k)
  }

  /** 会话/挑战的清理由时间触发（30 秒最多一次），不再挂在「重放表超过 5000 条」上 */
  #maybePrune() {
    if (Date.now() - this.prunedAt < 30 * 1000) return
    this.#prune()
  }

  /**
   * 握手挑战票封顶：超了就按到期时间从早到晚丢掉最旧的那些。
   * 丢掉的那张票再来验证会得到 `CHALLENGE_EXPIRED`，让对方重新握手——
   * 这比「让整张表一直涨、并且每次进门都全表扫一遍」要好。
   */
  #trimChallenges() {
    const overflow = this.challenges.size - this.maxChallenges
    if (overflow <= 0) return
    const oldest = [...this.challenges.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    for (let i = 0; i < overflow; i += 1) this.challenges.delete(oldest[i][0])
  }
}


function normalizeCats(cats, cfg) {
  const order = ['skills', 'rules', 'plugins', 'config', 'sessions', 'plugin-data']
  const requested =
    Array.isArray(cats) && cats.length ? cats : order.filter((c) => cfg.sync.categories[c])
  const clean = [...new Set(requested.filter((c) => order.includes(c)))]
  return clean.length ? clean : order.filter((c) => cfg.sync.categories[c])
}
