/**
 * dsh-remote-connect · 同步任务的收尾状态
 *
 * 任务只有一个收尾点（成功 / 失败 / 取消）。用户点了取消之后，
 * 界面上就不能再冒出「失败」或「完成」——这里把这三种收尾都逼一遍。
 */
import assert from 'node:assert/strict'
import { LinkService } from '../host/service.mjs'

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

const quiet = { info() {}, warn() {}, error() {} }
const store = { get: async () => ({ sync: { includeCredentials: false } }) }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** 造一个 LinkService，把「连对端」这一步换掉，剩下的编排逻辑跑真的。 */
function service(peer) {
  const svc = new LinkService({ logger: quiet, store })
  svc.ensureConnected = async () => peer
  svc.clients.set('p1', peer)
  return svc
}

/** 假对端：pull 一直挂着，直到被 abort 或手动完成。 */
function pendingPeer() {
  const peer = {
    aborted: false,
    settle: null,
    resolve: null,
    abort() {
      peer.aborted = true
      peer.settle?.(Object.assign(new Error('连接被中断'), { code: 'NETWORK' }))
    },
    pull() {
      return new Promise((resolve, reject) => {
        peer.resolve = resolve
        peer.settle = reject
      })
    },
  }
  return peer
}

console.log('sync-cancel')

await ok('取消后任务是 cancelled，不会被写成 failed', async () => {
  const peer = pendingPeer()
  const svc = service(peer)
  const view = svc.startSync({ peerId: 'p1', direction: 'pull' })
  await tick()
  assert.equal(svc.task(view.id).phase, 'preparing')

  const asked = await svc.cancelTask(view.id)
  assert.equal(asked.phase, 'cancelling', '取消的瞬间应显示 cancelling')
  assert.equal(peer.aborted, true, '应当真的把对端的连接掐掉')

  await tick()
  const settled = svc.task(view.id)
  assert.equal(settled.phase, 'cancelled')
  assert.equal(settled.error, undefined, '取消不该带一条「失败」的错误信息')
  assert.ok(settled.finishedAt > 0)
})

await ok('正常完成就是 done，之后再点取消也不改', async () => {
  const peer = pendingPeer()
  const svc = service(peer)
  const view = svc.startSync({ peerId: 'p1', direction: 'pull' })
  await tick()
  peer.resolve({ files: 2, bytes: 10 })
  await tick()
  const done = svc.task(view.id)
  assert.equal(done.phase, 'done')
  assert.equal(done.result.files, 2)

  const again = await svc.cancelTask(view.id)
  assert.equal(again.phase, 'done', '已完成的任务不该被取消改写')
})

await ok('真失败才写 failed，并带上错误码', async () => {
  const peer = pendingPeer()
  const svc = service(peer)
  const view = svc.startSync({ peerId: 'p1', direction: 'pull' })
  await tick()
  peer.settle(Object.assign(new Error('对端没响应'), { code: 'NETWORK' }))
  await tick()
  const bad = svc.task(view.id)
  assert.equal(bad.phase, 'failed')
  assert.match(bad.error, /^NETWORK: 对端没响应$/)
})

await ok('没连上就失败的任务也会落终态', async () => {
  const svc = new LinkService({ logger: quiet, store })
  svc.ensureConnected = async () => {
    throw Object.assign(new Error('需要密码'), { code: 'NEED_PASSWORD' })
  }
  const view = svc.startSync({ peerId: 'ghost', direction: 'pull' })
  await tick()
  const bad = svc.task(view.id)
  assert.equal(bad.phase, 'failed')
  assert.match(bad.error, /NEED_PASSWORD/)
})

console.log(`sync-cancel ok · 4 项断言 · 取消 / 完成 / 失败 / 连不上（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
