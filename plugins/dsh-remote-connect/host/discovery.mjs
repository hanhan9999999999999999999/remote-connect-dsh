/**
 * dsh-remote-connect · LAN discovery (UDP broadcast + unicast probe)
 */
import dgram from 'node:dgram'
import os from 'node:os'
import { lanAddresses, platformLabel } from './util.mjs'

const PROBE = JSON.stringify({ m: 'dsh-link/discover', v: 1 })

/**
 * 一轮探测的边界。局域网里谁都能往这个端口发包，所以「收多少」「探几台」「等多久」
 * 都得有上限——不然一次扫描能被灌到内存见底，或者被一个非法参数拖成永远不返回。
 */
export const SCAN_LIMITS = {
  maxPeers: 256,
  maxTargets: 64,
  minTimeoutMs: 200,
  maxTimeoutMs: 15000,
}

/** 把调用方给的等待时间收进合法区间；不是有限数就用默认值。 */
export function scanWindow(ms, fallback = 1500) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), SCAN_LIMITS.minTimeoutMs), SCAN_LIMITS.maxTimeoutMs)
}

/** 只留下看起来像 IPv4 字面量的地址，去重并封顶——extraHosts 也是外部输入。 */
export function sanitizeTargets(list, max = SCAN_LIMITS.maxTargets) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue
    const host = raw.trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue
    if (host.split('.').some((part) => Number(part) > 255)) continue
    if (seen.has(host)) continue
    seen.add(host)
    out.push(host)
    if (out.length >= max) break
  }
  return out
}

export function broadcastOf({ address, netmask }) {
  if (!netmask) return null
  const a = address.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  if (a.length !== 4 || m.length !== 4) return null
  return a.map((n, i) => (n | (~m[i] & 255)) & 255).join('.')
}

/** 截断到 length 个字符；非字符串一律当空。 */
function clip(value, length) {
  return typeof value === 'string' ? value.slice(0, length) : ''
}

/**
 * 把一条 `dsh-link/here` 回复变成对端条目；不像话的返回 null。
 * 局域网里谁都能往这个端口发包，所以字段一律当成不可信输入来做形状校验。
 */
export function sanitizePeerReply(data, rinfo) {
  if (!data || data.m !== 'dsh-link/here' || data.v !== 1) return null
  const id = clip(data.id, 64)
  if (!id) return null
  const port = Number(data.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = typeof rinfo?.address === 'string' ? rinfo.address : ''
  if (!host) return null
  return {
    id,
    name: clip(data.name, 64) || '未命名设备',
    host,
    port,
    platform: clip(data.platform, 32) || undefined,
    version: clip(data.version, 24) || undefined,
    seenAt: Date.now(),
  }
}

export function lanBroadcasts() {
  const out = new Set(['255.255.255.255'])
  for (const item of Object.values(os.networkInterfaces())) {
    for (const addr of item ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const b = broadcastOf(addr)
      if (b) out.add(b)
    }
  }
  return [...out]
}

export class Discovery {
  constructor({ port, logger, getInfo, enabled = true }) {
    this.port = port
    this.logger = logger
    this.getInfo = getInfo
    this.enabled = enabled
    this.socket = null
    this.startedAt = 0
  }

  async start() {
    if (!this.enabled || this.socket) return false
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (err) => {
      this.logger?.warn('discovery', `UDP 错误：${err.message}`)
    })
    // 套接字没了就得把 this.socket 放开，否则 start() 永远认为「已经在跑」，
    // 端口被别的东西抢走之后局域网发现就再也不会自己恢复。
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.logger?.warn('discovery', `局域网发现的 UDP ${this.port} 已关闭，可以重新开启`)
      }
    })
    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'))
        if (data?.m !== 'dsh-link/discover' || data.v !== 1) return
        const info = this.getInfo?.() ?? {}
        const reply = Buffer.from(
          JSON.stringify({
            m: 'dsh-link/here',
            v: 1,
            id: info.id,
            name: info.name,
            port: this.port,
            platform: info.platform ?? platformLabel(),
            version: info.version,
          }),
        )
        socket.send(reply, rinfo.port, rinfo.address, () => {})
      } catch {
        /* ignore malformed probes */
      }
    })
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (this.socket === socket) this.socket = null
        reject(err)
      }
      socket.once('error', onError)
      socket.bind(this.port, () => {
        socket.off('error', onError)
        try {
          socket.setBroadcast(true)
        } catch {
          /* some platforms refuse; unicast still works */
        }
        resolve()
      })
    })
    this.startedAt = Date.now()
    this.logger?.info('discovery', `局域网发现已监听 UDP ${this.port}`)
    return true
  }

  async stop() {
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    await new Promise((resolve) => socket.close(resolve))
  }

  /** Probe the LAN and collect responders for `timeoutMs`. */
  async scan({ timeoutMs = 1500, extraHosts = [] } = {}) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()
    const window = scanWindow(timeoutMs)
    let overflowed = 0
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), window)
      socket.on('message', (msg, rinfo) => {
        try {
          const peer = sanitizePeerReply(JSON.parse(msg.toString('utf8')), rinfo)
          if (!peer) return
          const key = `${peer.id}@${rinfo.address}:${peer.port}`
          if (!found.has(key) && found.size >= SCAN_LIMITS.maxPeers) {
            overflowed += 1
            return
          }
          found.set(key, peer)
        } catch {
          /* ignore */
        }
      })
      socket.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
      const close = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.once('close', close)
    })
    let sweep = null
    let closed = false
    try {
      await new Promise((resolve, reject) => {
        socket.bind(() => resolve())
        socket.once('error', reject)
      })
      socket.setBroadcast(true)
      const payload = Buffer.from(PROBE)
      // extraHosts 是调用方给的，也是外部输入：只认 IPv4 字面量、去重、封顶
      const targets = [...new Set([...lanBroadcasts(), ...sanitizeTargets(extraHosts)])]
      const sendTo = (host) =>
        new Promise((resolve) => {
          if (closed) return resolve()
          try {
            socket.send(payload, this.port, host, () => resolve())
          } catch {
            /* 广播地址不合法时 send 会同步抛，不能让它打断整轮探测 */
            resolve()
          }
        })
      for (const host of targets) await sendTo(host)
      // A second sweep catches sleepy Wi-Fi devices
      sweep = setTimeout(() => {
        for (const host of targets) sendTo(host)
      }, Math.min(450, Math.floor(window / 2)))
      sweep.unref?.()
      await done
    } finally {
      closed = true
      if (sweep) clearTimeout(sweep)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
    if (overflowed > 0) {
      this.logger?.warn(
        'discovery',
        `这一轮探测回过 ${found.size} 台设备，另有 ${overflowed} 条回复超出上限（${SCAN_LIMITS.maxPeers}）被丢掉`,
      )
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function selfLanAddresses() {
  return lanAddresses()
}
