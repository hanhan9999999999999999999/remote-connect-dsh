/**
 * host/guard.mjs 的单元测试：IP 提取、设备字段清洗、失败计数与锁定。
 * 这些东西以前埋在 server.mjs 里，只能靠「连错 10 次密码」这种笨办法间接验证。
 */
import assert from 'node:assert/strict'
import {
  CLOCK_SKEW_MS,
  FailureTracker,
  LOCK_AFTER,
  LOCK_MS,
  NONCE_WINDOW_MS,
  clientIp,
  sanitizeDevice,
} from '../host/guard.mjs'

let pass = 0
const ok = async (label, fn) => {
  await fn()
  pass += 1
  console.log(`  PASS ${label}`)
}

await ok('clientIp 去掉 IPv4-mapped 前缀', async () => {
  assert.equal(clientIp({ socket: { remoteAddress: '::ffff:192.168.1.9' } }), '192.168.1.9')
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2')
  assert.equal(clientIp({ socket: { remoteAddress: 'fe80::1' } }), 'fe80::1')
})

await ok('clientIp 拿不到地址时返回空串，不炸', async () => {
  assert.equal(clientIp({}), '')
  assert.equal(clientIp(null), '')
})

await ok('sanitizeDevice 只留四个字段并截断长度', async () => {
  const d = sanitizeDevice({
    id: 'x'.repeat(80),
    name: '一台名字特别特别长的电脑'.repeat(6),
    platform: 'w'.repeat(100),
    version: '1.0.8',
    secret: '不该出现',
  })
  assert.equal(d.id.length, 64)
  assert.equal(d.name.length, 48)
  assert.equal(d.platform.length, 64)
  assert.equal(d.version, '1.0.8')
  assert.deepEqual(Object.keys(d).sort(), ['id', 'name', 'platform', 'version'])
})

await ok('sanitizeDevice 没 id 就判非法，缺名字给默认值', async () => {
  assert.equal(sanitizeDevice({ name: 'x' }), null)
  assert.equal(sanitizeDevice(null), null)
  assert.equal(sanitizeDevice('not-an-object'), null)
  assert.equal(sanitizeDevice({ id: 'abc' }).name, '未命名设备')
})

await ok('第 9 次失败还不锁，第 10 次开始锁', async () => {
  const g = new FailureTracker()
  const t0 = 1_800_000_000_000
  for (let i = 0; i < LOCK_AFTER - 1; i += 1) g.register('1.2.3.4', { now: t0 + i })
  assert.equal(g.blocked('1.2.3.4', t0 + 100), false)
  const locked = g.register('1.2.3.4', { now: t0 + 100 })
  assert.equal(locked, true)
  assert.equal(g.blocked('1.2.3.4', t0 + 101), true)
})

await ok('锁满 LOCK_MS 自己解开，并把记录清掉', async () => {
  const g = new FailureTracker()
  const t0 = 1_800_000_000_000
  for (let i = 0; i < LOCK_AFTER; i += 1) g.register('5.6.7.8', { now: t0 })
  assert.equal(g.blocked('5.6.7.8', t0 + LOCK_MS - 1), true)
  assert.equal(g.blocked('5.6.7.8', t0 + LOCK_MS + 1), false)
  assert.equal(g.size, 0, '到期后记录应被丢掉，不该长期占内存')
})

await ok('不同 IP 各记各的，认证成功清零', async () => {
  const g = new FailureTracker()
  for (let i = 0; i < LOCK_AFTER; i += 1) g.register('9.9.9.9', { now: 1 })
  assert.equal(g.blocked('9.9.9.9', 2), true)
  assert.equal(g.blocked('8.8.8.8', 2), false)
  g.clear('9.9.9.9')
  assert.equal(g.blocked('9.9.9.9', 2), false)
})

await ok('常数与文档一致（10 次 / 10 分钟 / nonce 10 分钟 / 偏差 5 分钟）', async () => {
  assert.equal(LOCK_AFTER, 10)
  assert.equal(LOCK_MS, 10 * 60 * 1000)
  assert.equal(NONCE_WINDOW_MS, 10 * 60 * 1000)
  assert.equal(CLOCK_SKEW_MS, 5 * 60 * 1000)
})

console.log(`guard ok · ${pass} 项断言 · IP / 设备字段 / 锁定 / 常数`)
