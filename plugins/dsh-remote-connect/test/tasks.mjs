/**
 * 任务表守卫：这张表以前直接塞在 service.mjs 里，靠 `[...map.values()]` 现场排序淘汰，
 * 没有任何测试。现在它自己是一个模块，下面几条就是它必须守住的行为。
 */
import assert from 'node:assert/strict'
import { MAX_TASKS, TaskTable, newTask, taskView } from '../host/tasks.mjs'

const VIEW_KEYS = [
  'id', 'kind', 'direction', 'peerId', 'phase', 'done', 'total', 'bytes',
  'totalBytes', 'detail', 'startedAt', 'finishedAt', 'error', 'result',
].sort()

let passed = 0
const expect = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`PASS task · ${label}`)
}

await expect('newTask 的默认值', () => {
  const t = newTask({ peerId: 'p1' })
  assert.match(t.id, /^t_[0-9a-f]{12}$/, `id 形状不对：${t.id}`)
  assert.equal(t.kind, 'sync')
  assert.equal(t.direction, 'push')
  assert.equal(t.peerId, 'p1')
  assert.equal(t.phase, 'queued')
  for (const k of ['done', 'total', 'bytes', 'totalBytes']) assert.equal(t[k], 0, `${k} 应该是 0`)
  assert.equal(t.finishedAt, null)
  assert.equal(t.error, null)
  assert.equal(t.result, null)
  assert.equal(typeof t.startedAt, 'number')
})

await expect('newTask 接受 direction=null 之外的方向', () => {
  assert.equal(newTask({ direction: 'pull', peerId: 'p2' }).direction, 'pull')
})

await expect('taskView 只放行对外字段', () => {
  const t = newTask({ peerId: 'p3' })
  t.secret = '不该露出去'
  const view = taskView(t)
  assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS)
  assert.equal('secret' in view, false)
  assert.notEqual(view, t, '视图不能是同一个对象，否则外面改了会直接影响任务')
})

await expect('add / get / view 往返', () => {
  const table = new TaskTable()
  const t = table.add(newTask({ peerId: 'p4' }))
  assert.equal(table.get(t.id), t)
  assert.equal(table.view(t.id).peerId, 'p4')
  assert.equal(table.size, 1)
})

await expect('未知 id 返回 null 而不是抛错', () => {
  const table = new TaskTable()
  assert.equal(table.get('t_nope'), null)
  assert.equal(table.view('t_nope'), null)
})

await expect(`超过 ${MAX_TASKS} 条时淘汰最老的`, () => {
  const table = new TaskTable()
  const ids = []
  for (let i = 0; i < MAX_TASKS + 5; i += 1) {
    const t = newTask({ peerId: `p${i}` })
    t.startedAt = 1000 + i
    ids.push(table.add(t).id)
  }
  assert.equal(table.size, MAX_TASKS)
  for (const id of ids.slice(0, 5)) assert.equal(table.get(id), null, `最老的 ${id} 应该被淘汰`)
  assert.notEqual(table.get(ids[ids.length - 1]), null, '最新的那条必须还在')
})

await expect('淘汰看 startedAt，不看插入顺序', () => {
  const table = new TaskTable(3)
  const recent = [10, 11, 12].map((i) => {
    const t = newTask({ peerId: `r${i}` })
    t.startedAt = i
    return table.add(t)
  })
  const stale = newTask({ peerId: 'delayed' })
  stale.startedAt = 1 // 最后才插进来，但时间最早
  table.add(stale)
  assert.equal(table.get(stale.id), null, '时间最早的那条要被淘汰')
  assert.equal(table.size, 3)
  for (const t of recent) assert.notEqual(table.get(t.id), null)
})

await expect('recent(n) 按时间顺序给最近的几条', () => {
  const table = new TaskTable()
  for (let i = 0; i < 12; i += 1) {
    const t = newTask({ peerId: `n${i}` })
    t.startedAt = 100 + i
    table.add(t)
  }
  const list = table.recent(3)
  assert.deepEqual(list.map((t) => t.peerId), ['n9', 'n10', 'n11'])
  assert.equal(table.recent().length, 10, '默认给 10 条')
})

console.log(`task ok · ${passed} 项断言 · 默认值 / 视图 / 淘汰 / 顺序`)
