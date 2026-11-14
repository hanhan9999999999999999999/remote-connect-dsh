#!/usr/bin/env node
// 换端口这条路：以前是「先杀旧的、再写记录、再起新的」——
// 新的起不来时记录已经指到新端口、旧服务也已经被杀，等于搬家中途把家拆了。
// 现在：记录先落地（写不进就不搬）、新端口起不来就退回旧端口并尽量把旧桥接叫回来。
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const home = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'rc-phone-switch-'))
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { __test } = await import('../host/phone.mjs')
const { switchPort } = __test

let pass = 0
let fail = 0
async function ok(label, fn) {
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

// 一台「跑在 cur 上的桥接 + 记录里的端口」的模拟环境
function harness({ cur = 8899, alive = true, probeState = 'free', writeOk = true, startResults = [] } = {}) {
  const state = {
    port: cur,
    writes: [],
    started: [],
    killed: [],
  }
  const deps = {
    health: async () => (alive ? { ok: true } : null),
    clearStale: async () => ({ state: probeState, pid: probeState === 'foreign' ? 4242 : 0, name: '别的程序' }),
    writePortJson: (p) => {
      if (!writeOk) return false
      state.writes.push(Number(p))
      state.port = Number(p)
      return true
    },
    listenerPid: async () => 5150,
    killPid: async (pid) => {
      state.killed.push(pid)
      return true
    },
    bridgePort: () => state.port,
    startBridge: async ({ port }) => {
      state.started.push(Number(port))
      const next = startResults.shift()
      return next ?? { started: true, port: Number(port) }
    },
  }
  return { state, deps }
}

await ok('端口非法时直接拒绝，什么都不动', async () => {
  const { state, deps } = harness()
  for (const bad of [80, 70000, 'abc', null]) {
    const r = await switchPort(bad, deps)
    assert(r.switched === false, `${JSON.stringify(bad)} 应当被拒`)
  }
  assert(state.writes.length === 0, '不该写任何记录')
  assert(state.killed.length === 0, '不该杀任何进程')
})

await ok('目标端口被别的程序占着：报冲突，不杀自己的桥接', async () => {
  const { state, deps } = harness({ probeState: 'foreign' })
  const r = await switchPort(9100, deps)
  assert(r.switched === false, '应当失败')
  assert(r.conflict && r.conflict.pid === 4242, '要带上占用者信息')
  assert(state.killed.length === 0, '不能因为别人占着端口就杀自己的桥接')
  assert(state.writes.length === 0, '也不该改记录')
})

await ok('记录写不进去：原地不动，不杀旧桥接', async () => {
  const { state, deps } = harness({ writeOk: false })
  const r = await switchPort(9101, deps)
  assert(r.switched === false, '应当失败')
  assert(/port\.json/.test(r.error), `错误里要说明是写不进 port.json：${r.error}`)
  assert(state.killed.length === 0, '记录都写不下来，就更不该把旧服务停掉')
  assert(state.started.length === 0, '也不该尝试启动新端口')
})

await ok('换成功：先写记录，再杀旧桥接，再在新端口起来', async () => {
  const { state, deps } = harness()
  const r = await switchPort(9102, deps)
  assert(r.switched === true, '应当成功')
  assert(state.writes[0] === 9102, `记录应先写新端口，实际 ${JSON.stringify(state.writes)}`)
  assert(state.killed[0] === 5150, '应当杀掉落单的旧桥接')
  assert(r.port === 9102 && r.from === 8899, '返回值要带新端口与来源端口')
})

await ok('新端口起不来：记录退回旧值，并试着把旧桥接叫回来', async () => {
  const { state, deps } = harness({ startResults: [{ started: false, error: '端口 9103 被别的程序占用' }, { started: true, port: 8899 }] })
  const r = await switchPort(9103, deps)
  assert(r.switched === false, '换端口应当报失败')
  assert(r.rolledBack === true && r.restored === true, `应标记已退回，实际 ${JSON.stringify(r)}`)
  assert(state.writes.at(-1) === 8899, `记录要退回旧端口，实际 ${JSON.stringify(state.writes)}`)
  assert(state.started.at(-1) === 8899, `应当尝试重启旧端口，实际 ${JSON.stringify(state.started)}`)
  assert(/退回 8899/.test(r.error), `错误文案要说明退回了：${r.error}`)
})

await ok('新端口起不来、旧桥接也叫不回来：文案要说清楚，别让人以为还在跑', async () => {
  const { deps } = harness({ startResults: [{ started: false, error: '起不来' }, { started: false }] })
  const r = await switchPort(9104, deps)
  assert(r.switched === false && r.rolledBack === true && r.restored === false, JSON.stringify(r))
  assert(/也没能叫回来/.test(r.error), `错误文案要说明旧端口也没起来：${r.error}`)
})

await ok('目标就是当前端口且活着：直接返回 unchanged，不动任何东西', async () => {
  const { state, deps } = harness({ cur: 8899, alive: true })
  const r = await switchPort(8899, deps)
  assert(r.switched === true && r.unchanged === true, JSON.stringify(r))
  assert(state.killed.length === 0 && state.started.length === 0, '不该有多余动作')
})

await (await import('node:fs/promises')).rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `phone-switch ok · ${pass} 项断言 · 非法端口 / 端口冲突 / 记录写不进 / 正常换 / 起不来退回 / 退不回 / 原地不动（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
