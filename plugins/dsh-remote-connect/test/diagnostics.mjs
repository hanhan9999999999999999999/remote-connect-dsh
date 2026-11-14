#!/usr/bin/env node
/**
 * 诊断里的「可用磁盘」必须看同步真正写入的那块盘。
 *
 * 以前看的是 `os.homedir()`：DSH_HOME 搬到 D: 以后，设置页会拿 C: 的余量
 * 去报告 D: 的状态，用户以为还有几十 GB，结果下一个大文件就失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-diag-'))
fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
fs.mkdirSync(path.join(home, 'plugins'), { recursive: true })
process.env.DEVICE_LINK_DSH_HOME = home

const { LinkService } = await import('../host/service.mjs')

let pass = 0
let fail = 0
const expect = (label, fn) => {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass += 1
    console.log(`PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`FAIL ${label}: ${err.message}`)
  }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const cfg = {
  auth: { password: 'ABCD-EFGH-JKLM' },
  server: { port: 8788, enabled: true },
  sync: { maxFileMb: 64, maxTotalMb: 64, includeCredentials: true },
  device: { id: 'dev_test', name: 'node-T' },
}
// init() 里会 store.load()，两个入口都给同一份配置
const store = { load: async () => cfg, get: async () => cfg }

const svc = new LinkService({ logger: quiet, store })

let seenDir = null
svc.freeSpaceAt = async (dir) => {
  seenDir = dir
  return 5 * 1024 ** 3
}

const diag = await svc.diagnostics()
const disk = diag.checks.find((c) => c.id === 'disk')
const humanBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(1)} ${units[i]}`
}

expect('磁盘探测用的是 DSH 数据目录，不是用户主目录', () => seenDir === path.resolve(home))
expect('结果里写着这块盘的位置', () => disk.detail.includes(home))
expect('余量按人类可读单位展示', () => disk.detail.includes(humanBytes(5 * 1024 ** 3)))
expect('充足时状态是 ok', () => disk.status === 'ok')

svc.freeSpaceAt = async () => 512 * 1024 ** 2
const diag2 = await svc.diagnostics()
const disk2 = diag2.checks.find((c) => c.id === 'disk')
expect('不足 2 GB 时降级为 warn', () => disk2.status === 'warn')

svc.freeSpaceAt = async () => null
const diag3 = await svc.diagnostics()
const disk3 = diag3.checks.find((c) => c.id === 'disk')
expect('探测不到时标 warn 并说明位置', () => disk3.status === 'warn' && disk3.detail.includes(home))

expect('env 里同时给出 dshHome 与版本', () => diag3.env.dshHome === path.resolve(home) && typeof diag3.env.version === 'string')

void cfg
fs.rmSync(home, { recursive: true, force: true })

console.log(
  `diagnostics ok · ${pass + fail} 项断言 · 看对盘 / 位置 / 单位 / 阈值 / 探测失败（${pass} 通过、${fail} 失败）`,
)
// LinkService.init() 会建好 server/applier，可能留着句柄；测完直接退出，别让 runner 挂住
process.exit(fail > 0 ? 1 : 0)
