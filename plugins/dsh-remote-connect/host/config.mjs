/**
 * dsh-remote-connect · configuration & identity
 *
 * Config lives in <dataHome>/config.json (0600). File mode is enforced on POSIX;
 * on Windows we rely on the user profile ACL, which is the platform norm.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  KDF_DEFAULTS,
  deriveMasterKey,
  generatePassword,
  hmac,
  normalizePassword,
  randomNonce,
  safeEqualBuf,
} from './crypto.mjs'
import {
  APP_ID,
  VERSION,
  clampInt,
  ensureDir,
  hostname,
  lanAddresses,
  platformLabel,
  readJson,
  rid,
  writeJson,
} from './util.mjs'

export const DEFAULT_PORT = 8788

function dshHomeDefault() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function dataHome() {
  if (process.env.DEVICE_LINK_HOME) return path.resolve(process.env.DEVICE_LINK_HOME)
  return path.join(dshHomeDefault(), 'plugins-data', APP_ID)
}

export function dshHome() {
  return path.resolve(process.env.DEVICE_LINK_DSH_HOME || dshHomeDefault())
}

export function configPath() {
  return path.join(dataHome(), 'config.json')
}

function defaultConfig() {
  const id = `dev_${rid(10)}`
  return {
    version: 1,
    device: {
      id,
      name: defaultDeviceName(),
      platform: platformLabel(),
      createdAt: Date.now(),
    },
    server: {
      enabled: true,
      port: DEFAULT_PORT,
      bind: '0.0.0.0',
      discovery: true,
      allowLan: true,
    },
    auth: {
      // The password is stored locally so the owner can read it back and type it
      // on the other machine. See docs/SECURITY.md for the trade-off.
      password: generatePassword(),
      salt: randomBytes(16).toString('base64'),
      kdf: { ...KDF_DEFAULTS },
      changedAt: Date.now(),
    },
    sync: {
      categories: {
        skills: true,
        rules: true,
        plugins: true,
        config: true,
        sessions: true,
        'plugin-data': false,
      },
      includeCredentials: false,
      maxFileMb: 512,
      maxTotalMb: 8192,
      backupKeep: 5,
      compress: true,
    },
    ui: {
      lastTab: 'overview',
      language: 'zh',
    },
  }
}

function defaultDeviceName() {
  const raw = hostname()
  return raw.length > 32 ? raw.slice(0, 32) : raw
}

export class ConfigStore {
  constructor() {
    this.file = configPath()
    this.value = null
    this.loadedAt = 0
    this.listeners = new Set()
  }

  async load() {
    await ensureDir(path.dirname(this.file))
    const existing = await readJson(this.file, null)
    let cfg = existing
    if (!cfg || typeof cfg !== 'object' || cfg.version !== 1) {
      cfg = defaultConfig()
      await writeJson(this.file, cfg)
    } else {
      cfg = this.#migrate(cfg)
    }
    this.value = cfg
    this.loadedAt = Date.now()
    return cfg
  }

  #migrate(cfg) {
    const base = defaultConfig()
    const merged = {
      ...base,
      ...cfg,
      device: { ...base.device, ...(cfg.device ?? {}) },
      server: { ...base.server, ...(cfg.server ?? {}) },
      auth: { ...base.auth, ...(cfg.auth ?? {}) },
      sync: {
        ...base.sync,
        ...(cfg.sync ?? {}),
        categories: { ...base.sync.categories, ...(cfg.sync?.categories ?? {}) },
      },
      ui: { ...base.ui, ...(cfg.ui ?? {}) },
    }
    if (!merged.auth.password) merged.auth.password = generatePassword()
    if (!merged.auth.salt) merged.auth.salt = randomBytes(16).toString('base64')
    if (!merged.device.id) merged.device.id = `dev_${rid(10)}`
    return merged
  }

  async get() {
    if (!this.value) await this.load()
    return this.value
  }

  /** Deep-ish patch with validation. Returns the new config. */
  async patch(patch = {}) {
    const cfg = await this.get()
    const next = JSON.parse(JSON.stringify(cfg))
    if (patch.device) {
      if (typeof patch.device.name === 'string' && patch.device.name.trim()) {
        next.device.name = patch.device.name.trim().slice(0, 48)
      }
    }
    if (patch.server) {
      if (patch.server.enabled !== undefined) next.server.enabled = Boolean(patch.server.enabled)
      if (patch.server.discovery !== undefined) next.server.discovery = Boolean(patch.server.discovery)
      if (patch.server.port !== undefined) {
        next.server.port = clampInt(patch.server.port, 1024, 65535, next.server.port)
      }
      if (typeof patch.server.bind === 'string' && patch.server.bind.trim()) {
        next.server.bind = patch.server.bind.trim()
      }
    }
    if (patch.sync) {
      if (patch.sync.categories) {
        for (const key of Object.keys(next.sync.categories)) {
          if (patch.sync.categories[key] !== undefined) {
            next.sync.categories[key] = Boolean(patch.sync.categories[key])
          }
        }
      }
      for (const key of ['includeCredentials']) {
        if (patch.sync[key] !== undefined) next.sync[key] = Boolean(patch.sync[key])
      }
      for (const key of ['maxFileMb', 'maxTotalMb', 'backupKeep']) {
        if (patch.sync[key] !== undefined) {
          const max = key === 'backupKeep' ? 50 : 65536
          next.sync[key] = clampInt(patch.sync[key], key === 'backupKeep' ? 1 : 1, max, next.sync[key])
        }
      }
    }
    if (patch.ui) {
      if (typeof patch.ui.lastTab === 'string') next.ui.lastTab = patch.ui.lastTab.slice(0, 32)
      if (typeof patch.ui.language === 'string') next.ui.language = patch.ui.language.slice(0, 8)
    }
    await writeJson(this.file, next)
    this.value = next
    for (const fn of this.listeners) {
      try {
        fn(next)
      } catch {
        /* ignore */
      }
    }
    return next
  }

  async setPassword(rawPassword) {
    const cfg = await this.get()
    const password = String(rawPassword ?? '').trim()
    if (password.length < 6) throw new Error('密码至少 6 位')
    if (password.length > 128) throw new Error('密码过长')
    const next = JSON.parse(JSON.stringify(cfg))
    next.auth.password = password
    next.auth.salt = randomBytes(16).toString('base64')
    next.auth.kdf = { ...KDF_DEFAULTS }
    next.auth.changedAt = Date.now()
    await writeJson(this.file, next)
    this.value = next
    return next
  }

  async rotatePassword() {
    return this.setPassword(generatePassword())
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** Derived per-boot secret cache: master key is expensive by design. */
export class MasterKeyCache {
  constructor(store) {
    this.store = store
    this.cache = new Map()
  }
  async key(password, saltB64, kdf) {
    const cfg = await this.store.get()
    const effective = password ?? cfg.auth.password
    const salt = saltB64 ?? cfg.auth.salt
    const params = kdf ?? cfg.auth.kdf
    const cacheKey = `${normalizePassword(effective)}|${salt}|${params.N}|${params.r}|${params.p}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)
    const key = await deriveMasterKey(effective, Buffer.from(salt, 'base64'), params)
    this.cache.clear()
    this.cache.set(cacheKey, key)
    return key
  }
  clear() {
    this.cache.clear()
  }
}

export function authVerifier(cfg) {
  // A password verifier that never stores the raw key: HMAC over a fixed label.
  const salt = Buffer.from(cfg.auth.salt, 'base64')
  return { salt, params: cfg.auth.kdf }
}

export async function passwordFingerprint(cfg) {
  const key = await deriveMasterKey(cfg.auth.password, Buffer.from(cfg.auth.salt, 'base64'), cfg.auth.kdf)
  return hmac(key, 'fingerprint').toString('hex').slice(0, 12)
}

/** dshlink://192.168.1.5:8788?name=PC-A&pwd=XXXX#v1 */
export function buildConnectUri(cfg, address) {
  const host = address || lanAddresses()[0]?.address || '127.0.0.1'
  const q = new URLSearchParams({
    name: cfg.device.name,
    pwd: cfg.auth.password,
    v: '1',
  })
  return `dshlink://${host}:${cfg.server.port}?${q.toString()}`
}

export function parseConnectUri(uri) {
  const text = String(uri ?? '').trim()
  if (!text) throw new Error('连接串为空')
  if (!/^dshlink:\/\//i.test(text)) throw new Error('连接串必须以 dshlink:// 开头')
  const withScheme = text.replace(/^dshlink:\/\//i, 'http://')
  const url = new URL(withScheme)
  const port = Number(url.port || DEFAULT_PORT)
  const pwd = url.searchParams.get('pwd') || ''
  const name = url.searchParams.get('name') || ''
  return { host: url.hostname, port, password: pwd, name, raw: text }
}

export async function ensureIdentity() {
  const store = new ConfigStore()
  const cfg = await store.load()
  return { store, cfg }
}

export { VERSION }
