/**
 * 落地时的「条数」上限。
 *
 * 字节数早就封顶了（`maxTotalMb`），但条数没有：对端可以发几百万个 0 字节文件，
 * 一个字节的上限都碰不到，照样能把 backups/ 目录、journal 和 inode 撑爆。
 * 这个文件盯三件事：超了要报 `TOO_MANY_FILES`、刚好到上限还能过、默认值是真有。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-files-home-'))
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-files-data-'))
process.env.DEVICE_LINK_DSH_HOME = dshHome

import { pathToFileURL } from 'node:url'

const applierUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/apply.mjs', import.meta.url).href
const { Applier } = await import(applierUrl)
const { tarReadable } = await import('../host/tar.mjs')
const { statusFor } = await import('../host/status.mjs')

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

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function rowsFor(n) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    const bytes = Buffer.from(`# ${i}\n`)
    rows.push({
      rel: `skills/s${i}.md`,
      size: bytes.length,
      mtime: Date.now(),
      mode: 0o644,
      hash: sha(bytes),
      bytes,
    })
  }
  return rows
}

function applier(sync) {
  return new Applier({
    logger: { info() {}, warn() {}, error() {} },
    dataHome,
    sync,
  })
}

// —— 1. 超上限：明确报 TOO_MANY_FILES，而不是写到一半沉默
await ok('条目数超过上限时抛 TOO_MANY_FILES', async () => {
  const a = applier({ backupKeep: 5, maxFiles: 5 })
  const state = await a.prepare({ from: 'peer-test' })
  await assert.rejects(
    () => a.applyStream(state.id, tarReadable(rowsFor(9))),
    (err) => err.code === 'TOO_MANY_FILES',
  )
  const p = a.progress(state.id)
  assert.equal(p.phase, 'failed', `批次应当落成 failed，实际 ${p.phase}`)
  assert.match(p.error, /TOO_MANY_FILES/)
})

// —— 2. 刚好到上限：能过（不能把边界写成「少一条才算通过」）
await ok('条目数正好等于上限时正常落地', async () => {
  const a = applier({ backupKeep: 5, maxFiles: 5 })
  const state = await a.prepare({ from: 'peer-test' })
  const out = await a.applyStream(state.id, tarReadable(rowsFor(5)))
  assert.equal(out.phase, 'done')
  assert.equal(out.files, 5)
})

// —— 3. 这个错误码在 HTTP 层是 413（不是「服务端坏了」的 500）
await ok('TOO_MANY_FILES 映射到 413', async () => {
  assert.equal(statusFor('TOO_MANY_FILES'), 413)
})

// —— 4. 没传 maxFiles 时默认有个上限（不是 Infinity）
await ok('没配 maxFiles 时仍有上限', async () => {
  const a = applier({ backupKeep: 5 })
  const state = await a.prepare({ from: 'peer-test' })
  // 128 条当然没超，重点是它真的走完了（默认值不是 0/NaN 导致的「什么都拒」）
  const out = await a.applyStream(state.id, tarReadable(rowsFor(128)))
  assert.equal(out.phase, 'done')
  assert.equal(out.files, 128)
})

console.log(
  `apply-files ok · ${pass + fail} 项断言 · 超上限 / 边界 / 状态码 / 默认值（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
