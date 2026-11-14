#!/usr/bin/env node
// 重放表与失败计数都不能被人灌爆：两者都要有硬上限，挤掉旧记录时不能把正在锁着的人放进来。
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-guard-limits-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const modUrl = process.argv[2]
  ? new URL(`file://${path.resolve(process.argv[2]).replace(/\\/g, '/')}`).href
  : new URL('../host/guard.mjs', import.meta.url).href
const guardMod = await import(modUrl)
const NonceStore = guardMod.NonceStore
const FailureTracker = guardMod.FailureTracker
const NONCE_MAX = guardMod.NONCE_MAX ?? 20000
const FAILURE_MAX = guardMod.FAILURE_MAX ?? 10000

const { ConfigStore } = await import('../host/config.mjs')
const { LinkServer } = await import('../host/server.mjs')
const { signRequest, sha256 } = await import('../host/sign.mjs')

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err?.message ?? err}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const quiet = { info() {}, warn() {}, error() {} }

await ok('重放表：同一个 key 第二次算重放', async () => {
  assert(typeof NonceStore === 'function', 'guard.mjs 里没有 NonceStore')
  const ns = new NonceStore()
  assert(ns.take('a') === 'ok', '第一次应放行')
  assert(ns.take('a') === 'replay', '第二次应判重放')
  assert(ns.size === 1, `表里应只有一条，实际 ${ns.size}`)
})

await ok('重放表：到上限就挤掉最老的，不会无限涨', async () => {
  const ns = new NonceStore({ max: 100 })
  assert(ns.max === 100, `max 应为 100，实际 ${ns.max}`)
  for (let i = 0; i < 150; i += 1) ns.take(`k${i}`)
  assert(ns.size === 100, `表应停在上限 100，实际 ${ns.size}`)
  assert(ns.evicted === 50, `应挤掉 50 条，实际 ${ns.evicted}`)
  assert(ns.take('k0') === 'ok', '最早那条已被挤掉，再来应放行（这是上限换来的代价）')
  assert(ns.take('k149') === 'replay', '最新那条还应在表里')
})

await ok('重放表：过了窗口的记录会被清掉', async () => {
  const ns = new NonceStore({ windowMs: 1000, pruneEveryMs: 0 })
  const t0 = Date.now()
  ns.take('x', t0)
  assert(ns.prune(t0 + 2000) === 1, '过期的那条应被清掉')
  assert(ns.size === 0, `清完应为空，实际 ${ns.size}`)
})

await ok('重放表：清理按时间摊销，不是每个请求都扫全表', async () => {
  const ns = new NonceStore({ max: 10, pruneEveryMs: 5000 })
  const t0 = Date.now()
  ns.take('a', t0)
  const firstPrunedAt = ns.prunedAt
  ns.take('b', t0 + 100)
  assert(ns.prunedAt === firstPrunedAt, '间隔不到 5 秒不该再清一次')
  ns.take('c', t0 + 6000)
  assert(ns.prunedAt === t0 + 6000, '超过 5 秒应重新清理一次')
})

await ok('失败计数：来源超过上限时挤掉最老的', async () => {
  const warns = []
  const logger = { warn: (scope, msg) => warns.push(msg) }
  const ft = new FailureTracker({ max: 5, lockAfter: 10 })
  for (let i = 0; i < 9; i += 1) ft.register(`ip-${i}`, { logger })
  assert(ft.size === 5, `应停在上限 5，实际 ${ft.size}`)
  assert(
    warns.some((m) => m.includes('开始挤掉最老的记录')),
    `应有一条挤记录的警告，实际 ${JSON.stringify(warns)}`,
  )
})

await ok('失败计数：被锁的来源不会被挤掉，先挤没锁的', async () => {
  const ft = new FailureTracker({ max: 3, lockAfter: 3 })
  const now = Date.now()
  for (let i = 0; i < 3; i += 1) ft.register('locked', { now })
  assert(ft.blocked('locked', now), '连续失败 3 次应被锁')
  ft.register('a', { now })
  ft.register('b', { now })
  ft.register('c', { now })
  assert(ft.size <= 3, `应不超过上限 3，实际 ${ft.size}`)
  assert(ft.blocked('locked', now), '被锁的来源不该被挤掉')
})

