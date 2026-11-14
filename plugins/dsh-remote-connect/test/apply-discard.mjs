// 批次「建了但没开始」的收尾：它不能永远停在「接收中」。
// 两端各有一条这样的路：我拉一半失败（本地批次没人收），我推过去失败（对端批次没人收）。
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { Applier } = await import(pathToFileURL(path.join(here, '..', 'host', 'apply.mjs')).href)
const { RemotePeer } = await import(pathToFileURL(path.join(here, '..', 'host', 'peer.mjs')).href)

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-discard-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

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
function want(cond, message) {
  if (!cond) throw new Error(message)
}

const quiet = { info() {}, warn() {}, error() {}, warnOnce() {} }

function makeApplier() {
  const applier = new Applier({ logger: quiet, dataHome: path.join(home, 'data'), onEvent: null })
  const realPrepare = applier.prepare.bind(applier)
  const seen = { ids: [] }
  applier.prepare = async (opts) => {
    const state = await realPrepare(opts)
    seen.ids.push(state.id)
    return state
  }
  return { applier, seen }
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

function peerFor(port, callLog) {
  const peer = new RemotePeer({
    id: 'peer_x',
    host: '127.0.0.1',
    port,
    scheme: 'http',
    name: '假对端',
    logger: quiet,
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 7), expiresAt: Date.now() + 3600_000 }
  const realJson = peer.requestJson.bind(peer)
  peer.requestJson = async (method, p, opts) => {
    callLog.push({ method, path: p })
    return await realJson(method, p, opts)
  }
  return peer
}

// ① discard 自己：落终态、带原因，重复调用不会改写
await ok('discard 把「接收中」的批次落成 failed 并带原因', async () => {
  const { applier } = makeApplier()
  const state = await applier.prepare({ from: { id: 'a' }, meta: { totalBytes: 10, totalFiles: 1 } })
  want(state.phase === 'receiving', `初始相位应为 receiving，实际 ${state.phase}`)
  const r = applier.discard(state.id, '对端取消了')
  want(r.ok === true && r.already !== true, `第一次 discard 应真的收尾，实际 ${JSON.stringify(r)}`)
  const after = applier.get(state.id)
  want(after.phase === 'failed', `收尾后应为 failed，实际 ${after.phase}`)
  want(after.error === '对端取消了', `原因没记上：${after.error}`)
  want(Number(after.finishedAt) > 0, '没有 finishedAt，修剪时收不走')
  const again = applier.discard(state.id, '再来一次')
  want(again.ok === true && again.already === true, `重复 discard 应标 already，实际 ${JSON.stringify(again)}`)
  want(applier.get(state.id).error === '对端取消了', '重复 discard 不该改写原因')
})

await ok('discard 一个不存在的批次只回报不知道，不抛错', async () => {
  const { applier } = makeApplier()
  const r = applier.discard('s_nope', '随便')
  want(r.ok === false && r.code === 'SYNC_UNKNOWN', `实际 ${JSON.stringify(r)}`)
})

// ② 拉取一侧：开流之前就失败，本地批次不能留在 receiving
await ok('拉取在开流之前失败时，本地批次被收成 failed', async () => {
  const { srv, port } = await serve((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  const { applier, seen } = makeApplier()
  const calls = []
  const peer = peerFor(port, calls)
  peer.requestJson = async () => ({ packId: 'p1', totalBytes: 10, files: 1 })
  let threw = null
  try {
    await peer.pull({ cats: ['skills'], applier })
  } catch (err) {
    threw = err
  } finally {
    srv.close()
  }
  want(threw !== null, '对端 500 时 pull 应当失败')
  want(seen.ids.length === 1, `应当建过一个批次，实际 ${seen.ids.length}`)
  const state = applier.get(seen.ids[0])
  want(state.phase === 'failed', `批次应被收成 failed，实际停在 ${state.phase}`)
  want(String(state.error ?? '').includes('拉取没能开始'), `原因不像「没能开始」：${state.error}`)
})

// ③ 推送一侧：对端批次建了、我这边一个字节都没发出去，要顺手通知对方收掉
await ok('推送失败时通知对端把这个批次收掉', async () => {
  const { srv, port } = await serve((req, res) => {
    // PUT /apply/... 直接把连接掐了：模拟传到一半断掉
    req.destroy()
  })
  const calls = []
  const peer = peerFor(port, calls)
  const deleted = []
  peer.requestJson = async (method, p) => {
    if (method === 'POST' && p === '/apply/prepare') return { syncId: 's1', maxTotalBytes: 1 << 30 }
    if (method === 'DELETE') {
      deleted.push(p)
      return { ok: true }
    }
    return {}
  }
  let threw = null
  try {
    await peer.push({
      entries: [{ rel: 'a.md', size: 4, abs: path.join(home, 'a.md') }],
      manifest: { id: 'm1' },
    })
  } catch (err) {
    threw = err
  } finally {
    srv.close()
  }
  want(threw !== null, '对端掐断连接时 push 应当失败')
  want(deleted.length === 1, `应当只发一次收尾请求，实际 ${deleted.length}`)
  want(deleted[0].startsWith('/apply/s1'), `收尾请求打错了批次：${deleted[0]}`)
  want(deleted[0].includes('reason='), `收尾请求应当带上原因：${deleted[0]}`)
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`apply-discard ok · ${pass} 项断言 · 收尾 / 不知道 / 拉取失败 / 推送失败（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
