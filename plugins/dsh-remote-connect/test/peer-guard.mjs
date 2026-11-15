#!/usr/bin/env node
/**
 * `requestJson()` 的前置条件。
 *
 * 这个方法要用会话密钥加密请求体，可它以前不检查「有没有会话」：没连上时
 * `this.session.sk` 直接抛 TypeError，冒到路由层就是 500「服务端坏了」，
 * 而真实原因是「还没连上」。同理，payload 里塞了循环引用或 BigInt 时
 * JSON.stringify 抛 TypeError，也变成 500。
 *
 * 用法：node test/peer-guard.mjs [host/peer.mjs 路径]
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
void here
const peerUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/peer.mjs', import.meta.url).href
const { RemotePeer } = await import(peerUrl)

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    console.log(`  PASS ${label}`)
    pass += 1
  } catch (err) {
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(err?.message ?? err).split('\n')[0]}`)
    fail += 1
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

function makePeer(port) {
  return new RemotePeer({
    record: { id: 'p1', name: 'fixture', host: '127.0.0.1', port, scheme: 'http' },
  })
}

const port = await freePort()

await ok('没有会话时请求 JSON 直接报「还没连上」，不是 TypeError', async () => {
  const peer = makePeer(port)
  const err = await peer.requestJson('GET', '/ping', { timeoutMs: 2000 }).then(
    () => null,
    (e) => e
  )
  assert.ok(err, '没有会话时居然成功了')
  assert.equal(err.code, 'NOT_CONNECTED', `实际 ${err.code}: ${err.message}`)
  assert.ok(!/sk|undefined|null/i.test(err.message), `消息里带着内部细节：${err.message}`)
})

await ok('probe() 把「没连上」如实报出来，而不是崩', async () => {
  const peer = makePeer(port)
  const r = await peer.probe()
  assert.equal(r.ok, false, '没连上却报成功')
  assert.ok(String(r.error).includes('NOT_CONNECTED'), `实际 ${r.error}`)
})

await ok('带请求体的 POST 在没会话时也报「还没连上」', async () => {
  const peer = makePeer(port)
  const err = await peer
    .requestJson('POST', '/inventory', { payload: { cats: ['skills'] }, timeoutMs: 2000 })
    .then(() => null, (e) => e)
  assert.ok(err, '没有会话时带体的请求居然成功了')
  assert.equal(err.code, 'NOT_CONNECTED', `实际 ${err.code}: ${err.message}`)
})

await ok('内容没法序列化时报 BAD_INPUT，且一个字节都没发出去', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits += 1
    req.resume()
    res.writeHead(200).end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port2 = srv.address().port
  const peer = makePeer(port2)
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 7), expiresAt: Date.now() + 3600_000 }
  const circular = { name: 'x' }
  circular.self = circular
  const err = await peer
    .requestJson('POST', '/inventory', { payload: circular, timeoutMs: 2000 })
    .then(() => null, (e) => e)
  assert.ok(err, '循环引用居然发出去了')
  assert.equal(err.code, 'BAD_INPUT', `实际 ${err.code}: ${err.message}`)
  assert.equal(hits, 0, `不该有请求发到对端（收到 ${hits} 次）`)
  await new Promise((r) => srv.close(r))
})

console.log(`peer-guard ok · 4 项断言 · 没会话 / 探测如实报 / 带体请求 / 序列化失败（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
