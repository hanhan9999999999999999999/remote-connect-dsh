// 肥鱼端点解析 + 「端口被别的程序占用」识别。
//
// 背景：8898 是热门端口。本机 DSH Live2D 的 mini-bridge 就长期占着它，
// 它也会对 /health 回一个 JSON（{ok:false,error:"没有这个接口"}）。
// 旧代码把任何 JSON 都当成肥鱼在加载中，于是体检把「端口被占」误诊成「模型没起来」。
//
// 这份测试锁住三件事：
//   1. 地址按 PHONE_FEIYU_URL > service.json 的 port > 8898 解析，服务换端口能跟上；
//   2. 只有带肥鱼身份的 /health 才算肥鱼（旧版没有 service 字段时按形状兼容）；
//   3. 碰到别的程序的 /health，返回 foreign，而不是 ready:false。
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-endpoint-'));
const stateFile = path.join(dir, 'service.json');
process.env.PHONE_FEIYU_STATE = stateFile;
delete process.env.PHONE_FEIYU_URL;

const tts = await import('../tts.mjs');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

let tick = 0;
function writeState(obj) {
  fs.writeFileSync(stateFile, JSON.stringify(obj));
  // mtime 是缓存键：连续写入可能落在同一毫秒，往前拨一点保证「服务换端口」一定被看见。
  const at = new Date(Date.now() + (++tick) * 1000);
  fs.utimesSync(stateFile, at, at);
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function close(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

console.log('--- 端点解析 ---');
await t('没有 state 时回落到默认 8898', () => {
  try { fs.unlinkSync(stateFile); } catch {}
  eq(tts.feiyuUrl(), 'http://127.0.0.1:8898');
});

await t('state 里写了端口就用它', () => {
  writeState({ pid: 4242, port: 8903, token: 'abc' });
  eq(tts.feiyuUrl(), 'http://127.0.0.1:8903');
  eq(tts.feiyuServiceState().token, 'abc');
});

await t('服务换端口后不用重启桥就能跟上', () => {
  writeState({ pid: 4243, port: 8907, token: 'def' });
  eq(tts.feiyuUrl(), 'http://127.0.0.1:8907');
  eq(tts.feiyuServiceState().token, 'def');
});

await t('PHONE_FEIYU_URL 优先，且去掉尾部斜杠', () => {
  process.env.PHONE_FEIYU_URL = 'http://127.0.0.1:9999/';
  eq(tts.feiyuUrl(), 'http://127.0.0.1:9999');
  delete process.env.PHONE_FEIYU_URL;
  eq(tts.feiyuUrl(), 'http://127.0.0.1:8907');
});

console.log('--- /health 身份校验 ---');
await t('带 service 字段：认', () => {
  eq(tts.isFeiyuHealth({ ok: true, service: 'feiyu-tts', ready: true, styles: [] }), true);
});
await t('旧版只有 ready/styles：兼容', () => {
  eq(tts.isFeiyuHealth({ ok: true, ready: false, styles: [] }), true);
});
await t('别的程序的错误 JSON：不认', () => {
  eq(tts.isFeiyuHealth({ ok: false, error: '没有这个接口' }), false);
  eq(tts.isFeiyuHealth(null), false);
  eq(tts.isFeiyuHealth({ ok: true }), false);
});

console.log('--- feiyuHealth 实测 ---');
await t('端口被别的程序占用 → foreign，而不是 ready:false', async () => {
  const { srv, port } = await listen((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '没有这个接口' }));
  });
  try {
    writeState({ pid: 1, port, token: 'x' });
    const r = await tts.feiyuHealth(1200);
    eq(r.ok, false);
    eq(r.foreign, true);
    assert.ok(/被其他程序占用/.test(r.error), r.error);
  } finally { await close(srv); }
});

await t('真正的肥鱼 /health → ok，并带上端口', async () => {
  const { srv, port } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, service: 'feiyu-tts', ready: true, loading: false,
      style: 'cute', styles: [{ id: 'cute', label: '可爱' }], version: '1.2.0',
    }));
  });
  try {
    writeState({ pid: 2, port, token: 'y' });
    const r = await tts.feiyuHealth(1200);
    eq(r.ok, true);
    eq(r.ready, true);
    eq(r.port, port);
    eq(r.styles.length, 1);
    // 服务端不一定带 styleLabel（旧版没有），桥要能从 styles 里补出来
    eq(r.styleLabel, '可爱');
  } finally { await close(srv); }
});

await t('服务没起来 → ok:false 且不是 foreign', async () => {
  writeState({ pid: 3, port: 9, token: 'z' }); // 9 号端口不会有肥鱼
  const r = await tts.feiyuHealth(400);
  eq(r.ok, false);
  eq(!!r.foreign, false);
});

console.log(`\n合计 ${pass} 过 / ${fail} 挂`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
// 不用 process.exit：Windows 上 undici 的 keep-alive 句柄还在关闭中时强退，
// 会触发 libuv 的 UV_HANDLE_CLOSING 断言（测试明明是过的，输出却像崩了）。
process.exitCode = fail ? 1 : 0;
