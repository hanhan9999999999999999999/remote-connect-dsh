/**
 * dsh-remote-connect · 请求签名的一致性
 *
 * 这一层曾经有一个「两边各算各的」的错误：客户端把 `/progress?syncId=…` 整段算进签名，
 * 服务端只算 `url.pathname`，于是**带查询串的请求签名永远对不上**；而进度轮询把错误
 * 吞掉了（`catch { /* best-effort *\/ }`），所以现场表现是「进度条一直不动」，不是报错。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bodyDigest, signRequest, signatureBase } from '../host/sign.mjs'

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}：${err?.message ?? err}`)
  }
}

const sk = randomBytes(32)
const ts = 1794680000000
const nonce = 'abc123'
const BASE = '/dsh-link/v1'

/** 客户端怎么签（host/peer.mjs 的 #signedHeaders 走的就是这个函数） */
function clientMac(path, body = Buffer.alloc(0), isStream = false) {
  return signRequest(sk, {
    method: 'GET',
    target: `${BASE}${path}`,
    ts,
    nonce,
    digest: bodyDigest(body, isStream),
  })
}

/** 服务端怎么验（host/server.mjs 的 #authorize 走同一个 signatureBase） */
function serverMac({ pathname, search = '', body = Buffer.alloc(0), isStream = false }) {
  return signRequest(sk, {
    method: 'GET',
    target: `${pathname}${search}`,
    ts,
    nonce,
    digest: bodyDigest(body, isStream),
  })
}

ok('带查询串的请求：两边算出来一致（这就是之前的 bug）', () => {
  const mac = clientMac('/progress?syncId=s1')
  assert.equal(mac, serverMac({ pathname: `${BASE}/progress`, search: '?syncId=s1' }))
})

ok('只算 pathname 的老写法与客户端不一致（记录住这个错法）', () => {
  const mac = clientMac('/progress?syncId=s1')
  assert.notEqual(mac, serverMac({ pathname: `${BASE}/progress` }))
})

ok('改查询串就改签名（参数被替换会被发现）', () => {
  const a = clientMac('/progress?syncId=s1')
  const b = clientMac('/progress?syncId=s2')
  assert.notEqual(a, b)
})

ok('不带查询串的请求仍然对得上（对照组）', () => {
  const mac = clientMac('/status')
  assert.equal(mac, serverMac({ pathname: `${BASE}/status` }))
})

ok('路径不同 → 签名不同', () => {
  assert.notEqual(clientMac('/status'), clientMac('/statusx'))
})

ok('时间戳/nonce 变化 → 签名不同（防重放的前提）', () => {
  const a = signRequest(sk, { method: 'GET', target: '/x', ts, nonce, digest: 'd' })
  const b = signRequest(sk, { method: 'GET', target: '/x', ts: ts + 1, nonce, digest: 'd' })
  const c = signRequest(sk, { method: 'GET', target: '/x', ts, nonce: `${nonce}x`, digest: 'd' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

ok('正文摘要：流式标 stream，非流式是真正的 sha256', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(bodyDigest(body, true), 'stream')
  assert.match(bodyDigest(body, false), /^[0-9a-f]{64}$/)
  assert.notEqual(bodyDigest(body, false), bodyDigest(Buffer.from('{"a":2}'), false))
})

ok('签名里带方法：换个方法就失效', () => {
  const get = signRequest(sk, { method: 'GET', target: '/x', ts, nonce, digest: 'd' })
  const post = signRequest(sk, { method: 'POST', target: '/x', ts, nonce, digest: 'd' })
  assert.notEqual(get, post)
})

ok('拼接格式稳定（老版本客户端还能验过）', () => {
  assert.equal(signatureBase('GET', '/a?b=1', 1, 'n', 'd'), 'GET|/a?b=1|1|n|d')
})

console.log(`signature ok · ${pass} 项断言 · 查询串 / 摘要 / 方法 / 时间戳与 nonce（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
