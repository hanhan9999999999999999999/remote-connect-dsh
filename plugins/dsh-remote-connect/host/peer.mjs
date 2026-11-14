/**
 * dsh-remote-connect · peer client (the side that initiates)
 */
import http from 'node:http'
import https from 'node:https'
import { createGunzip } from 'node:zlib'
import {
  PROTOCOL,
  VERSION,
  AppError,
  rid,
  sha256,
} from './util.mjs'
import {
  decryptJson,
  deriveMasterKey,
  deriveSessionKey,
  encryptJson,
  handshakeProof,
  hmacHex,
  randomNonce,
  safeEqualBuf,
  sessionReadyProof,
} from './crypto.mjs'
import { FrameDecoderTransform, FrameEncoderTransform } from './frames.mjs'
import { packStream } from './pack.mjs'

const BASE = '/dsh-link/v1'

/** 会话还能用吗：留 30 秒余量，避免「以为还有 2 秒」的请求刚好撞在过期边界上。 */
export function sessionUsable(session, now = Date.now()) {
  if (!session || !session.token || !session.expiresAt) return false
  return session.expiresAt > now + 30_000
}

/** 这个错误码说明对端的会话已经作废，本地缓存必须立刻丢掉。 */
function isDeadSession(code) {
  return code === 'UNAUTHORIZED' || code === 'SESSION_EXPIRED'
}

export class RemotePeer {
  constructor({ record, logger, device }) {
    this.record = record
    this.logger = logger
    this.device = device
    this.session = null
    this.agent = null
  }

  get id() {
    return this.record.id
  }

