/**
 * dsh-device-link · remembered peers
 *
 * A peer record keeps everything needed to reconnect without retyping the
 * password: host, port, the (optional) password, and the live session token.
 * The file is 0600 and lives in the plugin data directory — see SECURITY.md.
 */
import path from 'node:path'
import { readJson, rid, writeJson } from './util.mjs'
import { dataHome } from './config.mjs'

export class PeerStore {
  constructor(file = path.join(dataHome(), 'peers.json')) {
    this.file = file
    this.items = []
    this.loaded = false
  }

  async load() {
    const raw = await readJson(this.file, null)
    if (Array.isArray(raw)) this.items = raw
    this.loaded = true
    return this
  }

  async save() {
    await writeJson(this.file, this.items)
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
    const idx = this.items.findIndex(
      (p) => p.id === record.id || (p.host === record.host && p.port === record.port && p.deviceId && p.deviceId === record.deviceId),
    )
    if (idx >= 0) {
      this.items[idx] = { ...this.items[idx], ...record, id: this.items[idx].id }
    } else {
      this.items.push({ id: record.id ?? `peer_${rid(6)}`, ...record })
    }
    await this.save()
    return idx >= 0 ? this.items[idx] : this.items[this.items.length - 1]
  }

  async patch(id, patch) {
    if (!this.loaded) await this.load()
    const item = this.items.find((p) => p.id === id)
    if (!item) return null
    Object.assign(item, patch)
    await this.save()
    return item
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
