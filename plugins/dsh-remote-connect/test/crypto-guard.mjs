/**
 * dsh-remote-connect · 加解密边界
 *
 * 对端发来的信封和帧都是不可信输入：字段缺失、iv/tag 长度不对、内容被改、
 * 两端密码不一致——以前这些都会从 node:crypto 抛出面相实现的消息
 * （`Invalid IV length` 之类），调用方只能当 500。现在每一种都给一句能看懂的错。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decryptJson, encryptJson, encodeFrame, decodeFrame, FrameDecoder } from '../host/crypto.mjs'

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}：${err?.message ?? err}`)
  }
}

const key = randomBytes(32)
const other = randomBytes(32)

ok('信封往返：加密再解密拿到原值', () => {
  const env = encryptJson(key, { a: 1, b: ['中', 2] })
  assert.equal(env.e, 1)
  assert.deepEqual(decryptJson(key, env), { a: 1, b: ['中', 2] })
})

ok('不是信封 → 无效的加密信封', () => {
  assert.throws(() => decryptJson(key, null), /无效的加密信封/)
  assert.throws(() => decryptJson(key, { e: 2 }), /无效的加密信封/)
})

ok('iv 长度不对 → 说清楚是 iv，而不是 node 的内部消息', () => {
  const env = encryptJson(key, { a: 1 })
  env.iv = randomBytes(8).toString('base64')
  assert.throws(() => decryptJson(key, env), /iv 长度不对：8/)
})

ok('tag 长度不对 → 说清楚是 tag', () => {
  const env = encryptJson(key, { a: 1 })
  env.tag = randomBytes(4).toString('base64')
  assert.throws(() => decryptJson(key, env), /tag 长度不对：4/)
})

ok('内容被改动 → 校验失败', () => {
  const env = encryptJson(key, { a: 1 })
  const raw = Buffer.from(env.ct, 'base64')
  raw[0] ^= 0xff
  env.ct = raw.toString('base64')
  assert.throws(() => decryptJson(key, env), /校验失败/)
})

ok('两端密钥不一致 → 校验失败（不是崩）', () => {
  const env = encryptJson(key, { a: 1 })
  assert.throws(() => decryptJson(other, env), /校验失败/)
})

ok('帧往返', () => {
  const plain = Buffer.from('hello frame')
  const payload = encodeFrame(key, 0, plain).subarray(4)
  assert.equal(decodeFrame(key, 0, payload).toString(), 'hello frame')
})

ok('帧太短 → 长度非法（带最小长度）', () => {
  assert.throws(() => decodeFrame(key, 0, Buffer.alloc(20)), /帧长度非法：20（至少 28）/)
})

ok('帧序号不对 → 校验失败并点名是第几帧', () => {
  const payload = encodeFrame(key, 5, Buffer.from('x')).subarray(4)
  assert.throws(() => decodeFrame(key, 0, payload), /第 0 帧校验失败/)
})

ok('声明的帧长为 0 时立刻报错，而不是无限等', () => {
  const dec = new FrameDecoder(key)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(0, 0)
  assert.throws(() => dec.push(head), /帧长度非法：0/)
})

ok('声明的帧长超大时立刻报错', () => {
  const dec = new FrameDecoder(key)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(9 * 1024 * 1024, 0)
  assert.throws(() => dec.push(head), /帧过大/)
})

ok('多帧一次喂进去按序解出（对照组）', () => {
  const dec = new FrameDecoder(key)
  const buf = Buffer.concat([encodeFrame(key, 0, Buffer.from('a')), encodeFrame(key, 1, Buffer.from('b'))])
  const out = dec.push(buf).map((b) => b.toString()).join('')
  assert.equal(out, 'ab')
  dec.end()
})

console.log(`crypto-guard ok · ${pass} 项断言 · 信封形状 / 篡改 / 换钥 / 帧长度 / 帧序号（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
