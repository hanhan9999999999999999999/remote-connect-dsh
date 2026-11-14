#!/usr/bin/env node
// 扫描是在用户的真实目录里走：里面一定有读不了的子目录、也（理论上）可能
// 有深得离谱的目录树。这两件事以前会让整个分类扫描直接抛错——用户看到的
// 是「扫描失败」，而不是「有几个地方没扫到」。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-inv-read-'))
const dsh = path.join(home, 'dsh')
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = dsh

const { scanAll, MAX_DEPTH } = await import('../host/inventory.mjs')

let pass = 0
let fail = 0
let skipped = 0
class Skip extends Error {}
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    if (err instanceof Skip) {
      console.log(`SKIP ${label}：${err.message}`)
      return
    }
    fail += 1
    console.log(`FAIL ${label}: ${err?.message ?? err}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// 正常文件（对照组）
await fs.mkdir(path.join(dsh, 'skills', 'plain'), { recursive: true })
await fs.writeFile(path.join(dsh, 'skills', 'plain', 'SKILL.md'), '# ok\n')

// 深得超过上限的一支：最后放一个文件，它不应该进清单
let deepDir = path.join(dsh, 'skills', 'deep')
await fs.mkdir(deepDir, { recursive: true })
for (let i = 0; i < MAX_DEPTH + 6; i += 1) {
  deepDir = path.join(deepDir, 'd')
  await fs.mkdir(deepDir, { recursive: true })
}
await fs.writeFile(path.join(deepDir, 'bottom.md'), '# too deep\n')

await ok(`超过 ${MAX_DEPTH} 层的目录不再往下走，但仍算进「没进清单」`, async () => {
  const res = await scanAll({ cats: ['skills'] })
  assert(Array.isArray(res.entries), '不该抛错')
  const deepFiles = res.entries.filter((e) => e.rel.includes('/d/d/d/'))
  assert(deepFiles.length === 0, `太深的那一支不该有文件进清单：${deepFiles.map((e) => e.rel).join(',')}`)
  assert((res.excludedReasons?.deep ?? 0) >= 1, `应当记一笔「层级太深」，实际 ${JSON.stringify(res.excludedReasons)}`)
  const hit = res.excluded.find((e) => e.code === 'deep')
  assert(hit, '明细里应当有一条 code=deep 的记录')
})

await ok('同一次扫描里，正常的文件照样进清单', async () => {
  const res = await scanAll({ cats: ['skills'] })
  const rels = res.entries.map((e) => e.rel)
  assert(rels.includes('skills/plain/SKILL.md'), `正常文件应当在清单里：${rels.join(',')}`)
  assert(!res.excludedReasons?.denied, `不该凭空报「读不了」：${JSON.stringify(res.excludedReasons)}`)
})

const canDeny = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0

await ok('权限不足的子目录只记一笔，不打断整次扫描', async () => {
  if (!canDeny) {
    // 这个平台上模拟不出「读不了」：Windows 的 chmod 000 拦不住自己，
    // root 也照样能读。与其让一条断言假过，不如明说它没跑。
    skipped += 1
    throw new Skip('这个平台上 chmod 000 拦不住自己（Windows / root）')
  }
  const locked = path.join(dsh, 'skills', 'locked')
  await fs.mkdir(locked, { recursive: true })
  await fs.writeFile(path.join(locked, 'inside.md'), '# hidden\n')
  await fs.chmod(locked, 0o000)
  try {
    const res = await scanAll({ cats: ['skills'] })
    assert(Array.isArray(res.entries), '不该抛错')
    assert(
      res.entries.some((e) => e.rel === 'skills/plain/SKILL.md'),
      '别的目录仍应被扫到，证明没有整次中止',
    )
    assert((res.excludedReasons?.denied ?? 0) >= 1, `应当记一笔「读不了」：${JSON.stringify(res.excludedReasons)}`)
    assert(res.excluded.some((e) => e.code === 'denied'), '明细里应当有一条 code=denied')
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {})
  }
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
const skipNote = skipped > 0 ? `（跳过 ${skipped} 项）` : ''
console.log(
  `inventory-read-errors ok · ${pass} 项断言 · 深层目录 / 正常对照 / 读不了的目录（${pass} 通过、${fail} 失败）${skipNote}`,
)
process.exit(fail > 0 ? 1 : 0)
