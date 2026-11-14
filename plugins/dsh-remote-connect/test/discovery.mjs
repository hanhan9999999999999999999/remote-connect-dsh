/**
 * dsh-remote-connect · 局域网发现的边界测试
 *
 * 发现走的是 UDP 广播：谁都能往这个端口发包，所以「不像话的回复」必须被丢掉，
 * 而不是变成一个 port 为 NaN 的对端条目。这里既测纯函数，也在本机真开端口跑一轮。
 */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { lanBroadcasts, broadcastOf, sanitizePeerReply, Discovery } from '../host/discovery.mjs'

const logger = { info() {}, warn() {}, error() {} }
let pass = 0
let fail = 0
const ok = async (label, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}：${err.message}`)
  }
}

/** 让系统挑一个空闲 UDP 端口再放掉，用它的号做测试端口。 */
async function freeUdpPort() {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  return port
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('discovery')

await ok('broadcastOf 按掩码算广播地址', () => {
  assert.equal(broadcastOf({ address: '192.168.1.10', netmask: '255.255.255.0' }), '192.168.1.255')
  assert.equal(broadcastOf({ address: '10.0.5.7', netmask: '255.255.0.0' }), '10.0.255.255')
  assert.equal(broadcastOf({ address: '172.16.3.4', netmask: '255.255.255.252' }), '172.16.3.7')
})

await ok('broadcastOf 对残缺输入返回 null', () => {
  assert.equal(broadcastOf({ address: '192.168.1.10' }), null)
  assert.equal(broadcastOf({ address: '192.168.1.10', netmask: '' }), null)
  assert.equal(broadcastOf({ address: 'fe80::1', netmask: '255.255.255.0' }), null)
  assert.equal(broadcastOf({ address: '192.168.1', netmask: '255.255.255.0' }), null)
})

await ok('lanBroadcasts 至少含全局广播且都是 IPv4', () => {
  const list = lanBroadcasts()
  assert.ok(list.includes('255.255.255.255'), '缺少 255.255.255.255')
  for (const item of list) {
    assert.match(item, /^\d{1,3}(\.\d{1,3}){3}$/, `不是 IPv4：${item}`)
  }
})

await ok('sanitizePeerReply 只放行形状正确的回复', () => {
  const good = sanitizePeerReply(
    { m: 'dsh-link/here', v: 1, id: 'abc', name: '楼上的电脑', port: 8089, platform: 'win32', version: '1.0.x' },
    { address: '192.168.1.9' },
  )
  assert.equal(good.id, 'abc')
  assert.equal(good.host, '192.168.1.9')
  assert.equal(good.port, 8089)
  assert.equal(good.name, '楼上的电脑')
  assert.ok(good.seenAt > 0)

  const bad = [
    null,
    {},
    { m: 'dsh-link/discover', v: 1, id: 'abc', port: 8089 }, // 不是回复
    { m: 'dsh-link/here', v: 2, id: 'abc', port: 8089 }, // 版本不对
    { m: 'dsh-link/here', v: 1, port: 8089 }, // 没有 id
    { m: 'dsh-link/here', v: 1, id: '', port: 8089 }, // id 是空串
    { m: 'dsh-link/here', v: 1, id: 'abc', port: 0 }, // 端口 0
    { m: 'dsh-link/here', v: 1, id: 'abc', port: 70000 }, // 端口越界
    { m: 'dsh-link/here', v: 1, id: 'abc', port: 'abc' }, // 端口不是数字
    { m: 'dsh-link/here', v: 1, id: 'abc', port: 8089.5 }, // 端口不是整数
  ]
  for (const item of bad) {
    assert.equal(sanitizePeerReply(item, { address: '192.168.1.9' }), null, `不该放行：${JSON.stringify(item)}`)
  }
  // 没有来源地址时也无法确定 host
  assert.equal(sanitizePeerReply({ m: 'dsh-link/here', v: 1, id: 'abc', port: 1 }, {}), null)

  // 超长字段会被截断，不会原样透传
  const long = sanitizePeerReply(
    { m: 'dsh-link/here', v: 1, id: 'x'.repeat(200), name: 'y'.repeat(200), port: 1, version: 'z'.repeat(200) },
    { address: '127.0.0.1' },
  )
  assert.equal(long.id.length, 64)
  assert.equal(long.name.length, 64)
  assert.equal(long.version.length, 24)
})

await ok('start() 应答合法探测、忽略垃圾包', async () => {
  const port = await freeUdpPort()
  const discovery = new Discovery({
    port,
    logger,
    getInfo: () => ({ id: 'dev-a', name: '本机', version: '9.9.9', platform: 'test' }),
  })
  assert.equal(await discovery.start(), true)
  try {
    const client = dgram.createSocket('udp4')
    const replies = []
    client.on('message', (msg) => replies.push(JSON.parse(msg.toString('utf8'))))
    await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve))
    const probe = Buffer.from(JSON.stringify({ m: 'dsh-link/discover', v: 1 }))
    client.send(probe, port, '127.0.0.1', () => {})
    client.send(Buffer.from('not json'), port, '127.0.0.1', () => {})
    client.send(Buffer.from(JSON.stringify({ m: 'dsh-link/discover', v: 9 })), port, '127.0.0.1', () => {})
    await sleep(400)
    await new Promise((resolve) => client.close(resolve))
    assert.equal(replies.length, 1, `应答条数应为 1，实际 ${replies.length}`)
    const reply = replies[0]
    assert.equal(reply.m, 'dsh-link/here')
    assert.equal(reply.v, 1)
    assert.equal(reply.id, 'dev-a')
    assert.equal(reply.port, port)
    assert.equal(reply.name, '本机')
    assert.equal(reply.version, '9.9.9')
  } finally {
    await discovery.stop()
  }
})

await ok('scan() 收到合规回复算一个对端，端口非法的丢掉', async () => {
  const responderPort = await freeUdpPort()
  const responder = dgram.createSocket('udp4')
  responder.on('message', (msg, rinfo) => {
    let data = null
    try {
      data = JSON.parse(msg.toString('utf8'))
    } catch {
      return
    }
    if (data?.m !== 'dsh-link/discover') return
    const here = (port) =>
      Buffer.from(
        JSON.stringify({ m: 'dsh-link/here', v: 1, id: 'fake-1', name: '假对端', port, platform: 'test', version: '1.2.3' }),
      )
    responder.send(here(responderPort), rinfo.port, rinfo.address, () => {})
    responder.send(here(0), rinfo.port, rinfo.address, () => {})
  })
  await new Promise((resolve) => responder.bind(responderPort, '127.0.0.1', resolve))
  try {
    const discovery = new Discovery({ port: responderPort, logger, getInfo: () => ({}) })
    const found = await discovery.scan({ timeoutMs: 900, extraHosts: ['127.0.0.1'] })
    const mine = found.filter((item) => item.id === 'fake-1')
    assert.equal(mine.length, 1, `应只剩一条合规条目，实际 ${mine.length}`)
    assert.equal(mine[0].host, '127.0.0.1')
    assert.equal(mine[0].port, responderPort)
    assert.equal(mine[0].name, '假对端')
    assert.ok(found.every((item) => item.port >= 1 && item.port <= 65535), '结果里不该有非法端口')
  } finally {
    await new Promise((resolve) => responder.close(resolve))
  }
})

await ok('scan() 遇到非法广播地址也不抛错', async () => {
  const discovery = new Discovery({ port: await freeUdpPort(), logger, getInfo: () => ({}) })
  const found = await discovery.scan({ timeoutMs: 300, extraHosts: ['999.999.999.999', '', 'localhost'] })
  assert.ok(Array.isArray(found))
})

console.log(`discovery ok · 7 项断言 · 广播 / 校验 / 应答 / 探测 / 容错（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
