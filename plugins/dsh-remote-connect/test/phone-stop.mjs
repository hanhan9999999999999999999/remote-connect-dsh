/**
 * 停掉手机通道这条路。
 *
 * 这里要看的是三件容易被写反的事：
 *   1. 端口记录过期时（顺延之后没写成），必须按**实际**端口去认进程，
 *      否则一个 pid 都找不到，干等 12 秒报「进程仍在响应」——服务其实还在跑。
 *   2. 暂停标记要在杀进程之前写：中途 DSH 重启才不会又把它拉起来。
 *   3. 停止失败必须把暂停标记撤掉，否则「服务还在跑、下次启动却不会自动起来」。
 *
 * 用法：node test/phone-stop.mjs [phone.mjs 的路径]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-phone-stop-'))
process.env.DEVICE_LINK_HOME = home
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'host', 'phone.mjs')
const mod = await import(pathToFileURL(target).href)
const stopBridge = mod.__test?.stopBridge

let pass = 0
let fail = 0
function ok(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `：${detail}`}`)
  }
}

if (typeof stopBridge !== 'function') {
  ok('phone.mjs 导出了 stopBridge', false, '没有 __test.stopBridge')
} else {
  /** 一套可观测的假依赖：谁被调用、按什么参数 */
  const harness = ({ recorded = 8899, aliveAt = 8899, detect = 0, keepsAlive = false, writeOk = true }) => {
    const calls = { health: [], detect: [], kill: [], pause: 0, resume: 0 }
    let alive = Boolean(aliveAt)
    return {
      calls,
      deps: {
        bridgePort: () => recorded,
        health: async (timeoutMs, port) => {
          calls.health.push({ timeoutMs, port })
          if (!alive) return false
          return port === (aliveAt || 0) && !(keepsAlive ? false : false)
        },
        detectBridgePort: async (rec) => {
          calls.detect.push(rec)
          return detect
        },
        listenerPid: async (port) => {
          calls.health.push({ listener: port })
          return port === (detect || aliveAt) ? 5150 : 0
        },
        killPid: async (pid) => {
          calls.kill.push(pid)
          if (!keepsAlive) alive = false
          return true
        },
        sleep: async () => {},
        writePauseFlag: () => {
          calls.pause += 1
          return writeOk ? null : '写 paused.flag 失败: EACCES'
        },
        clearPauseFlag: () => {
          calls.resume += 1
          return true
        },
      },
    }
  }

  // 1. 记录端口上有服务：按记录端口杀，成功之后报 stopped 并带端口
  {
    const h = harness({ aliveAt: 8899 })
    const r = await stopBridge(h.deps)
    ok('记录端口活着时能停掉', r.stopped === true && r.port === 8899, JSON.stringify(r))
    ok('按记录端口找进程并杀掉', h.calls.kill[0] === 5150, JSON.stringify(h.calls.kill))
    ok('先写暂停标记，再杀进程', h.calls.pause === 1 && r.waitedMs !== undefined, JSON.stringify({ pause: h.calls.pause }))
  }

  // 2. 记录过期、服务在 8900：必须按实际端口认，不能干等
  {
    const h = harness({ recorded: 8899, aliveAt: 0, detect: 8900 })
    h.deps.health = async (timeoutMs, port) => {
      h.calls.health.push({ timeoutMs, port })
      return port === 8900 && !h.calls.kill.includes(5150)
    }
    const r = await stopBridge(h.deps)
    ok('记录过期时按实际端口停掉', r.stopped === true && r.port === 8900 && r.recordedPort === 8899, JSON.stringify(r))
    ok('确实去认过实际端口', h.calls.detect.length === 1, JSON.stringify(h.calls.detect))
    ok('杀的是实际端口上的那个进程', h.calls.kill[0] === 5150, JSON.stringify(h.calls.kill))
  }

  // 3. 根本没在跑：不该写暂停标记、也不该杀任何东西
  {
    const h = harness({ aliveAt: 0, detect: 0 })
    const r = await stopBridge(h.deps)
    ok('没在跑时直接报已经停了', r.stopped === true && r.already === true, JSON.stringify(r))
    ok('没在跑时不动进程、不写标记', h.calls.kill.length === 0 && h.calls.pause === 0, JSON.stringify(h.calls))
  }

  // 4. 写不进暂停标记：一个进程都不许杀（杀了就成了「停了但下次不会回来」）
  {
    const h = harness({ aliveAt: 8899, writeOk: false })
    const r = await stopBridge(h.deps)
    ok('写不进暂停标记就报错', r.stopped === false && String(r.error).includes('paused.flag'), JSON.stringify(r))
    ok('写不进暂停标记时不杀进程', h.calls.kill.length === 0, JSON.stringify(h.calls.kill))
  }

  // 5. 杀不掉（服务一直回话）：报失败，并把暂停标记撤掉
  {
    const h = harness({ aliveAt: 8899, keepsAlive: true })
    const r = await stopBridge(h.deps)
    ok('杀不掉时报 stopped:false', r.stopped === false, JSON.stringify(r))
    ok('杀不掉时撤掉暂停标记', h.calls.resume === 1, JSON.stringify({ resume: h.calls.resume }))
    ok('失败时说明标记已撤销', String(r.error).includes('撤销'), String(r.error))
  }

  // 6. 客户端要能看见停止失败（不能只在卡片里悄悄红一行）
  {
    const clientPath = path.join(here, '..', 'client.js')
    const src = fs.readFileSync(clientPath, 'utf8')
    ok('停止失败会给用户提示', /r\.stopped === false && r\.error/.test(src), 'client.js 里没有 stopped === false 的提示分支')
  }
}

console.log(
  `phone-stop ok · ${pass + fail} 项断言 · 记录端口 / 端口过期 / 未运行 / 标记写不进 / 杀不掉 / 界面提示（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
