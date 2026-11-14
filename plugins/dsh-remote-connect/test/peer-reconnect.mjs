/**
 * 「记住密码」这条线：`connect()` 里以前用 `list()` 的结果去取旧密码，
 * 而 `list()` 是对外视图（按设计不含 password），于是旧密码永远是 undefined——
 * 每次不重输密码的重连都会把存下来的密码清成空字符串，下次自动重连直接 NEED_PASSWORD。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-reconnect-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = home

const { LinkService } = await import('../host/service.mjs')
const { PeerStore } = await import('../host/peers.mjs')

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${err?.message ?? err}`)
  }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const cfg = {
  device: { id: 'dev_test', name: '本机', platform: 'win32' },
  sync: { maxTotalMb: 8192, includeCredentials: false },
}

function fakePeer(record, { failConnect = false } = {}) {
  return {
    record: { ...record },
    session: null,
    connectCalls: [],
    async connect({ password }) {
      this.connectCalls.push(password)
      if (failConnect) {
        const err = new Error('密码不对')
        err.code = 'BAD_PASSWORD'
        throw err
      }
      this.record.token = 'tok'
      this.record.sk = 'sk'
      this.record.expiresAt = Date.now() + 3600_000
      this.session = { token: 'tok', sk: 'sk', expiresAt: this.record.expiresAt }
      return { server: { version: '1.0.0' } }
    },
    async restore() {
      return false
    },
    async disconnect() {},
    async probe() {
      return { ok: true }
    },
    async listSyncs() {
      return []
    },
    async rollback() {
      return { restored: 0 }
    },
  }
}

/** 造一个 service：真 PeerStore（真的写盘、真的按对外视图返回），假的 peer 实例 */
async function makeService(options = {}) {
  const peerStore = new PeerStore(path.join(home, `peers-${Math.random().toString(16).slice(2)}.json`))
  await peerStore.load()
  const svc = new LinkService({ logger: quiet, store: { get: async () => cfg, load: async () => cfg } })
  svc.init = async () => {}
  svc.peerStore = peerStore
  return { svc, peerStore, options }
}

const HOST = '192.0.2.10'
const PORT = 8788

/* 1. 已经存了密码，之后不重输密码地重连：密码必须还在 */
await ok('不重输密码的重连不会清掉已存的密码', async () => {
  const { svc, peerStore } = await makeService()
  const seeded = await peerStore.upsert({ name: '书桌', host: HOST, port: PORT, password: 'AAAA-BBBB-CCCC' })
  const peer = fakePeer(seeded)
  svc.clients.set(seeded.id, peer)

  await svc.connect({ host: HOST, port: PORT, rememberPassword: true })
  const stored = await peerStore.raw(seeded.id)
  assert.equal(stored.password, 'AAAA-BBBB-CCCC', '旧密码不该被清空')
  assert.deepEqual(peer.connectCalls, [undefined], '这次没传密码，交给对端用已有会话')
})

/* 2. 输入新密码且勾了「记住」：存新的 */
await ok('勾上「记住密码」并输入新密码时，存下新的那个', async () => {
  const { svc, peerStore } = await makeService()
  const seeded = await peerStore.upsert({ name: '书桌', host: HOST, port: PORT, password: 'OLD-PASS' })
  svc.clients.set(seeded.id, fakePeer(seeded))

  await svc.connect({ host: HOST, port: PORT, password: 'NEW-PASS', rememberPassword: true })
  assert.equal((await peerStore.raw(seeded.id)).password, 'NEW-PASS')
})

/* 3. 不勾「记住」连接成功：这一次的密码不落盘，旧的那个也一并清掉 */
await ok('不勾「记住密码」连接成功后，密码不留在磁盘上', async () => {
  const { svc, peerStore } = await makeService()
  const seeded = await peerStore.upsert({ name: '书桌', host: HOST, port: PORT, password: 'OLD-PASS' })
  svc.clients.set(seeded.id, fakePeer(seeded))

  await svc.connect({ host: HOST, port: PORT, password: 'TEMP-PASS', rememberPassword: false })
  assert.equal((await peerStore.raw(seeded.id)).password, '')
})

/* 4. 不勾「记住」但连不上：不能顺手把以前的密码抹掉 */
await ok('不勾「记住密码」但连接失败时，磁盘上的旧密码保持原样', async () => {
  const { svc, peerStore } = await makeService()
  const seeded = await peerStore.upsert({ name: '书桌', host: HOST, port: PORT, password: 'OLD-PASS' })
  svc.clients.set(seeded.id, fakePeer(seeded, { failConnect: true }))

  await assert.rejects(
    () => svc.connect({ host: HOST, port: PORT, password: 'TEMP-PASS', rememberPassword: false }),
    (err) => err.code === 'BAD_PASSWORD',
  )
  assert.equal((await peerStore.raw(seeded.id)).password, 'OLD-PASS', '失败不该有副作用')
})

await fsp.rm(home, { recursive: true, force: true }).catch(() => {})

console.log(`peer-reconnect ok · ${pass} 项断言 · 保留 / 更新 / 不记住 / 失败无副作用（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
