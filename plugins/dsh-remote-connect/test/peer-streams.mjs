/**
 * 拉取（pull）与推送（push）时那几条流：出错之后必须被关掉。
 *
 * 以前有两个真问题：
 *  1. `applyStream` 一抛错（路径越界、哈希不符、超过上限……），局部的 `res` 就没人管了——
 *     对端还在往外传，socket 留在 agent 池里，一个几 GB 的包会在失败之后继续往本机淌。
 *  2. 解码/解压这两环没有 error 监听：对端发来一段解不开的帧，Transform 直接 emit('error')，
 *     没人接就把整个进程抛死（实测 `Error: 帧过大` 未捕获）。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

process.env.DEVICE_LINK_HOME = process.env.TEMP ?? '/tmp'
process.env.DEVICE_LINK_DSH_HOME = process.env.TEMP ?? '/tmp'

// 可传一个模块路径参数，用来验证这个守卫本身（拿旧版本跑应当会红）。
const peerUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/peer.mjs', import.meta.url).href
const { RemotePeer } = await import(peerUrl)
const { encodeFrame } = await import('../host/crypto.mjs')

const KEY = Buffer.alloc(32, 1)
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

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 一个「prepare 成功、导出永远传不完」的对端。
 * mode = 'frames' 发合法加密帧，mode = 'garbage' 发一段解不开的字节。
 */
async function stubbornPeer(mode = 'frames') {
  const hits = { prepare: 0, export: 0, closedAt: 0 }
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/export/prepare')) {
      hits.prepare += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ packId: 'p1', totalBytes: 1 << 30, files: 1 }))
      return
    }
    if (req.url.includes('/export/')) {
      hits.export += 1
      res.writeHead(200, { 'content-type': 'application/x-dsh-link-frames' })
      const gzip = createGzip({ level: 1 })
      gzip.pipe(res)
      let index = 0
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(timer)
        if (mode === 'garbage') {
          gzip.write(Buffer.alloc(64 * 1024, 7))
          clearInterval(timer)
          return
        }
        gzip.write(encodeFrame(KEY, index, Buffer.alloc(64 * 1024, 5)))
        index += 1
      }, 20)
      const stop = () => {
        clearInterval(timer)
        if (!gzip.destroyed) gzip.destroy()
      }
      res.on('close', () => {
        hits.closedAt = Date.now()
        stop()
      })
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const peer = new RemotePeer({
    record: { id: 'p1', host: '127.0.0.1', port, scheme: 'http', name: '假对端' },
    logger: quiet,
    device: { id: 'me', name: '本机', platform: 'win32', version: '1.0.0' },
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 1), expiresAt: Date.now() + 3600_000 }
  return { server, peer, hits }
}

async function waitFor(fn, ms = 3000) {
  const startedAt = Date.now()
  while (!fn() && Date.now() - startedAt < ms) await new Promise((r) => setTimeout(r, 50))
  return fn()
}

/* 1. applyStream 抛错 → 那条下载流必须被关掉，不让对端继续传 */
await ok('落地失败时，下载流会被关掉（对端不再继续传）', async () => {
  const { server, peer, hits } = await stubbornPeer('frames')
  const applier = {
    prepare: async () => ({ id: 's_test', onTick: null }),
    applyStream: async () => {
      await new Promise((r) => setTimeout(r, 300))
      const err = new Error('拒绝非法路径：../../etc/passwd')
      err.code = 'PATH_ESCAPE'
      throw err
    },
  }
  try {
    await assert.rejects(() => peer.pull({ applier }), (err) => err.code === 'PATH_ESCAPE')
    assert.ok(await waitFor(() => hits.closedAt), '对端应当看到连接被关掉')
    assert.equal(hits.export, 1)
  } finally {
    peer.close()
    await new Promise((r) => server.close(r))
  }
})

/* 2. 成功路径：结果照常返回，流也会被收干净 */
await ok('成功路径仍然返回结果，并且流被收尾', async () => {
  const { server, peer, hits } = await stubbornPeer('frames')
  const applier = {
    prepare: async () => ({ id: 's_ok', onTick: null }),
    applyStream: async () => ({ id: 's_ok', files: 2, bytes: 9, phase: 'done' }),
  }
  try {
    const out = await peer.pull({ applier })
    assert.equal(out.files, 2)
    assert.ok(await waitFor(() => hits.closedAt), '成功之后也要把这条流关掉，别让它挂在池子里')
  } finally {
    peer.close()
    await new Promise((r) => server.close(r))
  }
})

/* 3. 坏帧流 → 报错，而不是把整个进程抛死 */
await ok('对端发来解不开的帧时，报错而不是崩进程', async () => {
  const { server, peer, hits } = await stubbornPeer('garbage')
  const applier = {
    prepare: async () => ({ id: 's_bad', onTick: null }),
    // 真把流读空：错误要么从这里冒出来，要么就是进程被抛死
    applyStream: async (id, stream) =>
      pipeline(stream, new Writable({ write(chunk, enc, cb) { cb() } })),
  }
  try {
    await assert.rejects(() => peer.pull({ applier }), /帧过大|invalid|unexpected/i)
    assert.ok(await waitFor(() => hits.closedAt), '坏流也要关掉')
  } finally {
    peer.close()
    await new Promise((r) => server.close(r))
  }
})

/* 4. 本地打包失败（文件在半路不见了）→ 立刻报「读不到」，而不是挂到超时 */
await ok('本地文件读不到时，推送立刻报错并让对方收掉批次', async () => {
  const hits = { prepare: 0, put: 0, del: 0 }
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/apply/prepare')) {
      hits.prepare += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's1', maxTotalBytes: 1 << 30 }))
      return
    }
    if (req.method === 'DELETE') {
      hits.del += 1
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'PUT') {
      // 故意不回话也不收尾：如果上传流没报错，这里就会一直挂着
      hits.put += 1
      req.resume()
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const peer = new RemotePeer({
    record: { id: 'p2', host: '127.0.0.1', port, scheme: 'http', name: '假对端' },
    logger: quiet,
    device: { id: 'me', name: '本机', platform: 'win32', version: '1.0.0' },
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 1), expiresAt: Date.now() + 3600_000 }
  const entries = [
    {
      rel: 'gone.md',
      abs: path.join(process.env.TEMP ?? '/tmp', `rc-gone-${Date.now()}.md`),
      size: 10,
      mtime: Date.now(),
      mode: 0o644,
      hash: 'x',
    },
  ]
  try {
    const startedAt = Date.now()
    await assert.rejects(() => peer.push({ entries }), /读不到|ENOENT/)
    const spent = Date.now() - startedAt
    assert.ok(spent < 3000, `应当立刻失败，实际等了 ${spent} ms（等于挂到超时）`)
    assert.ok(await waitFor(() => hits.del >= 1), '对端应当收到一条 DELETE 把这个批批次收掉')
  } finally {
    peer.close()
    await new Promise((r) => server.close(r))
  }
})

console.log(`peer-streams ok · ${pass} 项断言 · 失败收流 / 成功收流 / 坏流不崩 / 本地包读不到（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
