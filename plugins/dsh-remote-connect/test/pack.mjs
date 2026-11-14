/**
 * dsh-remote-connect · 打包与哈希缓存的边界测试
 *
 * 三件事容易出事：清单已经知道总量了却还逐个哈希完才报超限、缓存文件载入时比上限大、
 * 缓存键（rel|size|mtime）命中时到底是复用还是重算。这里都在本机临时目录里跑真文件。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-pack-home-'))
process.env.DEVICE_LINK_DSH_HOME = home
const skillsDir = path.join(home, 'skills')
await fs.mkdir(skillsDir, { recursive: true })
const aText = 'hello pack\n'
const bText = 'second file 第二个\n'
await fs.writeFile(path.join(skillsDir, 'a.md'), aText)
await fs.writeFile(path.join(skillsDir, 'b.txt'), bText)

const { preparePack, packStream, PackCache, CACHE_LIMIT } = await import('../host/pack.mjs')

const sha = (text) => createHash('sha256').update(text).digest('hex')

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

const newCache = () => new PackCache(path.join(home, `cache-${Math.random().toString(16).slice(2)}.json`))

console.log('pack')

await ok('缓存键形状与读写', async () => {
  const cache = newCache()
  assert.equal(cache.key('skills/a.md', 11, 1700000000000), 'skills/a.md|11|1700000000000')
  cache.set(cache.key('x', 1, 2), 'deadbeef')
  assert.equal(cache.get(cache.key('x', 1, 2)), 'deadbeef')
  assert.equal(cache.get(cache.key('y', 1, 2)), undefined)
  await cache.close()
})

await ok('载入时把超额的缓存裁到上限', async () => {
  const file = path.join(home, 'cache-big.json')
  const raw = {}
  for (let i = 0; i < CACHE_LIMIT + 3; i += 1) raw[`f${i}|1|1`] = `${i}`
  await fs.writeFile(file, JSON.stringify(raw), 'utf8')
  const cache = await new PackCache(file).load()
  assert.equal(cache.map.size, CACHE_LIMIT)
  // 最老的三条先掉，最新的还在
  assert.equal(cache.get('f0|1|1'), undefined)
  assert.equal(cache.get('f2|1|1'), undefined)
  assert.equal(cache.get(`f${CACHE_LIMIT + 2}|1|1`), String(CACHE_LIMIT + 2))
})

await ok('preparePack 算出的哈希与文件内容一致', async () => {
  const { manifest, entries, totalBytes } = await preparePack({ cats: ['skills'] })
  assert.equal(entries.length, 2, `条目数应为 2，实际 ${entries.length}`)
  const byRel = new Map(entries.map((e) => [e.rel, e]))
  assert.equal(byRel.get('skills/a.md').hash, sha(aText))
  assert.equal(byRel.get('skills/b.txt').hash, sha(bText))
  assert.equal(manifest.totalFiles, 2)
  assert.equal(totalBytes, Buffer.byteLength(aText) + Buffer.byteLength(bText))
  assert.equal(manifest.totalBytes, totalBytes)
  assert.ok(manifest.id && typeof manifest.id === 'string')
  // 清单里只带必要字段，不带绝对路径
  for (const entry of manifest.entries) {
    assert.ok(!('abs' in entry), '清单不该带绝对路径')
    assert.deepEqual(Object.keys(entry).sort(), ['cat', 'hash', 'mtime', 'rel', 'size'])
  }
})

await ok('缓存命中：同样大小同样的 mtime 不重算', async () => {
  const cache = newCache()
  const first = await preparePack({ cats: ['skills'], cache })
  const before = first.entries.find((e) => e.rel === 'skills/a.md')
  // 内容换掉但长度不变、mtime 改回去 —— 缓存键完全一样
  const target = path.join(skillsDir, 'a.md')
  const stat = await fs.stat(target)
  await fs.writeFile(target, 'HELLO PACK\n')
  await fs.utimes(target, stat.atime, stat.mtime)
  const second = await preparePack({ cats: ['skills'], cache })
  const after = second.entries.find((e) => e.rel === 'skills/a.md')
  assert.equal(after.hash, before.hash, '缓存命中时应复用旧哈希')
  // 换一个空缓存就必须算出新内容
  const fresh = await preparePack({ cats: ['skills'] })
  assert.equal(fresh.entries.find((e) => e.rel === 'skills/a.md').hash, sha('HELLO PACK\n'))
  // 复原
  await fs.writeFile(target, aText)
  await fs.utimes(target, stat.atime, stat.mtime)
})

await ok('总量超限在哈希之前就失败，不会白算一遍', async () => {
  const cache = newCache()
  await assert.rejects(
    () => preparePack({ cats: ['skills'], maxTotalMb: 0.000001, cache }),
    (err) => {
      assert.equal(err.code, 'TOO_LARGE')
      assert.match(err.message, /超过上限/)
      return true
    },
  )
  assert.equal(cache.map.size, 0, '早失败时不该有任何一条哈希被写进缓存')
})

await ok('packStream 产出的是 gzip 包着的 tar', async () => {
  const { entries } = await preparePack({ cats: ['skills'] })
  const chunks = []
  for await (const chunk of packStream(entries)) chunks.push(chunk)
  const gz = Buffer.concat(chunks)
  assert.equal(gz[0], 0x1f)
  assert.equal(gz[1], 0x8b)
  const tar = gunzipSync(gz)
  assert.equal(tar.length % 512, 0, 'tar 应当是 512 字节的整数倍')
  const text = tar.toString('latin1')
  assert.ok(text.includes('skills/a.md'), 'tar 里应包含文件路径')
  assert.ok(text.includes('skills/b.txt'))
})

await ok('打包途中源文件被删：报错而不是把进程抛死', async () => {
  // 以前 packStream 用 .pipe() 接 gzip：源上出错没人接，ENOENT 直接把进程抛死。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-pack-gone-'))
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true })
  await fs.writeFile(path.join(dir, 'skills', 'gone.md'), 'will disappear')
  process.env.DEVICE_LINK_DSH_HOME = dir
  const pack = await preparePack({ cats: ['skills'] })
  await fs.rm(path.join(dir, 'skills', 'gone.md'))
  await assert.rejects(async () => {
    for await (const chunk of packStream(pack.entries)) void chunk
  }, /读不到 skills\/gone\.md|ENOENT/)
})

console.log(`pack ok · ${pass} 项断言 · 缓存键 / 载入裁剪 / 哈希 / 命中 / 早失败 / 打包 / 源文件消失（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
