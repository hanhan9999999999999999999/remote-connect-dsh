/**
 * 落地时那条临时文件的写流：
 *
 * 1. 盘满 / 配额超了 / 连接半路断开时，写流上没有人接 `error`——异步的错会升级成未捕获异常，
 *    整个 DSH 进程直接退出；而只等 `drain` 的那条路则会一直等下去，同步永远停在那儿。
 * 2. 失败时流没关就去删 `*.dshlink`：Windows 上句柄还开着，删除一定失败，临时文件留在用户目录里，
 *    每失败一次还多漏一个句柄。
 *
 * 这个文件用 `createWriteStream` 注入一条「写几次就报错」的流来复现第一种情况，
 * 再用「字节上限中途炸掉」来确认临时文件真的被删干净。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const applyUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/apply.mjs', import.meta.url).href

const dshHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-apply-write-home-'))
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-apply-write-data-'))
process.env.DEVICE_LINK_DSH_HOME = dshHome

const { Applier } = await import(applyUrl)
const { tarReadable } = await import('../host/tar.mjs')

let pass = 0
let fail = 0
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

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function rowsFor(entries) {
  return entries.map((e) => {
    const bytes = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '')
    return {
      rel: e.rel,
      size: bytes.length,
      mtime: Date.now(),
      mode: 0o644,
      hash: sha(bytes),
      cat: e.cat,
      bytes,
    }
  })
}

function applier(sync = {}) {
  return new Applier({
    logger: { info() {}, warn() {}, error() {} },
    dataHome,
    sync: { backupKeep: 5, ...sync },
  })
}

async function listTmp(dir) {
  const out = []
  async function walk(abs) {
    let list = []
    try {
      list = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of list) {
      const p = path.join(abs, d.name)
      if (d.isDirectory()) await walk(p)
      else if (d.name.endsWith('.dshlink')) out.push(p)
    }
  }
  await walk(dir)
  return out
}

/**
 * 一条「第一块就写不进去」的写流：先真写进前 16 字节（留下一截文件，模拟盘满时的半截），
 * 再异步报 ENOSPC——这样既有真实文件要看清理，也能复现「error 没人接」。
 */
function faultyStream(file) {
  const real = fs.createWriteStream(file)
  const wrapper = new Writable({
    write(chunk, _enc, cb) {
      real.write(chunk.subarray(0, 16))
      real.end()
      process.nextTick(() =>
        wrapper.emit('error', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
      )
      void cb
    },
    final(cb) {
      real.end(cb)
    },
    destroy(err, cb) {
      real.destroy()
      cb(err)
    },
  })
  return wrapper
}

// ① 写流报错：必须 reject 成 WRITE_FAILED，而不是把进程带走、也不是一直等
await ok('写流报错时抛 WRITE_FAILED，不会一直等也不会崩', async () => {
  const a = applier({ maxTotalMb: 64, maxFiles: 100 })
  a.createWriteStream = (file) => faultyStream(file)
  const state = await a.prepare({ from: 'peer-x' })
  const rows = rowsFor([{ rel: 'skills/a.md', content: 'x'.repeat(512 * 1024) }])
  let thrown = null
  try {
    await a.applyStream(state.id, tarReadable(rows))
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '应当失败')
  assert.equal(thrown.code, 'WRITE_FAILED', `实际错误码：${thrown.code ?? thrown.message}`)
  assert.match(String(thrown.message), /写入临时文件失败/, `实际消息：${thrown.message}`)
  const snap = a.progress(state.id)
  assert.equal(snap.phase, 'failed')
})

// ② 写流报错后，那条临时文件不能留下（句柄没放就删不掉）
await ok('写流报错后不留下 *.dshlink 临时文件', async () => {
  const left = await listTmp(dshHome)
  assert.equal(left.length, 0, `还剩 ${left.length} 个：${left.join(', ')}`)
  const dev = await fsp.readdir(path.join(dshHome, 'skills')).catch(() => [])
  assert.ok(dev.includes('a.md') === false, '半截文件不应出现在目标位置')
})

// ③ 字节上限在文件中途炸掉：那条已打开的流也要被关掉，临时文件同样不能留下
await ok('中途因超字节上限失败时，临时文件也不留下', async () => {
  const a = applier({ maxTotalMb: 1, maxFiles: 100 })
  const state = await a.prepare({ from: 'peer-y' })
  const rows = rowsFor([{ rel: 'skills/big.bin', content: Buffer.alloc(3 * 1024 * 1024, 7) }])
  let thrown = null
  try {
    await a.applyStream(state.id, tarReadable(rows))
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '应当失败')
  assert.equal(thrown.code, 'TOO_LARGE', `实际错误码：${thrown.code ?? thrown.message}`)
  const left = await listTmp(dshHome)
  assert.equal(left.length, 0, `还剩 ${left.length} 个：${left.join(', ')}`)
})

// ④ 正常路径：写流关掉、文件落地、临时文件不残留
await ok('正常落地时文件写对、临时文件不残留', async () => {
  const a = applier({ maxTotalMb: 64, maxFiles: 100 })
  const state = await a.prepare({ from: 'peer-z' })
  const body = 'hello dsh\n'
  const rows = rowsFor([{ rel: 'rules/ok.md', content: body }])
  const out = await a.applyStream(state.id, tarReadable(rows))
  assert.equal(out.files, 1)
  const text = await fsp.readFile(path.join(dshHome, 'rules', 'ok.md'), 'utf8')
  assert.equal(text, body)
  const left = await listTmp(dshHome)
  assert.equal(left.length, 0, `还剩 ${left.length} 个：${left.join(', ')}`)
})

// 清理
await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => {})
await fsp.rm(dataHome, { recursive: true, force: true }).catch(() => {})

console.log(
  `apply-write ok · 4 项断言 · 写流报错 / 不留临时文件 / 中途超限 / 正常落地（${pass} 通过、${fail} 失败）`
)
process.exit(fail > 0 ? 1 : 0)
