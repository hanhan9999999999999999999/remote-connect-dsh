#!/usr/bin/env node
// 服务端授权的两道门：①没令牌的请求不该被读 body；②`/apply/<syncId>` 的失败要按错误码给状态，
// 不能一律 500（那会让对端以为自己坏掉了）。
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-server-auth-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const { LinkServer } = await import('../host/server.mjs')
const { signRequest, sha256 } = await import('../host/sign.mjs')
const { decryptJson } = await import('../host/crypto.mjs')

let pass = 0
let fail = 0
async function expect(label, fn) {
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

async function startServer() {
  const store = new ConfigStore()
  await store.load()
  const port = await freePort()
  const server = new LinkServer({ store, logger: quiet, idleMs: 5000 })
  await server.start({ port, bind: '127.0.0.1' })
  return { server, port: server.port }
}

// 造一个会话：直接塞进 server.sessions（省掉握手；握手本身在 e2e 里验）
function addSession(server, { expired = false } = {}) {
  const token = 'tok-' + randomBytes(4).toString('hex')
  const session = {
    token,
    sk: randomBytes(32),
    device: { id: 'dev_test', name: 't', platform: 'test' },
    expiresAt: Date.now() + (expired ? -1000 : 3600_000),
  }
  server.sessions.set(token, session)
  return session
}

function signedHeaders(session, { method, target, body = Buffer.alloc(0), stream = false }) {
  const ts = Date.now()
  const nonce = randomBytes(8).toString('hex')
  const digest = stream ? 'stream' : sha256(body)
  const mac = signRequest(session.sk, { method, target, ts, nonce, digest })
  const headers = {
    'x-dl-token': session.token,
    'x-dl-ts': String(ts),
    'x-dl-nonce': nonce,
    'x-dl-mac': mac,
  }
  if (stream) headers['x-dl-stream'] = '1'
  return headers
}

function request(port, { method = 'GET', path: target, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
    setTimeout(() => reject(new Error('请求超时')), 5000).unref?.()
  })
}

// 只发头部 + 半个 body，看服务器会不会先读 body 再拒绝
function leakyPost(port, { bodyBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let text = ''
    let resolved = false
    sock.on('connect', () => {
      sock.write(
        'POST /dsh-link/v1/inventory HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${bodyBytes}\r\n` +
          '\r\n',
      )
      sock.write('x'.repeat(1024))
    })
    const finish = (value) => {
      if (resolved) return
      resolved = true
      resolve(value)
    }
    sock.on('data', (c) => {
      text += c.toString('utf8')
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text)
      if (m) finish({ status: Number(m[1]), text })
    })
    sock.on('error', (err) => (resolved ? null : reject(err)))
    sock.on('close', () => finish({ status: 0, text }))
    setTimeout(() => finish({ status: 0, text, timedOut: true }), 4000).unref?.()
  })
}

// 1) 没有令牌：连 body 都不该读，先回 401
await expect('无令牌的 POST 在读 body 之前就被拒', async () => {
  const { server, port } = await startServer()
  try {
    const started = Date.now()
    const r = await leakyPost(port)
    const ms = Date.now() - started
    assert(r.status === 401, `应回 401，实际 ${r.status}${r.timedOut ? '（超时没回应）' : ''}`)
    assert(/UNAUTHORIZED|未连接/.test(r.text), `响应里应说明原因，实际：${r.text.slice(0, 120)}`)
    assert(ms < 3000, `应立刻拒绝，实际等了 ${ms}ms`)
  } finally {
    await server.stop().catch(() => {})
  }
})

