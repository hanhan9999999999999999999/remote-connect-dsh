/**
 * dsh-remote-connect · 加密帧流的边界测试
 *
 * 帧流是同步的传输层：长度头 + AES-GCM 密文，帧序号做 AAD。
 * 要确认的是——切在任意字节边界都能解、顺序被换或内容被改一定报错、半帧不能当正常结束。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { FrameDecoder, encodeFrame } from '../host/crypto.mjs'
import { FrameDecoderTransform, FrameEncoderTransform, decodeFrames } from '../host/frames.mjs'
import { createGzip } from 'node:zlib'

const key = randomBytes(32)
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

/** 跑一遍 输入 → FrameEncoderTransform → 字节 → FrameDecoderTransform → 输出 */
async function roundtrip(chunks, { splitAt = 0 } = {}) {
  const wire = []
  await pipeline(Readable.from(chunks), new FrameEncoderTransform(key), async function* (source) {
    for await (const buf of source) wire.push(buf)
  })
  const bytes = Buffer.concat(wire)
  const out = []
  let stream = Readable.from(
    splitAt > 0
      ? (function* () {
          for (let i = 0; i < bytes.length; i += splitAt) yield bytes.subarray(i, i + splitAt)
        })()
      : [bytes],
  )
  await pipeline(stream, new FrameDecoderTransform(key), async function* (source) {
    for await (const buf of source) out.push(buf)
  })
  return { out: Buffer.concat(out), bytes }
}

console.log('frames')

await ok('单帧往返：内容原样回来', async () => {
  const payload = Buffer.from('hello frame 你好')
  const frame = encodeFrame(key, 0, payload)
  const decoder = new FrameDecoder(key)
  const out = decoder.push(frame)
  decoder.end()
  assert.equal(out.length, 1)
  assert.equal(out[0].toString('utf8'), payload.toString('utf8'))
})

await ok('一次塞多帧、按顺序全部解出', async () => {
  const a = encodeFrame(key, 0, Buffer.from('first'))
  const b = encodeFrame(key, 1, Buffer.from('second'))
  const c = encodeFrame(key, 2, Buffer.from('third'))
  const decoder = new FrameDecoder(key)
  const out = decoder.push(Buffer.concat([a, b, c]))
  decoder.end()
  assert.deepEqual(out.map((x) => x.toString('utf8')), ['first', 'second', 'third'])
})

await ok('切在任意字节边界都能拼回来', async () => {
  const payload = Buffer.from('切一半也要能解出来，哪怕一个字节一个字节喂进来。'.repeat(3))
  const wanted = payload.toString('utf8')
  for (const splitAt of [1, 3, 7, 64]) {
    const { out } = await roundtrip([payload], { splitAt })
    assert.equal(out.toString('utf8'), wanted, `splitAt=${splitAt} 时内容不一致`)
  }
})

await ok('多块输入经 Transform 往返后逐字节一致', async () => {
  const chunks = [Buffer.alloc(1024, 7), Buffer.from('中间一块'), Buffer.alloc(65_536, 9)]
  const { out, bytes } = await roundtrip(chunks, { splitAt: 4096 })
  assert.equal(out.length, 1024 + Buffer.byteLength('中间一块') + 65_536)
  assert.ok(out.equals(Buffer.concat(chunks)))
  assert.ok(bytes.length > out.length, '线上字节应当比明文多（长度头 + iv + tag）')
})

await ok('密文被改动一个字节就解不出来', async () => {
  const frame = encodeFrame(key, 0, Buffer.from('tamper me'))
  frame[frame.length - 1] ^= 0xff
  const decoder = new FrameDecoder(key)
  assert.throws(() => decoder.push(frame))
})

await ok('帧序号被换掉（重放/乱序）就解不出来', async () => {
  const frame = encodeFrame(key, 5, Buffer.from('out of order'))
  const decoder = new FrameDecoder(key) // 期望序号 0
  assert.throws(() => decoder.push(frame), /authenticate|Unsupported state|unable to/i)
})

await ok('声明的长度超过上限直接报错', async () => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(9 * 1024 * 1024, 0)
  const decoder = new FrameDecoder(key)
  assert.throws(() => decoder.push(Buffer.concat([head, Buffer.alloc(16)])), /帧过大/)
})

await ok('半截帧不许当正常结束', async () => {
  const frame = encodeFrame(key, 0, Buffer.from('a longer payload to truncate'))
  const decoder = new FrameDecoder(key)
  decoder.push(frame.subarray(0, 10))
  assert.throws(() => decoder.end(), /帧流被截断/)
})

await ok('空流往返不产生任何输出', async () => {
  const { out } = await roundtrip([])
  assert.equal(out.length, 0)
})

/* decodeFrames：线上是「加密帧套着 gzip」，两头都要自己收场 */
const gzipOf = async (buf) =>
  new Promise((resolve, reject) => {
    const gz = createGzip()
    const parts = []
    gz.on('data', (c) => parts.push(c))
    gz.on('end', () => resolve(Buffer.concat(parts)))
    gz.on('error', reject)
    gz.end(buf)
  })

await ok('decodeFrames 把帧流解回原样', async () => {
  const plain = Buffer.from('hello 帧流 · decodeFrames · 你好')
  const wire = Buffer.concat([encodeFrame(key, 0, await gzipOf(plain))])
  const link = decodeFrames(Readable.from([wire]), key)
  const parts = []
  for await (const chunk of link.stream) parts.push(chunk)
  link.destroy()
  assert.equal(Buffer.concat(parts).toString('utf8'), plain.toString('utf8'))
})

await ok('decodeFrames 遇到解不开的帧时报错，而不是把进程抛死', async () => {
  const link = decodeFrames(Readable.from([Buffer.alloc(64 * 1024, 7)]), key)
  await assert.rejects(async () => {
    for await (const chunk of link.stream) void chunk
  }, /帧过大|invalid|unexpected/i)
  link.destroy()
})

console.log(`frames ok · ${pass} 项断言 · 往返 / 分片 / 篡改 / 乱序 / 超长 / 截断 / 解码链（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
