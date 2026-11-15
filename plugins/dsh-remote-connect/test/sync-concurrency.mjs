#!/usr/bin/env node
/**
 * 同步的并发边界。
 *
 * 每条同步都要读文件、算哈希、走一条长连接，还要在对端立一个批次。没有上限时，
 * 界面上连点十下就是十条同时在跑：磁盘互相抢、对端连接数被推高，而且同一台设备
 * 的两条同步会落在同一批文件上——谁后写谁赢，用户看到的是「同步成功了但内容不对」。
 *
 * 这一组断言盯三件事：全局有上限、同一台设备同时只跑一条、前面结束了新的还能开始。
 *
 * 用法：node test/sync-concurrency.mjs [host/service.mjs 路径]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-sync-concurrency-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const serviceUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/service.mjs', import.meta.url).href
const { LinkService } = await import(serviceUrl)
const { ConfigStore } = await import(new URL('../host/config.mjs', import.meta.url).href)
const { PeerStore } = await import(new URL('../host/peers.mjs', import.meta.url).href)
void here

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    console.log(`  PASS ${label}`)
    pass += 1
  } catch (err) {
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(err?.message ?? err).split('\n')[0]}`)
    fail += 1
  }
}

const quiet = { info() {}, warn() {}, error() {} }

/** 一个永远不结束的 peer：同步会一直挂在「上传中」，正好用来占满位置。 */
function hangingPeer() {
  return {
    pull: () => new Promise(() => {}),
    push: () => new Promise(() => {}),
    disconnect: async () => {},
    abort: () => {},
  }
}

let seq = 0
async function makeService(options = {}) {
  seq += 1
  const store = new ConfigStore()
  await store.load()
  const peerStore = new PeerStore(path.join(home, `peers-c${seq}.json`))
  const svc = new LinkService({ store, peerStore, logger: quiet, ...options })
  svc.init = async () => {}
  svc.ensureConnected = async () => hangingPeer()
  return svc
}

const svc = await makeService()

await ok('默认同时最多 3 条同步', () => {
  assert.equal(svc.maxConcurrentSyncs, 3, `实际 ${svc.maxConcurrentSyncs}`)
})

await ok('不同设备可以各跑一条，到上限之后第 4 条被明确拒绝', async () => {
  const a = svc.startSync({ peerId: 'p1' })
  const b = svc.startSync({ peerId: 'p2' })
  const c = svc.startSync({ peerId: 'p3' })
  assert.ok(a.id && b.id && c.id)
  assert.throws(
    () => svc.startSync({ peerId: 'p4' }),
    (err) => err.code === 'SYNC_BUSY' && /同时最多 3 个同步/.test(err.message),
    '第 4 条应当被拒',
  )
  const running = svc.tasks.listRefs().filter((t) => !t.finishedAt)
  assert.equal(running.length, 3, `实际 ${running.length}`)
})

await ok('同一台设备同时只允许一条（第二条明确说等它结束）', async () => {
  const svc2 = await makeService({ maxConcurrentSyncs: 5 })
  svc2.startSync({ peerId: 'same' })
  assert.throws(
    () => svc2.startSync({ peerId: 'same', direction: 'pull' }),
    (err) => err.code === 'SYNC_BUSY' && /还有一个同步没结束/.test(err.message),
    '同一台设备的第二条应当被拒',
  )
  const mine = svc2.tasks.listRefs().filter((t) => t.peerId === 'same')
  assert.equal(mine.length, 1, `实际 ${mine.length} 条`)
})

await ok('前面那条结束之后，同一台设备可以再开始', async () => {
  const svc3 = await makeService({ maxConcurrentSyncs: 1 })
  const first = svc3.startSync({ peerId: 'p' })
  await svc3.cancelTask(first.id)
  const t = svc3.tasks.get(first.id)
  if (!t.finishedAt) {
    // 假 peer 的 abort 不会让 promise 结束，这里手动落终态模拟「收尾完成」
    t.finishedAt = Date.now()
    t.phase = 'cancelled'
  }
  const second = svc3.startSync({ peerId: 'p' })
  assert.ok(second.id)
  assert.notEqual(second.id, first.id)
})

await ok('上限可以调：给 1 就只有 1 条能跑', async () => {
  const svc4 = await makeService({ maxConcurrentSyncs: 1 })
  svc4.startSync({ peerId: 'x' })
  assert.throws(
    () => svc4.startSync({ peerId: 'y' }),
    (err) => err.code === 'SYNC_BUSY',
    '上限 1 时第二条应当被拒',
  )
})

console.log(
  `sync-concurrency ok · 5 项断言 · 默认上限 / 全局上限 / 同设备互斥 / 结束可续 / 可调（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
