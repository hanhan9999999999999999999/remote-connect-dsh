#!/usr/bin/env node
// 握手应答是对端说的：缺字段、长度不对、kdf 要的内存离谱，本机都不该照着算。
// 这一套钉住三件事：参数被收干净、离谱的参数当场拒绝、拒绝时给的是人话（BAD_RESPONSE）而不是 500。
import http from 'node:http'
import { randomBytes } from 'node:crypto'

const { sanitizeKdf, decodeB64Field, KDF_DEFAULTS, KDF_LIMITS } = await import('../host/crypto.mjs')
const { RemotePeer } = await import('../host/peer.mjs')
const { PROTOCOL } = await import('../host/util.mjs')

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err?.message ?? err}`)
  }
}
async function okAsync(label, fn) {
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
function throwsCode(fn, code, hint) {
  try {
    fn()
  } catch (err) {
    assert(err?.code === code, `应当报 ${code}，实际 ${err?.code}：${err?.message ?? err}`)
    if (hint) assert(hint.test(String(err.message)), `错误文案不合适：${err.message}`)
    return err
  }
  throw new Error(`本该抛 ${code}，却什么都没抛`)
}

// ── 一、参数收拢 ───────────────────────────────────────────────
ok('kdf 缺省时回落到本机默认值', () => {
  const k = sanitizeKdf(undefined)
  assert(k.N === KDF_DEFAULTS.N && k.r === KDF_DEFAULTS.r && k.p === KDF_DEFAULTS.p, `不该改默认值：${JSON.stringify(k)}`)
  assert(k.keylen === 32, 'keylen 必须固定 32')
})

ok('对端塞进来的 keylen 一律无视', () => {
  const k = sanitizeKdf({ N: 16384, r: 8, p: 1, keylen: 4096 })
  assert(k.keylen === 32, `keylen 不该跟着对端走，实际 ${k.keylen}`)
})

ok('合法范围内的自定义 kdf 原样采用', () => {
  const k = sanitizeKdf({ N: 65536, r: 4, p: 2 })
  assert(k.N === 65536 && k.r === 4 && k.p === 2, `不该改动合法参数：${JSON.stringify(k)}`)
})

// ── 二、离谱的参数当场拒绝 ─────────────────────────────────────
ok('N 大得离谱（1 GiB 量级）被拒，且不报内部错误', () => {
  throwsCode(() => sanitizeKdf({ N: 1 << 30, r: 8, p: 1 }), 'BAD_RESPONSE', /kdf\.N/)
})

ok('N 不是 2 的幂被拒', () => {
  throwsCode(() => sanitizeKdf({ N: 20000, r: 8, p: 1 }), 'BAD_RESPONSE', /2 的幂/)
})

ok('N 低于默认强度被拒（不悄悄降级）', () => {
  throwsCode(() => sanitizeKdf({ N: 1024, r: 8, p: 1 }), 'BAD_RESPONSE', /kdf\.N/)
})

ok('r 太大被拒', () => {
  throwsCode(() => sanitizeKdf({ N: 16384, r: 999, p: 1 }), 'BAD_RESPONSE', /kdf\.r/)
})

ok('N 与 r 各自合法、合起来要的内存太多也被拒', () => {
  // 128 * 2^20 * 8 = 1 GiB，超过 512 MB 的线
  throwsCode(() => sanitizeKdf({ N: 1 << 20, r: 8, p: 1 }), 'BAD_RESPONSE', /内存太多/)
})

ok('kdf 不是对象被拒（字符串/数组/数字）', () => {
  throwsCode(() => sanitizeKdf('N=16384'), 'BAD_RESPONSE', /不是对象/)
  throwsCode(() => sanitizeKdf([16384]), 'BAD_RESPONSE', /不是对象/)
  throwsCode(() => sanitizeKdf(16384), 'BAD_RESPONSE', /不是对象/)
})

// ── 三、base64 字段 ───────────────────────────────────────────
ok('缺字段报 BAD_RESPONSE，而不是 Buffer.from(undefined) 的 TypeError', () => {
  throwsCode(() => decodeB64Field(undefined, { label: 'serverNonce' }), 'BAD_RESPONSE', /serverNonce/)
  throwsCode(() => decodeB64Field('', { label: 'salt' }), 'BAD_RESPONSE', /salt/)
  throwsCode(() => decodeB64Field(null, { label: 'salt' }), 'BAD_RESPONSE', /salt/)
})

ok('不是 base64 的内容被拒', () => {
  throwsCode(() => decodeB64Field('这不是 base64!!', { label: 'serverNonce' }), 'BAD_RESPONSE', /base64/)
})

ok('长度越界被拒，正常长度通过', () => {
  throwsCode(() => decodeB64Field('AAAA', { label: 'serverNonce', min: 16, max: 64 }), 'BAD_RESPONSE', /长度不对/)
  const good = randomBytes(24).toString('base64')
  assert(decodeB64Field(good, { label: 'serverNonce', min: 16, max: 64 }).length === 24, '正常长度应当通过')
})

// ── 四、真的握手一次：对端少给字段 ───────────────────────────
function fakeServer(reply) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/dsh-link/v1/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ app: 'dsh-remote-connect', protocol: PROTOCOL, version: '1.0.52' }))
      return
    }
    if (req.url.startsWith('/dsh-link/v1/hello')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

async function connectAgainst(reply, password = 'ABCD-EFGH-JKLM') {
  const { srv, port } = await fakeServer(reply)
  const peer = new RemotePeer({
    record: { id: 'p_test', host: '127.0.0.1', port, scheme: 'http', password },
    logger: { warn() {}, info() {}, warnOnce() {} },
    device: { id: 'dev_test', name: 'test', platform: 'win32' },
  })
  try {
    await peer.connect({ password })
    return { err: null, peer }
  } catch (err) {
    return { err, peer }
  } finally {
    peer.close()
    srv.close()
  }
}

const PROTO_OK = { app: 'dsh-remote-connect', protocol: 'dsh-link/1', version: '1.0.52' }

await okAsync('对端没给 serverNonce：BAD_RESPONSE，不是 500', async () => {
  const { err } = await connectAgainst({ challengeId: 'c1', salt: randomBytes(16).toString('base64'), kdf: KDF_DEFAULTS })
  assert(err, '本该失败')
  assert(err.code === 'BAD_RESPONSE', `应当 BAD_RESPONSE，实际 ${err.code}：${err.message}`)
  assert(/serverNonce/.test(err.message), `文案该点名 serverNonce：${err.message}`)
  assert(!/of type string|Buffer/i.test(err.message), `不该把 Buffer 的内部报错甩出来：${err.message}`)
})

await okAsync('对端没给 salt：BAD_RESPONSE', async () => {
  const { err } = await connectAgainst({ challengeId: 'c1', serverNonce: randomBytes(16).toString('base64') })
  assert(err?.code === 'BAD_RESPONSE', `应当 BAD_RESPONSE，实际 ${err?.code}：${err?.message}`)
  assert(/salt/.test(err.message), `文案该点名 salt：${err.message}`)
})

await okAsync('对端报了个吃内存的 kdf：BAD_RESPONSE，且很快返回', async () => {
  const started = Date.now()
  const { err } = await connectAgainst({
    challengeId: 'c1',
    serverNonce: randomBytes(16).toString('base64'),
    salt: randomBytes(16).toString('base64'),
    kdf: { N: 1 << 29, r: 8, p: 1 },
  })
  const ms = Date.now() - started
  assert(err?.code === 'BAD_RESPONSE', `应当 BAD_RESPONSE，实际 ${err?.code}：${err?.message}`)
  assert(ms < 3000, `应当立刻拒绝，实际花了 ${ms}ms`)
})

await okAsync('对端给的 serverNonce 太短：BAD_RESPONSE', async () => {
  const { err } = await connectAgainst({
    challengeId: 'c1',
    serverNonce: Buffer.alloc(2).toString('base64'),
    salt: randomBytes(16).toString('base64'),
  })
  assert(err?.code === 'BAD_RESPONSE', `应当 BAD_RESPONSE，实际 ${err?.code}：${err?.message}`)
  assert(/长度不对/.test(err.message), `文案该说长度：${err.message}`)
})

await okAsync('正常应答能走完握手前半段（拿着错误密码报 BAD_PASSWORD）', async () => {
  // 服务端给合法 salt/nonce/kdf，但没有 /hello/verify 的实现 → 连接阶段会失败；
  // 这里只要求它不再卡在参数校验上（不是 BAD_RESPONSE）。
  const { err } = await connectAgainst({
    challengeId: 'c1',
    serverNonce: randomBytes(16).toString('base64'),
    salt: randomBytes(16).toString('base64'),
    kdf: KDF_DEFAULTS,
  })
  assert(err, '假服务端没有 verify 路由，本该失败')
  assert(err.code !== 'BAD_RESPONSE', `参数合法时不该报 BAD_RESPONSE：${err.message}`)
})

console.log(
  `handshake-guard ok · ${pass} 项断言 · kdf 收拢 / 离谱参数被拒 / base64 字段 / 真握手（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
