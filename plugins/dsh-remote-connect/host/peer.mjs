/**
 * dsh-remote-connect · peer client (the side that initiates)
 */
import http from 'node:http'
import https from 'node:https'
import {
  PROTOCOL,
  VERSION,
  AppError,
  rid,
} from './util.mjs'
import {
  decryptJson,
  decodeB64Field,
  deriveMasterKey,
  deriveSessionKey,
  encryptJson,
  handshakeProof,
  randomNonce,
  safeEqualBuf,
  sanitizeKdf,
  sessionReadyProof,
} from './crypto.mjs'
import { bodyDigest, signRequest } from './sign.mjs'
import { FrameEncoderTransform, decodeFrames } from './frames.mjs'
import { packStream } from './pack.mjs'

const BASE = '/dsh-link/v1'

/**
 * 单个 JSON 响应的字节上限。清单/同步记录再大也就几 MB，
 * 但如果对端出错或被人改过，`/syncs` 可以一直往外吐——这条线得有个闸。
 */
export const MAX_JSON_BYTES = 64 * 1024 * 1024

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
    /** 单个 JSON 响应最多收多少字节（测试里会调小）。 */
    this.maxJsonBytes = MAX_JSON_BYTES
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
      const state = { timedOut: false }
      const req = lib.request(options, (res) => {
        // 把「这次超时了」标记带到响应流上，读 body 的那一侧才知道该报 TIMEOUT。
        // 只靠 socket 超时的话，读 body 阶段拿到的是一条裸 ECONNRESET / aborted。
        if (state.timedOut) res.__dlTimedOut = true
        res.__dlState = state
        resolve(res)
      })
      req.on('error', (err) => {
        // 超时是我们自己 destroy 出来的 AppError，别把它压成 NETWORK——
        // index.js 要靠 TIMEOUT 区分「对端没响应」和「网线断了」。
        if (err instanceof AppError) reject(err)
        else if (state.timedOut) reject(new AppError('TIMEOUT', '对端迟迟没有响应', { cause: err.code }))
        else reject(new AppError('NETWORK', networkMessage(err), { cause: err.code }))
      })
      const fireTimeout = () => {
        state.timedOut = true
        req.destroy(new AppError('TIMEOUT', '连接超时'))
      }
      if (timeoutMs) {
        req.setTimeout(timeoutMs, fireTimeout)
      } else {
        req.setTimeout(120_000, fireTimeout)
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
    const digest = bodyDigest(bodyBuf, extra['x-dl-stream'] === '1')
    // 目标包含查询串：服务和客户两边都走 signatureBase 这一个函数拼字符串
    const target = `${BASE}${path}`
    const mac = signRequest(this.session.sk, { method, target, ts, nonce, digest })
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
    let size = 0
    const limit = this.maxJsonBytes
    try {
      for await (const chunk of res) {
        size += chunk.length
        if (size > limit) {
          res.destroy()
          throw new AppError('BAD_RESPONSE', `对端返回的内容超过 ${Math.round(limit / 1024 / 1024)} MB，已中止`)
        }
        chunks.push(chunk)
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      // 读 body 阶段的失败（对端半路没了、被我们的超时掐断）以前是一条裸
      // ECONNRESET / aborted，冒到路由层就成了 500「服务端坏了」。
      if (res.__dlTimedOut || res.__dlState?.timedOut) {
        throw new AppError('TIMEOUT', '对端迟迟没有把内容发完', { cause: err.code })
      }
      throw new AppError('NETWORK', networkMessage(err), { cause: err.code })
    }
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
    // 握手应答是**对端说的**：缺字段、长度不对、kdf 要的内存离谱，
    // 都要在这里挡下来并说清是「对端坏了」，而不是让 Buffer/scrypt 抛内部错误。
    const serverNonce = decodeB64Field(hello.serverNonce, { label: 'serverNonce', min: 16, max: 64 })
    const salt = decodeB64Field(hello.salt, { label: 'salt', min: 16, max: 64 })
    const kdf = sanitizeKdf(hello.kdf)
    const master = await deriveMasterKey(pwd, salt, kdf)
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
    let res
    try {
      res = await this.#request({
        method: 'GET',
        path: `/export/${prep.packId}`,
        headers: this.#signedHeaders('GET', `/export/${prep.packId}`, Buffer.alloc(0)),
        timeoutMs: 0,
      })
      if (res.statusCode !== 200) {
        const err = await this.#jsonFrom(res, false)
        throw new AppError(err?.error?.code ?? 'EXPORT_FAILED', err?.error?.message ?? '对端拒绝导出')
      }
    } catch (err) {
      // 批次已经建好了却没收到任何东西：不收尾的话它会永远停在「接收中」——
      // #trimStates 只收 done/failed，面板上就挂着一个永远不动的批次。
      await this.#discardLocal(applier, state.id, `拉取没能开始：${err?.message ?? err}`)
      throw err
    }
    const link = decodeFrames(res, this.session.sk)
    try {
      const result = await applier.applyStream(state.id, link.stream)
      onProgress?.({ phase: 'done', ...result, totalBytes: Number(result?.bytes ?? prep.totalBytes ?? 0) })
      return { ...result, manifest: prep.manifest }
    } catch (err) {
      await this.#discardLocal(applier, state.id, `拉取失败：${err?.message ?? err}`)
      throw err
    } finally {
      // 不管成没成都把这条下载流关掉：失败时（路径越界、校验不符、超限……）
      // 对端还在继续往外传，不 destroy 的话 socket 会一直占着，几 GB 的包会在后台继续往本机淌。
      link.destroy()
    }
  }

  /** 尽力把本地批次落成终态，失败不影响要抛出去的那个错。 */
  async #discardLocal(applier, syncId, reason) {
    try {
      await applier?.discard?.(syncId, reason)
    } catch {
      /* 收尾失败不该盖掉原始错误 */
    }
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
    // 条数同理：对端最多收多少个文件，也在 prepare 里告诉我们了。
    // 超了就一个字节都不发，并把它刚建好的批次撤掉，别在它面板上留一条永远「接收中」的记录。
    const peerMaxFiles = Number(prep.maxFiles ?? 0)
    if (peerMaxFiles > 0 && entries.length > peerMaxFiles) {
      await this.#cancelRemote(syncId, `条目数超过对端上限 ${peerMaxFiles}`)
      throw new AppError(
        'TOO_MANY_FILES',
        `这次要传 ${entries.length} 个文件，超过对端上限 ${peerMaxFiles} 个（让对方调高「单次文件数」或分批同步）`,
        { files: entries.length, maxFiles: peerMaxFiles },
      )
    }
    // packStream 的错误**不会**经 .pipe() 传到编码器：打包途中某个文件读不到时，
    // 这条 gzip 只是带着 error 结束，编码器既不会结束也不会报错，上传就悬在那里，
    // 一直等到 120 秒空闲超时，用户看到的是「对端迟迟没有响应」——其实是本地文件没了。
    const pack = packStream(entries)
    const encoder = new FrameEncoderTransform(this.session.sk)
    pack.on('error', (err) => {
      encoder.destroy(err instanceof AppError ? err : new AppError('READ_FAILED', err?.message ?? String(err)))
    })
    const source = pack.pipe(encoder)
    let sent = 0
    source.on('data', (chunk) => {
      sent += chunk.length
      onProgress?.({ phase: 'uploading', done: sent, total: totalBytes })
    })
    // 进度是尽力而为：开始时勤一点，传久了慢慢退到 3 秒一次，别在大文件上传时刷出几百个请求。
    let delay = 700
    let timer = null
    let stopped = false
    let progressFailures = 0
    const poll = async () => {
      if (stopped) return
      try {
        const p = await this.requestJson('GET', `/progress?syncId=${encodeURIComponent(syncId)}`, {
          timeoutMs: 5000,
        })
        onProgress?.({ phase: 'applying', remote: p, done: sent, total: totalBytes })
      } catch (err) {
        // 进度是尽力而为的，失败不必让整个同步失败——但也不能一声不响，
        // 否则界面上只会看到「进度条一直不动」。同一个错误只记一条。
        progressFailures += 1
        const code = err?.code ?? 'ERROR'
        this.logger?.warnOnce?.(
          `progress:${code}`,
          'peer',
          `查询同步进度失败（${code}：${err?.message ?? err}）。同步本身还在跑，只是进度可能停住。`,
        )
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
      onProgress?.({ phase: 'done', done: totalBytes, total: totalBytes, result, progressFailures })
      return result
    } catch (err) {
      // 对端已经建了批次却一个字节都没收到：告诉它把这个批次收掉，
      // 否则它那边会一直挂着一个停在「接收中」的任务。
      await this.#cancelRemote(syncId, err?.message ?? String(err))
      throw err
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      // 对端提前拒了（413/401…）的时候，本地读流不会自己停：
      // 不 destroy 就等于继续把几个 GB 的文件读完再丢掉。
      if (!source.destroyed) source.destroy()
    }
  }

  async listSyncs() {
    return this.requestJson('GET', '/syncs', { timeoutMs: 20_000 })
  }

  /** 告诉对端「这次推送作废」（尽力而为，失败不抛）。 */
  async #cancelRemote(syncId, reason) {
    try {
      await this.requestJson('DELETE', `/apply/${encodeURIComponent(syncId)}?reason=${encodeURIComponent(String(reason).slice(0, 120))}`, {
        timeoutMs: 5000,
      })
    } catch {
      /* 对端收不到就等它自己过期；这条不该盖掉推送本身的错 */
    }
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
