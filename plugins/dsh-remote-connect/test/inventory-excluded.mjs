#!/usr/bin/env node
// 排除规则算出来的东西，得能被人看见：
// 以前 excluded 只留 40 条明细、总数根本没往上报，界面上一个字都没有——
// 勾了「包含凭据」的用户没有任何办法确认它到底生效了没有。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-inv-excl-'))
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { scanAll } = await import('../host/inventory.mjs')

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

const dsh = process.env.DEVICE_LINK_DSH_HOME
async function put(rel, content) {
  const abs = path.join(dsh, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

// 准备：三个会被排除的（凭据 / 日志 / 超大）+ 一个正常的
await put('skills/a/SKILL.md', '# 技能 A\n')
await put('skills/a/.env', 'TOKEN=secret\n')
await put('skills/a/run.log', 'noise\n')
await put('skills/big/huge.bin', Buffer.alloc(3 * 1024 * 1024, 7))

await ok('排除总数与原因分别统计，不只留 40 条明细', async () => {
  const inv = await scanAll({ cats: ['skills'], maxFileMb: 1 })
  assert(typeof inv.excludedTotal === 'number', 'excludedTotal 应当是数字')
  assert(inv.excludedTotal === 3, `应当排除 3 个，实际 ${inv.excludedTotal}`)
  assert(inv.excluded.length <= 40, '明细列表仍然有上限')
  assert(inv.excludedReasons.secret === 1, `凭据计数应为 1，实际 ${JSON.stringify(inv.excludedReasons)}`)
  assert(inv.excludedReasons.log === 1, '日志计数应为 1')
  assert(inv.excludedReasons.big === 1, '超大计数应为 1')
  // 明细里每条都带原因代号，界面才能按当前语言翻译，而不是去匹配中文串
  for (const ex of inv.excluded) {
    assert(['secret', 'log', 'big', 'other'].includes(ex.code), `明细缺少可翻译的代号：${JSON.stringify(ex)}`)
  }
})

await ok('勾上「包含凭据」之后，凭据那一项从统计里消失', async () => {
  const inv = await scanAll({ cats: ['skills'], maxFileMb: 1, includeSecrets: true })
  assert(inv.excludedTotal === 2, `应当只剩 2 个被排除，实际 ${inv.excludedTotal}`)
  assert(inv.excludedReasons.secret === undefined, '凭据不该再出现在统计里')
  assert(inv.entries.some((e) => e.rel === 'skills/a/.env'), '凭据文件应当进了清单')
})

await ok('明细上限之外的数量仍然算进总数（超过 40 条时）', async () => {
  for (let i = 0; i < 45; i += 1) await put(`skills/many/d${i}/.env`, 'X=1\n')
  const inv = await scanAll({ cats: ['skills'], maxFileMb: 1 })
  assert(inv.excluded.length <= 40, `明细最多 40 条，实际 ${inv.excluded.length}`)
  assert(inv.excludedTotal >= 45, `总数要包含没列出来的，实际 ${inv.excludedTotal}`)
  assert(inv.excludedReasons.secret >= 45, `凭据计数要包含没列出来的，实际 ${inv.excludedReasons.secret}`)
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `inventory-excluded ok · ${pass} 项断言 · 总数与原因 / 勾上凭据 / 明细上限之外（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
