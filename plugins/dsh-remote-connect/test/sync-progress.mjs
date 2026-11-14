#!/usr/bin/env node
/**
 * 同步任务的进度字段：两个方向都得有字节数、总量和「当前文件」。
 *
 * 以前只有推送方向能显示这些——拉取的进度由本地 applier 平铺在顶层，
 * 而任务表只认 `remote.*`，于是拉取时列表上永远写着 0 字节、没有当前文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-progress-'))
fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
fs.writeFileSync(path.join(home, 'skills', 'a.md'), 'hello progress\n')
process.env.DEVICE_LINK_DSH_HOME = home

const { LinkService } = await import('../host/service.mjs')

let pass = 0
let fail = 0
const expect = (label, fn) => {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err.message}`)
  }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const store = {
  get: async () => ({ sync: { includeCredentials: true, maxFileMb: 64, maxTotalMb: 64 } }),
}

function service(peer) {
  const svc = new LinkService({ logger: quiet, store })
  svc.ensureConnected = async () => peer
  svc.clients.set('p1', peer)
  return svc
}

async function settle(svc, id) {
  for (let i = 0; i < 200; i += 1) {
    const v = svc.task(id)
    if (v && (v.phase === 'done' || v.phase === 'failed' || v.phase === 'cancelled')) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  return svc.task(id)
}

/* ---------------------------------------------------------------- */
/* 推送：进度来自对端的 /progress（放在 remote 里）                  */
/* ---------------------------------------------------------------- */

const pushPeer = {
  async push({ onProgress }) {
    onProgress?.({ phase: 'preparing', done: 0, total: 2048 })
    onProgress?.({ phase: 'uploading', done: 1024, total: 2048 })
    onProgress?.({
      phase: 'applying',
      done: 2048,
      total: 2048,
      remote: { bytes: 1536, totalBytes: 2048, current: 'skills/a.md' },
    })
    onProgress?.({ phase: 'done', done: 2048, total: 2048, result: { files: 1, bytes: 2048 } })
    return { files: 1, bytes: 2048 }
  },
}

const svcPush = service(pushPeer)
const pushTask = await svcPush.startSync({ peerId: 'p1', direction: 'push', cats: ['skills'] })
const pushView = await settle(svcPush, pushTask.id)

expect('推送：状态收尾为 done', () => pushView.phase === 'done')
expect('推送：字节数取自对端 remote.bytes', () => pushView.bytes === 1536)
expect('推送：当前文件取自对端 remote.current', () => pushView.detail === 'skills/a.md')
expect('推送：总量取自对端 remote.totalBytes', () => pushView.totalBytes === 2048)
expect('推送：结果标了方向', () => pushView.result?.direction === 'push')

/* ---------------------------------------------------------------- */
/* 拉取：进度由本地 applier 平铺在顶层                              */
/* ---------------------------------------------------------------- */

const pullPeer = {
  async pull({ onProgress }) {
    onProgress?.({ phase: 'preparing', done: 0, total: 0 })
    onProgress?.({ phase: 'downloading', done: 0, total: 4096, totalBytes: 4096, bytes: 0 })
    onProgress?.({
      phase: 'applying',
      id: 's1',
      bytes: 2048,
      totalBytes: 4096,
      total: 4096,
      current: 'rules/x.md',
    })
    onProgress?.({ phase: 'done', files: 3, bytes: 4096, total: 4096, totalBytes: 4096 })
    // 收尾之后再来一条空事件：不该把已经记下的字节数、当前文件清掉
    onProgress?.({})
    return { files: 3, bytes: 4096 }
  },
}

const svcPull = service(pullPeer)
const pullTask = await svcPull.startSync({ peerId: 'p1', direction: 'pull', cats: ['skills'] })
const pullView = await settle(svcPull, pullTask.id)

expect('拉取：状态收尾为 done', () => pullView.phase === 'done')
expect('拉取：字节数不再留 0', () => pullView.bytes === 4096)
expect('拉取：当前文件不再为空', () => pullView.detail === 'rules/x.md')
expect('拉取：总量不再留 0', () => pullView.totalBytes === 4096)
expect('拉取：结果里带文件数与字节数', () => pullView.result?.files === 3 && pullView.result?.bytes === 4096)

/* ---------------------------------------------------------------- */
/* 空事件不该把已有数字清零                                          */
/* ---------------------------------------------------------------- */

expect('空事件不清零已有进度', () => pullView.bytes === 4096 && pullView.detail === 'rules/x.md')
expect('空事件不改写状态与总量', () => pullView.phase === 'done' && pullView.totalBytes === 4096)

fs.rmSync(home, { recursive: true, force: true })

console.log(
  `sync-progress ok · ${pass + fail} 项断言 · 推送 / 拉取 / 空事件（${pass} 通过、${fail} 失败）`,
)
if (fail > 0) process.exit(1)
