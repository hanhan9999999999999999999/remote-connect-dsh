/**
 * Docs guard: 让文档和代码互相钉住，谁改了另一边没跟上就红。
 *
 * 守卫六件事：
 *  1. 运行时注册的每条路由，都出现在 docs/ARCHITECTURE.md 的路由表里；
 *  2. CHANGELOG 顶部版本号 == package.json 的 version；
 *  3. locale/zh.json 与 locale/en.json 的键完全一致（缺翻译/多出来的键都会红）；
 *  4. 源码与文档里没有写死的绝对路径（C:\ / D:\ / /Users/ / /home/）；
 *  5. package.json 的 files[] 每一项在磁盘上真实存在；
 *  6. README / SECURITY / docs 里的相对链接都指得到文件。
 *
 * 只在仓库里跑（能读到 ../../README.md）时，顺带核对根 README 的路由表；
 * 单独装进 node_modules 时跳过这一条，不依赖仓库外的文件。
 */
import fs from 'node:fs/promises'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(pkgDir, rel), 'utf8')

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-docs-'))
process.env.DEVICE_LINK_HOME = path.join(tmp, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(tmp, 'dsh')

/* 1. 运行时路由 → 文档 ------------------------------------------------ */

const routes = new Set()
const fakeWeb = {
  register({ path: p }) {
    routes.add(p)
    return () => routes.delete(p)
  },
  get port() {
    return 0
  },
}
const ctx = { get: (name) => (name === 'webServer' ? fakeWeb : null), effect: (fn) => fn() }

const plugin = await import('../index.js')
plugin.apply(ctx, { bridgeDir: path.join(os.tmpdir(), 'remote-connect-no-such-bridge') })

const arch = read('docs/ARCHITECTURE.md')
const PREFIX = '/dsh-remote-connect-api'
const ownRoutes = [...routes].filter((p) => p.startsWith(PREFIX)).map((p) => p.slice(PREFIX.length))
const phoneRoutes = [...routes].filter((p) => p.startsWith('/dsh-phone-api'))

assert.ok(ownRoutes.length >= 30, `互联路由少于 30 条（实际 ${ownRoutes.length}）`)
assert.equal(phoneRoutes.length, 5, `手机通道路由应为 5 条（实际 ${phoneRoutes.length}）`)
assert.ok(arch.includes('/dsh-phone-api'), 'docs/ARCHITECTURE.md 没提到 /dsh-phone-api')

const missing = ownRoutes.filter((r) => !arch.includes('`' + r + '`') && !arch.includes(r + ' '))
assert.deepEqual(missing, [], `这些路由在 docs/ARCHITECTURE.md 里查不到：${missing.join('、')}`)

const rootReadme = path.resolve(pkgDir, '../../README.md')
if (existsSync(rootReadme)) {
  const top = readFileSync(rootReadme, 'utf8')
  const absent = ownRoutes.filter((r) => !top.includes(r))
  assert.deepEqual(absent, [], `这些路由在根 README 的接口表里查不到：${absent.join('、')}`)
  for (const r of phoneRoutes) {
    const tail = r.replace('/dsh-phone-api/', '')
    assert.ok(top.includes(tail), `根 README 没提到手机通道路由 /${tail}`)
  }
}

/* 2. CHANGELOG 版本 == package.json 版本 ------------------------------ */

const pkg = JSON.parse(read('package.json'))
const version = read('CHANGELOG.md').match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1]
assert.equal(version, pkg.version, `CHANGELOG 顶部版本 ${version} 与 package.json ${pkg.version} 不一致`)

/* 3. locale 文件的中英键完全一致 -------------------------------------
 * 界面上的 153 条文案在 client.js 里，由 client-smoke 逐条对齐；
 * 这里只管 locale/{zh,en}.json 这两份插件名片。 */

