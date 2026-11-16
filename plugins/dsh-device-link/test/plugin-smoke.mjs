/**
 * Mounts index.js on a fake DSH web server and exercises the real HTTP routes.
 * Proves the plugin entry, route table, service bootstrap and error mapping.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-plugin-'))
const port = 21000 + Math.floor(Math.random() * 15000)
process.env.DEVICE_LINK_HOME = path.join(tmp, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(tmp, 'dsh')

const { ConfigStore } = await import('../host/config.mjs')
const store = new ConfigStore()
await store.load()
await store.patch({ server: { enabled: true, port, bind: '127.0.0.1', discovery: false } })
await store.setPassword('SMOKE-PASSWORD-123')

const routes = new Map()
const fakeWeb = {
  register({ path: p, handler }) {
    routes.set(p, handler)
    return () => routes.delete(p)
  },
  get port() {
    return port
  },
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const handler = routes.get(pathname)
  if (!handler) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    return res.end('<h1>Not Found</h1>')
  }
  handler(req, res)
})
await new Promise((r) => server.listen(port, '127.0.0.1', r))

const disposers = []
const ctx = {
  get: (name) => (name === 'webServer' ? fakeWeb : null),
  effect: (fn) => {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
  },
}
const plugin = await import('../index.js')
plugin.apply(ctx)

const call = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/dsh-device-link-api${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  return { status: res.status, json }
}

try {
  assert.equal(routes.size, 30, `expected 30 routes, got ${routes.size}`)

  const status = await call('GET', '/status')
  assert.equal(status.status, 200)
  assert.equal(status.json.ok, true)
  assert.equal(status.json.data.server.running, true)
  assert.ok(status.json.data.server.port >= port, 'service must be listening (the fake web server owns the configured port)')
  assert.ok(status.json.data.config.auth.password)
  assert.ok(Array.isArray(status.json.data.config.categories) && status.json.data.config.categories.length === 6)
  console.log(`PASS status · running on ${status.json.data.server.port} · ${status.json.data.config.categories.length} categories`)

  const diag = await call('GET', '/diagnostics')
  assert.equal(diag.json.ok, true)
  assert.ok(diag.json.data.checks.length >= 9, 'expected at least 9 diagnostic checks')
  assert.ok(diag.json.data.checks.some((c) => c.id === 'server' && c.status === 'ok'))
  console.log(`PASS diagnostics · ${diag.json.data.checks.filter((c) => c.status === 'ok').length}/${diag.json.data.checks.length} ok`)

  const deps = await call('GET', '/deps')
  assert.equal(deps.json.ok, true)
  assert.deepEqual(deps.json.data.plugins, [])
  console.log('PASS plugin deps · empty home reports nothing missing')

  const bad = await call('GET', '/password/rotate')
  assert.equal(bad.status, 405)
  assert.equal(bad.json.error.code, 'METHOD')
  console.log('PASS method guard · 405 on wrong verb')

  const rotated = await call('POST', '/password/rotate')
  assert.equal(rotated.json.data.password.length >= 12, true)
  const cfg = await call('GET', '/status')
  assert.equal(cfg.json.data.config.auth.password, rotated.json.data.password)
  console.log('PASS password rotate · persisted')

  const phone = await call('GET', '/phone/status')
  assert.equal(phone.json.ok, true)
  assert.equal(phone.json.data.installed, false)
  console.log('PASS phone proxy · degrades cleanly when plugin absent')

  const unknown = await call('POST', '/task/status', { id: 'nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'TASK_UNKNOWN')
  console.log('PASS error mapping · 404 TASK_UNKNOWN')

} catch (err) {
  console.error('PLUGIN SMOKE FAILED:', err?.stack || err)
  process.exitCode = 1
} finally {
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 400))
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  process.exit(process.exitCode ?? 0)
}
