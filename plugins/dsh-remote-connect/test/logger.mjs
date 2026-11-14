/**
 * 日志写盘不该是致命错误。
 *
 * 以前的 `Logger` 用 `fs.createWriteStream` 写文件却没挂 `error` 监听：
 * 日志目录不可写（盘满、目录被删、U 盘拔掉）时，Node 会把异步的 error
 * 升级成未捕获异常，**整个 DSH 进程直接退出**——而代码注释写着
 * 「logging must never throw」。这里盯住四件事：不崩、只警告一次、
 * 背压有上限、close 之后不再碰文件。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 可传一个路径参数，用来验证「故意写坏的副本」会不会被抓（守卫不是空转）
const utilUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/util.mjs', import.meta.url).href
const { Logger } = await import(utilUrl)

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${extra ? `: ${extra}` : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等一个条件成立（写盘是异步的，别用固定 sleep 赌时间） */
async function waitFor(fn, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-logger-'))

  // ① 目录不存在 → 打不开也不许把进程带走
  const brokenDir = path.join(home, 'missing-dir', 'rc.jsonl')
  const broken = new Logger({ file: brokenDir })
  let thrown = null
  try {
    broken.info('probe', 'hello')
  } catch (err) {
    thrown = err
  }
  await sleep(80)
  ok('目录不存在时写日志不抛异常', thrown === null, thrown?.message)
  ok('条目仍然留在内存里（能看 /logs）', broken.list().some((e) => e.msg === 'hello'))
  ok('记下了写盘失败的原因', typeof broken.fileBroken === 'string' && broken.fileBroken.length > 0, String(broken.fileBroken))
  ok('文件确实没被建出来', !fs.existsSync(brokenDir))

  // ② 只警告一次，不刷屏
  broken.info('probe', 'second')
  broken.warn('probe', 'third')
  await sleep(40)
  const fileWarns = broken.list().filter((e) => e.scope === 'log' && e.level === 'warn')
  ok('写盘失败只记一条警告（不刷屏）', fileWarns.length === 1, `实际 ${fileWarns.length} 条`)
  ok('后续日志照旧进内存', broken.list().some((e) => e.msg === 'third'))

  // ③ 正常路径：真的写进文件，且是逐行的 JSONL
  const goodFile = path.join(home, 'rc.jsonl')
  const good = new Logger({ file: goodFile })
  good.info('server', 'started', { port: 8788 })
  good.warn('peer', 'slow')
  const text = await waitFor(async () => {
    const raw = await fsp.readFile(goodFile, 'utf8').catch(() => '')
    return raw.trim().split('\n').filter(Boolean).length >= 2 ? raw : null
  })
  const lines = (text ?? '').trim().split('\n').filter(Boolean)
  ok('正常路径写成了逐行 JSONL', lines.length === 2, `实际 ${lines.length} 行`)
  let parsed = null
  try {
    parsed = JSON.parse(lines[0])
  } catch {
    parsed = null
  }
  ok('每行能解析回对象且带 scope/msg', parsed?.scope === 'server' && parsed?.msg === 'started', JSON.stringify(parsed)?.slice(0, 80))
  ok('没有写盘失败记录', good.fileBroken === null, String(good.fileBroken))

  // ④ 循环引用之类的 extra 不该让日志本身炸掉
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  let cyclicThrown = null
  try {
    good.info('probe', 'cyclic', cyclic)
  } catch (err) {
    cyclicThrown = err
  }
  await sleep(60)
  ok('extra 里有循环引用也不抛', cyclicThrown === null, cyclicThrown?.message)

  // ⑤ close() 之后不再碰文件
  good.close()
  const sizeBefore = (await fsp.stat(goodFile)).size
  good.info('server', 'after-close')
  await sleep(120)
  const sizeAfter = (await fsp.stat(goodFile)).size
  ok('close() 之后不再往文件里写', sizeAfter === sizeBefore, `${sizeBefore} → ${sizeAfter}`)
  ok('close() 之后日志仍进内存', good.list().some((e) => e.msg === 'after-close'))

  // ⑥ 背压兜底：上限设小，写很多条，丢掉计数要起来、但内存不涨
  const busyFile = path.join(home, 'busy.jsonl')
  const busy = new Logger({ file: busyFile, maxPendingBytes: 200 })
  for (let i = 0; i < 40; i += 1) busy.info('probe', `line-${i}`)
  ok('积压超过上限时开始丢日志（有计数）', busy.dropped > 0, `dropped=${busy.dropped}`)
  const drops = busy.list().filter((e) => e.scope === 'log' && e.msg.includes('积压'))
  ok('丢日志只提示一次', drops.length === 1, `实际 ${drops.length} 条`)
  busy.close()

  // ⑦ warnOnce 语义没被改坏
  const once = new Logger()
  once.warnOnce('k', 'peer', 'first')
  once.warnOnce('k', 'peer', 'second')
  ok('warnOnce 同一个 key 只记一次', once.list().length === 1, `实际 ${once.list().length} 条`)

  once.close()
  broken.close()

  await fsp.rm(home, { recursive: true, force: true }).catch(() => {})
  console.log(`logger ok · 15 条断言（7 组）· 写盘失败不崩 / 只警告一次 / JSONL / 循环引用 / close 后不写 / 背压上限 / warnOnce（${pass} 通过、${fail} 失败）`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.log(`FAIL 测试自身抛错: ${err?.stack ?? err}`)
  process.exit(1)
})
