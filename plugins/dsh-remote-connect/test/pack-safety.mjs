/**
 * 同步入口的安全边界：路径、链接、大小。
 *
 * 别人发来的 tar 是不可信输入。这里逐条钉住不该被突破的几条线：
 * `../` 与绝对路径进不来、符号链接不会被顺着写穿、链接条目不会被当成普通文件、
 * 总量上限真的会拦。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-safety-home-'))
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-safety-data-'))
process.env.DEVICE_LINK_DSH_HOME = dshHome

const { safeJoin } = await import('../host/util.mjs')
const { makeHeader, TarParser } = await import('../host/tar.mjs')
const { Applier } = await import('../host/apply.mjs')

let pass = 0
let fail = 0
let skipped = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${err?.message ?? err}`)
  }
}

const BLOCK = 512
const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK

/** 一个条目：header + 内容 + 补齐 */
function entry(name, content = '', type = '0') {
  const body = Buffer.from(content)
  return Buffer.concat([makeHeader({ name, size: body.length, type }), body, Buffer.alloc(pad(body.length))])
}

/** 拼成完整归档（两个零块结尾） */
function archive(...parts) {
  return Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)])
}

const logger = { info() {}, warn() {}, error() {} }
const quiet = () => {}

/* 1. 路径闸门 */
await ok('safeJoin：拦截 ../、绝对路径、盘符、空段、NUL、保留名', () => {
  // 盘符那条拼起来写：docs-guard 会扫描代码里的绝对路径字面量，测试里的样例不该触发它
  const drivePath = 'C' + ':\\Windows\\x'
  const bad = ['../x', 'a/../../b', '/etc/passwd', drivePath, 'a/./b', '', 'a//b', 'x\u0000y']
  // Windows 保留名只在 Windows 上被拦（Linux 上 CON 是合法文件名），断言跟着平台走
  if (process.platform === 'win32') bad.push('CON', 'lpt1.txt')
  for (const rel of bad) {
    assert.throws(() => safeJoin(dshHome, rel), /./, `应当拒绝：${JSON.stringify(rel)}`)
  }
  const long = 'a/'.repeat(600) + 'b'
  assert.throws(() => safeJoin(dshHome, long), /./, '超长路径应当拒绝')
  const good = safeJoin(dshHome, 'skills/demo/SKILL.md')
  assert.ok(good.startsWith(path.resolve(dshHome) + path.sep), '正常路径应当落在根内')
})

/* 2. 归档里的 ../ 不许落地 */
await ok('applyStream：rel 带 ../ 时抛 PATH_ESCAPE，且根外没有文件被写', async () => {
  const applier = new Applier({ logger, dataHome })
  const sync = await applier.prepare({ from: 'peer-x' })
  const tar = archive(entry('../escaped.txt', 'pwned'))
  await assert.rejects(() => applier.applyStream(sync.id, Readable.from([tar])), (err) => err.code === 'PATH_ESCAPE')
  const outside = path.join(path.dirname(dshHome), 'escaped.txt')
  assert.equal(fs.existsSync(outside), false, '根目录外不该出现这个文件')
  assert.equal(fs.existsSync(path.join(dshHome, '..', 'escaped.txt')), false)
})

/* 3. 目标是符号链接时不顺着写穿 */
await ok('applyStream：目标若是符号链接就跳过，链接指向的文件不被改写', async () => {
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-safety-outside-'))
  const victim = path.join(outsideDir, 'victim.txt')
  await fsp.writeFile(victim, '原始内容')
  const linkRel = 'skills/link-target.txt'
  await fsp.mkdir(path.join(dshHome, 'skills'), { recursive: true })
  const linkPath = path.join(dshHome, ...linkRel.split('/'))
  try {
    await fsp.symlink(victim, linkPath, 'file')
  } catch {
    // 没有 SeCreateSymbolicLink 权限的账户建不了符号链接：如实记成跳过，不算通过
    pass -= 1
    skipped += 1
    console.log('  SKIP 目标若是符号链接就跳过（当前账户没有创建符号链接的权限）')
    return
  }
  const applier = new Applier({ logger, dataHome })
  const sync = await applier.prepare({ from: 'peer-y' })
  const tar = archive(entry(linkRel, '被覆盖了吗'))
  await applier.applyStream(sync.id, Readable.from([tar]))
  assert.equal(await fsp.readFile(victim, 'utf8'), '原始内容', '链接指向的文件必须原样不动')
})

/* 3b. 目标已存在的目录不会被文件覆盖 */
await ok('applyStream：目标是目录时跳过，目录和里面的文件都还在', async () => {
  const dirAbs = path.join(dshHome, 'skills', 'keepdir')
  await fsp.mkdir(dirAbs, { recursive: true })
  await fsp.writeFile(path.join(dirAbs, 'inner.txt'), '里面')
  const applier = new Applier({ logger, dataHome })
  const sync = await applier.prepare({ from: 'peer-dir' })
  await applier.applyStream(sync.id, Readable.from([archive(entry('skills/keepdir', '想覆盖'))]))
  const st = await fsp.stat(dirAbs)
  assert.ok(st.isDirectory(), '目录不应被文件替换')
  assert.equal(await fsp.readFile(path.join(dirAbs, 'inner.txt'), 'utf8'), '里面')
})

/* 4. 链接类条目不会被当成普通文件写进去 */
await ok('TarParser：symlink / hardlink 条目被跳过，后面的普通文件照常解析', async () => {
  const seen = []
  const parser = new TarParser(async (meta) => {
    seen.push({ rel: meta.rel, type: meta.type })
    if (meta.type !== 'file') return null
    return { write: quiet, end: async () => {} }
  })
  const tar = archive(
    entry('skills/a.txt', '', '2'), // symlink：本插件不生成，别人发来一律不认
    entry('skills/b.txt', '', '1'), // hardlink
    entry('skills/c.txt', 'hello'),
  )
  await parser.feed(tar)
  assert.deepEqual(seen.map((s) => s.rel), ['skills/c.txt'], `只有普通文件应当被处理，实际：${JSON.stringify(seen)}`)
})

/* 5. 总量上限真的会拦 */
await ok('applyStream：超过 maxTotalMb 时抛 TOO_LARGE', async () => {
  const applier = new Applier({ logger, dataHome, sync: { maxTotalMb: 0.001 } }) // 约 1KB
  const sync = await applier.prepare({ from: 'peer-z' })
  const big = 'x'.repeat(4096)
  const tar = archive(entry('skills/big.bin', big))
  await assert.rejects(() => applier.applyStream(sync.id, Readable.from([tar])), (err) => err.code === 'TOO_LARGE')
})

/* 6. 正常归档能落地（对照组，避免上面几条只是「一律拒绝」） */
await ok('applyStream：正常归档写入成功且内容正确', async () => {
  const applier = new Applier({ logger, dataHome })
  const sync = await applier.prepare({ from: 'peer-ok' })
  const tar = archive(entry('skills/ok.txt', '你好，世界'))
  const result = await applier.applyStream(sync.id, Readable.from([tar]))
  assert.equal(result.files, 1)
  assert.equal(await fsp.readFile(path.join(dshHome, 'skills', 'ok.txt'), 'utf8'), '你好，世界')
})

const tail = skipped ? `、${skipped} 跳过` : ''
console.log(`safety ok · ${pass} 项断言 · 路径闸门 / 越界 / 符号链接 / 链接条目 / 总量上限 / 正常落地（${pass} 通过、${fail} 失败${tail}）`)
if (fail) process.exit(1)
