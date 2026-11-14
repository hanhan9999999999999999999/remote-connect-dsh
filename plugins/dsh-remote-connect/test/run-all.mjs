/** Run every test in a predictable order; stop at the first failure. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  'client-smoke.mjs',
  'a11y.mjs',
  'tasks.mjs',
  'inventory-guard.mjs',
  'deps.mjs',
  'bridge-dir.mjs',
  'docs-guard.mjs',
  'install.mjs',
  'plugin-smoke.mjs',
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