const flat = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
const zh = flat(JSON.parse(read('locale/zh.json'))).sort()
const en = flat(JSON.parse(read('locale/en.json'))).sort()
const onlyZh = zh.filter((k) => !en.includes(k))
const onlyEn = en.filter((k) => !zh.includes(k))
assert.deepEqual(onlyZh, [], `这些词条只有中文：${onlyZh.join('、')}`)
assert.deepEqual(onlyEn, [], `这些词条只有英文：${onlyEn.join('、')}`)
assert.ok(zh.length >= 2, 'locale 文件读不到词条')

/* 4. 没有写死的绝对路径 ------------------------------------------------ */

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      walk(abs, out)
    } else if (/\.m?js$/.test(e.name)) {
      out.push(abs)
    }
  }
  return out
}
const codeFiles = ['index.js', 'client.js', 'host', 'scripts', 'test'].flatMap((rel) => {
  const abs = path.join(pkgDir, rel)
  if (!existsSync(abs)) return []
  return /\.[a-z0-9]+$/i.test(rel) ? [abs] : walk(abs)
})

// 只抓代码里的字符串常量：引号里直接跟着盘符或家目录
const absPathPattern = /['"`](?:[A-Za-z]:[\\/]|\/Users\/[A-Za-z]|\/home\/[A-Za-z])/
const offenders = []
for (const file of codeFiles) {
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (absPathPattern.test(line)) offenders.push(`${path.relative(pkgDir, file)}:${i + 1}: ${line.trim()}`)
    })
}
assert.deepEqual(offenders, [], `代码里有写死的绝对路径：\n${offenders.join('\n')}`)

/* 5. package.json 的 files[] 都存在 ---------------------------------- */

for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) {
    const [dir, glob] = entry.split('/')
    const hit = readdirSync(path.join(pkgDir, dir)).some((f) => glob === '*' || f.endsWith(glob.replace('*', '')))
    assert.ok(hit, `package.json 的 files 里 ${entry} 匹配不到任何文件`)
  } else {
    assert.ok(existsSync(path.join(pkgDir, entry)), `package.json 的 files 里 ${entry} 不存在`)
  }
}

/* 6. 相对链接都能指到文件 -------------------------------------------- */

const linkFiles = ['README.md', 'SECURITY.md', 'CHANGELOG.md', ...['docs'].flatMap((d) => readdirSync(path.join(pkgDir, d)).map((f) => `${d}/${f}`))]
const broken = []
let checked = 0
for (const rel of linkFiles) {
  const text = read(rel)
  for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
    const target = decodeURIComponent(m[1].split('#')[0])
    if (!target) continue
    const abs = path.resolve(path.dirname(path.join(pkgDir, rel)), target)
    // 指向包外的相对链接（比如仓库根的文件）在安装后的包里本来就不存在，不算坏链
    if (path.relative(pkgDir, abs).startsWith('..')) continue
    checked += 1
    if (!existsSync(abs)) broken.push(`${rel} → ${target}`)
  }
}
assert.deepEqual(broken, [], `文档里的相对链接指不到文件：${broken.join('、')}`)

/* 7. 文档里给用户抄的 #vX.Y.Z 必须是当前版本 -------------------------- */

const tagFiles = ['README.md', ...readdirSync(path.join(pkgDir, 'docs')).map((f) => `docs/${f}`)]
const staleTags = []
let tagRefs = 0
for (const rel of tagFiles) {
  for (const m of read(rel).matchAll(/#v(\d+\.\d+\.\d+)(?=[&\s"')`])/g)) {
    tagRefs += 1
    if (m[1] !== pkg.version) staleTags.push(`${rel} → #v${m[1]}（当前 ${pkg.version}）`)
  }
}
assert.deepEqual(staleTags, [], `文档里的安装标签过期了，照抄会装到旧版本：\n${staleTags.join('\n')}`)

console.log(
  `docs ok · 路由 ${ownRoutes.length}+${phoneRoutes.length} · 版本 ${pkg.version} · 词条 ${zh.length} 中英对齐 · 链接 ${checked} 条 0 坏链 · 版本标签 ${tagRefs} 处一致`,
)
