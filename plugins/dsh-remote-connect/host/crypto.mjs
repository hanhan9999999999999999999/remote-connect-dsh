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

const scryptAsync = promisify(scrypt)

export const KDF_DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 })
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
  const iv = Buffer.from(envelope.iv, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  const ct = Buffer.from(envelope.ct, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

/* ------------------------------------------------------------------ */
/* Framed stream encryption                                            */
/* ------------------------------------------------------------------ */

const FRAME_MAGIC = Buffer.from('DSHF')
export const FRAME_CHUNK = 64 * 1024

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
  if (payload.length < 28) throw new Error('帧长度非法')
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ct = payload.subarray(12, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(`frame|${index}`))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
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
      if (len > 8 * 1024 * 1024) throw new Error('帧过大')
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