// 2) 令牌有效但没签名头 → 401 MISSING_SIGNATURE（early 那一步不能把签名绕过去）
await expect('令牌有效但缺签名头，仍然 401', async () => {
  const { server, port } = await startServer()
  try {
    const session = addSession(server)
    const r = await request(port, {
      method: 'POST',
      path: '/dsh-link/v1/inventory',
      headers: { 'x-dl-token': session.token, 'content-type': 'application/json' },
      body: '{}',
    })
    assert(r.status === 401, `应回 401，实际 ${r.status}`)
    assert(/MISSING_SIGNATURE|签名/.test(r.text), `应说明缺签名，实际：${r.text.slice(0, 160)}`)
  } finally {
    await server.stop().catch(() => {})
  }
})

// 3) 过期会话：401 且会话被清掉
await expect('过期会话回 401 并从表里删掉', async () => {
  const { server, port } = await startServer()
  try {
    const session = addSession(server, { expired: true })
    const r = await request(port, {
      method: 'POST',
      path: '/dsh-link/v1/inventory',
      headers: { 'x-dl-token': session.token },
      body: '{}',
    })
    assert(r.status === 401, `应回 401，实际 ${r.status}`)
    assert(/SESSION_EXPIRED|过期/.test(r.text), `应说明会话过期，实际：${r.text.slice(0, 160)}`)
    assert(!server.sessions.has(session.token), '过期会话应被删除')
  } finally {
    await server.stop().catch(() => {})
  }
})

// 4) /apply/<不存在的 syncId> 要回 404 SYNC_UNKNOWN，而不是 500「服务端坏了」
await expect('往不存在的批次上传：404 而不是 500', async () => {
  const { server, port } = await startServer()
  try {
    const session = addSession(server)
    const r = await request(port, {
      method: 'PUT',
      path: '/dsh-link/v1/apply/nope',
      headers: signedHeaders(session, { method: 'PUT', target: '/dsh-link/v1/apply/nope', stream: true }),
      body: Buffer.alloc(0),
    })
    assert(r.status === 404, `应回 404，实际 ${r.status}`)
    const payload = decryptJson(session.sk, JSON.parse(r.text))
    assert(payload?.error?.code === 'SYNC_UNKNOWN', `应带 SYNC_UNKNOWN，实际 ` + JSON.stringify(payload).slice(0, 160))
  } finally {
    await server.stop().catch(() => {})
  }
})

// 5) /export/<不存在的包> 回 404 PACK_UNKNOWN
await expect('下载不存在的清单：404 PACK_UNKNOWN', async () => {
  const { server, port } = await startServer()
  try {
    const session = addSession(server)
    const target = '/dsh-link/v1/export/nope'
    const r = await request(port, {
      method: 'GET',
      path: target,
      headers: signedHeaders(session, { method: 'GET', target }),
    })
    assert(r.status === 404, `应回 404，实际 ${r.status}`)
    const payload = decryptJson(session.sk, JSON.parse(r.text))
    assert(payload?.error?.code === 'PACK_UNKNOWN', `应带 PACK_UNKNOWN，实际 ` + JSON.stringify(payload).slice(0, 160))
  } finally {
    await server.stop().catch(() => {})
  }
})

// 6) DELETE /apply/<syncId> 是「这次推送作废」的通路：不存在的批次 404 SYNC_UNKNOWN
await expect('撤回一条不存在的批次：404 SYNC_UNKNOWN', async () => {
  const { server, port } = await startServer()
  try {
    const session = addSession(server)
    const target = '/dsh-link/v1/apply/nope?reason=x'
    const r = await request(port, {
      method: 'DELETE',
      path: target,
      headers: signedHeaders(session, { method: 'DELETE', target }),
    })
    assert(r.status === 404, `应回 404，实际 ${r.status}`)
    const payload = decryptJson(session.sk, JSON.parse(r.text))
    assert(payload?.error?.code === 'SYNC_UNKNOWN', `应带 SYNC_UNKNOWN，实际 ` + JSON.stringify(payload).slice(0, 160))
  } finally {
    await server.stop().catch(() => {})
  }
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `server-auth ok · ${pass} 项断言 · 先验令牌 / 缺签名 / 过期会话 / 批次不存在 / 清单不存在 / 撤回批次（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
