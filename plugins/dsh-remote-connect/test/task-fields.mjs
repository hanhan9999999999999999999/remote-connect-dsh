/**
 * 「后端给的字段，界面至少得用上」守卫。
 *
 * 由来：1.0.39 让后端把 `progressFailures` 报出来了，但界面压根没有地方读它，
 * 于是用户还是什么都看不到——后端说清楚了、前端照样沉默。
 * 这类漂移用眼睛很难发现，所以这里做一条机械检查：
 * taskView 放行的每一个字段，client.js 里都必须至少出现一次；
 * 真的不该展示的，写进 UNUSED 并写明理由。
 */
import assert from 'node:assert'
import path from 'node:path'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.join(here, '..')
const { newTask, taskView } = await import(pathToFileURL(path.join(root, 'host', 'tasks.mjs')).href)
const clientSrc = await fs.readFile(path.join(root, 'client.js'), 'utf8')

/** 任务字段里确实不该出现在界面上的，写在这里并说明理由。 */
const UNUSED = new Map([
  ['kind', '目前只有 sync 一种任务，界面上不需要区分'],
  ['peerId', '任务就显示在刚发起同步的那一屏，不需要再标一遍对端'],
])

let passed = 0
const expect = (label, fn) => {
  fn()
  passed += 1
  console.log(`PASS ${label}`)
}

const keys = Object.keys(taskView(newTask({ peerId: 'p1' })))
// 「用到」= 以属性访问的形式出现（`task.bytes` / `next.phase`），
// 光出现同名单词不算——`kind` 这种词在样式里到处都有。
const usedInClient = (key) => new RegExp(`\\.${key}\\b`).test(clientSrc)

expect('taskView 的字段都出现在 client.js 里（或明确豁免）', () => {
  const missing = []
  for (const key of keys) {
    if (UNUSED.has(key)) continue
    if (!usedInClient(key)) missing.push(key)
  }
  assert.deepEqual(missing, [], `这些任务字段后端有、界面完全没用到：${missing.join(', ')}`)
})

expect('进度失败与轮询失败都有对应的界面文案', () => {
  for (const key of ['sync.progressUnreliable', 'sync.pollStale', 'sync.resultLine']) {
    assert.ok(clientSrc.includes(`'${key}'`), `字典里缺少 ${key}`)
    assert.ok(new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`).test(clientSrc), `${key} 定义了却没人 t() 用`)
  }
})

expect('豁免表里的字段确实没被用到（豁免过期就要删掉）', () => {
  const stale = []
  for (const key of UNUSED.keys()) {
    if (usedInClient(key)) stale.push(key)
  }
  assert.deepEqual(stale, [], `这些字段界面已经用上了，可以从 UNUSED 里删掉：${stale.join(', ')}`)
})

console.log(`\ntask-fields ok · ${passed} 项断言 · 字段覆盖 / 文案存在 / 豁免不过期（${keys.length} 个任务字段）`)
