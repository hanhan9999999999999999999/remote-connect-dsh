/**
 * scripts/install.mjs 的行为测试。
 *
 * 这个安装器曾经有一版「只给 --purge 时不卸载，反而又装了一遍」的 bug，而没有测试拦得住它。
 * 这里在临时目录里造一个假的 DSH_HOME，把安装 / 重复安装 / 试运行 / 卸载 / 清空 / 参数校验
 * 全跑一遍，断言落盘结果而不是断言输出文案。
 */
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installer = path.join(pkgDir, 'scripts', 'install.mjs')
const pkgName = 'dsh-remote-connect'

/** 跑安装器；不抛异常，把 exitCode/stdout/stderr 一起交回来。 */
async function invoke(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [installer, ...args], { cwd: os.tmpdir(), timeout: 60000 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) }
  }
}

async function makeHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-install-'))
  const home = path.join(root, 'home')
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'desktop', private: true, dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
  )
  return { root, home, profileDir, profileFile: path.join(profileDir, 'package.json') }
}

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  )
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'))

let checks = 0
let failed = 0
async function expect(label, fn) {
  checks += 1
  try {
    await fn()
    console.log(`PASS install · ${label}`)
  } catch (err) {
    failed += 1
    console.error(`FAIL install · ${label}\n      ${String(err.message).split('\n')[0]}`)
  }
}

// ── 1. --help / --version 只打印，不碰文件 ───────────────────────────
{
  const help = await invoke(['--help'])
  await expect('--help 退出码 0 且给出用法', () => {
    assert.equal(help.code, 0)
    assert.match(help.stdout, /用法: node scripts\/install\.mjs/)
    assert.match(help.stdout, /--dsh-home/)
    assert.match(help.stdout, /--purge/)
  })
  const version = await invoke(['--version'])
  const pkg = await readJson(path.join(pkgDir, 'package.json'))
  await expect('--version 打印包版本', () => {
    assert.equal(version.code, 0)
    assert.equal(version.stdout.trim(), `${pkgName} ${pkg.version}`)
  })
}

// ── 2. 参数写错要报错，不能默默忽略 ──────────────────────────────────
{
  const typo = await invoke(['--unistall', '--dsh-home', os.tmpdir()])
  await expect('拼错的参数被拒绝（exit 1 且说明不认识）', () => {
    assert.equal(typo.code, 1)
    assert.match(typo.stderr, /不认识的参数/)
    assert.match(typo.stderr, /--unistall/)
  })
  const missing = await invoke(['--dsh-home'])
  await expect('选项缺取值被拒绝', () => {
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /--dsh-home 后面缺少取值/)
  })
}

// ── 3. profile 不存在时给出可操作的提示 ─────────────────────────────
{
  const { root } = await makeHome()
  const res = await invoke(['--dsh-home', path.join(root, 'no-such-home')])
  await expect('找不到 profile 时 exit 1 且提示怎么修', () => {
    assert.equal(res.code, 1)
    assert.match(res.stderr, /找不到 profile/)
    assert.match(res.stderr, /--profile/)
  })
  await fs.rm(root, { recursive: true, force: true })
}

// ── 4. --dry-run 一个字节都不写 ──────────────────────────────────────
{
  const { root, home, profileFile } = await makeHome()
  const before = await fs.readFile(profileFile, 'utf8')
  const res = await invoke(['--dsh-home', home, '--dry-run'])
  await expect('--dry-run 退出码 0 且声明未写盘', () => {
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /试运行结束/)
  })
  await expect('--dry-run 没有落盘（目录不存在、profile 原样）', async () => {
    assert.equal(await exists(path.join(home, 'plugins', pkgName)), false)
    assert.equal(await fs.readFile(profileFile, 'utf8'), before)
  })
  await fs.rm(root, { recursive: true, force: true })
}

