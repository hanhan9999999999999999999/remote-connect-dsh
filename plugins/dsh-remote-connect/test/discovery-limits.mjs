/**
 * 局域网发现的边界：等待时间、目标列表、收多少台、套接字关掉之后还能不能重启。
 *
 * 这一轮的动机：`scan()` 的 `timeoutMs` 直接进 `setTimeout`（`NaN` 会变成 1ms，一次性返回
 * 空列表），`extraHosts` 原样拼进广播目标（可以传一万个），收到的回复也没有数量上限
 * （局域网里谁都能往这个端口灌包），而 `start()` 在 UDP 套接字意外关闭后仍把
 * `this.socket` 留着——端口被抢走之后局域网发现再也不会自己恢复。
 */
import dgram from 'node:dgram'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../host/discovery.mjs', import.meta.url).href
const mod = await import(target)
// 老版本没有这几个导出——缺了就让断言红，而不是让整个测试崩掉
const { Discovery } = mod
const SCAN_LIMITS = mod.SCAN_LIMITS ?? {}
const scanWindow = mod.scanWindow ?? (() => NaN)
const sanitizeTargets = mod.sanitizeTargets ?? (() => [])

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${detail ? `：${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

/** 拿一个当前空闲的 UDP 端口（先绑 0 再关掉）。 */
async function freePort() {
  const s = dgram.createSocket('udp4')
  await new Promise((resolve) => s.bind(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}

const warns = []
const loud = {
  info() {},
  warn(scope, msg) {
    warns.push(`${scope}: ${msg}`)
  },
  error() {},
}

// —— 1. 等待时间被收进合法区间
ok('scanWindow 收拢：NaN 用回默认值', scanWindow(NaN) === 1500, String(scanWindow(NaN)))
ok('scanWindow 收拢：非数字字符串也用默认值', scanWindow('abc') === 1500, String(scanWindow('abc')))
ok('scanWindow 收拢：太小抬到下限', scanWindow(50) === SCAN_LIMITS.minTimeoutMs, String(scanWindow(50)))
ok('scanWindow 收拢：太大压到上限', scanWindow(999999) === SCAN_LIMITS.maxTimeoutMs, String(scanWindow(999999)))
ok('scanWindow 收拢：正常值原样', scanWindow(1200) === 1200, String(scanWindow(1200)))

// —— 2. 目标列表只认 IPv4 字面量，去重并封顶
const cleaned = sanitizeTargets(['192.168.1.5', 'not-an-ip', '999.1.1.1', '10.0.0.1', '  10.0.0.1  ', 42, null])
ok('sanitizeTargets 丢掉不像地址的项并去重', cleaned.join(',') === '192.168.1.5,10.0.0.1', cleaned.join(','))
const many = Array.from({ length: 200 }, (_, i) => `10.1.${Math.floor(i / 250)}.${i % 250}`)
ok(
  'sanitizeTargets 封顶到 maxTargets',
  sanitizeTargets(many).length === SCAN_LIMITS.maxTargets,
  String(sanitizeTargets(many).length),
)
ok('sanitizeTargets 对非数组不抛', sanitizeTargets(null).length === 0)

// —— 3. 灌包时回复数量有上限
{
  // 假设备：收到探测就往回灌一批不同 id 的回复。
  // 一次灌太多时 loopback 的 UDP 缓冲区会丢包（CI 上实测 300 条只到 221 条），
  // 所以每轮多灌一些，并且最多重扫几轮——直到真的把 256 个名额填满为止。
  const PER_ROUND = 800
  const MAX_ROUNDS = 4
  const flooder = dgram.createSocket('udp4')
  let sent = 0
  let round = 0
  flooder.on('message', (_msg, rinfo) => {
    round += 1
    for (let i = 0; i < PER_ROUND; i += 1) {
      const reply = Buffer.from(
        JSON.stringify({
          m: 'dsh-link/here',
          v: 1,
          id: `peer-${round}-${i}`,
          name: `设备 ${i}`,
          port: 9000,
        }),
      )
      flooder.send(reply, rinfo.port, rinfo.address, () => {})
      sent += 1
    }
  })
  const floodPort = await freePort()
  await new Promise((resolve) => flooder.bind(floodPort, '127.0.0.1', resolve))

  let list = []
  for (let attempt = 0; attempt < MAX_ROUNDS && list.length < SCAN_LIMITS.maxPeers; attempt += 1) {
    warns.length = 0
    const d = new Discovery({ port: floodPort, logger: loud, getInfo: () => ({ id: 'self', name: '本机' }) })
    list = await d.scan({ timeoutMs: 600, extraHosts: ['127.0.0.1'] })
  }
  ok('灌包时收回来的设备不超过上限', list.length === SCAN_LIMITS.maxPeers, `实际 ${list.length} 台`)
  ok('超出上限的回复被丢掉并记了一条警告', warns.some((w) => w.includes('超出上限')), warns.join(' | '))
  ok('确实灌了不少包（否则这条断言不算数）', sent > SCAN_LIMITS.maxPeers, `发了 ${sent} 条`)
  await new Promise((resolve) => flooder.close(resolve))
}

// —— 4. NaN 等待时间不会让扫描立即返回空表
{
  const d = new Discovery({ port: await freePort(), logger: loud })
  const t0 = Date.now()
  const list = await d.scan({ timeoutMs: NaN })
  const spent = Date.now() - t0
  ok('timeoutMs 是 NaN 时也按默认窗口等，不立刻返回', spent >= 1000 && Array.isArray(list), `${spent}ms`)
}

// —— 5. 套接字意外关闭后 start() 能重新起来
{
  const port = await freePort()
  const d = new Discovery({ port, logger: loud, getInfo: () => ({ id: 'self', name: '本机' }) })
  const first = await d.start()
  ok('第一次 start 成功', first === true)
  d.socket.close()
  const cleared = await waitFor(() => d.socket === null)
  ok('套接字关掉之后 this.socket 被放开（不再是「已经在跑」）', cleared === true)
  const second = await d.start()
  ok('之后还能重新开启', second === true)
  await d.stop()
}

console.log(
  `discovery-limits ok · 15 项断言 · 等待时间 / 目标列表 / 灌包上限 / NaN 窗口 / 关闭后重启（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
