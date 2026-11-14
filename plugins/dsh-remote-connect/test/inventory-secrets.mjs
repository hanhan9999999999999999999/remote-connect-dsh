/**
 * 「包含凭据」开关必须真的管用：勾上之后，目录深处的 .env / 私钥也要跟着走；
 * 没勾时它们一律不出门；而日志、临时文件、超过单文件上限的东西，勾不勾都不走。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-sec-'))
const dsh = path.join(tmp, 'dsh')
process.env.DSH_HOME = dsh
process.env.DEVICE_LINK_DSH_HOME = dsh
process.env.DEVICE_LINK_HOME = path.join(dsh, 'plugins-data', 'dsh-remote-connect')

const w = async (rel, data) => {
  const abs = path.join(dsh, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, data)
}

await w('skills/a/SKILL.md', '# a\n')
await w('skills/a/.env', 'API_KEY=xxx\n')
await w('skills/a/server.pem', '-----BEGIN PRIVATE KEY-----\n')
await w('skills/a/cookies.txt', 'sid=1\n')
await w('skills/a/id_rsa', 'key\n')
await w('skills/a/app.log', 'noise\n')
await w('skills/a/notes.tmp', 'noise\n')
await w('skills/big.bin', Buffer.alloc(4096, 7))
await w('skills/prod.env', 'TOKEN=1\n')
for (let i = 0; i < 50; i += 1) {
  await w(`skills/many/d${String(i).padStart(2, '0')}/.env`, 'K=1\n')
}

const { scanCategory } = await import('../host/inventory.mjs')

let pass = 0
let fail = 0
const expect = (label, fn) => {
  try {
    fn()
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err.message}`)
  }
}

const rels = (r) => r.entries.map((e) => e.rel).sort()

// ① 默认（不勾）：目录深处的凭据一律不出门
const off = await scanCategory('skills', { includeSecrets: false, maxFileMb: 512 })
const offRels = rels(off)
const offStats = off.stats
expect('默认不带凭据：.env / .pem / cookies / id_rsa 全被挡下', () => {
  for (const bad of ['skills/a/.env', 'skills/a/server.pem', 'skills/a/cookies.txt', 'skills/a/id_rsa', 'skills/prod.env']) {
    assert.ok(!offRels.includes(bad), `${bad} 不该出现`)
  }
  assert.ok(offRels.includes('skills/a/SKILL.md'), '普通文件必须还在')
})
expect('默认的排除理由写着「凭据/密钥」', () => {
  // 明细只留 40 条：哪个文件先被扫到取决于文件系统顺序，所以按「理由」查，
  // 不认死某一个路径（Linux 上 skills/a/.env 可能排在第 41 位）。
  const hit = offStats.excluded.find((e) => e.reason === '凭据/密钥')
  assert.ok(hit, '应当记录一条凭据类的排除说明')
})

// ② 勾上：凭据跟着走（这是以前坏掉的那一半）
const on = await scanCategory('skills', { includeSecrets: true, maxFileMb: 512 })
const onRels = rels(on)
const onStats = on.stats
expect('勾上之后：目录深处的凭据也进清单', () => {
  for (const good of ['skills/a/.env', 'skills/a/server.pem', 'skills/a/cookies.txt', 'skills/a/id_rsa', 'skills/prod.env']) {
    assert.ok(onRels.includes(good), `${good} 应当出现`)
  }
})
expect('勾上之后：日志与临时文件仍然不走', () => {
  assert.ok(!onRels.includes('skills/a/app.log'))
  assert.ok(!onRels.includes('skills/a/notes.tmp'))
  assert.ok(onStats.excluded.some((e) => e.rel === 'skills/a/app.log' && e.reason === '日志/临时文件'))
})

// ③ 单文件上限与「包含凭据」无关
const small = await scanCategory('skills', { includeSecrets: true, maxFileMb: 0.001 })
expect('勾上凭据也不会绕过单文件上限', () => {
  assert.ok(!rels(small).includes('skills/big.bin'))
  assert.ok(small.stats.excluded.some((e) => e.rel === 'skills/big.bin' && e.reason === '超过单文件上限'))
})

// ④ 排除清单最多留 40 条，但计数照实累加
expect('排除明细最多 40 条、计数不设上限', () => {
  assert.ok(offStats.excludedCount >= 50 + 4, `计数应 ≥54，实际 ${offStats.excludedCount}`)
  assert.equal(offStats.excluded.length, 40)
})

// ⑤ 勾上凭据时，被挡下的数量应当少掉那些凭据文件
expect('勾上后排除数比不勾时少', () => {
  assert.ok(onStats.excludedCount < offStats.excludedCount, `on=${onStats.excludedCount} off=${offStats.excludedCount}`)
})

console.log(`\n${fail === 0 ? 'secret-filter ok' : 'secret-filter FAILED'} · ${pass} 项断言 · 默认挡 / 勾上带 / 日志仍挡 / 上限仍挡 / 明细上限 · ${pass} 通过、${fail} 失败`)
await fs.rm(tmp, { recursive: true, force: true })
if (fail) process.exit(1)
