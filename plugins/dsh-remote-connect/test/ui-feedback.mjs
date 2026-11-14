/**
 * 界面反馈守卫：按钮点下去，就必须有结果。
 *
 * 由来（1.0.41）：复制按钮拿到 `copyText` 返回 false 时什么都不做——
 * 用户点了一下，界面毫无变化，只会以为按钮坏了。
 * 这不是「少了个 toast」，是「动作有没有生效」这件事根本没人回答。
 *
 * 这里查三件事：
 *   1. CopyBtn 有明确的失败分支（不是只在成功时给反馈）
 *   2. `copyText()` 的返回值一律被使用，不许裸调用
 *   3. 不许再出现「空 catch 里只写一句 best-effort / keep polling」的写法
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'client.js')
const text = fs.readFileSync(target, 'utf8')

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

/** 取一个函数/组件体（从声明处到同层闭合的 `}`），够用就好。
 *  注意：参数表里也有 `{}`（解构），所以要从 `) {` 之后数起。 */
function bodyOf(name, openMarker) {
  const start = text.indexOf(openMarker)
  if (start < 0) throw new Error(`找不到 ${name}`)
  const params = text.indexOf(') {', start)
  if (params < 0) throw new Error(`${name} 的签名解析不了`)
  let depth = 0
  for (let i = params + 2; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 没有闭合`)
}

expect('CopyBtn 有失败分支，且用得上 copyFailed 文案', () => {
  const body = bodyOf('CopyBtn', 'function CopyBtn(')
  if (!/copyText\(/.test(body)) throw new Error('CopyBtn 不再调用 copyText，检查这个守卫是否过期')
  if (!/fail/.test(body)) throw new Error('CopyBtn 没有失败分支：复制失败时界面不会有任何变化')
  if (!/copyFailed/.test(body)) throw new Error('CopyBtn 失败时没有告诉用户（缺 copyFailed 文案）')
})

expect('copyText() 的返回值必须被使用', () => {
  const bare = []
  for (const m of text.matchAll(/(\S[^\n]{0,24})await copyText\(/g)) {
    const before = m[1]
    if (!/(=|\(|return|if|\?\?|\|\|)\s*$/.test(before)) bare.push(before.trim().slice(-24))
  }
  if (bare.length) throw new Error(`这些地方裸调用了 copyText，返回值被丢掉：${bare.join(' / ')}`)
})

expect('没有「空 catch 里只写 best-effort / keep polling」的写法', () => {
  const bad = []
  const re = /catch\s*(?:\([^)]*\))?\s*\{\s*\/\*([^*]*?)\*\/\s*\}/g
  for (const m of text.matchAll(re)) {
    const note = m[1]
    if (!/best[- ]?effort|keep polling|ignore/i.test(note)) continue
    bad.push(`${text.slice(0, m.index).split('\n').length} 行：/*${note.trim()}*/`)
  }
  if (bad.length) throw new Error(`这些地方把异常整个吞了，用户只会看到「没反应」：\n    ${bad.join('\n    ')}`)
})

console.log(`\nui-feedback ok · ${pass} 项断言 · 复制失败有反馈 / copyText 返回值被用 / 无静默吞异常（${pass} 通过、${fail} 失败）`)
if (fail > 0) process.exit(1)
