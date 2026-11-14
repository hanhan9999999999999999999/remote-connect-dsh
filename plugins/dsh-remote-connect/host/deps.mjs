/**
 * Plugin dependency health.
 *
 * Plugin sources are synced without node_modules (they are large, often
 * platform-specific, and contain build output). A plugin that declares runtime
 * dependencies is therefore only half-installed on the receiving machine until
 * `npm install` has run in its directory. This module detects exactly that and
 * can repair it on explicit user request.
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { dshHome } from './config.mjs'
import { AppError, pathExists, readJson } from './util.mjs'

const NPM_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LOG_LINES = 400

/** Locate every local plugin and report declared deps that are not installed. */
export async function scanPluginDeps(home = dshHome()) {
  const root = path.join(home, 'plugins')
  let names = []
  try {
    names = await fsp.readdir(root)
  } catch {
    return { plugins: [], missing: [], checkedAt: new Date().toISOString() }
  }
  const plugins = []
  for (const name of names.sort()) {
    const dir = path.join(root, name)
    const manifest = path.join(dir, 'package.json')
    if (!(await pathExists(manifest))) continue
    let pkg
    try {
      pkg = await readJson(manifest)
    } catch {
      continue
    }
    const deps = Object.keys(pkg.dependencies || {})
    if (deps.length === 0) {
      plugins.push({ id: name, dir, deps: [], missing: [], status: 'ok' })
      continue
    }
    const missing = []
    for (const dep of deps) {
      const installed = path.join(dir, 'node_modules', ...dep.split('/'), 'package.json')
      if (!(await pathExists(installed))) missing.push(dep)
    }
    plugins.push({
      id: name,
      dir,
      deps,
      missing,
      status: missing.length === 0 ? 'ok' : 'missing',
    })
  }
  return {
    plugins,
    missing: plugins.filter((p) => p.status === 'missing').map((p) => p.id),
    checkedAt: new Date().toISOString(),
  }
}

function npmInvocation(args) {
  // Node 20+ refuses to spawn .cmd files without a shell (EINVAL). Run the
  // fixed npm command through cmd.exe on Windows; the argument list contains
  // no user input, so there is nothing to quote-inject.
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
    }
  }
  return { command: 'npm', args }
}

/** Run `npm install --omit=dev` in one plugin directory. */
function installOne(plugin, { onLine, timeoutMs = NPM_TIMEOUT_MS } = {}) {
  // 超时至少给 5 秒、最长 30 分钟：调用方传 0 或负数不该变成「立刻 SIGKILL」
  const budget = Math.min(Math.max(Number(timeoutMs) || NPM_TIMEOUT_MS, 5_000), 30 * 60 * 1000)
  return new Promise((resolve) => {
    const lines = []
    const push = (line) => {
      const text = String(line).replace(/\r/g, '').trimEnd()
      if (!text) return
      lines.push(text)
      if (lines.length > MAX_LOG_LINES) lines.shift()
      onLine?.(text)
    }
    let child
    let timedOut = false
    try {
      const inv = npmInvocation(['install', '--omit=dev', '--no-audit', '--no-fund'])
      child = spawn(inv.command, inv.args, {
        cwd: plugin.dir,
        windowsHide: true,
        env: { ...process.env, npm_config_update_notifier: 'false' },
      })
    } catch (error) {
      resolve({ id: plugin.id, ok: false, code: 'SPAWN_FAILED', error: String(error?.message || error), lines })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      push(`[timeout] npm install exceeded ${Math.round(budget / 1000)}s`)
      child.kill('SIGKILL')
    }, budget)
    child.stdout?.on('data', (chunk) => String(chunk).split('\n').forEach(push))
    child.stderr?.on('data', (chunk) => String(chunk).split('\n').forEach(push))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ id: plugin.id, ok: false, code: 'SPAWN_FAILED', error: String(error?.message || error), lines })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // 被我们自己掐掉的，别把 `EXIT_null` 这种看不懂的东西丢给用户
      const outcome = timedOut ? 'TIMEOUT' : code === 0 ? 'OK' : `EXIT_${code ?? 'NULL'}`
      resolve({ id: plugin.id, ok: outcome === 'OK', code: outcome, lines })
    })
  })
}

/** Install dependencies for the requested plugin ids (or every plugin missing them). */
export async function installPluginDeps(ids, { onLine, timeoutMs } = {}) {
  const scan = await scanPluginDeps()
  const asked = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []
  const known = new Set(scan.plugins.map((p) => p.id))
  // 点名了但本机压根没装这个插件：不能装作装好了
  const unknown = asked.filter((id) => !known.has(id))
  const wanted = new Set(asked.length ? asked : scan.missing)
  const targets = scan.plugins.filter((p) => p.status === 'missing' && wanted.has(p.id))
  const skipped = scan.plugins.filter((p) => p.status === 'ok' && wanted.has(p.id)).map((p) => p.id)
  if (targets.length === 0) {
    const after = await scanPluginDeps()
    return { ok: unknown.length === 0, results: [], skipped, unknown, scan: after }
  }
  const results = []
  for (const plugin of targets) {
    onLine?.(`\n▸ ${plugin.id}: npm install (${plugin.missing.length} missing)`)
    results.push(await installOne(plugin, { onLine, timeoutMs }))
  }
  const after = await scanPluginDeps()
  return { ok: results.every((r) => r.ok) && unknown.length === 0, results, skipped, unknown, scan: after }
}

/** Fail loudly when a caller asks for a plugin that is not installed locally. */
export function assertPluginId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._@/-]+$/.test(id) || id.includes('..')) {
    throw new AppError('BAD_PLUGIN_ID', `非法插件标识：${id}`)
  }
  return id
}
