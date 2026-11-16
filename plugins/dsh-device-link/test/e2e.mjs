/**
 * End-to-end test: two LinkService processes, two isolated DSH homes.
 *
 * Covers: health check, wrong-password rejection, handshake, session restore,
 * remote inventory, pull (tar over encrypted frames), profile merge,
 * exclusion rules, push in the other direction, and rollback.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { RemotePeer } from '../host/peer.mjs'
import { Applier } from '../host/apply.mjs'
import { PackCache, preparePack } from '../host/pack.mjs'
import { Logger } from '../host/util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-e2e-'))
const basePort = 20000 + Math.floor(Math.random() * 20000)
const A = { dsh: path.join(root, 'A', 'dsh'), data: path.join(root, 'A', 'data'), port: basePort }
const B = { dsh: path.join(root, 'B', 'dsh'), data: path.join(root, 'B', 'data'), port: basePort + 1 }
const PASSWORD = 'TEST-PASSWORD-9x'
const CATS = ['skills', 'rules', 'plugins', 'config', 'sessions']
const logger = new Logger({})

const children = []
const cleanup = async () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 250))
  if (!process.env.KEEP_TMP) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}
process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
})

const w = async (base, rel, text) => {
  const abs = path.join(base, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text)
}
const exists = async (base, rel) => {
  try {
    await fs.access(path.join(base, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}
const read = (base, rel) => fs.readFile(path.join(base, ...rel.split('/')), 'utf8')

/* ---------------------------------------------------------------- fixtures */
await w(A.dsh, 'skills/demo-skill/SKILL.md', '# Demo skill\n\n这是 A 机器的技能。\n')
await w(A.dsh, 'skills/demo-skill/reference.md', 'reference body\n'.repeat(200))
await w(A.dsh, 'prompt-inject.md', '规则：回答要简洁。\n')
await w(A.dsh, 'cordis.patch.yml', '- insert: []\n')
await w(A.dsh, 'plugins/local-hello/package.json', JSON.stringify({ name: '@local/local-hello', version: '1.2.3' }, null, 2))
await w(A.dsh, 'plugins/local-hello/client.js', 'export const x = 1\n'.repeat(100))
await w(A.dsh, 'plugins/local-hello/node_modules/junk.js', 'must not travel\n')
await w(
  A.dsh,
  'profiles/desktop/package.json',
  JSON.stringify(
    {
      name: '@local/profile-desktop',
      dependencies: { '@local/local-hello': 'file:../../plugins/local-hello' },
      dsh: { profile: { bundles: ['@local/local-hello'] } },
    },
    null,
    2,
  ),
)
await w(A.dsh, 'sessions/work~0020space/s1/session.jsonl', '{"type":"user","text":"hi"}\n{"type":"assistant","text":"hello"}\n')
await w(A.dsh, 'storages/workspace.json', '{"workspaces":[]}\n')
await w(A.dsh, '.credentials.yaml', 'token: super-secret\n')
await w(A.dsh, 'plugins-data/private/blob.bin', 'private payload\n')

await w(
  B.dsh,
  'profiles/desktop/package.json',
  JSON.stringify(
    {
      name: '@local/profile-desktop',
      dependencies: { '@local/b-only': 'file:../../plugins/b-only' },
      dsh: { profile: { bundles: ['@local/b-only'] } },
      identity: 'b-local',
    },
    null,
    2,
  ),
)
await w(B.dsh, 'skills/b-existing/SKILL.md', '# B only\n')

const bProfileBefore = await read(B.dsh, 'profiles/desktop/package.json')

