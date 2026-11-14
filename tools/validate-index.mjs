#!/usr/bin/env node
/**
 * 独立校验 index.json（DSH 插件市场索引 format 1）。
 *
 * 不依赖 DSH 内部包，克隆之后 `node tools/validate-index.mjs` 就能跑；
 * 规则与 @deepseek-ai/dsh-plugin-market-index 的 parseMarketIndex 对齐：
 *   - 顶层 format 必须是 1
 *   - name 符合 PACKAGE_NAME，source.type 为 npm | git
 *   - git source：url 必须是 https，commit 必须是 40 位小写 hex，path 每段符合 PATH_SEGMENT
 *   - metadata.categories / labels 的每一项都是 { title: {...} }，且插件引用的 id 必须已声明
 *   - 文件不能带 BOM（JSON.parse 会直接炸）
 *
 * 用法：
 *   node tools/validate-index.mjs              # 校验仓库根目录的 index.json
 *   node tools/validate-index.mjs path/to.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.resolve(process.argv[2] ?? path.join(here, '..', 'index.json'))

const errors = []
const warnings = []
const fail = (msg) => errors.push(msg)
const warn = (msg) => warnings.push(msg)

const raw = fs.readFileSync(file)
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  fail('文件带 UTF-8 BOM —— JSON.parse 会报 Unexpected token，请用无 BOM 写回')
}
let index
try {
  index = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
} catch (err) {
  console.error(`✗ ${path.relative(process.cwd(), file)} 不是合法 JSON：${err.message}`)
  process.exit(1)
}

const localizedOk = (v) =>
  typeof v === 'string' ||
  (v && typeof v === 'object' && typeof v.en === 'string')

if (index.format !== 1) fail(`format 必须是 1，实际是 ${JSON.stringify(index.format)}`)
if (!localizedOk(index.title)) fail('title 必须是字符串，或含 en 键的对象')
if (index.description !== undefined && !localizedOk(index.description)) {
  fail('description 必须是字符串，或含 en 键的对象')
}

const categories = index.metadata?.categories ?? {}
const labels = index.metadata?.labels ?? {}
for (const [kind, table] of [['categories', categories], ['labels', labels]]) {
  if (typeof table !== 'object' || table === null) {
    fail(`metadata.${kind} 必须是对象`)
    continue
  }
  for (const [id, item] of Object.entries(table)) {
    if (!item || typeof item !== 'object' || !localizedOk(item.title)) {
      fail(`metadata.${kind}.${id} 必须是 { title: { zh, en } } 形状`)
    }
  }
}

const plugins = index.plugins
if (!Array.isArray(plugins) || plugins.length === 0) {
  fail('plugins 必须是非空数组')
} else {
  for (const [i, plugin] of plugins.entries()) {
    const at = `plugins[${i}]`
    if (!plugin || typeof plugin !== 'object') {
      fail(`${at} 必须是对象`)
      continue
    }
    if (typeof plugin.name !== 'string' || !PACKAGE_NAME.test(plugin.name)) {
      fail(`${at}.name 不合法：${JSON.stringify(plugin.name)}`)
    }
    const meta = plugin.metadata ?? {}
    if (meta.category !== undefined && !(meta.category in categories)) {
      fail(`${at}.metadata.category "${meta.category}" 没有在 metadata.categories 里声明`)
    }
    for (const key of meta.labels ?? []) {
      if (!(key in labels)) fail(`${at}.metadata.labels 引用了未声明的 "${key}"`)
    }
    const versions = plugin.versions
    if (!Array.isArray(versions) || versions.length === 0) {
      fail(`${at}.versions 必须是非空数组`)
      continue
    }
    for (const [j, version] of versions.entries()) {
      const vAt = `${at}.versions[${j}]`
      if (typeof version?.version !== 'string' || !version.version) {
        fail(`${vAt}.version 必须是字符串`)
      }
      const source = version?.source
      if (!source || typeof source !== 'object') {
        fail(`${vAt}.source 缺失`)
        continue
      }
      if (source.type === 'npm') {
        if (typeof source.package !== 'string' && typeof source.name !== 'string') {
          warn(`${vAt}.source 建议给出 npm 包名`)
        }
      } else if (source.type === 'git') {
        if (typeof source.url !== 'string' || !/^https:\/\//.test(source.url)) {
          fail(`${vAt}.source.url 必须是 https 地址`)
        }
        if (typeof source.commit !== 'string' || !COMMIT.test(source.commit)) {
          fail(`${vAt}.source.commit 必须是 40 位小写 hex`)
        }
        if (source.path !== undefined) {
          const segs = String(source.path).split('/').filter(Boolean)
          if (segs.length === 0) fail(`${vAt}.source.path 不能是空串`)
          for (const seg of segs) {
            if (!PATH_SEGMENT.test(seg)) fail(`${vAt}.source.path 段 "${seg}" 不合法`)
          }
        }
      } else {
        fail(`${vAt}.source.type 必须是 npm 或 git，实际是 ${JSON.stringify(source.type)}`)
      }
      if (version.publishTimestamp !== undefined && !Number.isInteger(version.publishTimestamp)) {
        fail(`${vAt}.publishTimestamp 必须是整数`)
      }
      if (version.engines?.dsh !== undefined && typeof version.engines.dsh !== 'string') {
        fail(`${vAt}.engines.dsh 必须是字符串`)
      }
      // 本地自检：git 源指向本仓库时，path 目录应当真的存在
      if (source.type === 'git' && source.path) {
        const local = path.join(here, '..', String(source.path))
        if (!fs.existsSync(local)) warn(`${vAt}.source.path 在本仓库里找不到：${source.path}`)
      }
    }
  }
}

const names = (plugins ?? []).map((p) => `${p.name}@${p.versions?.[0]?.version ?? '?'}`)
for (const w of warnings) console.warn(`! ${w}`)
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`)
  console.error(`\n索引校验失败：${errors.length} 个问题`)
  process.exit(1)
}
console.log(`✓ index.json 通过校验（format 1 · ${(plugins ?? []).length} 个插件：${names.join(', ')}）`)