// ── 5. 真装：包落位、profile 两处登记、备份文件 ─────────────────────
{
  const { root, home, profileDir, profileFile } = await makeHome()
  const res = await invoke(['--dsh-home', home])
  await expect('安装退出码 0 且提示要重启 DSH', () => {
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /安装完成/)
    assert.match(res.stdout, /不会重启 DSH/)
  })

  const installed = path.join(home, 'plugins', pkgName)
  await expect('包被拷到 <home>/plugins 且声明了 dsh.bundle', async () => {
    const manifest = await readJson(path.join(installed, 'package.json'))
    assert.equal(manifest.name, pkgName)
    assert.ok(manifest.dsh?.bundle?.patch, 'package.json 应声明 dsh.bundle.patch')
  })
  await expect('拷贝时没带上 node_modules / test', async () => {
    for (const dir of ['test', 'node_modules']) assert.equal(await exists(path.join(installed, dir)), false, dir)
  })

  const profile = await readJson(profileFile)
  await expect('profile dependencies 指向 file:../../plugins', () => {
    assert.equal(profile.dependencies[pkgName], 'file:../../plugins/dsh-remote-connect')
  })
  await expect('profile bundles 里出现且只出现一次', () => {
    assert.deepEqual(profile.dsh.profile.bundles, [pkgName])
  })
  await expect('改 profile 前留了备份', async () => {
    const backups = (await fs.readdir(profileDir)).filter((n) => n.startsWith('package.json.bak-'))
    assert.equal(backups.length, 1, `实际备份文件：${backups.join(', ') || '无'}`)
  })
  await expect('profile/node_modules 里能读到包（junction 或副本）', async () => {
    assert.equal(await exists(path.join(profileDir, 'node_modules', pkgName, 'package.json')), true)
  })

  // ── 6. 重复安装是幂等的 ────────────────────────────────────────────
  const again = await invoke(['--dsh-home', home])
  const profile2 = await readJson(profileFile)
  await expect('重复安装不报错、bundles 不重复', () => {
    assert.equal(again.code, 0, again.stderr)
    assert.deepEqual(profile2.dsh.profile.bundles, [pkgName])
  })

  // ── 7. --uninstall 只摘登记，文件留着 ──────────────────────────────
  const off = await invoke(['--dsh-home', home, '--uninstall'])
  const profile3 = await readJson(profileFile)
  await expect('--uninstall 退出码 0', () => {
    assert.equal(off.code, 0, off.stderr)
  })
  await expect('--uninstall 摘掉 dependencies 与 bundles', () => {
    assert.equal(profile3.dependencies?.[pkgName], undefined)
    assert.deepEqual(profile3.dsh.profile.bundles, [])
  })
  await expect('--uninstall 不删插件文件、但断开 profile 里的链接', async () => {
    assert.equal(await exists(installed), true, '插件目录不该被删')
    assert.equal(await exists(path.join(profileDir, 'node_modules', pkgName)), false, '链接该断开')
  })

  // ── 8. --purge 连目录一起删（这一条正是当年漏掉的 bug）────────────
  const dryPurge = await invoke(['--dsh-home', home, '--purge', '--dry-run'])
  await expect('--purge --dry-run 说明会删哪个目录但不动手', async () => {
    assert.equal(dryPurge.code, 0, dryPurge.stderr)
    assert.match(dryPurge.stdout, /会删的目录/)
    assert.equal(await exists(installed), true)
  })
  const purge = await invoke(['--dsh-home', home, '--purge'])
  await expect('--purge 退出码 0 且删掉插件目录', async () => {
    assert.equal(purge.code, 0, purge.stderr)
    assert.equal(await exists(installed), false)
  })

  await fs.rm(root, { recursive: true, force: true })
}

if (failed) {
  console.error(`FAILED: install.mjs 有 ${failed}/${checks} 项不通过`)
  process.exit(1)
}
console.log(`install ok · ${checks} 项断言 · 装 / 重装 / 试运行 / 卸载 / 清空 / 参数校验`)
