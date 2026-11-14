#!/usr/bin/env node
// 断开 / 删除设备时，「跟对端告别」这一步失败，本地状态必须照样收干净：
// 否则 token 留在 peers.json 里、clients 里还挂着一个死 peer，界面会一直显示已连接。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-disconnect-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const { PeerStore } = await import('../host/peers.mjs')
const { LinkService } = await import('../host/service.mjs')

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

const quiet = { info() {}, warn() {}, error() {} }
const warns = []
const loud = { info() {}, warn: (scope, msg) => warns.push(`${scope}: ${msg}`), error() {} }

async function makeService(peerId) {
  const cfg = new ConfigStore()
  await cfg.load()
  const peerStore = new PeerStore(path.join(home, `peers-${peerId}-${Date.now()}.json`))
  await peerStore.load()
  const svc = new LinkService({ store: cfg, peerStore, logger: loud })
  svc.init = async () => {}
  return { svc, peerStore }
}

// 告别就抛错的假 peer
function grumpyPeer(peerId) {
  return {
    id: peerId,
    session: { token: 'tok', sk: Buffer.alloc(32, 1), expiresAt: Date.now() + 3600_000 },
    aborted: false,
    async disconnect() {
      throw new Error('对端没答话')
    },
    abort() {
      this.aborted = true
    },
  }
}

await ok('断开时告别失败，token 照样清掉、clients 照样摘掉', async () => {
  const peerId = 'p_grumpy'
  const { svc, peerStore } = await makeService(peerId)
  await peerStore.upsert({
    id: peerId,
    host: '127.0.0.1',
    port: 65001,
    name: '坏对端',
    password: 'secret',
    token: 'tok',
    sk: Buffer.alloc(32, 1).toString('base64'),
    expiresAt: Date.now() + 3600_000,
  })
  const peer = grumpyPeer(peerId)
  svc.clients.set(peerId, peer)

  const out = await svc.disconnect(peerId)
  assert(out.ok === true, '断开本身要成功')
  assert(svc.clients.has(peerId) === false, 'clients 里不该再留着它')
  const rec = await peerStore.raw(peerId)
  assert(rec !== null, '记录本身还在（断开 ≠ 删除）')
  assert(rec.token === null && rec.sk === null, `会话该清空，实际 token=${rec.token} sk=${rec.sk}`)
  assert(rec.password === 'secret', '密码要保留，下次重连不用重输')
})

await ok('删除时告别失败，记录照样删掉', async () => {
  const peerId = 'p_grumpy2'
  const { svc, peerStore } = await makeService(peerId)
  await peerStore.upsert({ id: peerId, host: '127.0.0.1', port: 65002, name: '坏对端 2', token: 'tok2' })
  svc.clients.set(peerId, grumpyPeer(peerId))

  const out = await svc.forget(peerId)
  assert(out.ok === true, '删除本身要成功')
  assert(svc.clients.has(peerId) === false, 'clients 里不该再留着它')
  assert((await peerStore.raw(peerId)) === null, '记录该被删掉')
})

await ok('告别失败会留下一条 warn，而不是悄悄吞掉', async () => {
  assert(
    warns.some((w) => w.includes('告别时出错')),
    `应当记一条 warn，实际 ${JSON.stringify(warns)}`,
  )
})

await ok('peer 不在 clients 里也能断开（清会话不报错）', async () => {
  const peerId = 'p_absent'
  const { svc, peerStore } = await makeService(peerId)
  await peerStore.upsert({ id: peerId, host: '127.0.0.1', port: 65003, token: 'tok3' })
  const out = await svc.disconnect(peerId)
  assert(out.ok === true, '断开要成功')
  const rec = await peerStore.raw(peerId)
  assert(rec.token === null, '会话仍要清空')
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `disconnect ok · ${pass} 项断言 · 告别失败仍清会话 / 删除照常 / 有 warn / 不在列表也能断（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
