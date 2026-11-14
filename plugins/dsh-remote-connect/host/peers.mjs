/**
 * dsh-remote-connect · remembered peers
 *
 * A peer record keeps everything needed to reconnect without retyping the
 * password: host, port, the (optional) password, and the live session token.
 * The file is 0600 and lives in the plugin data directory — see SECURITY.md.
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { readJson, rid, writeJson } from './util.mjs'
import { dataHome } from './config.mjs'

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const stamp = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : null)

/**
 * 手改过、或者被别的程序写过一次的 peers.json 不该让整个插件起不来：
 * 认不出的记录直接丢掉，字段逐个收窄。
 */
function sanitize(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const host = clip(item.host, 255).trim()
    const port = Number(item.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const id = clip(item.id, 64) || `peer_${rid(6)}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      ...item,
      id,
      name: clip(item.name, 64) || host,
      host,
      port,
      scheme: item.scheme === 'https' ? 'https' : 'http',
      deviceId: clip(item.deviceId, 64) || null,
      platform: clip(item.platform, 32),
      version: clip(item.version, 24),
      password: typeof item.password === 'string' ? item.password : null,
      token: typeof item.token === 'string' ? item.token : null,
      sk: typeof item.sk === 'string' ? item.sk : null,
      expiresAt: stamp(item.expiresAt),
      lastSeen: stamp(item.lastSeen),
      lastOkAt: stamp(item.lastOkAt),
      lastError: clip(item.lastError, 200) || null,
      autoConnect: Boolean(item.autoConnect),
    })
  }
  return out
}

export class PeerStore {
  constructor(file = path.join(dataHome(), 'peers.json')) {
    this.file = file
    this.items = []
    this.loaded = false
    this.saving = Promise.resolve()
  }

  async load() {
    const raw = await readJson(this.file, null)
    if (Array.isArray(raw)) {
      this.items = sanitize(raw)
    } else if (raw && typeof raw === 'object') {
      // 不是数组：留着不动会一直读不出来，挪到一边再从空的开始
      const backup = `${this.file}.broken-${Date.now()}`
      await fsp.rename(this.file, backup).catch(() => {})
      this.items = []
    }
    this.loaded = true
    return this
  }

  /** 串行写盘：并发的 upsert/patch 不会互相覆盖临时文件，也不会交错 rename。 */
  async save() {
    const snapshot = this.items.map((p) => ({ ...p }))
    const next = this.saving.then(() => writeJson(this.file, snapshot))
    this.saving = next.catch(() => {})
    return next
  }

  async list() {
    if (!this.loaded) await this.load()
    return this.items.map((p) => this.#publicView(p))
  }

  #publicView(p) {
    return {
      id: p.id,
      name: p.name,
      host: p.host,
      port: p.port,
      scheme: p.scheme ?? 'http',
      deviceId: p.deviceId ?? null,
      platform: p.platform ?? '',
      version: p.version ?? '',
      lastSeen: p.lastSeen ?? null,
      lastOkAt: p.lastOkAt ?? null,
      lastError: p.lastError ?? null,
      connected: Boolean(p.token && p.expiresAt > Date.now()),
      expiresAt: p.expiresAt ?? null,
      rememberPassword: Boolean(p.password),
      autoConnect: Boolean(p.autoConnect),
    }
  }

  async raw(id) {
    if (!this.loaded) await this.load()
    return this.items.find((p) => p.id === id) ?? null
  }

  async upsert(record) {
    if (!this.loaded) await this.load()
    const [clean] = sanitize([record])
    if (!clean) throw new Error('对端记录不完整：需要 host 与 1–65535 的端口')
    const idx = this.items.findIndex(
      (p) =>
        p.id === clean.id ||
        (p.host === clean.host && p.port === clean.port && (!p.deviceId || !clean.deviceId || p.deviceId === clean.deviceId)),
    )
    if (idx >= 0) {
      this.items[idx] = { ...this.items[idx], ...clean, id: this.items[idx].id }
    } else {
      this.items.push(clean)
    }
    await this.save()
    return idx >= 0 ? this.items[idx] : this.items[this.items.length - 1]
  }

  async patch(id, patch) {
    if (!this.loaded) await this.load()
    const item = this.items.find((p) => p.id === id)
    if (!item) return null
    Object.assign(item, patch)
    this.items = sanitize(this.items)
    await this.save()
    return this.items.find((p) => p.id === id) ?? null
  }

  async remove(id) {
    if (!this.loaded) await this.load()
    this.items = this.items.filter((p) => p.id !== id)
    await this.save()
  }

  async clearSession(id) {
    return this.patch(id, { token: null, sk: null, expiresAt: null })
  }
}
