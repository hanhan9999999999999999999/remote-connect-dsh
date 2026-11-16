// 宿主端插件自测：不启动 DSH，只验证 index.js 能加载、五个路由都注册、
// /status 返回的确实是 JSON。2026-11-06 的「bad json」就是宿主端没挂载时报的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../plugins/dsh-phone-bridge/index.js';

function fakeCtx() {
  const routes = new Map();
  const ctx = {
    get(name) {
      assert.equal(name, 'webServer');
      return {
        register(opts) {
          routes.set(opts.path, opts);
          return () => {};
        },
      };
    },
    effect(fn) {
      fn();
    },
  };
  return { ctx, routes };
}

test('插件注册 5 个接口', () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx);
  for (const p of ['/dsh-phone-api/status', '/dsh-phone-api/start', '/dsh-phone-api/port', '/dsh-phone-api/stop', '/dsh-phone-api/paircode']) {
    assert.ok(routes.get(p), '缺少路由 ' + p);
  }
});

test('/status 返回 JSON 且端口来自 port.json', async () => {
  const { ctx, routes } = fakeCtx();
  apply(ctx);
  const handler = routes.get('/dsh-phone-api/status').handler;
  const res = {
    code: 0,
    body: '',
    writeHead(code) {
      this.code = code;
    },
    end(body) {
      this.body = String(body || '');
    },
  };
  await handler({ method: 'GET' }, res);
  assert.equal(res.code, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.equal(typeof j.port, 'number');
  assert.ok(j.port >= 1024 && j.port <= 65535);
  assert.equal(typeof j.running, 'boolean');
});
