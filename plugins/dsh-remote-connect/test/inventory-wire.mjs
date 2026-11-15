/**
 * `/inventory` 的线上字段。
 *
 * 扫描器早就算好了「有多少个文件被规则跳过、各是什么原因」，但服务端回给对端时
 * 只挑固定几个字段（`summary/totalFiles/totalBytes/excluded/entries`），
 * 把 `excludedTotal` 与 `excludedReasons` 吞掉了 —— 于是界面那句
 * 「有 N 个文件没进清单（凭据/密钥 · 日志）」只有自己扫自己时才出现，
 * 从对端拉清单时永远是 0。这个文件直接打真服务端，验线上字段。
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-inv-wire-'))
const dsh = path.join(home, 'dsh')
// 注意：插件自己的数据目录（dataHome）不能放在被扫描的根里面 —— 扫描时会整片跳过
// 「自己的状态」，那样 skills 一条都扫不到，测试会以为线上字段没了。
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = dsh

const { ConfigStore } = await import('../host/config.mjs')
const serverUrl = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/server.mjs', import.meta.url).href
const { LinkServer } = await import(serverUrl)
const { signRequest, sha256 } = await import('../host/sign.mjs')
const { encryptJson, decryptJson } = await import('../host/crypto.mjs')

let pass = 0
let fail = 0
async function ok(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}\n       ${err?.message ?? err}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

const quiet = { info() {}, warn() {}, error() {} }

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// 造一份会被跳过的东西：一个凭据、一个日志、一个超大文件
async function seed() {
  const dir = path.join(dsh, 'skills', 'demo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), '# demo\n')
  await fs.writeFile(path.join(dir, '.env'), 'TOKEN=1\n')
  await fs.writeFile(path.join(dir, 'run.log'), 'x\n')
  const big = path.join(dsh, 'skills', 'demo', 'huge.bin')
  await fs.writeFile(big, Buffer.alloc(3 * 1024 * 1024, 7))
}

const store = new ConfigStore()
await store.load()
// 单文件上限调小一点，好让造出来的 3 MB 大文件真的落在「超大」那一类
await store.patch({ sync: { maxFileMb: 1 } })
await seed()
const port = await freePort()
const server = new LinkServer({ store, logger: quiet, idleMs: 5000 })
await server.start({ port, bind: '127.0.0.1' })

const token = 'tok-' + randomBytes(4).toString('hex')
const session = {
  token,
  sk: randomBytes(32),
  device: { id: 'dev_wire', name: 'wire', platform: 'test' },
  expiresAt: Date.now() + 3600_000,
}
server.sessions.set(token, session)

function signedHeaders(method, target, body) {
  const ts = Date.now()
  const nonce = randomBytes(8).toString('hex')
  const mac = signRequest(session.sk, { method, target, ts, nonce, digest: sha256(body) })
  return {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-dl-token': token,
    'x-dl-ts': String(ts),
    'x-dl-nonce': nonce,
    'x-dl-mac': mac,
  }
}

function post(target, payload) {
  const body = Buffer.from(JSON.stringify(encryptJson(session.sk, payload)), 'utf8')
  const headers = signedHeaders('POST', target, body)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: target, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
    setTimeout(() => reject(new Error('请求超时')), 8000).unref?.()
  })
}

async function inventory(payload) {
  const r = await post('/dsh-link/v1/inventory', payload)
  assert(r.status === 200, `状态应为 200，实际 ${r.status}`)
  return decryptJson(session.sk, JSON.parse(r.text))
}

// —— 1. 线上确实带着「跳过了多少、为什么」
await ok('清单里有 excludedTotal 与 excludedReasons', async () => {
  const inv = await inventory({ cats: ['skills'] })
  assert(inv.excludedTotal >= 2, `excludedTotal 应至少 2，实际 ${inv.excludedTotal}`)
  const reasons = inv.excludedReasons ?? {}
  assert(reasons.secret >= 1, `应有凭据类跳过，实际 ${JSON.stringify(reasons)}`)
  assert(reasons.big >= 1, `应有超大文件跳过，实际 ${JSON.stringify(reasons)}`)
})

// —— 2. 明细每条都带可翻译的代号（界面据此换语言）
await ok('明细每条都带 code', async () => {
  const inv = await inventory({ cats: ['skills'] })
  assert(Array.isArray(inv.excluded) && inv.excluded.length > 0, '明细不该为空')
  for (const row of inv.excluded) {
    assert(['secret', 'log', 'big', 'denied', 'deep', 'other'].includes(row.code), `明细缺少可翻译的代号：${JSON.stringify(row)}`)
  }
})

// —— 3. 勾上「包含凭据」之后，凭据类真的不再被跳过（且统计跟着变）
await ok('勾上凭据后 secret 归零、.env 进清单', async () => {
  await store.patch({ sync: { includeCredentials: true } })
  const inv = await inventory({ cats: ['skills'], includeSecrets: true })
  const reasons = inv.excludedReasons ?? {}
  assert(reasons.secret === undefined, `勾上之后不该再有凭据类跳过，实际 ${JSON.stringify(reasons)}`)
  assert(
    inv.entries.some((e) => e.rel.endsWith('.env')),
    '勾上之后 .env 应当出现在清单里',
  )
  await store.patch({ sync: { includeCredentials: false } })
})

// —— 4. 一个文件都没跳过时，字段也在（不是「没数据就缺字段」）
await ok('没有跳过时字段仍然存在且为 0', async () => {
  const clean = path.join(dsh, 'rules', 'plain')
  await fs.mkdir(clean, { recursive: true })
  await fs.writeFile(path.join(clean, 'a.md'), '# a\n')
  const inv = await inventory({ cats: ['rules'] })
  assert(inv.excludedTotal === 0, `应当为 0，实际 ${inv.excludedTotal}`)
  assert(typeof inv.excludedReasons === 'object' && inv.excludedReasons !== null, 'excludedReasons 应当是个对象')
})

server.http?.close?.()
console.log(
  `inventory-wire ok · ${pass + fail} 项断言 · 线上字段 / 明细代号 / 勾上凭据 / 空统计（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
