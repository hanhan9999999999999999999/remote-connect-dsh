/**
 * 落地（apply）路径的三处边界：
 *
 * 1. `merge-profile` 收到坏 JSON 时，以前会把本机的 profile 覆盖成一份坏文件——
 *    同步反而把接收方的 DSH 弄挂了。现在宁可跳过。
 * 2. 内存里的批次状态以前只进不出，开几天就会挂上一堆。
 * 3. 普通条目照常落地（对照组，确保前两条不是靠「什么都不做」通过的）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-apply-home-'))
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-apply-data-'))
process.env.DEVICE_LINK_DSH_HOME = dshHome

const { Applier } = await import('../host/apply.mjs')
const { tarReadable } = await import('../host/tar.mjs')

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

const sha = (text) => createHash('sha256').update(text).digest('hex')

function applier() {
  return new Applier({
    logger: { info() {}, warn() {}, error() {} },
    dataHome,
    sync: { backupKeep: 5 },
  })
}

/** 造一个只含指定条目的同步批次并跑完 */
async function runBatch(entries, { from = 'peer-test' } = {}) {
  const a = applier()
  const state = await a.prepare({ from })
  const rows = entries.map((e) => {
    const bytes = Buffer.from(e.content ?? '')
    return {
      rel: e.rel,
      size: bytes.length,
      mtime: Date.now(),
      mode: 0o644,
      hash: sha(bytes.toString()),
      op: e.op,
      cat: e.cat,
      bytes,
    }
  })
  const out = await a.applyStream(state.id, tarReadable(rows))
  return { a, out }
}

const profilePath = path.join(dshHome, 'profiles', 'desktop', 'package.json')
const localProfile = {
  name: 'desktop',
  private: true,
  dependencies: { 'dsh-remote-connect': 'file:../../plugins/dsh-remote-connect' },
  dsh: { profile: { bundles: ['dsh-remote-connect'] } },
}
async function seedProfile() {
  await fsp.mkdir(path.dirname(profilePath), { recursive: true })
  await fsp.writeFile(profilePath, JSON.stringify(localProfile, null, 2))
}

/* 1. 对端发来的 profile 是坏 JSON：本机那份必须原样不动 */
await ok('merge-profile 收到坏 JSON 时不覆盖本机 profile', async () => {
  await seedProfile()
  const broken = '{"name": "desktop", "dsh": {'
  const { out } = await runBatch([
    { rel: 'profiles/desktop/package.json', content: broken, op: 'merge-profile', cat: 'config' },
  ])
  assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).name, 'desktop')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(profilePath, 'utf8')),
    localProfile,
    '本机 profile 应当一个字节都没变',
  )
  assert.ok(out.skipped >= 1, '被跳过的条目要计数')
  const strays = (await fsp.readdir(path.dirname(profilePath))).filter((n) => n.endsWith('.dshlink'))
  assert.deepEqual(strays, [], '不应留下临时文件')
})

/* 2. 正常 profile：合并依赖与 bundles，本机名字与私有标记保留 */
await ok('merge-profile 正常时合并依赖与 bundles、保留本机身份字段', async () => {
  await seedProfile()
  const incoming = {
    name: 'desktop-from-peer',
    private: false,
    dependencies: { 'other-plugin': '^1.2.3' },
    dsh: { profile: { bundles: ['other-plugin'] } },
  }
  await runBatch([
    {
      rel: 'profiles/desktop/package.json',
      content: JSON.stringify(incoming),
      op: 'merge-profile',
      cat: 'config',
    },
  ])
  const merged = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
  assert.equal(merged.name, 'desktop', '本机名字不能被对端改掉')
  assert.equal(merged.private, true, '本机的 private 不能被对端改掉')
  assert.equal(merged.dependencies['other-plugin'], '^1.2.3')
  assert.equal(merged.dependencies['dsh-remote-connect'], 'file:../../plugins/dsh-remote-connect')
  assert.deepEqual(merged.dsh.profile.bundles.sort(), ['dsh-remote-connect', 'other-plugin'])
})

/* 3. 内存里的批次状态有上限 */
await ok('批次状态只留最近 20 条，老的从内存里退场', async () => {
  const a = applier()
  for (let i = 0; i < 25; i += 1) {
    const state = await a.prepare({ from: `peer-${i}` })
    state.phase = 'done'
    state.finishedAt = Date.now() + i
  }
  assert.equal(a.syncs.size, 20, `期望 20，实际 ${a.syncs.size}`)
  assert.equal(a.get('s_') ?? null, null)
  const ids = [...a.syncs.keys()]
  assert.ok(ids.length === 20)
})

/* 4. 对照组：普通条目真的能落地 */
await ok('普通条目落地后内容正确、批次标记为 done', async () => {
  const { out } = await runBatch([{ rel: 'skills/hello.md', content: '# 你好\n', cat: 'skills' }])
  assert.equal(out.phase, 'done')
  assert.equal(fs.readFileSync(path.join(dshHome, 'skills/hello.md'), 'utf8'), '# 你好\n')
})

await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => {})
await fsp.rm(dataHome, { recursive: true, force: true }).catch(() => {})

console.log(
  `apply-guard ok · ${pass} 项断言 · 坏 profile / 合并 profile / 状态上限 / 正常落地（${pass} 通过、${fail} 失败）`,
)
if (fail) process.exit(1)
