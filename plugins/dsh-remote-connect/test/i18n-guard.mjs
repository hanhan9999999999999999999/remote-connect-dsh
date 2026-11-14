#!/usr/bin/env node
/**
 * client.js 的文案守卫。
 *
 * 这个界面有两套字典（zh / en），但真正会发生的事故不是「字典缺键」——
 * 而是有人图快，直接在 JSX 里写一句中文：
 *     h('option', { value: '127.0.0.1' }, '127.0.0.1 · 仅本机')
 * 中文用户看不出来，英文用户会看到一句中文镶嵌在英文界面里。
 *
 * 这里查四件事：
 *   1. 两套字典的键集合一致，且都够多
 *   2. 每个键的占位符（{n} / {size} / {time}）在两种语言里一样
 *   3. 字典之外的字符串字面量里没有中文字符（注释里可以有）
 *   4. t('…') 用到的键都在字典里；代码里不再出现旧品牌名
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 默认查插件自己的 client.js；也可以传一个路径，方便验证守卫本身是否有效
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'client.js')
const text = fs.readFileSync(target, 'utf8')
const lines = text.split('\n')

let pass = 0
let fail = 0
const expect = (label, fn) => {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err.message}`)
  }
}

/* ---------------------------------------------------------------- */
/* 抽出两套字典                                                      */
/* ---------------------------------------------------------------- */

function dictBounds(name) {
  const start = lines.findIndex((l) => l.trim() === `const ${name} = {`)
  if (start < 0) throw new Error(`找不到 const ${name} = {`)
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{4}\}\s*$/.test(lines[i])) return { start, end: i }
  }
  throw new Error(`${name} 字典没有闭合`)
}

const zh = dictBounds('zh')
const en = dictBounds('en')

function parseDict({ start, end }) {
  const out = new Map()
  for (let i = start + 1; i < end; i += 1) {
    const m = /^\s+(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(lines[i])
    if (m) out.set(m[1] ?? m[2], m[3])
  }
  return out
}

const zhDict = parseDict(zh)
const enDict = parseDict(en)

expect('中英字典键数相同且超过 150 条', () => {
  if (zhDict.size !== enDict.size) throw new Error(`zh ${zhDict.size} 键，en ${enDict.size} 键`)
  if (zhDict.size < 150) throw new Error(`只有 ${zhDict.size} 条，像是解析错了`)
  return true
})

expect('没有只在中文里有、英文里缺失的键', () => {
  const missing = [...zhDict.keys()].filter((k) => !enDict.has(k))
  if (missing.length) throw new Error(`${missing.length} 个：${missing.slice(0, 6).join(', ')}`)
  return true
})

expect('没有只在英文里有、中文里缺失的键', () => {
  const missing = [...enDict.keys()].filter((k) => !zhDict.has(k))
  if (missing.length) throw new Error(`${missing.length} 个：${missing.slice(0, 6).join(', ')}`)
  return true
})

/* ---------------------------------------------------------------- */
/* 占位符必须一致                                                    */
/* ---------------------------------------------------------------- */

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

expect('同一句文案在两种语言里的占位符一致', () => {
  const bad = []
  for (const [key, zhText] of zhDict) {
    const enText = enDict.get(key)
    if (enText === undefined) continue
    if (holes(zhText) !== holes(enText)) bad.push(`${key}（zh: {${holes(zhText)}} / en: {${holes(enText)}}）`)
  }
  if (bad.length) throw new Error(bad.slice(0, 5).join('；'))
  return true
})

/* ---------------------------------------------------------------- */
/* 字典之外不许出现中文字符（注释里可以）                            */
/* ---------------------------------------------------------------- */

/** 逐字符扫描，标出哪些位置在字符串/模板里、哪些在注释里。 */
function classify(src) {
  const inString = new Uint8Array(src.length)
  const inComment = new Uint8Array(src.length)
  let i = 0
  let quote = null
  const prevMeaningful = () => {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!/\s/.test(src[j])) return src[j]
    }
    return ''
  }
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      inString[i] = 1
      if (ch === '\\') {
        inString[i + 1] = 1
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        inComment[i] = 1
        i += 1
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        inComment[i] = 1
        i += 1
      }
      i += 2
      continue
    }
    if (ch === '/' ) {
      // 正则字面量：粗略跳过（这个文件里只有 pwd=… 与包名两条）
      const prev = prevMeaningful()
      if (!/[A-Za-z0-9_$)\]]/.test(prev)) {
        i += 1
        while (i < src.length && src[i] !== '/') {
          if (src[i] === '\\') i += 1
          i += 1
        }
        i += 1
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      inString[i] = 1
      i += 1
      continue
    }
    i += 1
  }
  return { inString, inComment }
}

