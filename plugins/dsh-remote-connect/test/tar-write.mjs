/**
 * dsh-remote-connect · tar 写入侧
 *
 * 接收端那半边已经防得很严，可发送端以前会悄悄写出「自己也解析不了」的包：
 *  - 名字超过 100 字节时，头里的 name 被 Buffer.write 默默截掉，与 pax 里的路径不一致
 *  - 数值放不进字段宽度（例如把毫秒当秒传进去的 mtime）时，后几位被截掉，写出来的头是错的
 *  - 长路径的退路名把末尾 40 个字符写了两遍
 */
import assert from 'node:assert/strict'
import { TarParser, makeHeader, tarEntries } from '../host/tar.mjs'

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

async function collect(entries) {
  const chunks = []
  for await (const chunk of tarEntries(entries)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function parseAll(buf) {
  const seen = []
  const handler = async (meta) => {
    seen.push({ rel: meta.rel, size: meta.size, hash: meta.hash })
    return { write: async () => {}, end: async () => {} }
  }
  const parser = new TarParser(handler)
  await parser.feed(buf)
  await parser.end()
  return seen
}

await ok('名字超过 100 字节时 makeHeader 直接报错，不再悄悄截断', async () => {
  assert.throws(() => makeHeader({ name: '长'.repeat(60), size: 0 }), /超过 100 字节/)
})

await ok('正好 100 字节的名字写得进去、解得回来', async () => {
  const name = 'a'.repeat(100)
  const header = makeHeader({ name, size: 0 })
  assert.equal(header.toString('utf8', 0, 100), name)
  assert.equal(header[124] === 0x30 || header[124] === 0x00, true)
})

await ok('数值放不进字段宽度时报错（把毫秒当秒传进来的 mtime）', async () => {
  assert.throws(() => makeHeader({ name: 'a', size: 0, mtime: 1e18 }), /放不进/)
})

await ok('负数/NaN 的数值直接拒绝', async () => {
  assert.throws(() => makeHeader({ name: 'a', size: -1 }), /数值不合法/)
  assert.throws(() => makeHeader({ name: 'a', size: Number.NaN }), /数值不合法/)
})

await ok('长中文路径：pax 带全名，头里的退路名不重复字符且是尾部', async () => {
  const name = `dir/中文${'A'.repeat(60)}/tail-${'B'.repeat(50)}`
  const buf = await collect([{ rel: name, bytes: Buffer.from('hi'), size: 2, mtime: 0 }])
  const seen = await parseAll(buf)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].rel, name)

  // 第二个块（跳过一个 pax 数据块）是真正的文件头
  const blocks = []
  for (let off = 0; off + 512 <= buf.length; off += 512) blocks.push(buf.subarray(off, off + 512))
  const fileHeader = blocks.find((b) => String.fromCharCode(b[156]) === '0')
  assert.ok(fileHeader, '应当有文件头')
  const fallback = fileHeader.toString('utf8', 0, 100).replace(/\0.*$/, '')
  assert.ok(Buffer.byteLength(fallback, 'utf8') <= 100)
  assert.ok(fallback.endsWith('B'.repeat(50)), `退路名应当以文件名结尾，实际：${fallback}`)
  assert.equal((fallback.match(/B{50}/g) || []).length, 1, '末尾不该被写两遍')
  assert.ok(name.endsWith(fallback), '退路名应当是原名的尾部')
})

await ok('普通 ASCII 短路径照旧（对照组）', async () => {
  const buf = await collect([{ rel: 'skills/a.md', bytes: Buffer.from('x'), size: 1, mtime: 0 }])
  const seen = await parseAll(buf)
  assert.equal(seen[0].rel, 'skills/a.md')
})

console.log(`tar-write ok · ${pass} 项断言 · 超长名字 / 100 字节边界 / 数值宽度 / 非法数值 / 退路名 / 对照组（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
