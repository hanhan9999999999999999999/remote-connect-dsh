#!/usr/bin/env node
/**
 * 端口输入不许「悄悄变成默认值」。
 *
 * 以前的写法是 `Number(port) || 8788`：
 *   - 输入框里写 `abc` → NaN → 变成 8788，界面还很开心地说「已保存」；
 *   - 写 `0` → 也是 8788；
 *   - 连接表单里写 `abc` → 去连默认端口，用户以为指向了别处。
 * 这种「帮他兜底」看着体贴，实际上是把他刚才敲的字悄悄换掉了。
 *
 * 这个文件做两件事：
 *   1. 从 client.js 里把 parsePort() 抠出来，真跑一遍看它对一串输入的判断；
 *   2. 静态核对调用点：两个填端口的地方都必须先判、判不过就 return，且不再有
 *      `Number(...) || 默认值` 这种写法。
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

/** 抠出 parsePort 的函数体（按括号配对；`) {` 之后的那个 `{` 是函数体自己的开头，不算） */
function bodyOf(name) {
  const at = text.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const start = text.indexOf(') {', at)
  if (start < 0) return ''
  let depth = 1
  for (let i = start + 3; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + 3, i)
    }
  }
  return ''
}

const body = bodyOf('parsePort')
ok('client.js 里有 parsePort 这个函数', body.length > 50, `取到 ${body.length} 字符`)

// —— 1. 真跑一遍（把函数体原样编译出来，不依赖浏览器环境）
if (body.length > 50) {
  let parsePort = null
  try {
    // eslint-disable-next-line no-new-func
    // 函数体里的 min / max 来自参数解构，包一层把默认值补上
    parsePort = new Function(
      `return function parsePort(raw, opts) { const { min = 1024, max = 65535 } = opts || {}; ${body} }`,
    )()
  } catch (err) {
    ok('parsePort 能被编译出来', false, err?.message)
  }
  if (parsePort) {
    const cases = [
      ['8788', true, 8788],
      [' 9000 ', true, 9000],
      ['1024', true, 1024],
      ['65535', true, 65535],
      ['abc', false],
      ['', false],
      ['  ', false],
      ['0', false],
      ['99999', false],
      ['8788.5', false],
      ['-1', false],
      ['8e3', false],
      ['0x22b4', false],
      ['123456', false],
    ]
    let bad = []
    for (const [input, expected, value] of cases) {
      const r = parsePort(input, { min: 1024, max: 65535 })
      const good = Boolean(r?.ok) === expected && (!expected || r.value === value)
      if (!good) bad.push(`${JSON.stringify(input)} → ${JSON.stringify(r)}`)
    }
    ok('一串典型输入都判对了（含 NaN / 0 / 越界 / 小数 / 十六进制）', bad.length === 0, bad.join(' ; '))
    ok('判不过时会带回原始文本（好让提示里说清填的是什么）', parsePort('abc', {}).text === 'abc')
    const narrow = parsePort('80', { min: 1024, max: 65535 })
    ok('范围可以收紧（80 对监听端口不合法）', narrow.ok === false)
    ok('连接对端的端口允许 1–65535', parsePort('80', { min: 1, max: 65535 }).ok === true)
  }
}

// —— 2. 两个调用点都必须先判
const saveAt = text.indexOf('const saveServer = async () => {')
const saveBlock = saveAt >= 0 ? text.slice(saveAt, saveAt + 700) : ''
ok('保存监听设置前先校验端口', /const parsed = parsePort\(port,/.test(saveBlock), saveBlock.slice(0, 200))
ok('校验不过就直接返回（不发请求）', /if \(!parsed\.ok\)[\s\S]{0,200}return notify\(t\('net\.portInvalid'/.test(saveBlock))

const connAt = text.indexOf('const connect = async (override) => {')
const connBlock = connAt >= 0 ? text.slice(connAt, connAt + 1400) : ''
ok('连接前也校验端口', /parsePort\((?:parsedHost\.port \?\? )?form\.port,/.test(connBlock) && /parsePort\(override\.port,/.test(connBlock))
ok('连接校验不过时也直接返回', /if \(!parsed\.ok\)[\s\S]{0,200}return notify\(t\('net\.portInvalid'/.test(connBlock))

// —— 3. 不许再退回「悄悄兜底」
{
  // 注释里会提到旧写法（那是在解释为什么要改），扫的时候要跳过注释行
  const codeLines = text
    .split('\n')
    .map((line) => (line.trim().startsWith('*') || line.trim().startsWith('//') ? '' : line))
  const code = codeLines.join('\n')
  const bad = []
  const re = /Number\((?:form\.)?port\)\s*\|\|/g
  let m
  while ((m = re.exec(code)) !== null) bad.push(m.index)
  ok('代码里不再有 Number(port) || 默认值 这种兜底', bad.length === 0, `命中 ${bad.length} 处`)
}

console.log(`client-port ok · ${pass + fail} 项断言 · 端口校验 / 调用点 / 不再兜底（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
