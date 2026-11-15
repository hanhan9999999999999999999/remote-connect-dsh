/**
 * 面板快照（`LinkService.status()`）的单块降级。
 *
 * 以前任何一块出错——配置读不出来、网卡枚举失败、`peers.json` 坏了、批次目录读不了
 * ——整份快照就变成 500，界面一片空白。用户连「哪里坏了」都看不到，更没法动手去修，
 * 而最需要看到面板的时候恰恰就是配置坏掉的时候。
 *
 * 所以这里逐块打断，断言：坏的那块降级成空值 + 在 `degraded` 里留下名字与原因，
 * 其余部分照常返回；一切正常时 `degraded` 是空数组（不能变成「永远在报警」）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const modUrl = (rel) => pathToFileURL(path.join(pluginRoot, rel)).href

let pass = 0
let fail = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? `（${detail}）` : ''))
    console.log(`FAIL ${label}${detail ? `：${detail}` : ''}`)
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-status-degraded-'))
  process.env.DEVICE_LINK_HOME = home
  process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

  // 可传一个模块路径，用来验证这个守卫自己（拿旧版 host/service.mjs 跑应该红一片）
  const serviceUrl = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : modUrl('host/service.mjs')
  const { LinkService } = await import(serviceUrl)

  const quiet = { info() {}, warn() {}, error() {} }
  const warns = []
  const loud = {
    info() {},
    error() {},
    warn(scope, msg) {
      warns.push(`${scope}: ${msg}`)
    },
  }

  /** 造一个「已经 init 过」的服务，把各块换成会抛的桩 */
  function makeService(broken = {}) {
    const svc = new LinkService({
      logger: loud,
      store: {
        async load() {
          return { sync: {} }
        },
        async get() {
          if (broken.config) throw new Error('配置文件坏了')
          return { device: { name: '本机', id: 'self' }, sync: {} }
        },
      },
      peerStore: { async load() {}, async list() { return [] } },
    })
    svc.init = async () => {}
    svc.publicConfig = async () => {
      if (broken.config) throw Object.assign(new Error('配置文件坏了'), { code: 'CONFIG_BROKEN' })
      return {
        device: { name: '本机', id: 'self' },
        server: { addresses: [] },
        auth: { hasPassword: false, password: '', changedAt: 0 },
        sync: { categories: {} },
        ui: {},
        connectUri: null,
        categories: [],
      }
    }
    svc.server = {
      async status() {
        if (broken.server) throw new Error('网卡枚举失败')
        return { running: true, port: 8899 }
      },
    }
    svc.peerStore = {
      async list() {
        if (broken.peers) throw new Error('peers.json 坏了')
        return [{ id: 'p1', name: '手机' }]
      },
    }
    svc.localApplier = {
      async listRecent() {
        if (broken.recent) throw new Error('syncs 目录读不了')
        return [{ id: 's1', phase: 'done' }]
      },
    }
    svc.tasks = {
      recent() {
        if (broken.tasks) throw new Error('任务表坏了')
        return [{ id: 't1', phase: 'done' }]
      },
    }
    return svc
  }

  // —— 1. 一切正常：degraded 是空数组，各部分都有值
  {
    warns.length = 0
    const svc = makeService()
    const s = await svc.status()
    ok('正常时 degraded 是空数组', Array.isArray(s.degraded) && s.degraded.length === 0, JSON.stringify(s.degraded))
    ok('正常时各部分都有值', s.server.port === 8899 && s.peers.length === 1 && s.recent.length === 1 && s.tasks.length === 1)
    ok('正常时不写警告日志', warns.length === 0, warns.join(' | '))
  }

  // —— 2. 配置读不出来：仍然返回可用快照，config 是形状一致的空壳
  try {
    warns.length = 0
    const svc = makeService({ config: true })
    const s = await svc.status()
    ok('配置坏了也返回快照', Boolean(s) && Boolean(s.app) && s.app.version.length > 0)
    ok('配置坏了会记进 degraded', s.degraded.some((d) => d.section === 'config'), JSON.stringify(s.degraded))
    ok(
      'degraded 里带错误码与原因',
      s.degraded.some((d) => d.code === 'CONFIG_BROKEN' && d.error.includes('配置文件')),
      JSON.stringify(s.degraded),
    )
    ok(
      'config 降级成形状一致的空壳（界面不会因此白屏）',
      s.config && typeof s.config === 'object' && s.config.device && typeof s.config.device === 'object' && Array.isArray(s.config.categories),
      JSON.stringify(s.config),
    )
    ok('device 降级成空对象', s.device && Object.keys(s.device).length === 0)
    ok('其它块照常返回', s.server.port === 8899 && s.peers.length === 1 && s.tasks.length === 1)
    ok('坏掉的那块写了一条 warn', warns.some((w) => w.includes('config')), warns.join(' | '))
  } catch (err) {
    ok('配置坏了时 status 不该抛错', false, err?.message)
  }

  // —— 3. 服务状态取不到：server 降级，其余不动
  try {
    warns.length = 0
    const svc = makeService({ server: true })
    const s = await svc.status()
    ok('服务状态炸了也返回快照', s.server && s.server.running === false)
    ok('只有 server 出现在 degraded', s.degraded.length === 1 && s.degraded[0].section === 'server', JSON.stringify(s.degraded))
    ok('其余部分不受牵连', s.peers.length === 1 && s.recent.length === 1 && s.tasks.length === 1)
  } catch (err) {
    ok('服务状态取不到时 status 不该抛错', false, err?.message)
  }

  // —— 4. 对端列表 / 批次 / 任务同时坏：三块各自降级，互不牵连
  try {
    warns.length = 0
    const svc = makeService({ peers: true, recent: true, tasks: true })
    const s = await svc.status()
    const sections = s.degraded.map((d) => d.section).sort()
    ok('三块都记进 degraded', JSON.stringify(sections) === JSON.stringify(['peers', 'recent', 'tasks']), JSON.stringify(section(s)))
    ok('三块都降级成空数组', s.peers.length === 0 && s.recent.length === 0 && s.tasks.length === 0)
    ok('服务与配置仍然正常', s.server.port === 8899 && Boolean(s.config.device))
  } catch (err) {
    ok('三块同时坏时 status 不该抛错', false, err?.message)
  }

  // —— 5. init 自己就失败：不抛，带 init 一条降级
  {
    warns.length = 0
    const svc = makeService()
    svc.init = async () => {
      throw Object.assign(new Error('配置结构性损坏'), { code: 'CONFIG_BROKEN' })
    }
    let threw = null
    let s = null
    try {
      s = await svc.status()
    } catch (err) {
      threw = err
    }
    ok('init 失败时 status 不抛', threw === null, threw?.message)
    ok('init 失败会记一条 init', s && s.degraded.some((d) => d.section === 'init' && d.code === 'CONFIG_BROKEN'), JSON.stringify(s?.degraded))
    ok(
      'init 失败时仍给出一份可用空壳',
      s && s.app && Array.isArray(s.peers) && Array.isArray(s.recent) && Array.isArray(s.tasks) && s.config && s.config.device,
    )
  }

  // —— 6. 客户端确实会把 degraded 显示出来
  {
    const client = fs.readFileSync(path.join(pluginRoot, 'client.js'), 'utf8')
    ok('界面渲染 degraded 提示', client.includes('status.degraded') && client.includes('dlk-degraded'))
    ok('界面用的是 alert 语义', /className: 'dlk-degraded', role: 'alert'/.test(client))
  }

  console.log(
    fail === 0
      ? `status-degraded ok · 21 项断言 · 单块降级 / 空壳形状 / init 失败 / 界面提示（${pass} 通过、${fail} 失败）`
      : `status-degraded FAILED · ${pass} 通过、${fail} 失败`,
  )
  if (fail > 0) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  console.log(`  临时目录 ${home}`)
  process.exit(fail > 0 ? 1 : 0)
}

function section(s) {
  return s?.degraded ?? []
}

main().catch((err) => {
  console.error('status-degraded 崩了：', err)
  process.exit(1)
})
