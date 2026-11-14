/**
 * dsh-remote-connect · 请求签名
 *
 * 签名覆盖：方法 | 目标（路径 + 查询串）| 时间戳 | nonce | 正文摘要（或 'stream'）
 *
 * 这里抽成一个模块，是为了让「签的一侧」和「验的一侧」用同一个函数拼字符串——
 * 以前客户端把 `/progress?syncId=…` 整段算进去，服务端只算 `url.pathname`，
 * 于是带查询串的请求签名永远对不上，而调用方又把错误吞了（进度轮询一直 401）。
 */
import { createHash } from 'node:crypto'
import { hmacHex } from './crypto.mjs'

export function sha256(buf) {
  return createHash('sha256').update(buf ?? Buffer.alloc(0)).digest('hex')
}

/** 正文摘要：流式上传时正文不算在内（帧层自带认证与序号） */
export function bodyDigest(body, isStream) {
  return isStream ? 'stream' : sha256(body)
}

/**
 * @param {string} method  HTTP 方法
 * @param {string} target  路径 + 查询串（例如 `/dsh-link/v1/progress?syncId=s1`）
 */
export function signatureBase(method, target, ts, nonce, digest) {
  return `${method}|${target}|${ts}|${nonce}|${digest}`
}

export function signRequest(sk, { method, target, ts, nonce, digest }) {
  return hmacHex(sk, signatureBase(method, target, ts, nonce, digest))
}