  #lib() {
    return this.record.scheme === 'https' ? https : http
  }

  #agentFor() {
    if (this.agent) return this.agent
    const lib = this.#lib()
    this.agent = new lib.Agent({
      keepAlive: true,
      maxSockets: 4,
      rejectUnauthorized: this.record.scheme === 'https' ? this.record.insecure !== true : undefined,
    })
    return this.agent
  }

  close() {
    this.agent?.destroy()
    this.agent = null
    this.session = null
  }

  /** Hard-stop every in-flight request (used when the user cancels a sync). */
  abort() {
    this.agent?.destroy()
    this.agent = null
  }

  #baseOptions(path) {
    return {
      host: this.record.host,
      port: this.record.port,
      path: `${BASE}${path}`,
      agent: this.#agentFor(),
      headers: { 'user-agent': `dsh-remote-connect/${VERSION}` },
    }
  }

  /** Low-level request. Resolves with the IncomingMessage (caller consumes). */
  #request({ method, path, headers = {}, body, bodyStream, timeoutMs = 60_000 }) {
    const lib = this.#lib()
    const options = { ...this.#baseOptions(path), method, headers: { ...headers } }
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => resolve(res))
      req.on('error', (err) => {
        // 超时是我们自己 destroy 出来的 AppError，别把它压成 NETWORK——
        // index.js 要靠 TIMEOUT 区分「对端没响应」和「网线断了」。
        if (err instanceof AppError) reject(err)
        else reject(new AppError('NETWORK', networkMessage(err), { cause: err.code }))
      })
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => req.destroy(new AppError('TIMEOUT', '连接超时')))
      } else {
        req.setTimeout(120_000, () => req.destroy(new AppError('TIMEOUT', '长时间没有响应')))
      }
      if (bodyStream) {
        bodyStream.on('error', (err) => req.destroy(err))
        bodyStream.pipe(req)
      } else if (body) {
        req.end(body)
      } else {
        req.end()
      }
    })
  }

  #signedHeaders(method, path, bodyBuf, extra = {}) {
    if (!this.session) throw new AppError('NOT_CONNECTED', '尚未连接对端')
    const ts = Date.now()
    const nonce = rid(12)
    const bodySha = extra['x-dl-stream'] ? 'stream' : sha256(bodyBuf ?? Buffer.alloc(0))
    const mac = hmacHex(this.session.sk, `${method}|${BASE}${path}|${ts}|${nonce}|${bodySha}`)
    return {
      ...extra,
      'x-dl-token': this.session.token,
      'x-dl-ts': String(ts),
      'x-dl-nonce': nonce,
      'x-dl-mac': mac,
    }
  }

  async #jsonFrom(res, expectOk = true) {
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    const buf = Buffer.concat(chunks)
    let parsed = null
    try {
      parsed = JSON.parse(buf.toString('utf8'))
    } catch {
      throw new AppError('BAD_RESPONSE', `对端返回了无法解析的内容（HTTP ${res.statusCode}）`)
    }
    if (parsed?.e === 1 && this.session) {
      try {
        parsed = decryptJson(this.session.sk, parsed)
      } catch {
        throw new AppError('BAD_ENVELOPE', '响应解密失败，可能两端密码不一致')
      }
    }
    if (expectOk && (res.statusCode >= 400 || parsed?.error)) {
      const err = parsed?.error ?? {}
      const code = err.code ?? `HTTP_${res.statusCode}`
      // 会话过期/未授权：把本地缓存的 session 丢掉，下一次操作才会重新握手，
      // 否则这个进程会一直拿着一个已经作废的 token 反复撞 401。
      if (isDeadSession(code) || res.statusCode === 401) this.session = null
      throw new AppError(code, err.message ?? '对端返回错误', err.extra)
    }
    return parsed
  }

  async health() {
    const res = await this.#request({ method: 'GET', path: '/health', timeoutMs: 8000 })
    const body = await this.#jsonFrom(res, false)
    const looksRight =
    body &&
    (body.app === '远程互联' ||
      body.app === '设备互联' ||
      body.app === 'dsh-remote-connect' ||
      body.app === 'dsh-device-link' ||
      body.app === 'Device Link')
    if (!looksRight || body.protocol !== PROTOCOL) {
      throw new AppError('NOT_DSH_LINK', '对端不是设备互联服务，或协议版本不兼容')
    }
    return body
  }

  async connect({ password, rememberPassword = true } = {}) {
    const health = await this.health()
    if (health.protocol !== PROTOCOL) {
      throw new AppError('VERSION_MISMATCH', `对端协议 ${health.protocol}，本机需要 ${PROTOCOL}`)
    }
    const pwd = password || this.record.password
    if (!pwd) throw new AppError('NO_PASSWORD', '请输入对端连接密码')
    const clientNonce = randomNonce(16)
    const helloRes = await this.#request({
      method: 'POST',
      path: '/hello',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: this.device, clientNonce: clientNonce.toString('base64') }),
      timeoutMs: 10_000,
    })
    const hello = await this.#jsonFrom(helloRes, false)
    if (hello?.error) throw new AppError(hello.error.code, hello.error.message)
    const serverNonce = Buffer.from(hello.serverNonce, 'base64')
    const master = await deriveMasterKey(pwd, Buffer.from(hello.salt, 'base64'), hello.kdf)
    const proof = handshakeProof(master, clientNonce, serverNonce, this.device.id)
    const verifyRes = await this.#request({
      method: 'POST',
      path: '/hello/verify',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: hello.challengeId, proof: proof.toString('base64') }),
      timeoutMs: 20_000,
    })
    const verified = await this.#jsonFrom(verifyRes, false)
    if (verified?.error) {
      const err = new AppError(verified.error.code, verified.error.message)
      if (verified.error.code === 'BAD_PASSWORD') await this.#rememberError(err.message)
      throw err
    }
    const sk = deriveSessionKey(master, clientNonce, serverNonce)
    if (!safeEqualBuf(sessionReadyProof(sk), Buffer.from(verified.ready ?? '', 'base64'))) {
      throw new AppError('KEY_MISMATCH', '会话密钥校验失败')
    }
    this.session = {
      token: verified.token,
      sk,
      expiresAt: verified.expiresAt,
      server: verified.server,
      ip: this.record.host,
    }
    this.record = {
      ...this.record,
      password: rememberPassword ? pwd : this.record.password,
      token: verified.token,
      sk: sk.toString('base64'),
      expiresAt: verified.expiresAt,
      deviceId: verified.server?.id ?? this.record.deviceId,
      name: verified.server?.name ?? this.record.name,
      platform: verified.server?.platform ?? this.record.platform,
      version: verified.server?.version ?? this.record.version,
      lastOkAt: Date.now(),
      lastError: null,
    }
    this.logger?.info('peer', `已连接 ${this.record.name} (${this.record.host}:${this.record.port})`)
    return { session: this.session, server: verified.server, health }
  }

  /** Reuse a stored session token if it is still valid. */
  async restore() {
    const r = this.record
    if (!r.token || !r.sk || !r.expiresAt) return false
    const candidate = { token: r.token, sk: Buffer.from(r.sk, 'base64'), expiresAt: r.expiresAt }
    if (!sessionUsable(candidate)) return false
    this.session = candidate
    try {
      await this.requestJson('GET', '/ping', { timeoutMs: 8000 })
      return true
    } catch (err) {
      if (isDeadSession(err.code)) {
        this.session = null
        return false
      }
      // 网络问题（含超时）：会话本身没准还是好的，留给调用方决定。
      return Boolean(this.session)
    }
  }

  async requestJson(method, path, { payload, encrypt = true, timeoutMs = 60_000 } = {}) {
    const plain = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8')
    const body = plain && encrypt ? Buffer.from(JSON.stringify(encryptJson(this.session.sk, payload)), 'utf8') : plain
    const headers = this.#signedHeaders(method, path, body, {
      ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
    })
    const res = await this.#request({ method, path, headers, body, timeoutMs })
    return this.#jsonFrom(res)
  }

  async probe() {
    const t0 = Date.now()
    try {
      const info = await this.requestJson('GET', '/ping', { timeoutMs: 6000 })
      return { ok: true, ms: Date.now() - t0, device: info.device }
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: `${err.code}: ${err.message}` }
    }
  }

  /** Ask the peer for its inventory (no file contents). */
  async inventory({ cats, includeSecrets = false }) {
    return this.requestJson('POST', '/inventory', { payload: { cats, includeSecrets }, timeoutMs: 120_000 })
  }

  /** Receive a pack and apply it locally. */
  async pull({ cats, applier, includeSecrets = false, onProgress } = {}) {
    onProgress?.({ phase: 'preparing', done: 0, total: 0 })
    const prep = await this.requestJson('POST', '/export/prepare', {
      payload: { cats, includeSecrets },
      timeoutMs: 10 * 60_000,
    })
    onProgress?.({ phase: 'downloading', done: 0, total: prep.totalBytes, totalBytes: prep.totalBytes, bytes: 0 })
    const state = await applier.prepare({
      from: this.record,
      meta: { totalBytes: prep.totalBytes, totalFiles: prep.files },
    })
    state.onTick = () => onProgress?.({ phase: 'applying', ...applier.progress(state.id), total: prep.totalBytes })
    const res = await this.#request({
      method: 'GET',
      path: `/export/${prep.packId}`,
      headers: this.#signedHeaders('GET', `/export/${prep.packId}`, Buffer.alloc(0)),
      timeoutMs: 0,
    })
    if (res.statusCode !== 200) {
      const err = await this.#jsonFrom(res, false)
      throw new AppError(err?.error?.code ?? 'EXPORT_FAILED', err?.error?.message ?? '对端拒绝导出')
    }
    const tar = res.pipe(new FrameDecoderTransform(this.session.sk)).pipe(createGunzip())
    const result = await applier.applyStream(state.id, tar)
    onProgress?.({ phase: 'done', ...result, totalBytes: Number(result?.bytes ?? prep.totalBytes ?? 0) })
    return { ...result, manifest: prep.manifest }
  }

  /** Send local files to the peer, which applies them. */
  async push({ entries, manifest, applierSummary, onProgress } = {}) {
    const totalBytes = entries.reduce((n, e) => n + e.size, 0)
    onProgress?.({ phase: 'preparing', done: 0, total: totalBytes })
    const prep = await this.requestJson('POST', '/apply/prepare', {
      payload: {
        from: this.device,
        totalBytes,
        totalFiles: entries.length,
        manifestId: manifest?.id,
      },
      timeoutMs: 30_000,
    })
    const syncId = prep.syncId
    // 对端在 prepare 里会告诉我们它的上限。超了就别开始传——传几个 GB 再被拒绝是白费带宽。
    const peerMax = Number(prep.maxTotalBytes ?? 0)
    if (peerMax > 0 && totalBytes > peerMax) {
      throw new AppError(
        'TOO_LARGE',
        `这次要传 ${totalBytes} 字节，超过对端上限 ${peerMax} 字节（让对方调高「同步上限」或分批同步）`,
        { totalBytes, maxTotalBytes: peerMax },
      )
    }
    const source = packStream(entries).pipe(new FrameEncoderTransform(this.session.sk))
    let sent = 0
    source.on('data', (chunk) => {
      sent += chunk.length
      onProgress?.({ phase: 'uploading', done: sent, total: totalBytes })
    })
    // 进度是尽力而为：开始时勤一点，传久了慢慢退到 3 秒一次，别在大文件上传时刷出几百个请求。
    let delay = 700
    let timer = null
    let stopped = false
    const poll = async () => {
      if (stopped) return
      try {
        const p = await this.requestJson('GET', `/progress?syncId=${encodeURIComponent(syncId)}`, {
          timeoutMs: 5000,
        })
        onProgress?.({ phase: 'applying', remote: p, done: sent, total: totalBytes })
      } catch {
        /* progress is best-effort */
      }
      if (stopped) return
      delay = Math.min(Math.round(delay * 1.6), 3000)
      timer = setTimeout(poll, delay)
      timer.unref?.()
    }
    timer = setTimeout(poll, delay)
    timer.unref?.()
    try {
      const res = await this.#request({
        method: 'PUT',
        path: `/apply/${syncId}`,
        headers: this.#signedHeaders('PUT', `/apply/${syncId}`, Buffer.alloc(0), {
          'content-type': 'application/x-dsh-link-frames',
          'x-dl-stream': '1',
          'x-dl-total': String(totalBytes),
        }),
        bodyStream: source,
        timeoutMs: 0,
      })
      const result = await this.#jsonFrom(res)
      onProgress?.({ phase: 'done', done: totalBytes, total: totalBytes, result })
      return result
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  async listSyncs() {
    return this.requestJson('GET', '/syncs', { timeoutMs: 20_000 })
  }

  async rollback(syncId) {
    return this.requestJson('POST', '/rollback', { payload: { syncId }, timeoutMs: 120_000 })
  }

  async disconnect() {
    try {
      if (this.session) await this.requestJson('POST', '/bye', { payload: {}, timeoutMs: 3000 })
    } catch {
      /* ignore */
    }
    this.session = null
    this.close()
  }

  async #rememberError(message) {
    this.record = { ...this.record, lastError: message, lastSeen: Date.now() }
  }
}

export function networkMessage(err) {
  const code = err?.code
  const map = {
    ECONNREFUSED: '对端没有在监听这个端口（服务未开启或端口不对）',
    EHOSTUNREACH: '网络不可达，检查两台机器是否在同一网段',
    ENOTFOUND: '找不到这个地址',
    ETIMEDOUT: '连接超时，检查防火墙',
    ECONNRESET: '连接被对端重置',
    EPIPE: '连接中断',
  }
  return map[code] ?? `网络错误：${err?.message ?? code ?? 'unknown'}`
}
