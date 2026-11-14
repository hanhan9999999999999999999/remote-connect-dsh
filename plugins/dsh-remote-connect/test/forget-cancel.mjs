#!/usr/bin/env node
// 断开 / 删除一台正在同步的设备：任务要跟着结束，不能挂在「准备中」永远转着。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-forget-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const { PeerStore } = await import('../host/peers.mjs')
const { LinkService } = await import('../host/service.mjs')

let pass = 0
let fail = 0
async function expect(label, fn) {
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

const quiet = { info() {}, warn() {}, error() {} }
const homeCfg = new ConfigStore()
await homeCfg.load()

// 一个「同步一直不回来」的假对端：只有被 abort 才会 reject
function hangingPeer(id) {
  let settle = () => {}
  const pending = new Promise((_, reject) => {
    settle = (err) => reject(err)
  })
  const peer = {
    record: { id, host: '127.0.0.1', port: 1234, name: 'demo' },
    session: { token: 'tok', sk: Buffer.alloc(32, 1), expiresAt: Date.now() + 3600_000 },
    aborted: false,
    async disconnect() {
      // 真实现会 close() 掐掉 agent；这里故意什么都不做，逼任务只能靠 abortNow 收尾
    },
    abort() {
      peer.aborted = true
      const err = new Error('连接被中断')
      err.code = 'NETWORK'
      settle(err)
    },
    async pull() {
      return await pending
    },
    async push() {
      return await pending
    },
    async requestJson() {
      throw new Error('不该被调用')
    },
  }
  return peer
}

async function makeService(peerId, { withRecord = true } = {}) {
  const peerStore = new PeerStore(path.join(home, `peers-${peerId}-${Date.now()}.json`))
  await peerStore.load()
  const svc = new LinkService({ store: homeCfg, peerStore, logger: quiet })
  svc.init = async () => {}
  const peer = hangingPeer(peerId)
  svc.ensureConnected = async () => peer
  svc.clients.set(peerId, peer)
  if (withRecord) {
    await peerStore.upsert({
      id: peerId,
      host: '127.0.0.1',
      port: 1234,
      name: 'demo',
      deviceId: 'dev_' + peerId,
      password: 'secret',
    })
  }
  return { svc, peer, peerStore }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) 删掉设备：任务跟着取消，记录也确实没了
await expect('删除设备时，它正在跑的任务会变成已取消', async () => {
  const { svc, peer, peerStore } = await makeService('p-forget')
  const task = svc.startSync({ peerId: 'p-forget', direction: 'pull', cats: ['skills'] })
  await wait(30)
  assert(svc.tasks.view(task.id).phase !== 'cancelled', '任务不该一开始就是取消态')
  await svc.forget('p-forget')
  await wait(60)
  const view = svc.tasks.view(task.id)
  assert(peer.aborted, '删除设备时应当掐断这条连接')
  assert(view.phase === 'cancelled', `任务应变成 cancelled，实际 ${view.phase}`)
  assert(view.error === undefined, `取消不该带错误信息，实际 ${view.error}`)
  assert(view.finishedAt > 0, '取消也要有结束时间')
  const left = await peerStore.raw('p-forget'); assert(left === null, '删除后对端记录应已消失，实际 ' + JSON.stringify(left))
})

// 2) 断开设备：任务取消，记录还在但会话被清掉
await expect('断开设备时，任务取消且会话被清空', async () => {
  const { svc, peerStore } = await makeService('p-disc')
  await peerStore.patch('p-disc', { token: 'tok', sk: 'abc', expiresAt: Date.now() + 1000 })
  const task = svc.startSync({ peerId: 'p-disc', direction: 'pull', cats: ['skills'] })
  await wait(30)
  await svc.disconnect('p-disc')
  await wait(60)
  const view = svc.tasks.view(task.id)
  assert(view.phase === 'cancelled', `任务应变成 cancelled，实际 ${view.phase}`)
  const rec = await peerStore.raw('p-disc')
  assert(rec, '断开不等于删除，记录还应留着（方便重连）')
  assert(!rec.token && !rec.sk && !rec.expiresAt, '会话字段应被清空')
  assert(rec.password === 'secret', '密码要留着，用户下次还能一键重连')
})

// 3) 对端已经从 clients 里摘掉，再点取消也得能收尾
await expect('对端不在 clients 里时，取消仍然生效', async () => {
  const { svc, peer } = await makeService('p-gone')
  const task = svc.startSync({ peerId: 'p-gone', direction: 'pull', cats: ['skills'] })
  await wait(30)
  svc.clients.delete('p-gone') // 模拟「先断开了，界面上还挂着那条任务」
  await svc.cancelTask(task.id)
  await wait(60)
  const view = svc.tasks.view(task.id)
  assert(peer.aborted, '应该靠任务自己留的那根线掐断连接')
  assert(view.phase === 'cancelled', `任务应变成 cancelled，实际 ${view.phase}`)
})

// 4) 已经完成的任务不会被「删除设备」改写成取消
await expect('已完成的任务不会被改写成取消', async () => {
  const { svc, peerStore } = await makeService('p-done')
  const task = svc.startSync({ peerId: 'p-done', direction: 'pull', cats: ['skills'] })
  await wait(20)
  // 让它在正常路径上结束
  svc.tasks.get(task.id).phase = 'done'
  svc.tasks.get(task.id).finishedAt = Date.now()
  await svc.forget('p-done')
  await wait(40)
  const view = svc.tasks.view(task.id)
  assert(view.phase === 'done', `已完成的任务不该被改写，实际 ${view.phase}`)
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `forget-cancel ok · 4 项断言 · 删除 / 断开 / 对端已摘除 / 已完成不改写（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
