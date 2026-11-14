/**
 * dsh-remote-connect · 安全参数与 SECURITY.md 对账
 *
 * SECURITY.md 里的每个数字都应该能在代码里找到出处；代码改了而文档没跟上，
 * 比没有文档更糟——读者会以为那条边界还在。这个测试把两边钉在一起。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(pkgDir, rel), 'utf8')

const doc = read('SECURITY.md')
const crypto = read('host/crypto.mjs')
const server = read('host/server.mjs')
const guard = read('host/guard.mjs')
const apply = read('host/apply.mjs')

let pass = 0
async function ok(label, fn) {
  await fn()
  pass += 1
  console.log(`  PASS ${label}`)
}

await ok('KDF 参数与文档一致（scrypt N=2^14, r=8, p=1）', async () => {
  const { KDF_DEFAULTS } = await import('../host/crypto.mjs')
  assert.equal(KDF_DEFAULTS.N, 16384)
  assert.equal(KDF_DEFAULTS.r, 8)
  assert.equal(KDF_DEFAULTS.p, 1)
  assert.equal(KDF_DEFAULTS.keylen, 32)
  assert.ok(doc.includes('scrypt(N=2^14, r=8, p=1'), '文档没写 KDF 参数')
})

await ok('密码形状是 3 组 ×4 字符，文档写的是同一件事', async () => {
  const { generatePassword } = await import('../host/crypto.mjs')
  const samples = Array.from({ length: 20 }, () => generatePassword())
  for (const s of samples) assert.match(s, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.ok(/3 组[^。\n]*4/.test(doc), '文档没写「3 组 4 字符」')
})

await ok('挑战 60 秒、会话 12 小时，与文档一致', async () => {
  const ttl = (name) => {
    const m = server.match(new RegExp(`const ${name} = ([0-9 *]+)`))
    assert.ok(m, `server.mjs 里找不到 ${name}`)
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]}`)()
  }
  assert.equal(ttl('CHALLENGE_TTL'), 60 * 1000)
  assert.equal(ttl('SESSION_TTL'), 12 * 60 * 60 * 1000)
  assert.ok(doc.includes('挑战 60 秒'), '文档没写挑战 60 秒')
  assert.ok(doc.includes('12 小时'), '文档没写会话 12 小时')
})

await ok('时钟偏移 5 分钟、失败 10 次锁 10 分钟，与文档一致', async () => {
  // 这三个常数住在 host/guard.mjs（1.0.9 从 server.mjs 搬过去），文档里的数字要对得上它们
  assert.ok(guard.includes('CLOCK_SKEW_MS = 5 * 60 * 1000'), 'guard.mjs 里找不到 5 分钟时钟窗口')
  assert.ok(guard.includes('LOCK_AFTER = 10'), 'guard.mjs 里找不到 10 次阈值')
  assert.ok(guard.includes('LOCK_MS = 10 * 60 * 1000'), 'guard.mjs 里找不到 10 分钟锁定')
  assert.ok(doc.includes('5 分钟'), '文档没写时钟偏移 5 分钟')
  assert.ok(doc.includes('10 次'), '文档没写失败 10 次')
  assert.ok(doc.includes('10 分钟'), '文档没写锁 10 分钟')
})

await ok('nonce 窗口 10 分钟，与文档一致', async () => {
  assert.ok(guard.includes('NONCE_WINDOW_MS = 10 * 60 * 1000'), 'guard.mjs 里找不到 nonce 10 分钟窗口')
  assert.ok(server.includes('NONCE_WINDOW_MS'), 'server.mjs 的 #prune 没用上 NONCE_WINDOW_MS')
  assert.ok(doc.includes('10 分钟窗口内只能使用一次'), '文档没写 nonce 窗口')
})

await ok('备份默认保留 5 批，与文档一致', async () => {
  assert.ok(apply.includes('backupKeep ?? 5'), 'apply.mjs 里找不到默认保留 5 批')
  assert.ok(doc.includes('默认保留 5 批'), '文档没写备份保留 5 批')
})

await ok('文档声称改密码会清空会话，代码里确实做了', async () => {
  const service = read('host/service.mjs')
  assert.ok(service.includes('this.server.sessions.clear()'), 'service.mjs 没清会话')
  assert.ok(service.includes('this.server.masterKey = null'), 'service.mjs 没丢主密钥')
  assert.ok(doc.includes('改密码会清空所有会话'), '文档没写这条')
})

await ok('文档列的排除项在 inventory 里都有对应实现', async () => {
  const inv = read('host/inventory.mjs')
  for (const token of ['node_modules', '.git', 'dist', 'build', 'coverage']) {
    assert.ok(inv.includes(`'${token}'`), `inventory.mjs 没排除 ${token}`)
  }
  for (const re of ['\\.log$', '\\.tmp$', '\\.part$', '\\.map$', '\\.swp$', '\\.(pem|key|p12|pfx)$', 'id_(rsa|ed25519|ecdsa)', '\\.netrc$', 'cookies?']) {
    assert.ok(inv.includes(re), `inventory.mjs 里没有 ${re} 的排除规则`)
  }
  assert.ok(inv.includes('storages/session_projcache'), 'inventory.mjs 没跳过 projcache')
  assert.ok(doc.includes('storages/session_projcache/'), '文档没写 projcache')
})

console.log(`security ok · ${pass} 项断言 · KDF / 密码形状 / 挑战与会话 TTL / 锁定 / nonce 窗口 / 备份 / 改密码 / 排除项`)
