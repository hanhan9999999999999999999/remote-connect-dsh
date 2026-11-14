/**
 * 桥接目录的探测顺序：不写死某台机器的路径。
 * 用子进程测，因为默认值在模块第一次 import 时就算出来了。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const phoneUrl = pathToFileURL(path.join(here, '..', 'host', 'phone.mjs')).href

const probe = (env) => {
  const code = `const m = await import(${JSON.stringify(phoneUrl)}); console.log(m.bridgeDir())`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(out.stderr || `probe exited ${out.status}`)
  return out.stdout.trim()
}

// 1. DSH_HOME 下真有一个装好的 phone-bridge → 用它
const home = mkdtempSync(path.join(os.tmpdir(), 'rc-bridge-home-'))
const bridge = path.join(home, 'phone-bridge')
mkdirSync(bridge, { recursive: true })
writeFileSync(path.join(bridge, 'server.mjs'), '// stub\n')
const picked = probe({ DSH_HOME: home, DSH_PHONE_BRIDGE_DIR: '' })
assert.equal(path.resolve(picked), path.resolve(bridge), 'DSH_HOME/phone-bridge 应被自动选中')
console.log('PASS probe · DSH_HOME 下的 phone-bridge 被选中')

// 2. 环境变量优先级高于探测
const custom = mkdtempSync(path.join(os.tmpdir(), 'rc-bridge-env-'))
writeFileSync(path.join(custom, 'ensure-running.ps1'), '# stub\n')
const viaEnv = probe({ DSH_HOME: home, DSH_PHONE_BRIDGE_DIR: custom })
assert.equal(path.resolve(viaEnv), path.resolve(custom), 'DSH_PHONE_BRIDGE_DIR 应压过自动探测')
console.log('PASS probe · DSH_PHONE_BRIDGE_DIR 优先')

// 3. configure() 又压过环境变量
const another = mkdtempSync(path.join(os.tmpdir(), 'rc-bridge-cfg-'))
const code = `
  const m = await import(${JSON.stringify(phoneUrl)})
  const got = m.configure({ bridgeDir: ${JSON.stringify(another)} })
  console.log(got)
`
const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  env: { ...process.env, DSH_HOME: home, DSH_PHONE_BRIDGE_DIR: custom },
  encoding: 'utf8',
})
assert.equal(out.status, 0, out.stderr)
assert.equal(path.resolve(out.stdout.trim()), path.resolve(another), 'configure({bridgeDir}) 应压过环境变量')
console.log('PASS probe · configure({ bridgeDir }) 最高优先')

// 4. 任何候选都不存在时也要给出一条路径而不是 undefined/空
const empty = mkdtempSync(path.join(os.tmpdir(), 'rc-bridge-none-'))
const fallback = probe({ DSH_HOME: empty, DSH_PHONE_BRIDGE_DIR: '' })
assert.ok(path.isAbsolute(fallback) && fallback.length > 3, '没有候选时仍应回落成绝对路径：' + fallback)
console.log('PASS probe · 无候选时回落绝对路径 · ' + fallback)
