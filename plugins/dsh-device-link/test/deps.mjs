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

await fs.rm(tmp, { recursive: true, force: true })
