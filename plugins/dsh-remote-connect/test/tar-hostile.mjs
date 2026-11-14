/**
 * dsh-remote-connect · 恶意/损坏 tar 头
 *
 * 归档是「对端发来的东西」，里面每一个数字都是它说了算：
 *  - pax / GNU 长名块声明 8 GB，接收端就会在内存里攒到 8 GB（OOM）
 *  - 长度字段写成 1e30 或非数字，解析器会一直等下去
 * 这里逐条确认：坏头只会得到一个可读的错误，不会吃内存、不会挂住。
 */
import assert from 'node:assert/strict'
import { TarParser, makeHeader } from '../host/tar.mjs'

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}：${err?.message ?? err}`)
  }
}

/** 手搓一个头块（解析器不看校验和，这里只关心字段） */
function block({ name = 'x', size = '00000000000', type = '0', base256 = null } = {}) {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'utf8')
  if (base256 === null) b.write(size, 124, 12, 'ascii')
  else {
    b[124] = 0x80
    for (let i = 125; i < 136; i += 1) b[i] = 0xff
  }
  b.write(type, 156, 1, 'ascii')
  b.write('ustar\0', 257, 6, 'ascii')
  return b
}

const collector = () => {
  const seen = []
  const handler = async (meta) => {
    seen.push(meta)
    return { write: async () => {}, end: async () => {} }
  }
  return { seen, handler }
}

await ok('pax 块声明 8 GB：直接拒绝，不吃内存', async () => {
  const parser = new TarParser(collector().handler)
  // 0o77777777777 = 8589934591 字节 ≈ 8 GB
  await assert.rejects(() => parser.feed(block({ name: 'pax', type: 'x', size: '77777777777' })), /元数据块过大/)
})

await ok('GNU 长名块声明 8 GB：直接拒绝', async () => {
  const parser = new TarParser(collector().handler)
  await assert.rejects(() => parser.feed(block({ name: '././@LongLink', type: 'L', size: '77777777777' })), /长名块过大/)
})

await ok('base-256 的巨型长度：拒绝而不是当成正常值', async () => {
  const parser = new TarParser(collector().handler)
  await assert.rejects(() => parser.feed(block({ name: 'big', base256: true })), /长度不合法/)
})

/** pax 记录的长度字段包含它自己：递归算到稳定为止 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  while (String(len).length + body.length !== len) len = String(len).length + body.length
  return `${len}${body}`
}

function paxBlockFor(records) {
  const body = Buffer.from(records.join(''), 'utf8')
  const header = block({ name: 'pax', type: 'x', size: body.length.toString(8).padStart(11, '0') })
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, pad])
}

await ok('pax 里的 size 不是合法整数：拒绝，不挂住', async () => {
  const pax = paxBlockFor([paxRecord('size', 'abc')])
  const fileHeader = makeHeader({ name: 'x.txt', size: 5, mtime: 0 })
  const parser = new TarParser(collector().handler)
  await assert.rejects(() => parser.feed(Buffer.concat([pax, fileHeader])), /pax 里的长度不合法/)
})

await ok('正常的 pax 小文件仍然解析得动（对照组）', async () => {
  const pax = paxBlockFor([paxRecord('path', 'a.txt')])
  const content = Buffer.from('hello')
  const fileHeader = makeHeader({ name: 'short.txt', size: content.length, mtime: 0 })
  const filePad = Buffer.alloc((512 - (content.length % 512)) % 512)
  const end = Buffer.alloc(1024)
  const { seen, handler } = collector()
  const parser = new TarParser(handler)
  await parser.feed(Buffer.concat([pax, fileHeader, content, filePad, end]))
  await parser.end()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].rel, 'a.txt')
  assert.equal(seen[0].size, 5)
})

console.log(`tar-hostile ok · ${pass} 项断言 · pax 上限 / 长名上限 / base-256 / 坏 pax 长度 / 对照组（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