/* ------------------------------------------------------------ child nodes */
async function startNode(node, name) {
  const child = spawn(process.execPath, [path.join(here, 'link-node.mjs')], {
    env: {
      ...process.env,
      DEVICE_LINK_HOME: node.data,
      DEVICE_LINK_DSH_HOME: node.dsh,
      LINK_TEST_PORT: String(node.port),
      LINK_TEST_PASSWORD: PASSWORD,
      LINK_TEST_NAME: name,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (err += c))
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    if (out.includes('READY')) return child
    if (child.exitCode !== null) throw new Error(`node ${name} exited early: ${err || out}`)
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`node ${name} did not become ready: ${err || out}`)
}

/* ------------------------------------------------------------------- peers */
const device = { id: 'dev_orchestrator', name: 'orchestrator', platform: 'test' }
function makePeer(node, name) {
  return new RemotePeer({
    record: {
      id: `e2e_${name}`,
      name,
      host: '127.0.0.1',
      port: node.port,
      scheme: 'http',
      password: PASSWORD,
    },
    logger,
    device,
  })
}

try {
  await startNode(A, 'node-A')
  await startNode(B, 'node-B')

  const peerA = makePeer(A, 'node-A')
  const health = await peerA.health()
  assert.equal(health.protocol, 'dsh-link/v1')
  assert.ok(health.device && health.device.id, 'health must include a device id')
  console.log(`PASS health · ${health.app} v${health.version} · ${health.device.name}`)

  const bad = makePeer(A, 'node-A')
  let badCode = ''
  try {
    await bad.connect({ password: 'wrong-password' })
  } catch (err) {
    badCode = err.code
  }
  bad.close()
  assert.equal(badCode, 'BAD_PASSWORD')
  console.log('PASS wrong password rejected')

  const connected = await peerA.connect({ password: PASSWORD })
  assert.ok(connected.session?.token, 'connect must return a session token')
  console.log(`PASS handshake · session expires ${new Date(connected.session.expiresAt).toISOString()}`)

  // A fresh peer restores the stored token instead of asking for the password.
  const restored = new RemotePeer({ record: { ...peerA.record }, logger, device })
  assert.equal(await restored.restore(), true)
  const pong = await restored.requestJson('GET', '/ping')
  assert.ok(pong.device?.id)
  restored.close()
  console.log('PASS session restore')

  const inv = await peerA.inventory({ cats: CATS })
  assert.ok(inv.entries.length >= 8, `expected >=8 entries, got ${inv.entries.length}`)
  const rels = inv.entries.map((e) => e.rel)
  assert.ok(rels.includes('skills/demo-skill/SKILL.md'))
  assert.ok(rels.includes('profiles/desktop/package.json'))
  const profileEntries = inv.entries.filter((e) => e.rel === 'profiles/desktop/package.json')
  assert.equal(profileEntries.length, 1, 'profile package.json must appear exactly once')
  assert.equal(profileEntries[0].op, 'merge-profile')
  assert.ok(!rels.some((r) => r.includes('node_modules')), 'node_modules must be excluded')
  assert.ok(!rels.includes('.credentials.yaml'), 'credentials must be excluded')
  console.log(`PASS inventory · ${inv.totalFiles} files / ${inv.totalBytes} bytes · ${inv.entries.length} entries`)

  // ---- pull A -> B
  process.env.DEVICE_LINK_HOME = B.data
  process.env.DEVICE_LINK_DSH_HOME = B.dsh
  const applier = new Applier({ logger, dataHome: B.data, sync: { backupKeep: 5 } })
  const pulled = await peerA.pull({ cats: CATS, applier })
  assert.equal(pulled.phase, 'done')
  console.log(`PASS pull · ${pulled.files} files / ${pulled.bytes} bytes · sync ${pulled.id}`)

  assert.equal(await read(B.dsh, 'skills/demo-skill/SKILL.md'), '# Demo skill\n\n这是 A 机器的技能。\n')
  assert.equal(await read(B.dsh, 'prompt-inject.md'), '规则：回答要简洁。\n')
  assert.equal(await read(B.dsh, 'plugins/local-hello/client.js'), 'export const x = 1\n'.repeat(100))
  assert.equal(await read(B.dsh, 'sessions/work~0020space/s1/session.jsonl'), '{"type":"user","text":"hi"}\n{"type":"assistant","text":"hello"}\n')
  assert.equal(await exists(B.dsh, 'plugins/local-hello/node_modules/junk.js'), false)
  assert.equal(await exists(B.dsh, '.credentials.yaml'), false)
  assert.equal(await exists(B.dsh, 'plugins-data/private/blob.bin'), false)
  assert.equal(await exists(B.dsh, 'skills/b-existing/SKILL.md'), true)
  console.log('PASS applied files · exclusions honoured · local files untouched')

  const merged = JSON.parse(await read(B.dsh, 'profiles/desktop/package.json'))
  assert.equal(merged.identity, 'b-local')
  assert.equal(merged.dependencies['@local/local-hello'], 'file:../../plugins/local-hello')
  assert.equal(merged.dependencies['@local/b-only'], 'file:../../plugins/b-only')
  assert.deepEqual(merged.dsh.profile.bundles.sort(), ['@local/b-only', '@local/local-hello'])
  console.log('PASS profile merge · local identity and dependency preserved')

  // ---- push B -> A
  await w(B.dsh, 'skills/b-skill/SKILL.md', '# B skill\n\n来自 B 机器。\n')
  const outbound = await preparePack({ cats: ['skills'], cache: await new PackCache(path.join(B.data, 'hash-cache.json')).load(), maxFileMb: 32 })
  const pushed = await peerA.push({ entries: outbound.entries, manifest: outbound.manifest })
  assert.equal(pushed.phase, 'done')
  assert.equal(await read(A.dsh, 'skills/b-skill/SKILL.md'), '# B skill\n\n来自 B 机器。\n')
  console.log(`PASS push · ${pushed.files} files written on A`)

  // ---- rollback the pull on B
  const rb = await applier.rollback(pulled.id)
  assert.equal(await exists(B.dsh, 'skills/demo-skill/SKILL.md'), false)
  assert.equal(await exists(B.dsh, 'sessions/work~0020space/s1/session.jsonl'), false)
  assert.equal(await read(B.dsh, 'profiles/desktop/package.json'), bProfileBefore)
  assert.equal(await exists(B.dsh, 'skills/b-existing/SKILL.md'), true)
  console.log(`PASS rollback · removed=${rb.removed ?? '?'} restored=${rb.restored ?? '?'}`)

  await peerA.disconnect()
  console.log('PASS disconnect')
  console.log('\nE2E OK ·', root)
} catch (err) {
  console.error('E2E FAILED:', err?.stack || err)
  process.exitCode = 1
} finally {
  await cleanup()
}
