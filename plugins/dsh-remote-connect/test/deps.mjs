/**
 * Dependency detection and repair, using a local file: dependency so the test
 * never touches the network.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-deps-'))
const dsh = path.join(tmp, 'dsh')
process.env.DEVICE_LINK_DSH_HOME = dsh
const plugin = path.join(dsh, 'plugins', 'demo')
await fs.mkdir(path.join(plugin, 'fixture-dep'), { recursive: true })
await fs.writeFile(
  path.join(plugin, 'package.json'),
  JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { 'fixture-dep': 'file:./fixture-dep' } }, null, 2),
)
await fs.writeFile(
  path.join(plugin, 'fixture-dep', 'package.json'),
  JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.js' }, null, 2),
)
await fs.writeFile(path.join(plugin, 'fixture-dep', 'index.js'), 'module.exports = 1\n')
await fs.mkdir(path.join(dsh, 'plugins', 'standalone'), { recursive: true })
await fs.writeFile(path.join(dsh, 'plugins', 'standalone', 'package.json'), JSON.stringify({ name: 'standalone', version: '1.0.0' }))

const { scanPluginDeps, installPluginDeps, assertPluginId } = await import('../host/deps.mjs')

const before = await scanPluginDeps(dsh)
assert.deepEqual(before.missing, ['demo'])
assert.equal(before.plugins.find((p) => p.id === 'demo').missing[0], 'fixture-dep')
assert.equal(before.plugins.find((p) => p.id === 'standalone').status, 'ok')
console.log('PASS detection · demo missing fixture-dep, standalone ok')

const lines = []
const result = await installPluginDeps(['demo'], { onLine: (l) => lines.push(l) })
assert.equal(result.ok, true, result.results.map((r) => r.lines.join('\n')).join('\n'))
const after = await scanPluginDeps(dsh)
assert.deepEqual(after.missing, [])
assert.ok(await fs.stat(path.join(plugin, 'node_modules', 'fixture-dep', 'package.json')))
console.log(`PASS repair · npm install ok (${lines.length} lines)`)

assert.throws(() => assertPluginId('../etc'), /非法插件标识/)
console.log('PASS id validation')

// 点名了一个本机压根没装的插件：不能装作「已装好」
const unknown = await installPluginDeps(['no-such-plugin'])
assert.deepEqual(unknown.unknown, ['no-such-plugin'])
assert.deepEqual(unknown.results, [])
assert.equal(unknown.ok, false, 'unknown 非空时 ok 必须是 false')
console.log('PASS unknown id · 报 unknown 且 ok=false')

// 依赖齐全的插件：算 skipped，不算失败
const skipped = await installPluginDeps(['standalone'])
assert.deepEqual(skipped.skipped, ['standalone'])
assert.deepEqual(skipped.results, [])
assert.equal(skipped.ok, true)
console.log('PASS skipped · 已齐全的插件不重复安装')

// 超时：用假 npm 拖住 30 秒，预算会被抬到 5 秒下限，于是必然由我们自己掐断
await fs.mkdir(path.join(dsh, 'plugins', 'slowpoke'), { recursive: true })
await fs.writeFile(
  path.join(dsh, 'plugins', 'slowpoke', 'package.json'),
  JSON.stringify({ name: 'slowpoke', version: '1.0.0', dependencies: { 'never-installed': '1.0.0' } }),
)
const binDir = path.join(tmp, 'fake-npm')
await fs.mkdir(binDir, { recursive: true })
if (process.platform === 'win32') {
  await fs.writeFile(path.join(binDir, 'npm.cmd'), '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n')
} else {
  const shim = path.join(binDir, 'npm')
  await fs.writeFile(shim, '#!/bin/sh\nsleep 30\n')
  await fs.chmod(shim, 0o755)
}
const oldPath = process.env.PATH
process.env.PATH = binDir + path.delimiter + (oldPath ?? '')
let timed
try {
  timed = await installPluginDeps(['slowpoke'], { timeoutMs: 1 })
} finally {
  process.env.PATH = oldPath
}
assert.equal(timed.ok, false)
assert.equal(timed.results[0].code, 'TIMEOUT', `应当报 TIMEOUT，实际 ${timed.results[0].code}`)
console.log('PASS timeout · 被掐掉时报 TIMEOUT 而不是 EXIT_null')

// 装不上（离线依赖）时报 EXIT_<code>，同样不是 ok
await fs.mkdir(path.join(dsh, 'plugins', 'broken'), { recursive: true })
await fs.writeFile(
  path.join(dsh, 'plugins', 'broken', 'package.json'),
  JSON.stringify({ name: 'broken', version: '1.0.0', dependencies: { 'dsh-link-no-such-package-xyz': '9.9.9' } }),
)
const broken = await installPluginDeps(['broken'], { timeoutMs: 60_000 })
assert.equal(broken.ok, false)
assert.match(broken.results[0].code, /^EXIT_\d+$/, `应当报 EXIT_<code>，实际 ${broken.results[0].code}`)
console.log('PASS failure · npm 失败时报 EXIT_<code> 且 ok=false')

await fs.rm(tmp, { recursive: true, force: true })
