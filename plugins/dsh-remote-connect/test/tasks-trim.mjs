#!/usr/bin/env node
/**
 * 任务表的淘汰规则。
 *
 * 表有上限（默认 40）是为了「长期运行不无限长大」，但淘汰只该发生在**已经结束**的
 * 任务身上：把正在跑的那条丢掉，`/task/status` 就查不到它、取消也点不到，用户只能
 * 等它自己结束或者重启。
 *
 * 用法：node test/tasks-trim.mjs [host/tasks.mjs 路径]
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const tasksUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/tasks.mjs', import.meta.url).href
const { TaskTable, newTask, MAX_TASKS } = await import(tasksUrl)
void here

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    console.log(`  PASS ${label}`)
    pass += 1
  } catch (err) {
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(err?.message ?? err).split('\n')[0]}`)
    fail += 1
  }
}

/** 造一条任务；`finished` 为真就当它已经收尾。 */
function makeTask({ startedAt, finished = true, peerId = 'p' } = {}) {
  const t = newTask({ direction: 'push', peerId })
  t.startedAt = startedAt
  if (finished) t.finishedAt = startedAt + 10
  return t
}

ok('结束了的任务超过上限时，淘汰的是最早开始的那条', () => {
  const table = new TaskTable(3)
  const list = [1, 2, 3].map((i) => makeTask({ startedAt: i * 100, peerId: `p${i}` }))
  for (const t of list) table.add(t)
  assert.equal(table.size, 3)
  const extra = makeTask({ startedAt: 400, peerId: 'p4' })
  table.add(extra)
  assert.equal(table.size, 3, `实际 ${table.size}`)
  assert.equal(table.get(list[0].id), null, '最早那条应当被淘汰')
  assert.ok(table.get(list[2].id), '最近那条不该被淘汰')
  assert.ok(table.get(extra.id), '刚加的那条不该被淘汰')
})

ok('全都还在跑的时候，一条都不淘汰（宁可暂时超上限）', () => {
  const table = new TaskTable(3)
  const list = [1, 2, 3].map((i) => makeTask({ startedAt: i * 100, finished: false, peerId: `p${i}` }))
  for (const t of list) table.add(t)
  const extra = makeTask({ startedAt: 400, finished: false, peerId: 'p4' })
  table.add(extra)
  assert.equal(table.size, 4, `实际 ${table.size}（在跑的任务被丢掉了）`)
  for (const t of [...list, extra]) assert.ok(table.get(t.id), `${t.peerId} 查不到了——它就是跑着的时候被丢掉的`)
})

ok('混合时先淘汰结束的，在跑的一条都留着', () => {
  const table = new TaskTable(3)
  const running = makeTask({ startedAt: 1, finished: false, peerId: 'running' })
  const done = [10, 20].map((n) => makeTask({ startedAt: n, peerId: `done${n}` }))
  table.add(running)
  for (const t of done) table.add(t)
  const extra = makeTask({ startedAt: 400, peerId: 'extra' })
  table.add(extra)
  assert.equal(table.size, 3, `实际 ${table.size}`)
  assert.ok(table.get(running.id), '在跑的那条被淘汰了')
  assert.equal(table.get(done[0].id), null, '结束的最早那条应当被淘汰')
  assert.ok(table.get(done[1].id))
  assert.ok(table.get(extra.id))
})

ok('在跑的任务一定还能查询、还能出现在取消路径里', () => {
  const table = new TaskTable(2)
  const running = makeTask({ startedAt: 1, finished: false, peerId: 'running' })
  table.add(running)
  for (let i = 0; i < 5; i += 1) table.add(makeTask({ startedAt: 100 + i, peerId: `done${i}` }))
  assert.ok(table.view(running.id), '在跑的任务查不到视图了（面板会一直空着）')
  assert.ok(
    table.listRefs().some((t) => t.id === running.id),
    '在跑的任务不在 listRefs 里——取消路径会找不到它'
  )
})

ok('只加已完成的任务，表不会无限长大', () => {
  const table = new TaskTable(MAX_TASKS)
  for (let i = 0; i < 200; i += 1) table.add(makeTask({ startedAt: i, peerId: `p${i}` }))
  assert.ok(table.size <= MAX_TASKS, `实际 ${table.size}`)
  const views = table.recent(5)
  assert.equal(views.length, 5)
})

console.log(`tasks-trim ok · 5 项断言 · 淘汰旧的 / 不丢在跑的 / 混合 / 查询与取消 / 上限（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
