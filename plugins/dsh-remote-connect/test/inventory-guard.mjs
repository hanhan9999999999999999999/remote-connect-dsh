/**
 * Inventory guard: the link's own state (password, peers, backups) must never
 * be offered for transfer, even when the whole plugins-data category is on.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-inv-'))
const dsh = path.join(tmp, 'dsh')
process.env.DSH_HOME = dsh
process.env.DEVICE_LINK_DSH_HOME = dsh
process.env.DEVICE_LINK_HOME = path.join(dsh, 'plugins-data', 'dsh-remote-connect')

const w = async (rel, text) => {
  const abs = path.join(dsh, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text)
}
await w('plugins-data/dsh-remote-connect/config.json', '{"auth":{"password":"secret"}}')
await w('plugins-data/dsh-remote-connect/peers.json', '{"peers":[]}')
await w('plugins-data/other-plugin/data.json', '{"ok":true}')
await w('.credentials.yaml', 'token: nope')
await w('skills/a/SKILL.md', '# a\n')
await w('sessions/ws/s/session.jsonl', '{}\n')

const { scanCategory } = await import('../host/inventory.mjs')

const pluginData = await scanCategory('plugin-data', { includeSecrets: false })
const rels = pluginData.entries.map((e) => e.rel)
assert.ok(rels.includes('plugins-data/other-plugin/data.json'))
assert.ok(!rels.some((r) => r.startsWith('plugins-data/dsh-remote-connect/')), 'own state must be excluded')
console.log(`PASS plugin-data · ${rels.length} entries, own state excluded`)

const skills = await scanCategory('skills', { includeSecrets: false })
assert.deepEqual(skills.entries.map((e) => e.rel), ['skills/a/SKILL.md'])
console.log('PASS skills scan')

const secrets = await scanCategory('skills', { includeSecrets: false })
assert.ok(!secrets.entries.some((e) => e.rel.endsWith('.credentials.yaml')))
console.log('PASS secret filter')

await fs.rm(tmp, { recursive: true, force: true })