/**
 * 字典区间（按行号 → 字符偏移）之外，字符串字面量里不许有中文。
 * 注释里的中文是文风，不是漏翻。
 */
expect('字典之外的字符串里没有中文（注释除外）', () => {
  const { inString, inComment } = classify(text)
  let offset = 0
  const lineStart = []
  for (const line of lines) {
    lineStart.push(offset)
    offset += line.length + 1
  }
  const dictRanges = [
    [lineStart[zh.start], lineStart[zh.end] + lines[zh.end].length],
    [lineStart[en.start], lineStart[en.end] + lines[en.end].length],
  ]
  const inDict = (pos) => dictRanges.some(([a, b]) => pos >= a && pos <= b)

  // 样式表也是一段字符串，但它不是界面文字：CSS 注释里的中文是写给人看的，
  // 不会显示给用户。注释之外的 CSS 中文仍然算问题（那才是会漏到界面上的 content）。
  const cssAt = text.indexOf('const css = `')
  const cssStart = cssAt >= 0 ? text.indexOf('`', cssAt) + 1 : -1
  const cssEnd = cssStart > 0 ? text.indexOf('`', cssStart) : -1
  const inCss = (pos) => cssStart > 0 && pos >= cssStart && pos < cssEnd
  const cssComment = new Uint8Array(text.length)
  for (let p = cssStart; p > 0 && p < cssEnd; ) {
    const open = text.indexOf('/*', p)
    if (open < 0 || open >= cssEnd) break
    const close = text.indexOf('*/', open + 2)
    const stop = close < 0 || close >= cssEnd ? cssEnd : close + 2
    for (let k = open; k < stop; k += 1) cssComment[k] = 1
    p = stop
  }

  // 一行里有好几个汉字也只算一处：按行号去重，否则一条文案会报成六条
  const badLines = new Set()
  for (let pos = 0; pos < text.length; pos += 1) {
    if (!/[\u4e00-\u9fff]/.test(text[pos])) continue
    if (inComment[pos]) continue
    if (inCss(pos)) {
      if (!cssComment[pos]) badLines.add(text.slice(0, pos).split('\n').length)
      continue
    }
    if (!inString[pos]) continue
    if (inDict(pos)) continue
    badLines.add(text.slice(0, pos).split('\n').length)
  }
  if (badLines.size) {
    const detail = [...badLines].slice(0, 6).map((n) => `${n}: ${lines[n - 1].trim().slice(0, 80)}`)
    throw new Error(`${badLines.size} 行写死的中文：\n    ${detail.join('\n    ')}`)
  }
  return true
})

/* ---------------------------------------------------------------- */
/* t() 用到的键必须存在；旧品牌名不许残留                            */
/* ---------------------------------------------------------------- */

expect('t(…) 用到的键都在字典里', () => {
  const used = new Set()
  for (const m of text.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(m[1])
  const missing = [...used].filter((k) => !zhDict.has(k))
  if (missing.length) throw new Error(`${missing.length} 个：${missing.slice(0, 8).join(', ')}`)
  if (used.size < 80) throw new Error(`只找到 ${used.size} 处 t()，正则可能失效了`)
  return true
})

expect('界面文案里没有旧品牌名 Device Link', () => {
  if (/Device Link|DeviceLink/.test(text)) throw new Error('还留着旧品牌名，英文界面会显示 Device Link')
  return true
})

console.log(
  `i18n ok · 词条 ${zhDict.size} 中英对齐 · 占位符一致 · 写死中文 0 处 · t() ${new Set([...text.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])).size} 处（${pass} 通过、${fail} 失败）`,
)
if (fail > 0) process.exit(1)
