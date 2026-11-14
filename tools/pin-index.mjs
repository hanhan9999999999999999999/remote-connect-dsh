#!/usr/bin/env node
/**
 * 把市场索引钉到某个版本 / 某个提交，并且**写出稳定的格式**。
 *
 * 为什么要有这个脚本：`publishTimestamp` 用 `Get-Date -UFormat %s` 会多 8 小时，
 * 用 `ConvertTo-Json` 写出的是 Windows 的 CRLF，还会把本来就紧凑的数组摊成几十行——
 * 一次发版就能在索引上制造几十行假改动。这里只做三件事：
 *   1. 改 plugins[i].versions[0] 的 version / source.commit / publishTimestamp
 *   2. 用固定缩进 + LF 写回（不碰其它字段）
 *   3. 顺手校验格式（format=1、包名、40 位 hex、无 BOM），不对就非零退出
 *
 * 用法：
 *   node tools/pin-index.mjs --version 1.0.27 --commit <40 位 sha>
 *   node tools/pin-index.mjs --version 1.0.27 --commit <sha> --ts 1794677881
 *   node tools/pin-index.mjs --version 1.0.27 --commit <sha> --name dsh-remote-connect
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const file = path.join(repo, 'index.json')

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const version = arg('version')
const commit = arg('commit')
const name = arg('name')
const tsArg = arg('ts')

if (!version) fail('缺 --version（例：--version 1.0.28）')
if (!commit) fail('缺 --commit（40 位小写 hex，取自 git rev-parse HEAD）')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`--version 不像版本号：${version}`)
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`--commit 必须是 40 位小写 hex，收到：${commit}`)

const raw = fs.readFileSync(file, 'utf8')
if (raw.charCodeAt(0) === 0xfeff) fail('index.json 开头有 BOM，市场解析器会直接报语法错')

let index
try {
  index = JSON.parse(raw)
} catch (err) {
  fail(`index.json 不是合法 JSON：${err.message}`)
}
if (index.format !== 1) fail(`format 必须是 1，现在是 ${index.format}`)

const plugins = Array.isArray(index.plugins) ? index.plugins : []
const plugin = name ? plugins.find((p) => p.name === name) : plugins[0]
if (!plugin) fail(name ? `索引里没有这个插件：${name}` : '索引里没有任何插件')

if (!PACKAGE_NAME.test(plugin.name)) fail(`插件名不合规：${plugin.name}`)
const versions = Array.isArray(plugin.versions) ? plugin.versions : []
const target = versions[0]
if (!target) fail(`${plugin.name} 没有任何版本条目`)
if (target.source?.type !== 'git') fail('这个脚本只处理 git 来源的版本条目')
if (target.source.path && !target.source.path.split('/').filter(Boolean).every((s) => PATH_SEGMENT.test(s))) {
  fail(`source.path 不合规：${target.source.path}`)
}

const ts = tsArg ? Number(tsArg) : Math.floor(Date.now() / 1000)
if (!Number.isInteger(ts) || ts <= 0) fail(`--ts 必须是正整数的秒级时间戳，收到：${tsArg}`)

const before = { version: target.version, commit: target.source.commit, ts: target.publishTimestamp }
target.version = version
target.source.commit = commit
target.publishTimestamp = ts

// 固定格式：2 空格缩进 + LF + 结尾一个换行。只改内容，不重排字段顺序。
const text = `${JSON.stringify(index, null, 2)}\n`
fs.writeFileSync(file, text, 'utf8')

console.log(`✓ ${plugin.name} 已钉到 ${version}`)
console.log(`  commit    ${before.commit.slice(0, 7)} → ${commit.slice(0, 7)}`)
console.log(`  时间戳    ${before.ts} → ${ts}`)
if (before.version !== version) console.log(`  版本号    ${before.version} → ${version}`)
console.log(`  文件      ${file}（${Buffer.byteLength(text)} 字节，LF）`)
