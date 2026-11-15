#!/usr/bin/env node
/**
 * 提示条（toast）的说话方式。
 *
 * 三件事以前都糊在一起：
 * 1. 出错了和「已保存」用的是同一个 aria-live=polite，读屏软件会把它排在
 *    当前正在念的内容后面 —— 而错误恰恰是需要立刻知道的那种；
 * 2. 连点两下同一个按钮（比如重复点「断开」），同一句话会被念两遍；
 * 3. 错误提示 4.2 秒就消失，够不够看完一行中文全凭运气。
 *
 * 这个文件只做静态核对：client.js 是宿主里跑的浏览器模块，在这里跑不起来，
 * 能查的是「代码里有没有把这件事写对」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'client.js')
const text = fs.readFileSync(target, 'utf8')

let pass = 0
let fail = 0
function ok(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? `：${detail}` : ''}`)
  }
}

/** 取某个函数声明的函数体（从参数列表之后的第一个 `{` 起，按括号配对） */
function bodyOf(name) {
  const at = text.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const start = text.indexOf(') {', at)
  if (start < 0) return ''
  let depth = 0
  for (let i = start + 2; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + 2, i)
    }
  }
  return ''
}

// —— 1. 错误用 assertive，普通成功用 polite
{
  const body = bodyOf('useToast')
  ok('useToast 存在且能取到函数体', body.length > 100, `取到 ${body.length} 字符`)
  ok('错误提示比普通提示多留一会儿', /nextTone === 'error' \? 9000 : 4200/.test(body), body.slice(0, 200))
  ok('同样的内容记下了上一次', /spoken/.test(body) && /repeat/.test(body))
  ok('空消息不再弹一个空条', /if \(!text\) return/.test(body))
}

// —— 2. 渲染的时候按 tone 决定 aria-live
{
  const at = text.indexOf("className: 'dlk-toast'")
  const block = at >= 0 ? text.slice(at, at + 700) : ''
  ok('提示条仍然挂着 role="status"', /role: 'status'/.test(block), block.slice(0, 120))
  ok('错误用 assertive 报出来', /'aria-live':[^,\n]*toast\.tone === 'error' \? 'assertive'/.test(block), block.slice(0, 300))
  ok('重复内容改成 off（不再念一遍）', /toast\.repeat \? 'off'/.test(block))
}

// —— 3. 不允许退回「一律 polite」
{
  const at = text.indexOf("className: 'dlk-toast'")
  const block = at >= 0 ? text.slice(at, at + 700) : ''
  ok("不再是写死的 'aria-live': 'polite'", !/'aria-live': 'polite',?\s*\}/.test(block))
}

// —— 4. CSS：错误与警告条要能看清（有专用色），并且尊重「减少动效」
{
  ok('错误条有专用描边色', /\.dlk-toast\[data-tone=error\]/.test(text))
  ok('警告条有专用描边色', /\.dlk-toast\[data-tone=warn\]/.test(text))
  ok('减少动效时提示条不做过渡', /prefers-reduced-motion: reduce\)\{[^}]*\.dlk-toast/.test(text))
}

console.log(
  `toast-a11y ok · ${pass + fail} 项断言 · 说话方式 / 停留时长 / 不重复念（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
