#!/usr/bin/env node
/**
 * 握手挑战票的边界。
 *
 * `/hello` 是公开路由：谁能连上端口谁就能要一张票，不需要密码。票里存着设备信息、
 * 客户端随机数、服务端随机数与来源地址，TTL 一分钟。
 *
 * 以前这张表没有上限，而清理又是每次进门都做一遍全表扫描——于是「一分钟要一千张票」
 * 既能灌内存，也能让每次握手都变慢。这一组断言盯三件事：封顶、丢最旧的、丢掉之后
 * 新的握手照常能走。
 *
 * 用法：node test/handshake-flood.mjs [host/server.mjs 路径]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-handshake-flood-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const serverUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/server.mjs', import.meta.url).href
const { LinkServer } = await import(serverUrl)
const { ConfigStore } = await import(new URL('../host/config.mjs', import.meta.url).href)

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

const quiet = { info() {}, warn() {}, error() {} }

async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(home, 'data-'))
  const store = new ConfigStore()
  await store.load()
  const server = new LinkServer({ store, logger: quiet, idleMs: 5000, ...options })
  const port = await freePort()
  await server.start({ port, bind: '127.0.0.1' })
  return { server, port, store, dir }
}

function post(port, pathname, payload) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, json, text })
        })
      }
    )
    req.on('error', (err) => resolve({ status: 0, json: null, text: String(err?.code ?? err) }))
    req.end(body)
  })
}

const hello = (port, i) =>
  post(port, '/dsh-link/v1/hello', {
    device: { id: `dev-${i}`, name: `probe-${i}`, platform: 'test' },
    clientNonce: Buffer.alloc(16, i % 250).toString('base64'),
  })

await ok('默认上限是 512 张票', async () => {
  const store = new ConfigStore()
  await store.load()
  const server = new LinkServer({ store, logger: quiet })
  assert.equal(server.maxChallenges, 512, `实际 ${server.maxChallenges}`)
})

const { server, port } = await startServer({ maxChallenges: 40 })

const first = await hello(port, 0)
const firstTicket = first.json?.challengeId

await ok('公开的握手路由能被连灌，但票数不会超过上限', async () => {
  assert.equal(first.status, 200, `第一次握手失败：${first.status} ${first.text.slice(0, 120)}`)
  let bad = 0
  const t0 = Date.now()
  for (let i = 1; i <= 1200; i += 1) {
    const r = await hello(port, i)
    if (r.status !== 200) bad += 1
  }
  const spent = Date.now() - t0
  assert.equal(bad, 0, `有 ${bad} 次握手没回 200`)
  assert.ok(server.challenges.size <= 40, `票数 ${server.challenges.size} 超过上限 40`)
  assert.ok(spent < 8000, `1200 次握手花了 ${spent} ms`)
})

await ok('被挤掉的是最早那张票，用它验证会明确报过期', async () => {
  assert.ok(firstTicket, '第一次握手没拿到 challengeId')
  assert.equal(server.challenges.has(firstTicket), false, '最早那张票还在，说明没挤掉')
  const r = await post(port, '/dsh-link/v1/hello/verify', {
    challengeId: firstTicket,
    device: { id: 'dev-0', name: 'probe-0', platform: 'test' },
    proof: Buffer.alloc(32, 1).toString('base64'),
  })
  assert.equal(r.status, 400, `实际 ${r.status}`)
  assert.equal(r.json?.error?.code, 'CHALLENGE_EXPIRED', `实际 ${r.json?.error?.code}`)
})

await ok('灌满之后新的握手照样能拿到票', async () => {
  const r = await hello(port, 5000)
  assert.equal(r.status, 200, `实际 ${r.status}`)
  assert.ok(r.json?.challengeId, '没有 challengeId')
  assert.equal(server.challenges.has(r.json.challengeId), true, '新票没进表')
  assert.ok(server.challenges.size <= 40, `票数 ${server.challenges.size}`)
})

await ok('过期清理按时间节流，不是每次进门都全表扫', async () => {
  const before = server.prunedAt
  await hello(port, 6001)
  await hello(port, 6002)
  assert.equal(server.prunedAt, before, '每次握手都重扫了全表')
})

await server.stop()
console.log(
  `handshake-flood ok · 5 项断言 · 票数上限 / 丢最旧 / 新票可用 / 清理节流（${pass} 通过、${fail} 失败）`
)
process.exit(fail > 0 ? 1 : 0)