await ok('失败计数：过了锁定期会自己解开', async () => {
  const ft = new FailureTracker({ max: 10, lockAfter: 2, lockMs: 1000 })
  const now = Date.now()
  ft.register('x', { now })
  ft.register('x', { now })
  assert(ft.blocked('x', now), '应锁上')
  assert(!ft.blocked('x', now + 2000), '过期后应解开')
  assert(ft.size === 0, '解开时应把记录丢掉')
})

await ok('默认上限与导出常量一致', async () => {
  assert(new NonceStore().max === NONCE_MAX, 'NonceStore 默认上限应与 NONCE_MAX 一致')
  assert(new FailureTracker().max === FAILURE_MAX, 'FailureTracker 默认上限应与 FAILURE_MAX 一致')
})

/* ---------------- 真服务器：server 是否真的用上了这两个上限 ---------------- */

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function startServer(opts = {}) {
  const store = new ConfigStore()
  await store.load()
  const port = await freePort()
  const server = new LinkServer({ store, logger: quiet, idleMs: 5000, ...opts })
  await server.start({ port, bind: '127.0.0.1' })
  return server
}

function addSession(server) {
  const token = 'tok-' + randomBytes(4).toString('hex')
  const session = {
    token,
    sk: randomBytes(32),
    device: { id: 'dev_test', name: 't', platform: 'test' },
    expiresAt: Date.now() + 3600_000,
  }
  server.sessions.set(token, session)
  return session
}

function signedHeaders(session, { method, target, nonce }) {
  const ts = Date.now()
  const digest = sha256(Buffer.alloc(0))
  const n = nonce ?? randomBytes(8).toString('hex')
  const mac = signRequest(session.sk, { method, target, ts, nonce: n, digest })
  return {
    'x-dl-token': session.token,
    'x-dl-ts': String(ts),
    'x-dl-nonce': n,
    'x-dl-mac': mac,
  }
}

function request(port, { method = 'GET', target, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
    setTimeout(() => reject(new Error('请求超时')), 5000).unref?.()
  })
}

await ok('server 把上限参数真的传下去了', async () => {
  const server = await startServer({ nonceMax: 50, failureMax: 7 })
  try {
    assert(server.nonces?.max === 50, `nonces.max 应为 50，实际 ${server.nonces?.max}`)
    assert(server.guard?.max === 7, `guard.max 应为 7，实际 ${server.guard?.max}`)
  } finally {
    await server.stop().catch(() => {})
  }
})

await ok('同一个 nonce 发两次，第二次是 REPLAY', async () => {
  const server = await startServer()
  const session = addSession(server)
  const target = '/dsh-link/v1/progress?syncId=none'
  const nonce = randomBytes(8).toString('hex')
  try {
    const first = await request(server.port, {
      target,
      headers: signedHeaders(session, { method: 'GET', target, nonce }),
    })
    assert(first.status === 404, `第一次应是 404（批次不存在），实际 ${first.status}`)
    const second = await request(server.port, {
      target,
      headers: signedHeaders(session, { method: 'GET', target, nonce }),
    })
    assert(second.status === 401, `第二次应是 401 重放，实际 ${second.status}`)
    assert(second.text.includes('REPLAY'), `第二次应说 REPLAY，实际 ${second.text.slice(0, 120)}`)
  } finally {
    await server.stop().catch(() => {})
  }
})

await ok('真服务器上灌满 nonce 也不会让表无限涨', async () => {
  const server = await startServer({ nonceMax: 20 })
  const session = addSession(server)
  const target = '/dsh-link/v1/progress?syncId=none'
  try {
    for (let i = 0; i < 60; i += 1) {
      await request(server.port, { target, headers: signedHeaders(session, { method: 'GET', target }) })
    }
    assert(server.nonces.size <= 20, `表应不超过 20，实际 ${server.nonces.size}`)
    assert(server.nonces.evicted > 0, '应当发生过挤记录')
  } finally {
    await server.stop().catch(() => {})
  }
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})

console.log(
  `guard-limits ok · ${pass + fail} 项断言 · 重放表上限 / 失败计数上限 / 真服务器接线（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
