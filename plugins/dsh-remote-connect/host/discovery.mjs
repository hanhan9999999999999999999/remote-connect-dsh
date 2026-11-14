/**
 * dsh-remote-connect · LAN discovery (UDP broadcast + unicast probe)
 */
import dgram from 'node:dgram'
import os from 'node:os'
import { lanAddresses, platformLabel } from './util.mjs'

const PROBE = JSON.stringify({ m: 'dsh-link/discover', v: 1 })

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
      const onError = (err) => reject(err)
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
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs)
      socket.on('message', (msg, rinfo) => {
        try {
          const peer = sanitizePeerReply(JSON.parse(msg.toString('utf8')), rinfo)
          if (!peer) return
          found.set(`${peer.id}@${rinfo.address}:${peer.port}`, peer)
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
    try {
      await new Promise((resolve, reject) => {
        socket.bind(() => resolve())
        socket.once('error', reject)
      })
      socket.setBroadcast(true)
      const payload = Buffer.from(PROBE)
      const targets = [...new Set([...lanBroadcasts(), ...extraHosts])]
      const sendTo = (host) =>
        new Promise((resolve) => {
          try {
            socket.send(payload, this.port, host, () => resolve())
          } catch {
            /* 广播地址不合法时 send 会同步抛，不能让它打断整轮探测 */
            resolve()
          }
        })
      for (const host of targets) await sendTo(host)
      // A second sweep catches sleepy Wi-Fi devices
      setTimeout(() => {
        for (const host of targets) sendTo(host)
      }, 450).unref?.()
      await done
    } finally {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function selfLanAddresses() {
  return lanAddresses()
}
