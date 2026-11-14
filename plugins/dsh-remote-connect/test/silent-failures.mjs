/**
 * 静默失败守卫。
 *
 * 上一版的教训：进度轮询的签名一直对不上，而那里写着
 * 「progress is best-effort」，把异常整个吞了——现场表现不是报错，
 * 而是「进度条一直不动」，藏了两个版本。
 *
 * 现在「尽力而为」的分支必须满足两条：
 *   1. 出错不能刷屏（同一个 key 只记一条）——Logger.warnOnce 负责；
 *   2. 出错不能一声不响——第一次失败必须留下一条可读的 warn。
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.join(here, '..')
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { Logger } = await load('host/util.mjs')
const { RemotePeer } = await load('host/peer.mjs')
const { PackCache } = await load('host/pack.mjs')
const { LinkService } = await load('host/service.mjs')

let pass = 0
let fail = 0
async function expect(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err?.message ?? err}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
const quiet = () => new Logger({ ring: 200 })

/* 1. warnOnce 只记一次，不同 key 各记一次 */
await expect('warnOnce 同一个 key 只记一条', async () => {
  const logger = quiet()
  logger.warnOnce('k1', 'peer', '第一次')
  logger.warnOnce('k1', 'peer', '第二次')
  logger.warnOnce('k2', 'peer', '另一个 key')
  const rows = logger.list()
  assert(rows.length === 2, `应当只有 2 条，实际 ${rows.length} 条`)
  assert(rows[0].msg === '第一次', '第一条内容不对')
  assert(rows[1].msg === '另一个 key', '第二条内容不对')
  assert(
    rows.every((r) => r.level === 'warn'),
    'warnOnce 必须是 warn 级别',
  )
})

await expect('warnOnce 与普通 warn 互不影响', async () => {
  const logger = quiet()
  logger.warn('peer', '普通警告')
  logger.warn('peer', '普通警告')
  logger.warnOnce('x', 'peer', '一次性')
  logger.warnOnce('x', 'peer', '一次性')
  const msgs = logger.list().map((r) => r.msg)
  assert(msgs.filter((m) => m === '普通警告').length === 2, '普通 warn 不该被去重')
  assert(msgs.filter((m) => m === '一次性').length === 1, 'warnOnce 该去重')
})

/* 2. 进度查询失败：同步照样成功，但要留 warn 并把次数上报 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => handler(req, res, Buffer.concat(chunks)))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

await expect('进度查询失败会记一条 warn，且同步仍然成功', async () => {
  const logger = quiet()
  const uploads = []
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-silent-'))
  const file = path.join(tmp, 'a.md')
  await fs.writeFile(file, 'abc')
  const fake = await serve((req, res, body) => {
    const url = req.url
    if (url.startsWith('/dsh-link/v1/apply/prepare')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ syncId: 's1', maxTotalBytes: 1 << 20 }))
      return
    }
    if (url.startsWith('/dsh-link/v1/progress')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }))
      return
    }
    if (url.startsWith('/dsh-link/v1/apply/')) {
      uploads.push({ url, bytes: body.length })
      // 压一拍再回：给进度轮询（首轮 700ms）一个真的失败机会，
      // 否则小文件一瞬间传完，根本轮不到轮询。
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, files: 1 }))
      }, 1200)
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  try {
    const peer = new RemotePeer({
      record: { id: 'p1', host: '127.0.0.1', port: fake.port, scheme: 'http' },
      logger,
      device: { id: 'me', name: 'me' },
    })
    peer.session = { token: 'tok', sk: Buffer.alloc(32, 3), expiresAt: Date.now() + 3600_000 }
    const events = []
    const result = await peer.push({
      entries: [{ rel: 'a.md', size: 3, abs: file, mtime: Date.now() }],
      manifest: { id: 'm1', totalFiles: 1 },
      onProgress: (p) => events.push(p),
    })
    assert(result && result.files === 1, '推送结果不对')
    assert(uploads.length === 1, `上传应当只发生一次，实际 ${uploads.length} 次`)
    const warns = logger.list().filter((r) => r.level === 'warn')
    assert(warns.length === 1, `进度失败应当只记一条 warn，实际 ${warns.length} 条`)
    assert(/查询同步进度失败/.test(warns[0].msg), `warn 文案不对：${warns[0].msg}`)
    assert(/INTERNAL/.test(warns[0].msg), `warn 里应当带错误码：${warns[0].msg}`)
    const done = events.find((e) => e.phase === 'done')
    assert(done, '缺少 done 事件')
    assert(done.progressFailures >= 1, `done 事件里应当带 progressFailures，实际 ${done.progressFailures}`)
  } finally {
    fake.server.close()
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

/* 3. 同步任务把 progressFailures 带到任务视图 */
await expect('任务视图里能看出「进度查询失败过」', async () => {
  const logger = quiet()
  // 推送方向要真的扫一遍文件，先造一个只含一个 skills 文件的家目录
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-silent-home-'))
  await fs.mkdir(path.join(home, 'skills'), { recursive: true })
  await fs.writeFile(path.join(home, 'skills', 'a.md'), 'hello\n')
  const before = process.env.DEVICE_LINK_DSH_HOME
  process.env.DEVICE_LINK_DSH_HOME = home
  try {
    const svc = new LinkService({
      logger,
      store: { get: async () => ({ sync: { includeCredentials: false }, server: {} }) },
    })
    const peer = {
      push: async ({ onProgress }) => {
        onProgress?.({ phase: 'applying', done: 10, total: 10 })
        onProgress?.({ phase: 'done', done: 10, total: 10, progressFailures: 3, result: { ok: true } })
        return { ok: true, files: 1, bytes: 10 }
      },
    }
    svc.ensureConnected = async () => peer
    svc.clients.set('p1', peer)
    const task = svc.startSync({ peerId: 'p1', direction: 'push', cats: ['skills'] })
    for (let i = 0; i < 80 && !task.finishedAt; i += 1) await new Promise((r) => setTimeout(r, 25))
    const view = svc.task(task.id)
    assert(view, '拿不到任务视图')
    assert(view.phase === 'done', `任务应当完成，实际 ${view.phase}（${view.error ?? ''}）`)
    assert(view.progressFailures === 3, `progressFailures 应当为 3，实际 ${view.progressFailures}`)
  } finally {
    if (before === undefined) delete process.env.DEVICE_LINK_DSH_HOME
    else process.env.DEVICE_LINK_DSH_HOME = before
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* 4. 哈希缓存写不进去：留一条 warn，并保持 dirty 等下次重试 */
await expect('哈希缓存写盘失败会记 warn 且保持 dirty', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-cache-fail-'))
  const blocker = path.join(dir, 'not-a-dir')
  await fs.writeFile(blocker, 'x')
  const logger = quiet()
  const cache = new PackCache(path.join(blocker, 'hash-cache.json'), { logger })
  cache.set('a.md|1|1', 'deadbeef')
  await cache.flush()
  const warns = logger.list().filter((r) => r.level === 'warn')
  assert(warns.length === 1, `应当有一条 warn，实际 ${warns.length}`)
  assert(/哈希缓存写盘失败/.test(warns[0].msg), `文案不对：${warns[0].msg}`)
  assert(cache.dirty === true, 'dirty 应当保持 true，等下次重试')
  await fs.rm(dir, { recursive: true, force: true })
})

console.log(`\nsilent ok · 5 项断言 · warnOnce / 进度失败 / 任务视图 / 缓存写盘（${pass} 通过、${fail} 失败）`)
process.exit(fail > 0 ? 1 : 0)
