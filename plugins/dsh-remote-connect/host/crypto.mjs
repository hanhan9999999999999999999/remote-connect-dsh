/**
 * dsh-remote-connect · crypto
 *
 * Password  --scrypt-->  master key K (never leaves the machine, never stored)
 * K + nonces --HKDF-->    session key SK
 * SK --HMAC--> request signatures; SK --AES-256-GCM--> every request/response body
 * SK --AES-256-GCM frames--> tar.gz streams (upload and download)
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { AppError } from './util.mjs'

const scryptAsync = promisify(scrypt)

export const KDF_DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 })
/**
 * KDF 参数的上限。握手时对端会把它的 kdf 参数报过来，本机照着算——
 * 但那是**对端说的**，不能当可信值用：scrypt 的内存≈128*N*r，
 * 一句 `{"kdf":{"N":1073741824}}` 就能让本机去申请一个不存在的体积。
 * 这里给一条硬线，和 config.mjs 里本机自设的上限保持一致。
 */
export const KDF_LIMITS = Object.freeze({
  minN: KDF_DEFAULTS.N,
  maxN: 1 << 20,
  maxR: 32,
  maxP: 16,
  /** 128 * N * r 不得超过这个体积（≈ 512 MB）。 */
  maxMemoryBytes: 512 * 1024 * 1024,
})
const PROOF_LABEL = 'dsh-link/hello/v1'
const SESSION_LABEL = 'dsh-link/session/v1'

/** Human-transferable, ambiguity-free password: 3 groups of 4 chars. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = () => alphabet[randomBytes(1)[0] % alphabet.length]
  const group = () => Array.from({ length: 4 }, pick).join('')
  return `${group()}-${group()}-${group()}`
}

export function normalizePassword(raw) {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase()
}

export function randomNonce(bytes = 16) {
  return randomBytes(bytes)
}

/**
 * 把对端报来的 kdf 参数收成一份能干活的、且有上限的参数。
 * 任何一条不合法都抛 BAD_RESPONSE（对端坏了），而不是让 scrypt 抛内部错误。
 */
export function sanitizeKdf(raw) {
  if (raw == null) return { ...KDF_DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('BAD_RESPONSE', '对端报来的 kdf 参数不是对象')
  }
  const int = (value, fallback) => (Number.isInteger(value) ? value : fallback)
  const N = int(raw.N, KDF_DEFAULTS.N)
  const r = int(raw.r, KDF_DEFAULTS.r)
  const p = int(raw.p, KDF_DEFAULTS.p)
  if (N < KDF_LIMITS.minN || N > KDF_LIMITS.maxN || (N & (N - 1)) !== 0) {
    throw new AppError('BAD_RESPONSE', `对端报来的 kdf.N 不合法：${raw.N}（需要 ${KDF_LIMITS.minN}–${KDF_LIMITS.maxN} 之间的 2 的幂）`)
  }
  if (r < 1 || r > KDF_LIMITS.maxR) {
    throw new AppError('BAD_RESPONSE', `对端报来的 kdf.r 不合法：${raw.r}（需要 1–${KDF_LIMITS.maxR}）`)
  }
  if (p < 1 || p > KDF_LIMITS.maxP) {
    throw new AppError('BAD_RESPONSE', `对端报来的 kdf.p 不合法：${raw.p}（需要 1–${KDF_LIMITS.maxP}）`)
  }
  if (128 * N * r > KDF_LIMITS.maxMemoryBytes) {
    throw new AppError('BAD_RESPONSE', `对端报来的 kdf 参数要的内存太多（N=${N} r=${r}），已拒绝`)
  }
  // keylen 只认 32：会话密钥长度不由对端决定。
  return { N, r, p, keylen: KDF_DEFAULTS.keylen }
}

/**
 * 解一个 base64 字段，并核对长度。缺字段/长度不对都报 BAD_RESPONSE，
 * 免得 `Buffer.from(undefined, 'base64')` 抛出来的 TypeError 冒到路由层变成 500。
 */
