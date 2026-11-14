#!/usr/bin/env node
// 面板每隔几秒调一次状态，而"最近批次"要逐个批次读 journal.json：
// 批次一多，等于每次轮询把整个 syncs/ 翻一遍。这里钉住缓存的三件事：
// 短时间内不重复翻目录、新增/回滚之后立刻能看到、不同 limit 不会互相污染。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-local-syncs-'))
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { Applier } = await import('../host/apply.mjs')

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
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const logger = { info() {}, warn() {}, error() {} }
function applier(ttl) {
  const a = new Applier({ logger, dataHome: path.join(home, 'data'), sync: { backupKeep: 3 } })
  if (ttl !== undefined) a.recentTtlMs = ttl
  return a
}

async function seed(id, createdAt) {
  const dir = path.join(home, 'data', 'syncs', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({ id, from: 'peer', createdAt, files: 1, bytes: 10, replaced: 0, created: 1, skipped: 0 }),
  )
}

await seed('s_old', 1000)
await seed('s_new', 3000)
await seed('s_mid', 2000)

await ok('第一次读盘，第二次走缓存（不重复翻目录）', async () => {
  const a = applier(5000)
  const first = await a.listRecent(10)
  assert(first.length === 3, `应当读到 3 条，实际 ${first.length}`)
  assert(a.recentReads === 1, `第一次应当读盘一次，实际 ${a.recentReads}`)
  const second = await a.listRecent(10)
  assert(a.recentReads === 1, `缓存期内不该再读盘，实际 ${a.recentReads}`)
  assert(second.map((r) => r.id).join(',') === first.map((r) => r.id).join(','), '两次结果应当一致')
})

await ok('按创建时间倒序，limit 在缓存之上裁剪', async () => {
  const a = applier(5000)
  const rows = await a.listRecent(2)
  assert(rows.length === 2, `limit 应当生效，实际 ${rows.length}`)
  assert(rows[0].id === 's_new' && rows[1].id === 's_mid', `顺序不对：${rows.map((r) => r.id)}`)
  const again = await a.listRecent(3)
  assert(again.length === 3, '换 limit 后仍从同一份缓存里取全量')
  assert(a.recentReads === 1, '换 limit 不该触发重新读盘')
})

await ok('新增批次之后立刻能看到（prepare 会让缓存失效）', async () => {
  const a = applier(5000)
  await a.listRecent(10)
  assert(a.recentReads === 1, '先确认进了缓存')
  await a.prepare({ from: 'peer-x', meta: { totalBytes: 0, totalFiles: 0 } })
  const rows = await a.listRecent(10)
  assert(rows.some((r) => r.incomplete === true), `新建的批次应当出现在列表里：${JSON.stringify(rows)}`)
  assert(a.recentReads === 2, `prepare 之后应当重新读盘，实际 ${a.recentReads}`)
})

await ok('TTL 过去之后自己失效，不会一直给旧数据', async () => {
  const a = applier(30)
  await a.listRecent(10)
  assert(a.recentReads === 1, '先确认进了缓存')
  await new Promise((r) => setTimeout(r, 60))
  await a.listRecent(10)
  assert(a.recentReads === 2, `过了 TTL 应当重新读盘，实际 ${a.recentReads}`)
})

await ok('syncs 目录还不存在时返回空表，不抛错', async () => {
  const bare = new Applier({ logger, dataHome: path.join(home, 'nowhere'), sync: {} })
  const rows = await bare.listRecent(5)
  assert(Array.isArray(rows) && rows.length === 0, `应当返回空数组，实际 ${JSON.stringify(rows)}`)
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `local-syncs ok · ${pass} 项断言 · 缓存命中 / 倒序裁剪 / 新增失效 / TTL 失效 / 空目录（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
