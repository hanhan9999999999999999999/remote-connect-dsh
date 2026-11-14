/**
 * dsh-remote-connect · 错误码到 HTTP 状态码的映射
 *
 * 一个错误码落到 500 意味着「服务端出了意外」，界面会把它当成故障；
 * 但「内容太大」「没连上」「参数不对」都是可操作的事，各有自己的状态码。
 */
import assert from 'node:assert/strict'
import { statusFor } from '../index.js'

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

console.log('http-status')

await ok('认证类错误是 401', () => {
  for (const code of ['BAD_PASSWORD', 'LOCKED_OUT', 'UNAUTHORIZED', 'SESSION_EXPIRED']) {
    assert.equal(statusFor(code), 401, code)
  }
})

await ok('没连上 / 端口被占 / 回滚无记录是 409', () => {
  for (const code of [
    'NOT_CONNECTED',
    'NEED_PASSWORD',
    'NO_PASSWORD',
    'PORT_IN_USE',
    'SYNC_BUSY',
    'NO_JOURNAL',
    'ALREADY_ROLLED_BACK',
  ]) {
    assert.equal(statusFor(code), 409, code)
  }
})

await ok('参数与内容不对是 400', () => {
  for (const code of ['BAD_INPUT', 'BAD_JSON', 'NO_HOST', 'METHOD', 'CATEGORY', 'PATH_ESCAPE', 'VERSION_MISMATCH']) {
    assert.equal(statusFor(code), 400, code)
  }
})

await ok('「太大」是 413，不是 500', () => {
  assert.equal(statusFor('TOO_LARGE'), 413)
  assert.equal(statusFor('BODY_TOO_LARGE'), 413)
})

await ok('对端的问题归 502，内容不对归 400，本地故障才归 500', () => {
  for (const code of ['NETWORK', 'TIMEOUT', 'NOT_DSH_LINK', 'BAD_RESPONSE', 'BAD_ENVELOPE']) {
    assert.equal(statusFor(code), 502, code)
  }
  // 哈希/大小不符是对面发来的内容不对（或者传到一半被截），不是本机出了意外：
  // 报 500 会让用户以为是自己这边坏了。
  for (const code of ['HASH_MISMATCH', 'SIZE_MISMATCH']) {
    assert.equal(statusFor(code), 400, code)
  }
  for (const code of ['READ_FAILED', 'CONFIG_BROKEN', 'CONFIG_UNREADABLE', 'BACKUP_FAILED']) {
    assert.equal(statusFor(code), 500, code)
  }
  assert.equal(statusFor(undefined), 500)
  assert.equal(statusFor('SOMETHING_NEW'), 500)
  assert.equal(statusFor(''), 500)
})

await ok('同一码不会因为大小写或空白改变', () => {
  assert.equal(statusFor('too_large'), 500, '错误码按原样匹配，不做大小写折叠')
  assert.equal(statusFor(' TOO_LARGE'), 500)
})

console.log(`http-status ok · 6 项断言 · 401 / 409 / 400 / 413 / 502 / 未知（${pass} 通过、${fail} 失败）`)
if (fail) process.exit(1)