export function decodeB64Field(value, { label, min = 1, max = 1024 } = {}) {
  const name = label ?? '字段'
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('BAD_RESPONSE', `对端没有给出合法的 ${name}`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new AppError('BAD_RESPONSE', `对端给出的 ${name} 不是 base64`)
  }
  const buf = Buffer.from(value, 'base64')
  if (buf.length < min || buf.length > max) {
    throw new AppError('BAD_RESPONSE', `对端给出的 ${name} 长度不对：${buf.length} 字节（需要 ${min}–${max}）`)
  }
  return buf
}

export async function deriveMasterKey(password, salt, params = KDF_DEFAULTS) {
  const buf = await scryptAsync(normalizePassword(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  })
  return Buffer.from(buf)
}

export function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

export function hmacHex(key, data) {
  return hmac(key, data).toString('hex')
}

export function safeEqualBuf(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function deriveSessionKey(masterKey, clientNonce, serverNonce) {
  const salt = Buffer.concat([clientNonce, serverNonce])
  const info = Buffer.from(SESSION_LABEL)
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, 32))
}

export function handshakeProof(masterKey, clientNonce, serverNonce, deviceId) {
  return hmac(masterKey, `${PROOF_LABEL}|${clientNonce.toString('base64')}|${serverNonce.toString('base64')}|${deviceId}`)
}

export function sessionReadyProof(sessionKey) {
  return hmac(sessionKey, 'ready')
}

/* ------------------------------------------------------------------ */
/* Envelope encryption for JSON bodies                                 */
/* ------------------------------------------------------------------ */

export function encryptJson(key, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    e: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decryptJson(key, envelope) {
  if (!envelope || envelope.e !== 1) throw new Error('无效的加密信封')
  const iv = Buffer.from(String(envelope.iv ?? ''), 'base64')
  const tag = Buffer.from(String(envelope.tag ?? ''), 'base64')
  const ct = Buffer.from(String(envelope.ct ?? ''), 'base64')
  // 先校验形状再交给 node:crypto：否则坏信封会抛出「Invalid IV length」这类
  // 面向实现的消息，调用方也只能当成 500。
  if (iv.length !== 12) throw new Error(`加密信封的 iv 长度不对：${iv.length}（应为 12）`)
  if (tag.length !== 16) throw new Error(`加密信封的 tag 长度不对：${tag.length}（应为 16）`)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plain
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new Error('加密信封校验失败（内容被改动，或两端密钥不一致）')
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('加密信封里的内容不是合法 JSON')
  }
}

/* ------------------------------------------------------------------ */
/* Framed stream encryption                                            */
/* ------------------------------------------------------------------ */

const FRAME_MAGIC = Buffer.from('DSHF')
export const FRAME_CHUNK = 64 * 1024
/** 单帧上限：64 KB 的明文 + iv + tag 远小于这个数，超出说明对面在乱发。 */
export const MAX_FRAME = 8 * 1024 * 1024
const FRAME_MIN = 12 + 16

/**
 * Emits: [4-byte len][payload] where payload = 12B iv + ciphertext + 16B tag.
 * AAD binds the stream label and the frame index (replay/reorder protection).
 */
export function encodeFrame(key, index, chunk) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`frame|${index}`))
  const ct = Buffer.concat([cipher.update(chunk), cipher.final()])
  const payload = Buffer.concat([iv, ct, cipher.getAuthTag()])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, payload])
}

export function decodeFrame(key, index, payload) {
  if (payload.length < FRAME_MIN) throw new Error(`帧长度非法：${payload.length}（至少 ${FRAME_MIN}）`)
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ct = payload.subarray(12, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(`frame|${index}`))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new Error(`第 ${index} 帧校验失败（内容被改动，或帧顺序不对）`)
  }
}

/** Buffering decoder for a framed byte stream. */
export class FrameDecoder {
  constructor(key) {
    this.key = key
    this.buf = Buffer.alloc(0)
    this.index = 0
  }
  /** @returns {Buffer[]} decoded chunks ready to consume */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME) throw new Error(`帧过大：${len} 字节（上限 ${MAX_FRAME}）`)
      if (len < FRAME_MIN) throw new Error(`帧长度非法：${len}（至少 ${FRAME_MIN}）`)
      if (this.buf.length < 4 + len) break
      const payload = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      out.push(decodeFrame(this.key, this.index++, payload))
    }
    return out
  }
  end() {
    if (this.buf.length) throw new Error('帧流被截断')
  }
}

export { FRAME_MAGIC }
