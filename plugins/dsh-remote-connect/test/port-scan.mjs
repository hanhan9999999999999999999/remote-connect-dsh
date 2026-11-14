/**
 * 端口窥探层的测试：主要盯 `parseNetstat` 这个纯函数。
 *
 * 拆出 `host/port-scan.mjs` 的最大理由就是它——以前这段解析混在启停编排里，
 * 想测就得真的起一个 netstat 进程；现在喂字符串就能断言。
 * 另外几条断言盯缓存与端口挑选的边界（这些会真的碰系统，所以只做不会出事的用法）。
 */
import assert from 'node:assert/strict';

const { parseNetstat, isBridgeCmd, pickFreePort, listenerPids, invalidateNetstat } = await import(
  '../host/port-scan.mjs'
);

let pass = 0;
const ok = async (label, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS ${label}`);
  } catch (e) {
    console.log(`  FAIL ${label}`);
    throw e;
  }
};

/* 1. 标准输出：IPv4 / IPv6 / 通配地址都要认，UDP 与 ESTABLISHED 不要 ---------- */

const sample = [
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:8899           0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:8899         0.0.0.0:0              LISTENING       777',
  '  TCP    [::]:8899              [::]:0                 LISTENING       4242',
  '  TCP    192.168.1.9:52000      93.184.216.34:443      ESTABLISHED     9001',
  '  UDP    0.0.0.0:5353           *:*                                    1234',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000',
  '',
].join('\r\n');

await ok('解析出两个被监听的端口', () => {
  const map = parseNetstat(sample);
  assert.deepEqual([...map.keys()].sort((a, b) => a - b), [135, 8899]);
});

await ok('同一个端口有多个 pid 时全部收集、且去重', () => {
  const map = parseNetstat(sample);
  assert.deepEqual(map.get(8899), [4242, 777]);
  assert.deepEqual(map.get(135), [1000]);
});

await ok('UDP 与 ESTABLISHED 不算监听', () => {
  const map = parseNetstat(sample);
  assert.equal(map.has(5353), false);
  assert.equal(map.has(52000), false);
});

await ok('pid 为 0 或端口为 0 的脏行丢掉', () => {
  const dirty = ['  TCP    0.0.0.0:0              0.0.0.0:0              LISTENING       0'].join('\n');
  assert.equal(parseNetstat(dirty).size, 0);
});

await ok('空输入不炸', () => {
  assert.equal(parseNetstat('').size, 0);
  assert.equal(parseNetstat(null).size, 0);
  assert.equal(parseNetstat(undefined).size, 0);
});

/* 2. 认领自己的桥接：只认 phone-bridge 的 server.mjs ------------------------- */

await ok('server.mjs 的几种写法都认', () => {
  assert.equal(isBridgeCmd('node D:\\x\\phone-bridge\\server.mjs --port 8899'), true);
  assert.equal(isBridgeCmd('/usr/local/bin/node /srv/phone-bridge/SERVER.MJS'), true);
});

await ok('别的程序一律不认', () => {
  assert.equal(isBridgeCmd('node C:\\app\\index.js'), false);
  assert.equal(isBridgeCmd('powershell.exe -File ensure-running.ps1'), false);
  assert.equal(isBridgeCmd(''), false);
  assert.equal(isBridgeCmd(null), false);
});

/* 3. 真实环境：缓存与端口挑选（只读，不会动任何进程） ----------------------- */

const netstat = await import('../host/port-scan.mjs');

await ok('netstatListeners 返回 Map，缓存生效后在有效期内复用同一个对象', async () => {
  invalidateNetstat();
  const a = await netstat.netstatListeners();
  const b = await netstat.netstatListeners();
  assert.ok(a instanceof Map);
  assert.equal(a, b, '2 秒缓存应该在有效期内返回同一个 Map 实例');
});

await ok('listenerPids 对一个没人用的高端口返回空数组', async () => {
  const pids = await listenerPids(1);
  assert.ok(Array.isArray(pids));
  assert.equal(pids.length, 0);
});

// 下面这条要在真有 netstat 的机器上才有意义（CI 的 ubuntu 作业也会跑这个文件）
if (process.platform === 'win32') {
  await ok('pickFreePort 挑出的端口确实不在监听表里', async () => {
    const port = await pickFreePort(65000);
    assert.ok(port === 0 || (port >= 65000 && port <= 65060));
    if (port) {
      const map = await netstat.netstatListeners();
      assert.equal(map.has(port), false);
    }
  });
} else {
  await ok('非 Windows 上直接回落空表，不反复起进程', async () => {
    invalidateNetstat();
    const map = await netstat.netstatListeners();
    assert.equal(map.size, 0);
  });
}

console.log(`port ok · ${pass} 项断言 · 解析 / 认领 / 缓存 / 挑端口（${process.platform}）`);
