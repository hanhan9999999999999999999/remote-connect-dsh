/**
 * 回滚路径：正常批次、半途失败的批次、什么都没写成的批次。
 *
 * 第二种以前是死路——`rollback()` 只读 `journal.json`，而它只在正常收尾时才写。
 * 于是「同步到一半失败」这种最需要撤销的情况，反而永远拿不到回滚能力。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-rollback-home-'))
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-rollback-data-'))
process.env.DEVICE_LINK_DSH_HOME = dshHome

const { Applier } = await import('../host/apply.mjs')

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

const write = async (rel, text) => {
  const abs = path.join(dshHome, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, text)
  return abs
}
const read = (rel) => fs.readFileSync(path.join(dshHome, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(dshHome, rel))

function applier() {
  return new Applier({
    logger: { info() {}, warn() {}, error() {} },
    dataHome,
    sync: { backupKeep: 5 },
  })
}

/* 1. 正常批次：备份的还原、新建的删掉 */
await ok('正常批次回滚：改过的文件还原，新建的文件删除', async () => {
  const syncId = 's_normal'
  const dir = path.join(dataHome, 'syncs', syncId)
  await fsp.mkdir(path.join(dir), { recursive: true })
  await fsp.mkdir(path.join(dataHome, 'backups', syncId), { recursive: true })
  await write('skills/keep.md', '旧内容')
  await write('skills/new.md', '新内容')
  // 备份 + 日志（模拟 applyStream 正常收尾写下的东西）
  const backupRel = path.join('backups', syncId, 'skills/keep.md')
  await fsp.mkdir(path.dirname(path.join(dataHome, backupRel)), { recursive: true })
  await fsp.writeFile(path.join(dataHome, backupRel), '旧内容')
  await fsp.writeFile(path.join(dshHome, 'skills/keep.md'), '被同步改写后的内容')
  await fsp.writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({
      id: syncId,
      entries: [
        { rel: 'skills/keep.md', reason: 'replaced', backup: `backups/${syncId}/skills/keep.md` },
        { rel: 'skills/new.md', reason: 'created', backup: null },
      ],
    }),
  )

  const out = await applier().rollback(syncId)
  assert.equal(out.restored, 1)
  assert.equal(out.removed, 1)
  assert.equal(out.partial, false)
  assert.equal(read('skills/keep.md'), '旧内容', '被覆盖的文件应当还原')
  assert.equal(exists('skills/new.md'), false, '新建的文件应当删掉')
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'))
  assert.ok(journal.rolledBackAt, '要记下回滚时间')
})

/* 2. 半途失败：只有 journal.jsonl，也必须能回滚 */
await ok('半途失败（只有 journal.jsonl）也能回滚，并标记 partial', async () => {
  const syncId = 's_partial'
  const dir = path.join(dataHome, 'syncs', syncId)
  await fsp.mkdir(path.join(dir), { recursive: true })
  await write('rules/a.md', '原样')
  await fsp.writeFile(path.join(dshHome, 'rules/a.md'), '被改写')
  await write('rules/b.md', '刚落地的')
  const backupRel = path.join('backups', syncId, 'rules/a.md')
  await fsp.mkdir(path.dirname(path.join(dataHome, backupRel)), { recursive: true })
  await fsp.writeFile(path.join(dataHome, backupRel), '原样')
  const rows = [
    { rel: 'rules/a.md', reason: 'replaced', backup: `backups/${syncId}/rules/a.md` },
    { rel: 'rules/b.md', reason: 'created', backup: null },
  ]
  await fsp.writeFile(path.join(dir, 'journal.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const out = await applier().rollback(syncId)
  assert.equal(out.partial, true, '没有 journal.json 的批次要标成 partial')
  assert.equal(out.restored, 1)
  assert.equal(out.removed, 1)
  assert.equal(read('rules/a.md'), '原样')
  assert.equal(exists('rules/b.md'), false)
  assert.ok(
    fs.existsSync(path.join(dir, 'journal.json')),
    '回滚后补一份 journal.json，免得下次又被当成半成品',
  )
})

/* 3. 一次都不能滚两回 */
await ok('同一个批次不能回滚两次', async () => {
  await assert.rejects(() => applier().rollback('s_partial'), (err) => err.code === 'ALREADY_ROLLED_BACK')
})

/* 4. 什么记录都没有时给明确错误，而不是空转 */
await ok('没有任何记录时抛 NO_JOURNAL', async () => {
  const dir = path.join(dataHome, 'syncs', 's_none')
  await fsp.mkdir(dir, { recursive: true })
  await assert.rejects(() => applier().rollback('s_none'), (err) => err.code === 'NO_JOURNAL')
})

/* 5. 备份已经被备份轮转清掉：不许假装回滚成功 */
await ok('备份被轮转清掉时回报 missing，而不是当作已还原', async () => {
  const syncId = 's_missing'
  const dir = path.join(dataHome, 'syncs', syncId)
  await fsp.mkdir(dir, { recursive: true })
  await write('config/settings.json', '同步后的新内容')
  // journal 里写着有备份，但 backups/<syncId>/ 早被 pruneBackups 删了
  await fsp.writeFile(
    path.join(dir, 'journal.json'),
    JSON.stringify({
      id: syncId,
      entries: [{ rel: 'config/settings.json', reason: 'replaced', backup: `backups/${syncId}/config/settings.json` }],
    }),
  )

  const out = await applier().rollback(syncId)
  assert.equal(out.restored, 0, '备份不在就不能算还原')
  assert.equal(out.missing, 1, '要找得到「备份没了」这件事')
  assert.equal(read('config/settings.json'), '同步后的新内容', '内容保持原样，没有假装成功')
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'))
  assert.equal(journal.rollback.missing, 1, 'journal 里也要记下来')
})

await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => {})
await fsp.rm(dataHome, { recursive: true, force: true }).catch(() => {})

console.log(`rollback ok · ${pass} 项断言 · 正常批次 / 半途失败 / 重复回滚 / 无记录 / 备份被清（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
