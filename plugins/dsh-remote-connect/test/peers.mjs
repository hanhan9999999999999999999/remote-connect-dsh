/**
 * dsh-remote-connect · 记住的对端（peers.json）
 *
 * 这个文件是手改得动的，所以两种情况都得撑住：
 * 里面混进怪记录时不能把整个插件带崩；多个同步同时写时不能互相覆盖。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PeerStore } from '../host/peers.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-peers-'))
process.env.DEVICE_LINK_HOME = dir

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

let seq = 0
const fresh = async (content) => {
  const file = path.join(dir, `peers-${(seq += 1)}.json`)
  if (content !== undefined) await fs.writeFile(file, content, 'utf8')
  return { file, store: new PeerStore(file) }
}

const record = (over = {}) => ({
  name: '甲',
  host: '127.0.0.1',
  port: 8788,
  scheme: 'http',
  deviceId: 'dev_a',
  ...over,
})

console.log('peers')

await ok('第一次是空的，加一条之后能从盘上读回来', async () => {
  const { file, store } = await fresh()
  assert.deepEqual(await store.list(), [])
  const saved = await store.upsert(record())
  assert.equal(saved.host, '127.0.0.1')
  const reloaded = await new PeerStore(file).load()
  const list = await reloaded.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].port, 8788)
})

await ok('文件里混进怪记录时只丢掉坏的那几条', async () => {
  const { store } = await fresh(
    JSON.stringify([null, 'not-a-record', { id: 'x' }, { host: 'h', port: 0 }, record({ id: 'good', name: '好的' })]),
  )
  const list = await store.list()
  assert.equal(list.length, 1, `应只剩一条，实际 ${JSON.stringify(list)}`)
  assert.equal(list[0].name, '好的')
})

await ok('文件不是数组时挪到 .broken-* 再从空的开始', async () => {
  const { file, store } = await fresh('{"oops": true}')
  assert.deepEqual(await store.list(), [])
  const names = await fs.readdir(path.dirname(file))
  assert.ok(
    names.some((name) => name.startsWith(path.basename(file) + '.broken-')),
    `应当留一份 .broken-*：${names.join(', ')}`,
  )
})

await ok('并发写入不会互相覆盖（最终文件是合法 JSON 且记录都在）', async () => {
  const { file, store } = await fresh()
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.upsert(record({ host: `10.0.0.${i + 1}`, deviceId: `dev_${i}`, name: `机器${i}` }))),
  )
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(raw.length, 8, `应有 8 条，实际 ${raw.length}`)
  assert.equal((await store.list()).length, 8)
})

await ok('同一台机器再连一次是更新，不是新增', async () => {
  const { store } = await fresh()
  const first = await store.upsert(record())
  const again = await store.upsert(record({ name: '改过名' }))
  assert.equal(again.id, first.id)
  assert.equal(again.name, '改过名')
  assert.equal((await store.list()).length, 1)
})

await ok('字段超长会被截断，scheme 只认 http/https', async () => {
  const { store } = await fresh()
  const saved = await store.upsert(record({ name: 'n'.repeat(200), scheme: 'file:', deviceId: 'd'.repeat(200) }))
  assert.equal(saved.name.length, 64)
  assert.equal(saved.scheme, 'http')
  assert.equal(saved.deviceId.length, 64)
})

await ok('补丁只改指定字段，删除是真的删掉', async () => {
  const { store } = await fresh()
  const saved = await store.upsert(record())
  const patched = await store.patch(saved.id, { lastError: '连不上', autoConnect: true })
  assert.equal(patched.lastError, '连不上')
  assert.equal(patched.host, '127.0.0.1')
  await store.remove(saved.id)
  assert.deepEqual(await store.list(), [])
})

await ok('列表不泄露口令与密钥', async () => {
  const { store } = await fresh()
  await store.upsert(record({ password: 'secret', token: 'tok', sk: 'a2', expiresAt: Date.now() + 60_000 }))
  const [view] = await store.list()
  for (const key of ['password', 'token', 'sk']) assert.ok(!(key in view), `不该出现 ${key}`)
  assert.equal(view.rememberPassword, true)
  assert.equal(view.connected, true)
})

console.log(`peers ok · 8 项断言 · 落盘 / 坏记录 / 备份 / 并发 / 去重 / 截断 / 补丁 / 不外泄（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
