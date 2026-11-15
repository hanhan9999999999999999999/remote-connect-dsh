/** Run every test in a predictable order; stop at the first failure. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  'client-smoke.mjs',
  'i18n-guard.mjs',
  'a11y.mjs',
  'toast-a11y.mjs',
  'logger.mjs',
  'tasks.mjs',
  'task-fields.mjs',
  'ui-feedback.mjs',
  'port-scan.mjs',
  'inventory-guard.mjs',
  'inventory-secrets.mjs',
  'inventory-excluded.mjs',
  'inventory-read-errors.mjs',
  'deps.mjs',
  'bridge-dir.mjs',
  'security.mjs',
  'guard.mjs',
  'guard-limits.mjs',
  'peer-session.mjs',
  'peer-reconnect.mjs',
  'peer-body.mjs',
  'handshake-guard.mjs',
  'server-limits.mjs',
  'server-auth.mjs',
  'rollback.mjs',
  'apply-discard.mjs',
  'local-syncs.mjs',
  'status-degraded.mjs',
  'apply-guard.mjs',
  'pack-safety.mjs',
  'tar-hostile.mjs',
  'tar-write.mjs',
  'discovery.mjs',
  'discovery-limits.mjs',
  'pack.mjs',
  'push-guard.mjs',
  'frames.mjs',
  'crypto-guard.mjs',
  'signature.mjs',
  'silent-failures.mjs',
  'peer-streams.mjs',
  'config.mjs',
  'sync-cancel.mjs',
  'forget-cancel.mjs',
  'disconnect-hardening.mjs',
  'sync-progress.mjs',
  'diagnostics.mjs',
  'http-status.mjs',
  'peers.mjs',
  'docs-guard.mjs',
  'install.mjs',
  'plugin-smoke.mjs',
  'phone-http.mjs',
  'phone-switch.mjs',
  'phone-port-sync.mjs',
  'phone-stop.mjs',
  'e2e.mjs',
]

for (const file of suites) {
  process.stdout.write(`\n── ${file} ──\n`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
    child.on('exit', (c) => resolve(c ?? 1))
    child.on('error', () => resolve(1))
  })
  if (code !== 0) {
    process.stderr.write(`\nFAILED: ${file} (exit ${code})\n`)
    process.exit(code)
  }
}
process.stdout.write('\nAll suites passed.\n')
