#!/usr/bin/env node
/**
 * Installer / uninstaller for dsh-remote-connect.
 *
 *   node scripts/install.mjs --help          # 看全部参数
 *   node scripts/install.mjs                 # install into $DSH_HOME (默认 ~/.dsh), profile "desktop"
 *   node scripts/install.mjs --dsh-home D:\dsh-home
 *   node scripts/install.mjs --profile work  # another profile
 *   node scripts/install.mjs --dry-run       # show what would change, writes nothing
 *   node scripts/install.mjs --uninstall     # remove from profile, keep files
 *   node scripts/install.mjs --purge         # same as --uninstall, and delete the copied files too
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

const TAKES_VALUE = new Set(['--dsh-home', '--profile'])
const BOOLEAN = new Set(['--dry-run', '--uninstall', '--purge', '--help', '-h', '--version', '-v'])

const pkgName = 'dsh-remote-connect'
const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8').catch(() => '{}'))

const HELP = `用法: node scripts/install.mjs [选项]

把 ${pkgName}@${pkg.version ?? '?'} 装进 DSH 的某个 profile，或从 profile 里卸掉。

选项
  --dsh-home <目录>   DSH 的数据目录。默认 $DSH_HOME，再不行用 ~/.dsh
  --profile <名字>    profile 名。默认 desktop
  --dry-run           只打印将要做什么，一个字节都不写
  --uninstall         从 profile 里摘掉（插件文件留着）
  --purge             摘掉并删除 <dsh-home>/plugins/${pkgName}
  -h, --help          显示这段帮助
  -v, --version       显示版本

安装会做三件事：把包拷到 <dsh-home>/plugins/${pkgName}；在 profile 的 dependencies
里写 file:../../plugins/${pkgName}；把它加进 profile 的 dsh.profile.bundles。
改 profile 前会先备份成 package.json.bak-<时间戳>。

它不会重启 DSH。装完自己退出并重新打开 DSH，插件才会加载。
`

function die(message) {
  console.error(message)
  process.exitCode = 1
}

/** 把参数拆成 {options, unknown}：认不出来的选项要报出来，不能默默忽略。 */
function parseArgs(argv) {
  const options = Object.create(null)
  const unknown = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (TAKES_VALUE.has(token)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        unknown.push(`${token} 后面缺少取值`)
        continue
      }
      options[token.slice(2)] = next
      i += 1
      continue
    }
    if (BOOLEAN.has(token)) {
      options[token.replace(/^--?/, '')] = true
      continue
    }
    unknown.push(token)
  }
  return { options, unknown }
}

const { options, unknown } = parseArgs(args)

if (options.help) {
  console.log(HELP)
  process.exit(0)
}
if (options.version) {
  console.log(`${pkgName} ${pkg.version ?? '0.0.0'}`)
  process.exit(0)
}
if (unknown.length) {
  die(
    `不认识的参数：${unknown.join('、')}\n` +
      '可用：--dsh-home <目录> --profile <名字> --dry-run --uninstall --purge --help --version',
  )
  process.exit(1)
}

const dshHome = path.resolve(options['dsh-home'] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const profileName = options.profile || 'desktop'
const dryRun = Boolean(options['dry-run'])
const uninstall = Boolean(options.uninstall) || Boolean(options.purge)
const purge = Boolean(options.purge)
const target = path.join(dshHome, 'plugins', pkgName)
const profileDir = path.join(dshHome, 'profiles', profileName)
const profileFile = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', pkgName)

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
  if (source === target) {
    die(`源目录和安装目标相同（${source}）：这是发布仓本身，别往自己头上装。`)
    return
  }
  console.log(
    `remote-connect installer · ${pkgName}@${pkg.version ?? '?'} · dshHome=${dshHome} profile=${profileName}${dryRun ? ' · DRY RUN' : ''}`,
  )

  const exists = await fs.access(profileFile).then(
    () => true,
    () => false,
  )
  if (!exists) {
    die(
      `找不到 profile：${profileFile}\n` +
        `· 先启动一次 DSH 让它建出这个 profile，或用 --profile 指定别的名字。\n` +
        `· 也可以 --dsh-home 指向真正的 DSH 数据目录。`,
    )
    return
  }
  const profile = await readJson(profileFile).catch((err) => {
    throw new Error(`profile 不是合法 JSON：${profileFile}\n${err.message}`)
  })

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
    const suffix = purge ? (dryRun ? ' and delete plugin files' : ' and deleted plugin files') : ' (files kept)'
    console.log(`${dryRun ? 'will remove' : 'removed'} from profile${suffix}`)
    if (dryRun) console.log(`（没有写盘）会删的目录：${purge ? target : linkPath}`)
    else if (purge) console.log(`已删除：${target}`)
    if (dryRun) console.log('\n· 试运行结束：上面这些都没有写盘。')
    else console.log('\n重启 DSH 后生效。')
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
  console.log(`profile bundles += ${pkgName}`)

  if (dryRun) {
    console.log('\n· 试运行结束：上面这些都没有写盘。去掉 --dry-run 才真装。')
    return
  }
  console.log('\n✅ 安装完成。')
  console.log('   打开 DSH → 设置 → 远程互联。')
  console.log('   ⚠ 本安装器不会重启 DSH；请手动退出并重新打开 DSH 后生效。')
}

main().catch((err) => {
  console.error('install failed:', err?.stack || err?.message || err)
  process.exitCode = 1
})
