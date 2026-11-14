/**
 * dsh-remote-connect · 配置的读、迁移与校验
 *
 * 配置是手会去改的文件：少了字段、写成字符串、数字超出范围、甚至被编辑器截断成半截 JSON。
 * 这些都不该让插件起不来，更不该悄悄把主人的连接密码覆盖掉。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-config-'))
let counter = 0
const freshDir = async () => {
  counter += 1
  const dir = path.join(root, `case-${counter}`)
  await fs.mkdir(dir, { recursive: true })
  process.env.DEVICE_LINK_HOME = dir
  return dir
}

const { ConfigStore, DEFAULT_PORT, buildConnectUri, configPath, parseConnectUri } = await import('../host/config.mjs')

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

console.log('config')

await ok('第一次运行生成完整配置，密码形状正确', async () => {
  await freshDir()
  const store = new ConfigStore()
  const cfg = await store.load()
  assert.equal(cfg.version, 1)
  assert.equal(cfg.server.port, DEFAULT_PORT)
  assert.equal(cfg.server.enabled, true)
  assert.match(cfg.auth.password, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.ok(Buffer.from(cfg.auth.salt, 'base64').length === 16)
  assert.equal(cfg.auth.kdf.N, 16384)
  assert.equal(cfg.sync.categories['plugin-data'], false)
  assert.equal(cfg.sync.maxTotalMb, 8192)
  assert.match(cfg.device.id, /^dev_[0-9a-z]+$/)
  const onDisk = JSON.parse(await fs.readFile(configPath(), 'utf8'))
  assert.equal(onDisk.auth.password, cfg.auth.password)
})

await ok('JSON 被改坏时报错，而且不覆盖原文件', async () => {
  const dir = await freshDir()
  const file = path.join(dir, 'config.json')
  const broken = '{ "version": 1, "auth": { "password": "keep-me'
  await fs.writeFile(file, broken, 'utf8')
  const store = new ConfigStore()
  await assert.rejects(
    () => store.load(),
    (err) => {
      assert.equal(err.code, 'CONFIG_BROKEN')
      assert.match(err.message, /不是合法 JSON/)
      assert.match(err.message, /没有覆盖/)
      return true
    },
  )
  assert.equal(await fs.readFile(file, 'utf8'), broken, '原文件必须原样留着')
})

await ok('JSON 是合法但不是对象时也拒绝，不覆盖', async () => {
  const dir = await freshDir()
  const file = path.join(dir, 'config.json')
  await fs.writeFile(file, '[1,2,3]', 'utf8')
  const store = new ConfigStore()
  await assert.rejects(() => store.load(), (err) => err.code === 'CONFIG_BROKEN')
  assert.equal(await fs.readFile(file, 'utf8'), '[1,2,3]')
})

await ok('手改坏的类型/范围在读入时被收回来', async () => {
  const dir = await freshDir()
  const file = path.join(dir, 'config.json')
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 0,
      device: { id: '', name: '', platform: 42 },
      server: { port: 'abc', enabled: 'false', discovery: 0, bind: '' },
      auth: { password: 'short', salt: 'not-base64', kdf: { N: 999, r: 999, p: 0 } },
      sync: { maxFileMb: -3, maxTotalMb: 'lots', backupKeep: 999, categories: { skills: 'false', bogus: true } },
      ui: { language: 'fr', lastTab: '' },
    }),
    'utf8',
  )
  const cfg = await new ConfigStore().load()
  assert.equal(cfg.version, 1)
  assert.match(cfg.device.id, /^dev_/)
  assert.ok(cfg.device.name.length > 0)
  assert.equal(typeof cfg.device.platform, 'string')
  assert.equal(cfg.server.port, DEFAULT_PORT, '端口非法时回默认值')
  assert.equal(cfg.server.enabled, false, "'false' 应当被认成 false")
  assert.equal(cfg.server.discovery, false)
  assert.equal(cfg.server.bind, '0.0.0.0')
  assert.equal(cfg.auth.kdf.N, 16384, 'N 必须是 2 的幂，999 不算')
  assert.equal(cfg.auth.kdf.r, 32)
  assert.equal(cfg.auth.kdf.p, 1)
  assert.ok(Buffer.from(cfg.auth.salt, 'base64').length === 16)
  assert.equal(cfg.sync.maxFileMb, 1)
  assert.equal(cfg.sync.maxTotalMb, 8192)
  assert.equal(cfg.sync.backupKeep, 50)
  assert.equal(cfg.sync.categories.skills, false)
  assert.equal('bogus' in cfg.sync.categories, false, '不认识的分类不该被记住')
  assert.equal(cfg.ui.language, 'zh')
  assert.equal(cfg.ui.lastTab, 'overview')
  // 收回来之后要落盘，下次读到的就是干净的
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.server.port, DEFAULT_PORT)
})

await ok('patch 会夹住范围，也不接受未知分类', async () => {
  await freshDir()
  const store = new ConfigStore()
  await store.load()
  let cfg = await store.patch({
    server: { port: 22 },
    sync: { maxTotalMb: 0, backupKeep: 999, maxFileMb: 100000, categories: { skills: false, bogus: true } },
    ui: { language: 'en-US-not-valid', lastTab: 'x'.repeat(80) },
  })
  assert.equal(cfg.server.port, 1024, '端口低于 1024 抬到 1024')
  assert.equal(cfg.sync.maxTotalMb, 1)
  assert.equal(cfg.sync.backupKeep, 50)
  assert.equal(cfg.sync.maxFileMb, 65536)
  assert.equal(cfg.sync.categories.skills, false)
  assert.equal('bogus' in cfg.sync.categories, false)
  assert.equal(cfg.ui.language, 'en-US-no', '语言截到 8 个字符')
  assert.equal(cfg.ui.lastTab.length, 32)
  cfg = await store.patch({ server: { port: 70000 } })
  assert.equal(cfg.server.port, 65535)
})

await ok('密码太短报 BAD_INPUT，正常改密码会换 salt', async () => {
  await freshDir()
  const store = new ConfigStore()
  const before = await store.load()
  await assert.rejects(
    () => store.setPassword('123'),
    (err) => {
      assert.equal(err.code, 'BAD_INPUT')
      assert.match(err.message, /至少 6 位/)
      return true
    },
  )
  const after = await store.setPassword('my-own-passphrase')
  assert.equal(after.auth.password, 'my-own-passphrase')
  assert.notEqual(after.auth.salt, before.auth.salt)
  assert.ok(after.auth.changedAt >= before.auth.changedAt)
})

await ok('连接串能生成也能解析回来', async () => {
  await freshDir()
  const store = new ConfigStore()
  const cfg = await store.load()
  const uri = buildConnectUri(cfg, '192.168.1.5')
  const parsed = parseConnectUri(uri)
  assert.equal(parsed.host, '192.168.1.5')
  assert.equal(parsed.port, cfg.server.port)
  assert.equal(parsed.password, cfg.auth.password)
  assert.equal(parsed.name, cfg.device.name)
})

await ok('坏的连接串给出可读提示', async () => {
  for (const [value, pattern] of [
    ['', /为空/],
    ['http://1.2.3.4:8788', /dshlink:\/\//],
    ['dshlink://', /没有主机地址|格式不对/],
    ['dshlink://h:99999', /端口不对|格式不对/],
  ]) {
    await assert.rejects(
      () => Promise.resolve().then(() => parseConnectUri(value)),
      (err) => {
        assert.equal(err.code, 'BAD_INPUT', `${value} 应当是 BAD_INPUT`)
        assert.match(err.message, pattern)
        return true
      },
    )
  }
})

console.log(`config ok · 8 项断言 · 首启 / 坏文件 / 类型回收 / 范围 / 密码 / 连接串（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
