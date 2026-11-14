/**
 * 连接守卫：认证之外、跟安全相关的一小撮纯逻辑。
 *
 * 这些东西以前直接住在 server.mjs 里（会话、挑战、nonce、失败计数混成一团），
 * 但它们其实不需要 HTTP、不需要 store，只吃「一个 IP」和「一个时间」。
 * 拆出来之后可以单独断言：第 9 次失败不锁、第 10 次锁、锁满 10 分钟自己解开。
 */

/** 同一 IP 连续失败多少次开始锁 */
export const LOCK_AFTER = 10
/** 锁多久 */
export const LOCK_MS = 10 * 60 * 1000
/** 签名里的 nonce 记多久（窗口内同一个 nonce 只能出现一次） */
export const NONCE_WINDOW_MS = 10 * 60 * 1000
/** 重放表最多记多少条（窗口内再多就挤掉最老的） */
export const NONCE_MAX = 20000
/** 重放表多久清一次过期的（不是每个请求都清） */
export const NONCE_PRUNE_EVERY_MS = 1000
/** 失败计数最多记多少个来源（防止有人换着 IP 灌） */
export const FAILURE_MAX = 10000
/** 签名允许的时间偏差 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

/** 取请求来源 IP：去掉 IPv4-mapped 前缀，拿不到就是空串 */
export function clientIp(req) {
  const raw = req?.socket?.remoteAddress ?? ''
  if (raw.startsWith('::ffff:')) return raw.slice(7)
  return raw
}

/**
 * 对端自报的设备信息，只收四个字段并截断长度。
 * 缺 id 视为非法（没有 id 就没法认人）。
 */
export function sanitizeDevice(device) {
  if (!device || typeof device !== 'object') return null
  const id = typeof device.id === 'string' ? device.id.slice(0, 64) : ''
  if (!id) return null
  return {
    id,
    name: String(device.name ?? '未命名设备').slice(0, 48),
    platform: String(device.platform ?? '').slice(0, 64),
    version: String(device.version ?? '').slice(0, 24),
  }
}

/**
 * 失败计数与锁定。
 *
 * 语义（改动前就存在，这里只是搬了个家）：
 * - 没记录 → 不锁；
 * - 记满了 `lockedUntil` 且没到期 → 锁；
 * - 到期了 → 顺手丢掉这条记录，不锁。
 *
 * 以前这张表没有上限：谁都能换着来源地址来试密码，每个地址留一条记录永不清理，
 * 一个扫描器扫一晚上就能把内存吃掉。现在记满 `max` 条时先清过期的，
 * 还不够就挤掉最老的（先挤没被锁的，正在锁着的尽量留着）。
 */
export class FailureTracker {
  constructor({ lockAfter = LOCK_AFTER, lockMs = LOCK_MS, max = FAILURE_MAX } = {}) {
    this.lockAfter = lockAfter
    this.lockMs = lockMs
    this.max = Number.isInteger(max) && max > 0 ? max : FAILURE_MAX
    this.entries = new Map()
    this.prunedAt = 0
    this.trimWarned = false
  }

  get size() {
    return this.entries.size
  }

  blocked(ip, now = Date.now()) {
    const f = this.entries.get(ip)
    if (!f) return false
    if (f.lockedUntil && f.lockedUntil > now) return true
    if (f.lockedUntil && f.lockedUntil <= now) {
      this.entries.delete(ip)
      return false
    }
    return false
  }

  /**
   * 清掉该忘掉的记录：正在锁着的等它到期，没锁的按「最后一次失败」算，
   * 超过 `lockMs` 就不再记账（否则一年里零散失败十次也会被锁）。
   */
  #pruneExpired(now) {
    for (const [ip, f] of this.entries) {
      const stale = f.lockedUntil ? f.lockedUntil <= now : now - (f.lastFault ?? 0) > this.lockMs
      if (stale) this.entries.delete(ip)
    }
  }

  /** 表满了：先清该忘的，再按「没锁的先走、老的后走」挤到上限以内 */
  #trim(now) {
    if (this.entries.size <= this.max) return
    this.#pruneExpired(now)
    if (this.entries.size <= this.max) return
    for (const [ip, f] of this.entries) {
      if (this.entries.size <= this.max) return
      if (!f.lockedUntil || f.lockedUntil <= now) this.entries.delete(ip)
    }
    for (const ip of this.entries.keys()) {
      if (this.entries.size <= this.max) return
      this.entries.delete(ip)
    }
  }

  /** 记一次失败；返回是否已经进入锁定状态（方便调用方决定要不要写日志） */
  register(ip, { now = Date.now(), logger } = {}) {
    const f = this.entries.get(ip) ?? { count: 0, lockedUntil: 0, lastFault: 0 }
    f.count += 1
    f.lastFault = now
    if (f.count >= this.lockAfter) {
      f.lockedUntil = now + this.lockMs
      logger?.warn?.('auth', `${ip} 连续失败 ${f.count} 次，锁定 ${Math.round(this.lockMs / 60000)} 分钟`)
    } else {
      f.lockedUntil = 0
    }
    this.entries.set(ip, f)
    if (this.entries.size > this.max) {
      const before = this.entries.size
      this.#trim(now)
      if (this.entries.size < before && !this.trimWarned) {
        this.trimWarned = true
        logger?.warn?.('auth', `失败来源已超过 ${this.max} 个，开始挤掉最老的记录`)
      }
    }
    return Boolean(f.lockedUntil)
  }

  /** 认证成功即清零 */
  clear(ip) {
    this.entries.delete(ip)
  }
}

/**
 * 重放表：窗口内同一个 nonce 只认一次。
 *
 * 以前它是 server.mjs 里的一个裸 Map，只在「超过 5000 条」时清一次过期的——
 * 可要是十分钟内真来了五千多个不同 nonce（一个已经连上的对端就能做到），
 * 那次清理一条都删不掉，于是**每个请求都要把整张表扫一遍**，表还继续涨。
 * 现在：过期清理按时间摊销（最多每秒一次），并且有硬上限，
 * 到顶就挤掉最老的——代价是「十秒内来两万个请求」时最老的那批不再防重放，
 * 换来的是内存不会被人灌爆。
 */
export class NonceStore {
  constructor({ max = NONCE_MAX, windowMs = NONCE_WINDOW_MS, pruneEveryMs = NONCE_PRUNE_EVERY_MS } = {}) {
    this.max = Number.isInteger(max) && max > 0 ? max : NONCE_MAX
    this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : NONCE_WINDOW_MS
    this.pruneEveryMs = Number.isFinite(pruneEveryMs) && pruneEveryMs >= 0 ? pruneEveryMs : NONCE_PRUNE_EVERY_MS
    this.map = new Map()
    this.prunedAt = 0
    this.evicted = 0
  }

  get size() {
    return this.map.size
  }

  /** 清掉过了窗口的记录（时间摊销，不每个请求都做） */
  prune(now = Date.now(), { force = false } = {}) {
    if (!force && now - this.prunedAt < this.pruneEveryMs) return 0
    this.prunedAt = now
    let removed = 0
    for (const [k, ts] of this.map) {
      if (now - ts > this.windowMs) {
        this.map.delete(k)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 判定并登记：`'ok'` 表示这次可以用，`'replay'` 表示窗口内见过。
   * 表满时挤掉最老的一条（Map 按插入顺序遍历，时间单调，第一条就是最老的）。
   */
  take(key, now = Date.now()) {
    this.prune(now)
    if (this.map.has(key)) return 'replay'
    this.map.set(key, now)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
      this.evicted += 1
    }
    return 'ok'
  }
}
