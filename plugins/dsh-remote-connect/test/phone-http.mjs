#!/usr/bin/env node
/**
 * 手机通道的 HTTP 外壳：读请求体、状态码、找 node.exe、杀进程。
 *
 * 这几样过去只有「手点面板才知道对不对」的间接证明，其中读请求体那条是真 bug：
 * 超过 1e5 字符只 `req.destroy()`，'end' 不会再来，那个 promise 就永远挂着。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const mod = await import('../host/phone.mjs');
const { readJsonBody, startStatusFor, portStatusFor, resolveNodeCandidates, killPid } = mod.__test;

let pass = 0;
let fail = 0;
const results = [];
const expect = async (label, fn) => {
  try {
    await fn();
    pass += 1;
    results.push(`  PASS ${label}`);
  } catch (err) {
    fail += 1;
    results.push(`  FAIL ${label}\n       ${err && err.message}`);
  }
};

/** 造一个能喂数据的假 IncomingMessage。 */
const req = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

/** 带超时地等一个 promise —— 卡死本身就是这条测试要抓的毛病。 */
const within = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms 还没结果（挂住了）`)), ms).unref?.()),
  ]);

/* ---------- 1. 读请求体 ---------- */
await expect('合法 JSON 对象', async () => {
  const r = await within(readJsonBody(req('{"port":','8899}')), 2000, 'readJsonBody');
  assert.deepEqual(r, { ok: true, body: { port: 8899 } });
});

await expect('空体当 {}', async () => {
  const r = await within(readJsonBody(req()), 2000, 'readJsonBody');
  assert.deepEqual(r, { ok: true, body: {} });
});

await expect('数组与标量都不算对象', async () => {
  assert.deepEqual(await readJsonBody(req('[1,2]')), { ok: false, code: 'BAD_JSON' });
  assert.deepEqual(await readJsonBody(req('"just a string"')), { ok: false, code: 'BAD_JSON' });
  assert.deepEqual(await readJsonBody(req('42')), { ok: false, code: 'BAD_JSON' });
});

await expect('半截 JSON → BAD_JSON', async () => {
  assert.deepEqual(await readJsonBody(req('{"a":')), { ok: false, code: 'BAD_JSON' });
});

await expect('超过上限会回话，不会挂住', async () => {
  const big = 'x'.repeat(120 * 1024);
  const r = await within(readJsonBody(req('{"pad":"', big, '"}')), 2000, '超大请求体');
  assert.deepEqual(r, { ok: false, code: 'BODY_TOO_LARGE' });
});

await expect('超限后继续读也不会变成 BAD_JSON', async () => {
  const big = 'y'.repeat(200 * 1024);
  const r = await within(readJsonBody(req(big, big.slice(0, 10))), 2000, '连续超大块');
  assert.equal(r.code, 'BODY_TOO_LARGE');
});

/* ---------- 2. 状态码 ---------- */
await expect('启动：成功 / 端口被占 / 还在起', async () => {
  assert.equal(startStatusFor({ started: true }), 200);
  assert.equal(startStatusFor({ started: false, conflict: { port: 8899 } }), 409);
  assert.equal(startStatusFor({ started: false, starting: true }), 504);
  assert.equal(startStatusFor(null), 504);
});

await expect('换端口：成功 / 被占 / 参数不对', async () => {
  assert.equal(portStatusFor({ switched: true }), 200);
  assert.equal(portStatusFor({ switched: false, conflict: { port: 9000 } }), 409);
  assert.equal(portStatusFor({ switched: false, error: '端口要填 1024–65535 之间的整数' }), 400);
  assert.equal(portStatusFor(undefined), 400);
});

/* ---------- 3. 找 node.exe ---------- */
await expect('DSH_HOME 优先于 ~/.dsh', async () => {
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(os.tmpdir(), 'rc-fake-dsh-home');
  try {
    const list = resolveNodeCandidates();
    const first = list[0].split(path.sep).join('/');
    assert.ok(first.startsWith('rc-fake-dsh-home') || first.includes('/rc-fake-dsh-home/'), `首个候选应落在 DSH_HOME 下，实得 ${list[0]}`);
    assert.ok(first.endsWith('dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'));
    assert.equal(list.filter((p) => p !== 'node.exe').some((p) => p.includes(`${path.sep}.dsh${path.sep}`)), true);
  } finally {
    if (before === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before;
  }
});

await expect('最后一定回落到 PATH 里的 node.exe', async () => {
  assert.equal(resolveNodeCandidates().at(-1), 'node.exe');
});

/* ---------- 4. 杀进程 ---------- */
await expect('没有 pid 就返回 false', async () => {
  assert.equal(await killPid(0), false);
  assert.equal(await killPid(null), false);
});

await expect('非 Windows 不去 spawn taskkill', async () => {
  const r = await within(killPid(999999), 2000, 'killPid');
  if (process.platform === 'win32') assert.equal(typeof r, 'boolean');
  else assert.equal(r, false);
});

results.forEach((line) => console.log(line));
console.log(
  `phone-http ok · ${pass + fail} 项断言 · 请求体 / 状态码 / node 候选 / 杀进程（${pass} 通过、${fail} 失败）`,
);
if (fail) process.exitCode = 1;
