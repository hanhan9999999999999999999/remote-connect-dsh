/**
 * dsh-remote-connect · 推送前的账目核对与进度轮询收尾
 *
 * 对端在 `/apply/prepare` 里会回一个 `maxTotalBytes`。超了就不该开始传——
 * 传几个 GB 再被拒绝，白占带宽也白等。这里用一个假对端把这两条路都跑一遍。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { RemotePeer } from '../host/peer.mjs'

const logger = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let pass = 0
let fail = 0
const ok = async (label, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}：${err.message}`)
  }
}

/** 假对端：按脚本回答，并记下收到的每条请求。 */
async function fakePeer(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, bytes: 0 }
    seen.push(entry)
    req.on('data', (chunk) => {
      entry.bytes += chunk.length
    })
    req.on('end', () => handler(req, res, entry))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const peer = new RemotePeer({
    record: { id: 'p1', host: '127.0.0.1', port, scheme: 'http' },
    logger,
    device: { id: 'dev-a', name: '甲', platform: 'test', version: '9.9.9' },
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 7), expiresAt: Date.now() + 3_600_000 }
  const close = () => new Promise((resolve) => server.close(resolve))
  return { peer, seen, close, port }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-push-'))
const fileA = path.join(tmp, 'a.txt')
await fs.writeFile(fileA, 'abc')
const entries = [{ rel: 'a.txt', size: 3, cat: 'skills', abs: fileA, mtime: Date.now() }]
const manifest = { id: 'm1' }

console.log('push')

await ok('对端上限小于要传的量时，连一个字节都不发', async () => {
  const { peer, seen, close } = await fakePeer((req, res) => {
    if (req.url.endsWith('/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's1', maxTotalBytes: 2 }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  try {
    await assert.rejects(
      () => peer.push({ entries, manifest }),
      (err) => {
        assert.equal(err.code, 'TOO_LARGE')
        assert.match(err.message, /超过对端上限/)
        return true
      },
    )
    await sleep(150)
    assert.equal(seen.filter((e) => e.method === 'PUT').length, 0, '不该发起 PUT')
    assert.equal(seen.filter((e) => e.url.includes('/progress')).length, 0, '不该开进度轮询')
  } finally {
    await close()
  }
})

await ok('上限够用时正常推送，签名头齐全', async () => {
  const { peer, seen, close } = await fakePeer((req, res) => {
    if (req.url.endsWith('/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's2', maxTotalBytes: 1024 * 1024 }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, applied: 1, skipped: 0 }))
  })
  try {
    const result = await peer.push({ entries, manifest })
    assert.equal(result.ok, true)
    const put = seen.find((e) => e.method === 'PUT')
    assert.ok(put, '应当发起一次 PUT')
    assert.equal(put.url, '/dsh-link/v1/apply/s2')
    assert.equal(put.headers['x-dl-total'], '3')
    assert.equal(put.headers['x-dl-stream'], '1')
    assert.equal(put.headers['x-dl-token'], 'tok')
    assert.match(put.headers['x-dl-mac'] ?? '', /^[0-9a-f]{64}$/)
    assert.ok(put.bytes > 0, '上传应当有内容（帧 + gzip）')
  } finally {
    await close()
  }
})

await ok('推送结束后进度轮询真的停了', async () => {
  const { peer, seen, close } = await fakePeer((req, res) => {
    if (req.url.endsWith('/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's3', maxTotalBytes: 1024 * 1024 }))
      return
    }
    if (req.url.includes('/progress')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ phase: 'applying', done: 0, total: 3 }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  try {
    await peer.push({ entries, manifest })
    const before = seen.filter((e) => e.url.includes('/progress')).length
    await sleep(2000)
    const after = seen.filter((e) => e.url.includes('/progress')).length
    assert.equal(after, before, `结束后不该再有进度请求（${before} → ${after}）`)
  } finally {
    await close()
  }
})

console.log(`push ok · 3 项断言 · 超限不发 / 正常推送 / 轮询收尾（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
