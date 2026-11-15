#!/usr/bin/env node
/**
 * 「地址」这一栏能读成什么。
 *
 * 面板上就摆着那串 `dshlink://192.168.1.5:8788?name=…&pwd=…`，旁边还有个复制按钮——
 * 拿到它的人自然会整串粘进「地址」。以前一律当主机名发出去，于是去连一个叫
 * `dshlink://…` 的主机，报一句 DNS 找不到，人还以为对方机器没开。
 *
 * 这个文件把 parseHostInput 抠出来真跑一遍，覆盖人可能填/粘的几种写法。
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

/** 取某个函数声明的函数体（`) {` 之后按括号配对；`) {` 里的 `{` 之后才是正文） */
function bodyOf(name) {
  const at = text.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const open = text.indexOf(') {', at)
  if (open < 0) return ''
  const start = open + 3
  let depth = 1
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i)
    }
  }
  return ''
}

const body = bodyOf('parseHostInput')
ok('client.js 里有 parseHostInput 这个函数', body.length > 200, `取到 ${body.length} 字符`)

let parseHostInput = null
try {
  // 函数体里的 defaultPort 来自参数解构，包一层把默认值补上
  parseHostInput = new Function(
    `return function parseHostInput(raw, opts) { const { defaultPort = 8788 } = opts || {}; ${body} }`,
  )()
} catch (err) {
  ok('parseHostInput 能被单独编译', false, err?.message)
}

if (parseHostInput) {
  const run = (raw) => parseHostInput(raw, { defaultPort: 8788 })

  // —— 只填主机
  {
    const r = run('192.168.1.20')
    ok('只有主机时 host 就是它、不带端口', r.ok === true && r.host === '192.168.1.20' && r.port === undefined)
    ok('前后空格会被去掉', run('  192.168.1.20  ').host === '192.168.1.20')
  }

  // —— 主机带端口
  {
    const r = run('192.168.1.20:8899')
    ok('主机带端口时拆开', r.ok === true && r.host === '192.168.1.20' && r.port === 8899)
    ok('带 http:// 前缀也认', (() => { const x = run('http://192.168.1.20:8899'); return x.ok && x.host === '192.168.1.20' && x.port === 8899 })())
    ok('末尾多余斜杠会被去掉', run('http://192.168.1.20:8899/').host === '192.168.1.20')
    ok('端口越界不认', run('192.168.1.20:70000').ok === false)
  }

  // —— 整串连接串（复制按钮旁边那种）
  {
    const r = run('dshlink://192.168.1.5:8788?name=PC-A&pwd=s3cret&v=1')
    ok('整串 dshlink:// 能读成主机 + 端口', r.ok === true && r.host === '192.168.1.5' && r.port === 8788)
    ok('整串里的密码被读出来', r.password === 's3cret')
    ok('整串里的备注名被读出来', r.name === 'PC-A')
    ok('整串被标记了来源（好让界面知道该覆盖哪些字段）', r.fromLink === true)
    ok('大写协议头也认', (() => { const x = run('DSHLINK://10.0.0.9:9000?pwd=a'); return x.ok && x.host === '10.0.0.9' && x.port === 9000 })())
    ok('链接里没写端口时回落到默认端口', run('dshlink://10.0.0.9?pwd=a').port === 8788)
    ok('链接写坏了报 link 而不是当成主机', (() => { const x = run('dshlink://'); return x.ok === false && x.reason === 'link' })())
  }

  // —— 明显不对的
  {
    ok('空地址报 empty', (() => { const x = run('   '); return x.ok === false && x.reason === 'empty' })())
    ok('带空格的域名不当成主机（含空格的地址没法连）', run('my laptop').ok === false)
    ok('带路径的不当成主机', run('192.168.1.20/admin').ok === false)
  }

  // —— 调用点确实用了它
  {
    const at = text.indexOf('const parsedHost = parseHostInput(')
    const block = at >= 0 ? text.slice(at, at + 900) : ''
    ok('连接前先按人的写法解析地址', at >= 0, '没找到 parseHostInput 的调用')
    ok('解析不了就当场提示、不发请求', /connect\.hostInvalid/.test(block) && /return notify\(/.test(block))
    ok('地址里的端口优先于手填端口', /parsedHost\.port \?\? form\.port/.test(block))
  }
}

console.log(`client-host ok · ${pass + fail} 项断言 · 只填主机 / 带端口 / 整串连接串 / 明显不对（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
