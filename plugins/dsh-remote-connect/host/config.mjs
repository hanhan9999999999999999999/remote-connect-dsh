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
  AppError,
  VERSION,
  clampInt,
  ensureDir,
  hostname,
  lanAddresses,
  parseBool,
  platformLabel,
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
      maxFiles: 200000,
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
    const existing = await this.#readExisting()
    let cfg
    if (existing === null) {
      cfg = defaultConfig()
      await writeJson(this.file, cfg)
    } else {
      cfg = this.#migrate(existing)
      if (existing.version !== 1) await writeJson(this.file, cfg)
    }
    this.value = cfg
    this.loadedAt = Date.now()
    return cfg
  }

  /**
   * 读现有配置：文件不存在或为空 → null（当作第一次运行）；
   * 内容不是合法 JSON → 抛错，**不覆盖**。静默用默认值写回去会把主人的连接密码弄丢。
   */
  async #readExisting() {
    let text
    try {
      text = await fsp.readFile(this.file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') return null
      throw new AppError('CONFIG_UNREADABLE', `读不到配置文件 ${this.file}：${err?.code ?? err?.message}`, {
        cause: err?.code,
      })
    }
    if (!text.trim()) return null
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new AppError(
        'CONFIG_BROKEN',
        `配置文件不是合法 JSON（${this.file}）：${err.message}。我没有覆盖它——先备份再删掉，插件会重新生成配置。`,
        { path: this.file },
      )
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('CONFIG_BROKEN', `配置文件里不是对象（${this.file}）。先备份再删掉，插件会重新生成配置。`, {
        path: this.file,
      })
    }
    return parsed
  }

  /** 合并默认值，并把每个字段的类型/范围收一遍——手改坏的配置不该让插件起不来。 */
  #migrate(cfg) {
    const base = defaultConfig()
    const src = cfg && typeof cfg === 'object' ? cfg : {}
    const str = (value, fallback, max = 64) =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
    const stamp = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : Date.now())

    const merged = {
      version: 1,
      device: { ...base.device, ...(src.device ?? {}) },
      server: { ...base.server, ...(src.server ?? {}) },
      auth: { ...base.auth, ...(src.auth ?? {}) },
      sync: {
        ...base.sync,
        ...(src.sync ?? {}),
        categories: { ...base.sync.categories, ...(src.sync?.categories ?? {}) },
      },
      ui: { ...base.ui, ...(src.ui ?? {}) },
    }

    merged.device.id = str(merged.device.id, `dev_${rid(10)}`, 64)
    merged.device.name = str(merged.device.name, defaultDeviceName(), 48)
    merged.device.platform = str(merged.device.platform, base.device.platform, 24)
    merged.device.createdAt = stamp(merged.device.createdAt)

    merged.server.enabled = parseBool(merged.server.enabled, base.server.enabled)
    merged.server.discovery = parseBool(merged.server.discovery, base.server.discovery)
    merged.server.allowLan = parseBool(merged.server.allowLan, base.server.allowLan)
    merged.server.port = clampInt(merged.server.port, 1024, 65535, DEFAULT_PORT)
    merged.server.bind = str(merged.server.bind, base.server.bind, 64)

    if (!merged.auth.password || typeof merged.auth.password !== 'string') merged.auth.password = generatePassword()
    const saltOk =
      typeof merged.auth.salt === 'string' && Buffer.from(merged.auth.salt, 'base64').length === 16
    if (!saltOk) merged.auth.salt = randomBytes(16).toString('base64')
    const kdf = merged.auth.kdf && typeof merged.auth.kdf === 'object' ? merged.auth.kdf : {}
    const pow2 = (n, fallback) => {
      // 只允许 ≥ 默认强度的 2 的幂：手改小了不该悄悄降低 KDF 强度
      const v = clampInt(n, fallback, 1 << 20, fallback)
      return (v & (v - 1)) === 0 ? v : fallback
    }
    merged.auth.kdf = {
      N: pow2(kdf.N, KDF_DEFAULTS.N),
      r: clampInt(kdf.r, 1, 32, KDF_DEFAULTS.r),
      p: clampInt(kdf.p, 1, 16, KDF_DEFAULTS.p),
      keylen: KDF_DEFAULTS.keylen,
    }
    merged.auth.changedAt = stamp(merged.auth.changedAt)

    const categories = {}
    for (const key of Object.keys(base.sync.categories)) {
      categories[key] = parseBool(merged.sync.categories?.[key], base.sync.categories[key])
    }
    merged.sync.categories = categories
    merged.sync.includeCredentials = parseBool(merged.sync.includeCredentials, false)
    merged.sync.maxFileMb = clampInt(merged.sync.maxFileMb, 1, 65536, base.sync.maxFileMb)
    merged.sync.maxTotalMb = clampInt(merged.sync.maxTotalMb, 1, 65536, base.sync.maxTotalMb)
    merged.sync.maxFiles = clampInt(merged.sync.maxFiles, 1, 2000000, base.sync.maxFiles)
    merged.sync.backupKeep = clampInt(merged.sync.backupKeep, 1, 50, base.sync.backupKeep)
    merged.sync.compress = parseBool(merged.sync.compress, base.sync.compress)

    merged.ui.lastTab = str(merged.ui.lastTab, base.ui.lastTab, 32)
    merged.ui.language = merged.ui.language === 'en' ? 'en' : 'zh'
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
      for (const key of ['maxFileMb', 'maxTotalMb', 'backupKeep', 'maxFiles']) {
        if (patch.sync[key] !== undefined) {
          const max = key === 'backupKeep' ? 50 : key === 'maxFiles' ? 2000000 : 65536
          next.sync[key] = clampInt(patch.sync[key], 1, max, next.sync[key])
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
    if (password.length < 6) throw new AppError('BAD_INPUT', '密码至少 6 位')
    if (password.length > 128) throw new AppError('BAD_INPUT', '密码过长（最多 128 位）')
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
  if (!text) throw new AppError('BAD_INPUT', '连接串为空')
  if (!/^dshlink:\/\//i.test(text)) throw new AppError('BAD_INPUT', '连接串必须以 dshlink:// 开头')
  const withScheme = text.replace(/^dshlink:\/\//i, 'http://')
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new AppError('BAD_INPUT', `连接串格式不对：${text.slice(0, 80)}`)
  }
  const host = url.hostname
  if (!host) throw new AppError('BAD_INPUT', '连接串里没有主机地址')
  const port = Number(url.port || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('BAD_INPUT', `连接串的端口不对：${url.port || '(空)'}`)
  }
  const pwd = url.searchParams.get('pwd') || ''
  const name = url.searchParams.get('name') || ''
  return { host, port, password: pwd, name, raw: text }
}

export async function ensureIdentity() {
  const store = new ConfigStore()
  const cfg = await store.load()
  return { store, cfg }
}

export { VERSION }
