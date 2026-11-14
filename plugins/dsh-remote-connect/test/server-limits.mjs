#!/usr/bin/env node
// 服务端的「兜底」：连上来什么都不发、连接数被灌满，这两种情况以前都能把端口占死。
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-server-limits-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const { LinkServer } = await import('../host/server.mjs')

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

// 只连上、不说话，然后等它被服务器掐掉
function idleSocket(port) {
  const sock = net.connect(port, '127.0.0.1')
  const closed = new Promise((resolve) => {
    const done = () => resolve(true)
    sock.once('close', done)
    sock.once('error', done)
    setTimeout(() => resolve(false), 4000)
  })
  return { sock, closed }
}

async function startServer({ idleMs, maxConnections } = {}) {
  const store = new ConfigStore()
  await store.load()
  const port = await freePort()
  const server = new LinkServer({ store, logger: quiet, idleMs, maxConnections })
  await server.start({ port, bind: '127.0.0.1' })
  return { server, port: server.port }
}

async function stopServer(server) {
  await server.stop().catch(() => {})
}

// 1) 默认值：空闲 120 秒、连接上限 128
await expect('默认是 120 秒空闲 / 128 条连接', async () => {
  const store = new ConfigStore()
  await store.load()
  const srv = new LinkServer({ store, logger: quiet })
  assert(srv.idleMs === 120_000, `idleMs 应为 120000，实际 ${srv.idleMs}`)
  assert(srv.maxConnections === 128, `maxConnections 应为 128，实际 ${srv.maxConnections}`)
})

// 2) 真的挂到 http server 上：requestTimeout 仍为 0（大包要传很久），空闲超时兜底
await expect('http 层：requestTimeout=0 但有 idle 超时与连接上限', async () => {
  const { server, port } = await startServer({ idleMs: 400, maxConnections: 3 })
  try {
    assert(server.http.requestTimeout === 0, 'requestTimeout 应保持 0（大文件同步不能按总时长掐）')
    assert(server.http.headersTimeout === 60_000, `headersTimeout 应为 60000，实际 ${server.http.headersTimeout}`)
    assert(server.http.maxConnections === 3, `maxConnections 应为 3，实际 ${server.http.maxConnections}`)
    assert(port > 0, '应已监听端口')
  } finally {
    await stopServer(server)
  }
})

// 3) 连上什么都不发 → 空闲超时把它断掉
await expect('连上不说话，会被空闲超时断开', async () => {
  const { server, port } = await startServer({ idleMs: 400 })
  try {
    const { sock, closed } = idleSocket(port)
    const gone = await closed
    sock.destroy()
    assert(gone, '空闲连接没有被断开（4 秒内仍连着）')
  } finally {
    await stopServer(server)
  }
})

// 4) 闲着不等于死着：正常请求照旧能被服务
await expect('正常请求不受空闲超时影响', async () => {
  const { server, port } = await startServer({ idleMs: 400 })
  try {
    const body = await new Promise((resolve, reject) => {
      const req = net.connect(port, '127.0.0.1', () => {
        req.write('GET /dsh-link/v1/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      })
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
      setTimeout(() => reject(new Error('health 没有回应')), 4000)
    })
    assert(/^HTTP\/1\.1 200/.test(body), `health 应回 200，实际首行 ${body.split('\r\n')[0]}`)
    assert(body.includes('dsh-link/v1'), 'health 响应里应带协议名')
  } finally {
    await stopServer(server)
  }
})

// 5) 连接数到上限后，多出来的那条会被拒
await expect('连接数到上限后，新连接被拒', async () => {
  const { server, port } = await startServer({ idleMs: 10_000, maxConnections: 2 })
  const held = []
  try {
    for (let i = 0; i < 2; i += 1) {
      const { sock } = idleSocket(port)
      held.push(sock)
      await new Promise((r) => sock.once('connect', r))
    }
    assert(Number(server.http._connections ?? 0) >= 2, `应已有 2 条连接，实际 ${server.http._connections}`)
    const extra = net.connect(port, '127.0.0.1')
    const dropped = await new Promise((resolve) => {
      const done = () => resolve(true)
      extra.once('close', done)
      extra.once('error', done)
      setTimeout(() => resolve(false), 3000)
    })
    extra.destroy()
    assert(dropped, '第 3 条连接没有被拒绝（3 秒内仍连着）')
  } finally {
    for (const s of held) s.destroy()
    await stopServer(server)
  }
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `server-limits ok · 5 项断言 · 默认值 / http 层 / 空闲断开 / 正常请求 / 连接上限（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
