/**
 * `/apply/prepare` 里的「条数」对账。
 *
 * 1.0.67 给了落地时的条数上限（`sync.maxFiles`），但那是**边收边数**——
 * 五百万个 0 字节文件也要先传上来，`backups/` 与 `journal.jsonl` 先被撑一遍才发现超限。
 * 所以 prepare 阶段就该对账：对端声明多少条、本机上限多少，超了直接 413，
 * 并把 `maxFiles` 一起回给对端，让它一个字节都不发。
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-prep-files-'))
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const serverUrl =
  process.argv[2] && process.argv[2] !== '-'
    ? pathToFileURL(path.resolve(process.argv[2])).href
    : new URL('../host/server.mjs', import.meta.url).href
const { LinkServer } = await import(serverUrl)
const { signRequest, sha256 } = await import('../host/sign.mjs')
const { encryptJson, decryptJson } = await import('../host/crypto.mjs')
const { RemotePeer } = await import(
  process.argv[3] ? pathToFileURL(path.resolve(process.argv[3])).href : new URL('../host/peer.mjs', import.meta.url).href
)

let pass = 0
let fail = 0
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}\n       ${err?.message ?? err}`)
  }
}

const quiet = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const store = new ConfigStore()
await store.load()
await store.patch({ sync: { maxFiles: 5 } })
const port = await freePort()
const server = new LinkServer({ store, logger: quiet, idleMs: 5000 })
await server.start({ port, bind: '127.0.0.1' })

const token = 'tok-' + randomBytes(4).toString('hex')
const session = {
  token,
  sk: randomBytes(32),
  device: { id: 'dev_prep', name: 'prep', platform: 'test' },
  expiresAt: Date.now() + 3600_000,
}
server.sessions.set(token, session)

function post(target, payload) {
  const body = Buffer.from(JSON.stringify(encryptJson(session.sk, payload)), 'utf8')
  const ts = Date.now()
  const nonce = randomBytes(8).toString('hex')
  const mac = signRequest(session.sk, { method: 'POST', target, ts, nonce, digest: sha256(body) })
  const headers = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-dl-token': token,
    'x-dl-ts': String(ts),
    'x-dl-nonce': nonce,
    'x-dl-mac': mac,
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: target, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let payloadOut = null
        try {
          payloadOut = decryptJson(session.sk, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          payloadOut = null
        }
        resolve({ status: res.statusCode, payload: payloadOut })
      })
    })
    req.on('error', reject)
    req.end(body)
    setTimeout(() => reject(new Error('请求超时')), 8000).unref?.()
  })
}

const before = server.applier.listRecent(50).length

await ok('声明的条数超过本机上限时，prepare 直接 413', async () => {
  const r = await post('/dsh-link/v1/apply/prepare', { from: { id: 'dev_prep' }, totalBytes: 10, totalFiles: 9 })
  assert(r.status === 413, `应当 413，实际 ${r.status}`)
  assert(r.payload?.error?.code === 'TOO_MANY_FILES', `错误码应为 TOO_MANY_FILES，实际 ${r.payload?.error?.code}`)
  assert(/超过本机上限 5 个/.test(r.payload?.error?.message ?? ''), `消息应说明上限：${r.payload?.error?.message}`)
})

await ok('被拒时不会先建一个空批次', async () => {
  const now = server.applier.listRecent(50).length
  assert(now === before, `批次数量不该变（${before} → ${now}）`)
})

await ok('条数在上限内时正常建批次，并把 maxFiles 一起回给对端', async () => {
  const r = await post('/dsh-link/v1/apply/prepare', { from: { id: 'dev_prep' }, totalBytes: 10, totalFiles: 3 })
  assert(r.status === 200, `应当 200，实际 ${r.status}`)
  assert(typeof r.payload?.syncId === 'string' && r.payload.syncId.length > 0, '应当回一个 syncId')
  assert(r.payload?.maxFiles === 5, `应当回 maxFiles=5，实际 ${r.payload?.maxFiles}`)
  assert(Number(r.payload?.maxTotalBytes) > 0, 'maxTotalBytes 仍要在')
})

await ok('没声明条数（老版本对端）时不拦', async () => {
  const r = await post('/dsh-link/v1/apply/prepare', { from: { id: 'dev_prep' }, totalBytes: 10 })
  assert(r.status === 200, `应当 200，实际 ${r.status}`)
})

// ---- 推的一侧：拿到 maxFiles 之后一个字节都不发，并撤掉对端刚建好的批次 ----
async function fakePeer(handler) {
  const seen = []
  const srv = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, bytes: 0 }
    seen.push(entry)
    req.on('data', (c) => {
      entry.bytes += c.length
    })
    req.on('end', () => handler(req, res, entry))
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const peer = new RemotePeer({
    record: { id: 'p1', host: '127.0.0.1', port: srv.address().port, scheme: 'http' },
    logger: quiet,
    device: { id: 'dev-a', name: '甲', platform: 'test', version: '9.9.9' },
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 7), expiresAt: Date.now() + 3600_000 }
  return { peer, seen, close: () => new Promise((resolve) => srv.close(resolve)) }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-prep-entries-'))
const entries = []
for (let i = 0; i < 3; i += 1) {
  const abs = path.join(tmp, `f${i}.txt`)
  await fs.writeFile(abs, 'x')
  entries.push({ rel: `f${i}.txt`, size: 1, cat: 'skills', abs, mtime: Date.now() })
}

await ok('对端说最多收 1 个、我要传 3 个：一个字节都不发，并撤掉它的批次', async () => {
  const { peer, seen, close } = await fakePeer((req, res, entry) => {
    if (req.url.endsWith('/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's1', maxTotalBytes: 1024 * 1024, maxFiles: 1 }))
      return
    }
    if (req.method === 'DELETE') {
      entry.cancelled = true
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  try {
    let thrown = null
    try {
      await peer.push({ entries, manifest: { id: 'm1' } })
    } catch (err) {
      thrown = err
    }
    assert(thrown, '应当抛错，实际推送成功了')
    assert(thrown.code === 'TOO_MANY_FILES', `错误码应为 TOO_MANY_FILES，实际 ${thrown.code}`)
    assert(/超过对端上限 1 个/.test(thrown.message), `消息应说明上限：${thrown.message}`)
    await sleep(200)
    assert(seen.filter((e) => e.method === 'PUT').length === 0, '不该发起 PUT')
    const del = seen.find((e) => e.method === 'DELETE')
    assert(del, '应当发一条 DELETE 撤掉对端批次')
    assert(del.url.startsWith('/dsh-link/v1/apply/s1'), `DELETE 路径应指向该批次：${del.url}`)
    assert(del.url.includes('reason='), `DELETE 应带原因：${del.url}`)
    assert(seen.filter((e) => e.url.includes('/progress')).length === 0, '不该开进度轮询')
  } finally {
    await close()
  }
})

await ok('对端没给 maxFiles（老版本）时照旧推送', async () => {
  const { peer, seen, close } = await fakePeer((req, res) => {
    if (req.url.endsWith('/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's2', maxTotalBytes: 1024 * 1024 }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, applied: 3 }))
  })
  try {
    const r = await peer.push({ entries, manifest: { id: 'm2' } })
    assert(r?.ok === true, '应当推送成功')
    assert(seen.filter((e) => e.method === 'PUT').length === 1, '应当发一次 PUT')
  } finally {
    await close()
  }
})

await server.stop()
await fs.rm(home, { recursive: true, force: true })
await fs.rm(tmp, { recursive: true, force: true })

console.log(
  `prepare-files ok · 6 项断言 · 条数超限就拒 / 不建空批次 / 回 maxFiles / 老对端不拦 / 推前不发 / 老对端照推（${pass} 通过、${fail} 失败）`,
)
if (fail) process.exit(1)
