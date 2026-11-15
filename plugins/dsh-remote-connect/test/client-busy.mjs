#!/usr/bin/env node
/**
 * 「已经有一条在跑」这类拒绝，界面得有自己的动作。
 *
 * 服务端会回 409 `SYNC_BUSY`。如果界面只是把这句话弹成一闪而过的提示，用户看到的
 * 是「我点了没反应」；更常见的情况是刷新页面之后本地已经没有那条任务——进度条不
 * 见了、开始按钮又能点，点下去还是被拒。
 *
 * 这一组断言盯两件事：拒绝之后把状态读回来（让正在跑的那条重新出现在进度条上），
 * 以及页面加载时把已经在跑的任务接回本地状态。
 *
 * 用法：node test/client-busy.mjs [client.js 路径]
 */
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'client.js')
const text = fs.readFileSync(target, 'utf8')

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
function need(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 取一个函数/组件的正文（按括号配对，`参数) {` 后面那个 `{` 不算正文开头）。 */
function bodyOf(name) {
  const key = `function ${name}(`
  const at = text.indexOf(key)
  if (at < 0) throw new Error(`找不到 function ${name}`)
  const open = text.indexOf(') {', at)
  if (open < 0) throw new Error(`找不到 ${name} 的函数体`)
  let depth = 0
  for (let i = open + 2; i < text.length; i += 1) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 3, i)
    }
  }
  throw new Error(`${name} 的括号没配对`)
}

const syncPage = bodyOf('SyncPage')

ok('被拒之后把状态读回来，而不是只弹一句提示', () => {
  need(/e\.code === 'SYNC_BUSY'/.test(syncPage), 'SyncPage 没有单独处理 SYNC_BUSY')
  const at = syncPage.indexOf("e.code === 'SYNC_BUSY'")
  const near = syncPage.slice(at, at + 400)
  need(/reload\(/.test(near), '拿到 SYNC_BUSY 之后没有 reload，界面还停在旧状态')
  need(/t\('sync\.busy'\)/.test(near), 'SYNC_BUSY 没有用本地文案（用户会看到服务端的内部话）')
})

ok('页面加载时把已经在跑的任务接回本地状态', () => {
  need(/status\.tasks/.test(syncPage), 'SyncPage 没读过 status.tasks')
  const at = syncPage.indexOf('status.tasks')
  const near = syncPage.slice(Math.max(0, at - 400), at + 200)
  need(/finishedAt/.test(near), '没按 finishedAt 判断哪条还在跑')
  need(/setTask\(/.test(near), '没有把它接进本地 task 状态（进度条还是空的）')
})

ok('文案在字典里，中英都有', () => {
  need(/'sync\.busy': '[^']+'/.test(text), '字典里没有 sync.busy')
  const zh = text.indexOf("'sync.busy':")
  const en = text.indexOf("'sync.busy':", zh + 1)
  need(en > zh, 'sync.busy 只有一份（中英应当各一份）')
})

console.log(`client-busy ok · 3 项断言 · 拒绝后刷新 / 加载接管 / 文案（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
