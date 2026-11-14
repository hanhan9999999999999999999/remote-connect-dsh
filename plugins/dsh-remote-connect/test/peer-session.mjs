/**
 * 会话生命周期：过期判定、401 后的失效处理、超时不被压成网络错误。
 *
 * 这三件事以前全靠「用久了就会遇到」来发现问题——会话 12 小时过期以后，
 * 进程会一直拿着作废的 token 反复撞 401，用户只能手动重连。这里用假服务把
 * 它们钉住。
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { RemotePeer, sessionUsable } from '../host/peer.mjs'

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${err?.message ?? err}`)
  }
}

/** 起一个只按脚本回答的假对端。 */
async function fakePeer(handler) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, res, body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    close: () => new Promise((r) => server.close(r)),
    peer: () =>
      new RemotePeer({
        record: { id: 'p1', host: '127.0.0.1', port, scheme: 'http', name: '假对端' },
        logger: { info() {}, warn() {}, error() {} },
        device: { id: 'dev-local', name: 'node-A', platform: 'test' },
      }),
  }
}

const liveSession = () => ({ token: 'tok', sk: Buffer.alloc(32, 7), expiresAt: Date.now() + 3_600_000 })

/* 1. 过期判定 */
await ok('sessionUsable：没有会话 / 缺字段 / 已过期 / 只剩 10 秒，都算不能用', () => {
  assert.equal(sessionUsable(null), false)
  assert.equal(sessionUsable({}), false)
  assert.equal(sessionUsable({ token: 't' }), false)
  assert.equal(sessionUsable({ token: 't', expiresAt: Date.now() - 1 }), false)
  assert.equal(sessionUsable({ token: 't', expiresAt: Date.now() + 10_000 }), false)
  assert.equal(sessionUsable({ token: 't', expiresAt: Date.now() + 60_000 }), true)
})

/* 2. 会话本身没坏时不能乱丢 */
await ok('200 响应不会动会话', async () => {
  const f = await fakePeer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, echo: req.url }))
  })
  try {
    const peer = f.peer()
    peer.session = liveSession()
    const body = await peer.requestJson('GET', '/ping', { timeoutMs: 3000 })
    assert.equal(body.ok, true)
    assert.ok(peer.session, '正常响应后会话应当还在')
  } finally {
    await f.close()
  }
})

/* 3. 401 之后必须自己把会话丢掉，下一次才会重新握手 */
await ok('401 SESSION_EXPIRED：错误照抛，但本地会话被清空', async () => {
  const f = await fakePeer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '会话已过期' } }))
  })
  try {
    const peer = f.peer()
    peer.session = liveSession()
    await assert.rejects(
      () => peer.requestJson('GET', '/ping', { timeoutMs: 3000 }),
      (err) => err.code === 'SESSION_EXPIRED',
    )
    assert.equal(peer.session, null, '作废的会话必须被丢掉，否则会一直撞 401')
  } finally {
    await f.close()
  }
})

/* 4. 超时要保持 TIMEOUT，而不是被压成 NETWORK（index.js 靠它决定提示语和状态码） */
await ok('对端不回话：错误码是 TIMEOUT，不是 NETWORK', async () => {
  const f = await fakePeer(() => {
    /* 故意不响应 */
  })
  try {
    const peer = f.peer()
    peer.session = liveSession()
    await assert.rejects(
      () => peer.requestJson('GET', '/ping', { timeoutMs: 250 }),
      (err) => err.code === 'TIMEOUT',
    )
  } finally {
    await f.close()
  }
})

/* 5. 连不上时仍然是 NETWORK，且给了人话提示 */
await ok('端口没人监听：NETWORK + 可读提示', async () => {
  const f = await fakePeer(() => {})
  const port = f.port
  await f.close()
  const peer = new RemotePeer({
    record: { id: 'p2', host: '127.0.0.1', port, scheme: 'http' },
    logger: { info() {}, warn() {}, error() {} },
    device: { id: 'dev-local', name: 'node-A', platform: 'test' },
  })
  peer.session = liveSession()
  await assert.rejects(
    () => peer.requestJson('GET', '/ping', { timeoutMs: 2000 }),
    (err) => err.code === 'NETWORK' && /端口|不可达|找不到|超时|重置/.test(err.message),
  )
})

console.log(`peer ok · ${pass} 项断言 · 会话过期 / 401 失效 / 超时保真 / 连不上（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
