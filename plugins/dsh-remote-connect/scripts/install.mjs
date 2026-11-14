#!/usr/bin/env node
/**
 * Installer / uninstaller for dsh-remote-connect.
 *
 *   node scripts/install.mjs                 # install into ~/.dsh, profile "desktop"
 *   node scripts/install.mjs --profile work  # another profile
 *   node scripts/install.mjs --dry-run       # show what would change
 *   node scripts/install.mjs --uninstall     # remove from profile, keep files
 *   node scripts/install.mjs --uninstall --purge
 *
 * It never restarts DSH. The new plugin becomes visible after the next launch.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(here, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const dshHome = path.resolve(value('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const profileName = value('--profile', 'desktop')
const dryRun = flag('--dry-run')
const uninstall = flag('--uninstall')
const purge = flag('--purge')
const pkgName = 'dsh-remote-connect'
const target = path.join(dshHome, 'plugins', 'dsh-remote-connect')
const profileDir = path.join(dshHome, 'profiles', profileName)
const profileFile = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', 'dsh-remote-connect')

const SKIP = new Set(['node_modules', '.git', 'test', '.DS_Store', 'Thumbs.db'])
const SKIP_EXT = /\.(log|tmp|part|bak)$/i

async function copyTree(from, to, { overwrite }) {
  const stat = await fs.stat(from)
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true })
    for (const name of await fs.readdir(from)) {
      if (SKIP.has(name) || SKIP_EXT.test(name)) continue
      await copyTree(path.join(from, name), path.join(to, name), { overwrite })
    }
    return
  }
  if (!overwrite) {
    const exists = await fs.access(to).then(
      () => true,
      () => false,
    )
    if (exists) return
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function main() {
  console.log(`remote-connect installer · dshHome=${dshHome} profile=${profileName}${dryRun ? ' · DRY RUN' : ''}`)
  const profile = await readJson(profileFile).catch(() => null)
  if (!profile) throw new Error(`找不到 profile：${profileFile}`)

  if (uninstall) {
    if (!dryRun) {
      await fs.rm(linkPath, { recursive: true, force: true })
      delete profile.dependencies?.[pkgName]
      profile.dsh ??= {}
      profile.dsh.profile ??= {}
      profile.dsh.profile.bundles = (profile.dsh.profile.bundles ?? []).filter((b) => b !== pkgName)
      await fs.writeFile(profileFile, JSON.stringify(profile, null, 2) + '\n')
      if (purge) await fs.rm(target, { recursive: true, force: true })
    }
    console.log(`removed from profile${purge ? ' and deleted plugin files' : ' (files kept)'}`)
    console.log('\n重启 DSH 后生效。')
    return
  }

  if (!dryRun) {
    await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(target, { recursive: true })
    await copyTree(source, target, { overwrite: true })
    await fs.writeFile(path.join(target, '.installed-at'), new Date().toISOString() + '\n')
  }
  console.log(`copy → ${target}`)

  profile.dependencies ??= {}
  const previous = profile.dependencies[pkgName]
  profile.dependencies[pkgName] = 'file:../../plugins/dsh-remote-connect'
  profile.dsh ??= {}
  profile.dsh.profile ??= {}
  profile.dsh.profile.bundles = Array.from(new Set([...(profile.dsh.profile.bundles ?? []), pkgName]))
  if (!dryRun) {
    const backup = `${profileFile}.bak-${stamp()}`
    await fs.copyFile(profileFile, backup)
    await fs.writeFile(profileFile, JSON.stringify(profile, null, 2) + '\n')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    let linked = false
    for (const mode of ['junction', 'dir']) {
      try {
        await fs.symlink(target, linkPath, mode)
        linked = true
        break
      } catch (err) {
        if (err.code === 'EEXIST') {
          await fs.rm(linkPath, { recursive: true, force: true })
          continue
        }
      }
    }
    if (!linked) {
      await copyTree(target, linkPath, { overwrite: true })
      console.log('symlink unavailable → copied into profile node_modules')
    }
  }
  console.log(`profile dependency${previous ? ` (replaced ${previous})` : ''} → file:../../plugins/dsh-remote-connect`)
  console.log('profile bundles += dsh-remote-connect')

  console.log('\n✅ 安装完成。')
  console.log('   打开 DSH → 设置 → 远程互联。')
  console.log('   ⚠ 本安装器不会重启 DSH；请手动退出并重新打开 DSH 后生效。')
}

main().catch((err) => {
  console.error('install failed:', err?.stack || err?.message || err)
  process.exitCode = 1
})
