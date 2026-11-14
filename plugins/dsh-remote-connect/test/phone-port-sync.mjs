#!/usr/bin/env node
// 端口记录与实际的两种不一致：
//   1) 端口被占后自动顺延，但 port.json 没写进去 —— 桥接在 8900 跑着，记录还指 8899；
//   2) 记录被手改过 / 上次写失败 —— 面板只信记录，就会一口咬定「没运行」。
// 这里钉住两件事：顺延时要如实报「记录没写成」；snapshot 要能从监听表里把它认回来。
import os from 'node:os'
import path from 'node:path'

const home = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'rc-port-sync-'))
process.env.DEVICE_LINK_HOME = path.join(home, 'data')
process.env.DEVICE_LINK_DSH_HOME = path.join(home, 'dsh')

const { __test } = await import('../host/phone.mjs')
const { startBridgeOnce, snapshot, detectBridgePort } = __test
const { pickActualPort } = await import('../host/phone.mjs')

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

// 端口被别的程序占着、顺延到 8900 的那套假环境
function startDeps({ writeOk = true, alt = 8900, healthy = true } = {}) {
  const calls = { writes: [], spawns: [], killed: [] }
  return {
    calls,
    deps: {
      health: async (_ms, port) => (healthy && Number(port) === alt ? { ok: true, port: Number(port), addresses: [] } : null),
      clearStale: async () => ({ state: 'foreign', pid: 4242, name: '别的程序' }),
      pickFreePort: async () => alt,
      listenerPid: async () => 5150,
      killPid: async (pid) => {
        calls.killed.push(pid)
        return true
      },
      writePortJson: (p) => {
        if (!writeOk) return false
        calls.writes.push(Number(p))
        return true
      },
      spawnBridgeDirect: async (port) => {
        calls.spawns.push(Number(port))
        return { ok: true, node: 'fake-node' }
      },
      runEnsureScript: async () => {},
      sleep: async () => {},
      bridgePort: () => 8899,
    },
  }
}

await ok('顺延成功且记录写下去了：不报 portWriteFailed', async () => {
  const { calls, deps } = startDeps()
  const r = await startBridgeOnce({ port: 8899, autoPort: true }, deps)
  assert(r.started === true && r.port === 8900 && r.portChanged === true, JSON.stringify(r))
  assert(r.portWriteFailed === undefined, '写成功了就不该报失败')
  assert(calls.writes.length === 1 && calls.writes[0] === 8900, `记录要写成 8900，实际 ${JSON.stringify(calls.writes)}`)
  assert(calls.killed.length === 1 && calls.killed[0] === 5150, '老端口上自己那个要先请下来')
})

await ok('顺延成功但记录写不进去：服务照样起，但必须如实说', async () => {
  const { deps } = startDeps({ writeOk: false })
  const r = await startBridgeOnce({ port: 8899, autoPort: true }, deps)
  assert(r.started === true && r.port === 8900, JSON.stringify(r))
  assert(r.portWriteFailed === true, 'record 没写成必须标出来，否则下次启动又搬回去')
  assert(/写不进 runtime\/port\.json/.test(r.warning || ''), `要给出可读的 warning：${r.warning}`)
  assert(/8899/.test(r.warning || '') && /8900/.test(r.warning || ''), 'warning 要同时说明现在在哪、下次可能回哪')
})

await ok('autoPort 关掉时：端口冲突原样报错，不出 warning 也不启动', async () => {
  const { calls, deps } = startDeps()
  const r = await startBridgeOnce({ port: 8899, autoPort: false }, deps)
  assert(r.started === false && r.conflict && r.conflict.pid === 4242, JSON.stringify(r))
  assert(calls.spawns.length === 0, '不该启动任何东西')
  assert(r.portWriteFailed === undefined, '没顺延就不该带这个字段')
})

await ok('pickActualPort：只认命令行像桥接、且不是记录里那个端口的监听', async () => {
  const rows = [
    { port: 8899, cmdline: 'node bridge/server.mjs' },
    { port: 8900, cmdline: 'node C:\\phone-bridge\\server.mjs' },
    { port: 8901, cmdline: 'node something-else.js' },
  ]
  assert(pickActualPort(rows, 8899) === 8900, '应当认出 8900')
  assert(pickActualPort(rows, 8900) === 8899, '记录是 8900 时应当认出 8899')
  assert(pickActualPort([{ port: 8901, cmdline: 'node x.js' }], 8899) === 0, '认不出就返回 0')
  assert(pickActualPort([], 8899) === 0, '空表返回 0')
  assert(pickActualPort(null, 8899) === 0, '非数组也不许抛')
})

await ok('detectBridgePort：探进程预算有限，认得出来就返回端口', async () => {
  const listeners = new Map([
    [8899, [1]],
    [8900, [5150]],
  ])
  const found = await detectBridgePort(8899, {
    netstatListeners: async () => listeners,
    procInfo: async (pid) => ({ name: 'node.exe', cmdline: pid === 5150 ? 'node server.mjs' : 'other.exe' }),
  })
  assert(found === 8900, `应当返回 8900，实际 ${found}`)
})

await ok('snapshot：记录过期但桥接真在别的端口时，如实报实际端口并标 portMismatch', async () => {
  const snap = await snapshot({
    health: async (_ms, port) => (Number(port) === 8900 ? { ok: true, mode: 'chat', addresses: [] } : null),
    detectBridgePort: async () => 8900,
  })
  assert(snap.running === true, '桥接其实在跑，不能报没运行')
  assert(snap.port === 8900, `要报实际端口，实际 ${snap.port}`)
  assert(snap.recordedPort === 8899 && snap.portMismatch === true, JSON.stringify({ p: snap.recordedPort, m: snap.portMismatch }))
})

await ok('snapshot：认不出来时仍按记录报「没运行」，不假装有服务', async () => {
  const snap = await snapshot({ health: async () => null, detectBridgePort: async () => 0 })
  assert(snap.running === false, '没有服务就该报没运行')
  assert(snap.port === 8899 && snap.portMismatch === false, JSON.stringify({ p: snap.port, m: snap.portMismatch }))
})

await (await import('node:fs/promises')).rm(home, { recursive: true, force: true }).catch(() => {})
console.log(
  `phone-port-sync ok · ${pass} 项断言 · 顺延报记录失败 / 冲突原样报错 / 认端口 / 探预算 / 状态对齐（${pass} 通过、${fail} 失败）`,
)
process.exit(fail > 0 ? 1 : 0)
