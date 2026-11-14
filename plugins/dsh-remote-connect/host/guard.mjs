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
 */
export class FailureTracker {
  constructor({ lockAfter = LOCK_AFTER, lockMs = LOCK_MS } = {}) {
    this.lockAfter = lockAfter
    this.lockMs = lockMs
    this.entries = new Map()
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

  /** 记一次失败；返回是否已经进入锁定状态（方便调用方决定要不要写日志） */
  register(ip, { now = Date.now(), logger } = {}) {
    const f = this.entries.get(ip) ?? { count: 0, lockedUntil: 0 }
    f.count += 1
    if (f.count >= this.lockAfter) {
      f.lockedUntil = now + this.lockMs
      logger?.warn?.('auth', `${ip} 连续失败 ${f.count} 次，锁定 ${Math.round(this.lockMs / 60000)} 分钟`)
    } else {
      f.lockedUntil = 0
    }
    this.entries.set(ip, f)
    return Boolean(f.lockedUntil)
  }

  /** 认证成功即清零 */
  clear(ip) {
    this.entries.delete(ip)
  }
}
