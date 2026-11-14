// 对端「半死不活」时，读 body 这一侧到底报什么。
//
// 背景：`#request` 只负责把响应头拿回来，`#jsonFrom` 才是真正读内容的地方。
// 以前那里对错误一概不管，于是：
//   · 对端发完响应头就挂住 → socket 超时掐断 → 抛的是裸 ECONNRESET / "aborted"
//     （路由层 statusFor 认不出来，只好回 500「服务端坏了」）
//   · 对端一直吐内容 → chunks 无限增长，直到把内存吃掉
// 这组断言把这两种情况都钉住。
import http from 'node:http'
import { RemotePeer } from '../host/peer.mjs'

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

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assert(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}：期望 ${expected}，实际 ${actual}`)
}

const quiet = { info() {}, warn() {}, error() {} }

/** 起一个只会按 handler 回话的假对端。 */
async function serve(handler) {
  const srv = http.createServer(handler)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, port: srv.address().port }
}

function peerFor(port, extra = {}) {
  const peer = new RemotePeer({
    record: { id: 'p1', host: '127.0.0.1', port, scheme: 'http' },
    logger: quiet,
  })
  peer.session = { token: 'tok', sk: Buffer.alloc(32, 3), expiresAt: Date.now() + 3_600_000 }
  Object.assign(peer, extra)
  return peer
}

async function codeOf(promise) {
  try {
    await promise
    return '(resolved)'
  } catch (err) {
    return err?.code ?? '(no code)'
  }
}

async function errorOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err
  }
}

/** 成功/失败都拿得到：成功 → {value}，失败 → {err}。 */
async function outcome(promise) {
  try {
    return { value: await promise }
  } catch (err) {
    return { err }
  }
}

// ① 响应头回来了，body 只发一半就挂着不动 → 必须报 TIMEOUT，而且话要说得明白
{
  const { srv, port } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"ok":true,')
    // 故意不 end
  })
  const peer = peerFor(port)
  const err = await errorOf(peer.requestJson('GET', '/syncs', { timeoutMs: 400 }))
  await expect('挂住的响应体报 TIMEOUT', async () => {
    assert(err?.code, 'TIMEOUT', '错误码')
    ok(/没有把内容发完/.test(err.message), `文案不可读：${err.message}`)
  })
  await expect('挂住的响应体不再报裸 ECONNRESET', async () => {
    ok(err?.code !== 'ECONNRESET', '仍然把 socket 的原始错误冒出来了')
  })
  srv.close()
}

// ② 对端把连接掐在半路 → NETWORK（不是 500 的裸错误，也不是 TIMEOUT）
{
  const { srv, port } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"ok":')
    setTimeout(() => res.destroy(), 40)
  })
  const peer = peerFor(port)
  const err = await errorOf(peer.requestJson('GET', '/syncs', { timeoutMs: 5000 }))
  await expect('半路断开的响应体报 NETWORK', async () => {
    assert(err?.code, 'NETWORK', '错误码')
    ok(err.message && !/^(aborted|socket hang up)$/i.test(err.message.trim()), `文案还是原始错误：${err.message}`)
  })
  srv.close()
}

// ③ 对端一直往外吐内容 → 到上限就中止，别把内存吃掉
{
  const { srv, port } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"rows":[')
    const filler = `"${'x'.repeat(2048)}",`
    const timer = setInterval(() => res.write(filler), 5)
    res.on('close', () => clearInterval(timer))
  })
  const peer = peerFor(port, { maxJsonBytes: 16 * 1024 })
  const t0 = Date.now()
  const err = await errorOf(peer.requestJson('GET', '/syncs', { timeoutMs: 20_000 }))
  const elapsed = Date.now() - t0
  await expect('响应体超过上限时报 BAD_RESPONSE', async () => {
    assert(err?.code, 'BAD_RESPONSE', '错误码')
    ok(/超过/.test(err.message), `文案里要说明超限：${err.message}`)
  })
  await expect('超限后立刻中止，不等对端吐完', async () => {
    ok(elapsed < 3000, `花了 ${elapsed}ms，说明没有及时掐断`)
  })
  srv.close()
}

// ④ 对照组：正常的一次请求照旧拿得到 JSON
{
  const { srv, port } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, syncs: [] }))
  })
  const peer = peerFor(port)
  const out = await outcome(peer.requestJson('GET', '/syncs', { timeoutMs: 5000 }))
  await expect('正常响应照旧解析', async () => {
    ok(!out.err, `不该报错：${out.err?.message}`)
    ok(out.value && out.value.ok === true, `返回体不对：${JSON.stringify(out.value)}`)
  })
  srv.close()
}

console.log(`peer-body ${fail === 0 ? 'ok' : 'FAILED'} · ${pass + fail} 项断言 · 挂住的响应体 / 半路断开 / 超量内容 / 正常对照组（${pass} 通过、${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
