#!/usr/bin/env node
/**
 * hosttest.mjs — 用一个假的宿主把插件跑一遍，**不用重启 DSH**。
 *
 * 为什么要有这一层：插件接进 DSH 之后，任何错误都会变成"模型那边好像不太对"。
 * 这里用假宿主把 `apply()`、工具注册、返回值形状、附件上传、叫醒投递全走一遍，
 * 出的问题在这里就是一句话的报错，而不是一段玄学。
 *
 *   node scripts/hosttest.mjs            # 全部（含真摄像头，约 15 秒）
 *   node scripts/hosttest.mjs --no-cam   # 只验注册与契约，不碰硬件
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveFfmpeg } from '../src/binaries.js';
import { apply } from '../src/index.js';
import { TOOL_NAME } from '../src/tool-spec.js';
import { createWatcher } from '../src/loop.js';

const noCam = process.argv.includes('--no-cam');
let fails = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails += 1; console.log(`  ✗ ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/** 返回值必须是 lossless JSON —— host 遇到 undefined/NaN 会直接判失败。 */
function lossless(v, path = 'value') {
  if (v === undefined) return `${path} 是 undefined`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} 不是有限数（${v}）`;
  if (v === null || typeof v !== 'object') return null;
  if (v instanceof Uint8Array) return `${path} 是二进制（不该进返回值）`;
  for (const [k, x] of Object.entries(v)) {
    const r = lossless(x, `${path}.${k}`);
    if (r) return r;
  }
  return null;
}

// ── 假宿主 ──────────────────────────────────────────────
const registered = [];
const images = [];
const wakes = [];
const handlers = new Map();
const routes = [];
const SESSION = 'sess-hosttest';

// 配置写进临时目录：这个测试会 POST /config，绝不能碰真实 $DSH_HOME/see-world.json
const HOME = mkdtempSync(join(tmpdir(), 'see-world-hosttest-'));
const REAL_DSH_HOME = process.env.DSH_HOME || 'D:\\dsh-home';
process.env.DSH_HOME = HOME;

// DSH_HOME 被挪到临时目录后，$DSH_HOME/tools/ffmpeg/bin 这条查找链就断了。
// 真机上有装好的那份就直接指给它，否则沿用调用者给的 DSH_FFMPEG_PATH。
if (!process.env.DSH_FFMPEG_PATH && !process.env.FFMPEG_PATH) {
  const installed = join(REAL_DSH_HOME, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (existsSync(installed)) process.env.DSH_FFMPEG_PATH = installed;
}

const ctx = {
  get(key) {
    if (key === 'tools') return { register: (t) => { registered.push(t); return () => {}; } };
    if (key === 'attachments') {
      return {
        async saveImage({ data, mediaType, name }) {
          const ref = { ref: `att-${images.length}`, name, mediaType, bytes: data.length };
          images.push(ref);
          return ref;
        },
      };
    }
    if (key === 'sessionController') {
      return {
        async resolveAgent(id) {
          if (String(id).startsWith('missing')) return { error: { message: 'no such session' } };
          return {
            agent: {
              session: { header: { id } },
              status: 'idle',
              followup: (m) => wakes.push({
                sessionId: id,
                text: m?.content?.find((b) => b.type === 'text')?.text,
                images: m?.content?.filter((b) => b.type === 'image')?.length ?? 0,
                source: m?.source?.kind,
                role: m?.role,
              }),
              steer: (m) => wakes.push({ sessionId: id, text: m?.content?.[0]?.text, via: 'steer' }),
            },
          };
        },
      };
    }
    return null;
  },
  on(evt, fn) { handlers.set(evt, fn); },
  /** webServer 是可选服务：插件必须走 inject 拿，这里模拟"晚挂载"。 */
  inject(names, cb) {
    if (!names.includes('webServer')) return;
    const scoped = {
      effect: (fn) => { const d = fn(); return d; },
      webServer: {
        register: (spec) => { routes.push(spec); return () => {}; },
      },
      get: (k) => (k === 'connection' ? null : ctx.get(k)),
    };
    cb(scoped);
  },
};

/** 打一条假请求进路由 handler。 */
function callRoute(spec, { method = 'GET', path = '/status', headers = { host: '127.0.0.1:56149' }, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 0, headers: {}, chunks: [] };
    const req = {
      method,
      url: `/api/see-world${path}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== null) yield Buffer.from(JSON.stringify(body));
      },
    };
    const res = {
      writeHead(status, h) { out.status = status; Object.assign(out.headers, h ?? {}); },
      end(buf) {
        if (buf) out.chunks.push(Buffer.from(buf));
        out.body = Buffer.concat(out.chunks);
        resolve(out);
      },
    };
    Promise.resolve(spec.handler(req, res)).catch(reject);
  });
}

function jsonOf(out) {
  try { return JSON.parse(out.body.toString('utf8')); } catch { return null; }
}

/**
 * 实时预览是长连接：它不是"一个请求一个响应"，而是 handler 挂住、一直往 res 里写。
 * 所以这里单独造一个会收集 write 的假 res，收到几段就收工。
 */
function runStream(spec, { path = '/stream?w=320&fps=10', wantParts = 4, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 0, headers: {}, chunks: [], done: false };
    const req = {
      method: 'GET',
      url: `/api/see-world${path}`,
      headers: { host: '127.0.0.1:56149' },
      on() {}, once() {},
    };
    const finish = () => {
      if (out.done) return;
      out.done = true;
      clearTimeout(timer);
      out.body = Buffer.concat(out.chunks);
      resolve(out);
    };
    const res = {
      writableEnded: false,
      destroyed: false,
      writableLength: 0,
      writeHead(status, h) { out.status = status; Object.assign(out.headers, h ?? {}); },
      write(buf) { out.chunks.push(Buffer.from(buf)); if (out.chunks.length >= wantParts) finish(); return true; },
      end() { out.ended = true; finish(); },
      on() {}, once() {},
    };
    const timer = setTimeout(finish, timeoutMs);
    Promise.resolve(spec.handler(req, res)).catch(reject);
  });
}

const run = { agent: { session: { header: { id: SESSION } } }, invocation: { delegationDepth: 0 } };

console.log('1) 注册');
await apply(ctx);
check(registered.length === 1, `注册了 1 个工具（实际 ${registered.length}）`);
const tool = registered[0];
check(tool?.name === TOOL_NAME, `工具名 = ${TOOL_NAME}`);
check(typeof tool?.execute === 'function' && typeof tool?.handler === 'function', 'execute / handler 都在');
check(tool?.timeoutMs === 900_000, `timeoutMs = ${tool?.timeoutMs}`);
check(tool?.isConcurrencySafe?.() === false, 'isConcurrencySafe() = false');

console.log('2) 参数契约');
const inSchema = tool?.inputSchema ?? {};
check(inSchema.type === 'object', 'inputSchema.type = object');
check(inSchema.properties && Object.keys(inSchema.properties).length >= 5, `inputSchema 属性 ${Object.keys(inSchema.properties ?? {}).length} 个`);
check((inSchema.required ?? []).includes('action'), 'inputSchema.required 含 action');
check(inSchema.properties?.action?.required === undefined, '属性里的 required 已提升到父级');
const outSchema = tool?.outputSchema ?? {};
check((outSchema.required ?? []).includes('text'), 'outputSchema.required 含 text');
check(!JSON.stringify(inSchema).includes('"type":"json"'), 'inputSchema 里没有非法的 type:json');

console.log('3) 无硬件动作');
for (const action of ['help', 'status']) {
  const r = await tool.execute({ action }, run);
  const err = lossless(r);
  check(!err, `${action} 返回值 lossless${err ? `（${err}）` : ''}`);
  check(typeof r.text === 'string' && r.text.length > 10, `${action} 有文字（${r.text.length} 字符）`);
}

const devices = await tool.execute({ action: 'devices' }, run);
check(!lossless(devices), 'devices 返回值 lossless');
check(typeof devices.text === 'string' && devices.text.length > 0, `devices 有文字：${devices.text.split('\n')[0]}`);

if (!noCam) {
  console.log('4) 真摄像头');
  const look = await tool.execute({ action: 'look', seconds: 2, frames: 4 }, run);
  check(!lossless(look), 'look 返回值 lossless');
  check(Array.isArray(look.images) && look.images.length === 1, `look 附了 ${look.images?.length} 张图`);
  check(images.length >= 1 && images[0].bytes > 20_000, `图有实际内容（${images[0]?.bytes} 字节）`);
  const rendered = tool.output.render({ action: 'look' }, look);
  check(rendered[0]?.type === 'image' && rendered[1]?.type === 'text', 'render() 先图后文');
  console.log(`    结果摘要：${look.text.split('\n').slice(0, 3).join(' / ')}`);

  const peek = await tool.execute({ action: 'peek' }, run);
  check(!lossless(peek), 'peek 返回值 lossless');
  ok(`peek：${peek.text.split('\n')[0]}`);

  const watch = await tool.execute({ action: 'watch', seconds: 3 }, run);
  check(!lossless(watch), 'watch 返回值 lossless');
  check(Array.isArray(watch.images) && watch.images.length === 1, `watch 附了 ${watch.images?.length} 张图`);
  console.log(`    ${String(watch.text).split('\n')[0]}`);

  const still = await tool.execute({ action: 'snapshot' }, run);
  check(!lossless(still), 'snapshot 返回值 lossless');
  check(Array.isArray(still.images) && still.images.length === 1, `snapshot 附了 ${still.images?.length} 张图`);

  const st = await tool.execute({ action: 'status' }, run);
  check(!lossless(st), 'status（跑过之后）lossless');
  console.log(`    ${String(st.text).split('\n').slice(0, 3).join('\n    ')}`);

  const stop = await tool.execute({ action: 'stop' }, run);
  check(!lossless(stop), 'stop 返回值 lossless');
}

console.log('5) 叫醒投递');
{
  // 上一段真摄像头的 watch 会留下一个正在跑的 watcher，它可能在监控期间投过 1 条；
  // 这里只关心本段假眼的投递，所以先把账清零。
  wakes.length = 0;
  // 假眼：pendingCount / __state 足够让 tick 走完投递
  const sheet = {
    device: 'TEST CAM', from: Date.now() - 3000, to: Date.now(), frames: [{ moved: 0.4, clock: '00:00:00' }],
    exposure: { meanV: 150, clipHigh: 0.1, clipLow: 0 }, note: '画面里出现了值得看的变化',
  };
  const eye = {
    pendingCount: 1,
    __state: { pending: [sheet], lastUseAt: Date.now() },
  };
  const w = createWatcher({ ctx, eye, device: 'TEST CAM', sessionId: SESSION, log: () => {} });
  await w.tick();
  check(wakes.length === 1, `投递了 1 条叫醒（实际 ${wakes.length}）`);
  const msg = wakes[0];
  check(msg?.role === 'user', '投递消息角色是 user');
  check(msg?.source === 'see-world', `source.kind = ${msg?.source}`);
  check(/see_world/.test(msg?.text ?? ''), '文案里指向 peek 用法');
  check(msg?.sessionId === SESSION, '投给了正确的会话');
  const st = w.state();
  check(st.wakes === 1, `wakes 计数 = ${st.wakes}`);
  // 同一张图不能重复叫
  await w.tick();
  check(wakes.length === 1, '同一张图不会重复叫醒');
}

console.log('5b) 规矩在一个会话里只说一次');
{
  const told = new Set();
  const sheetB = {
    device: 'TEST CAM', from: Date.now() - 2000, to: Date.now(), frames: [{ moved: 0.3, clock: '00:00:01' }],
    exposure: { meanV: 140, clipHigh: 0, clipLow: 0 }, note: '画面变了',
  };
  const eyeB = { pendingCount: 1, __state: { pending: [sheetB], lastUseAt: Date.now() } };
  const w1 = createWatcher({ ctx, eye: eyeB, device: 'TEST CAM', sessionId: SESSION, log: () => {}, told });
  wakes.length = 0;
  await w1.tick();
  const firstText = wakes[0]?.text ?? '';
  check(/自动回报已开始|规矩|不用调工具/.test(firstText), '第一句带规矩');
  check(told.has(SESSION), '讲过之后记进 told');

  // 关掉再开（新 watcher 同一个会话）：不该再讲一遍规矩
  const w2 = createWatcher({ ctx, eye: eyeB, device: 'TEST CAM', sessionId: SESSION, log: () => {}, told });
  check(w2.state().rulesTold === true, '重建 watcher 也记得这个会话听过规矩');
  eyeB.__state.pending = [{ ...sheetB, from: sheetB.from - 5000, frames: [{ moved: 0.5, clock: '00:00:02' }] }];
  wakes.length = 0;
  await w2.tick();
  const againText = wakes[0]?.text ?? '';
  check(wakes.length === 1 && !/自动回报已开始/.test(againText), `第二次不再讲规矩（首句：${againText.slice(0, 28)}…）`);

  // 换到没听过的会话：要讲
  const w3 = createWatcher({ ctx, eye: eyeB, device: 'TEST CAM', sessionId: 'sess-fresh', log: () => {}, told });
  check(w3.state().rulesTold === false, '从没听过的会话要讲规矩');
  check(w3.state().sessionId === 'sess-fresh', `绑到 sess-fresh（${w3.state().sessionId}）`);
}

console.log('6) 错误路径');
{
  const r = await tool.execute({ action: 'look', device: '显然不存在的摄像头' }, run);
  check(!lossless(r), '坏设备名返回 lossless');
  check(Array.isArray(r.images) && r.images.length === 0, '坏设备没附图');
  check(typeof r.text === 'string' && r.text.length > 10, `坏设备有解释文字：${r.text.split('\n')[0]}`);
}

console.log('7) 网页接口');
{
  check(routes.length === 1, `注册了 1 条路由（实际 ${routes.length}）`);
  const spec = routes[0];
  check(spec?.kind === 'prefix', `kind = ${spec?.kind}`);
  check(spec?.path === '/api/see-world', `path = ${spec?.path}`);

  const statusOut = await callRoute(spec, { path: '/status' });
  const statusJson = jsonOf(statusOut);
  check(statusOut.status === 200 && statusJson?.ok === true, `GET /status → ${statusOut.status}`);
  check(statusJson && typeof statusJson.running === 'boolean', 'status 里有 running');
  check(typeof statusJson?.ffmpeg?.path === 'string', 'status 里有 ffmpeg.path');
  check(!lossless(statusJson), 'GET /status 是 lossless JSON');

  const cfgOut = await callRoute(spec, { path: '/config' });
  const cfgJson = jsonOf(cfgOut);
  check(cfgJson?.ok === true && typeof cfgJson.path === 'string', `GET /config → ${cfgJson?.path}`);
  check(Array.isArray(cfgJson?.resolutions) && cfgJson.resolutions.length > 3, 'config 里带分辨率候选');
  check(cfgJson?.config && typeof cfgJson.config.fps === 'number', 'config.config.fps 是数字');

  const saved = await callRoute(spec, {
    method: 'POST', path: '/config', body: { patch: { fps: 12, frames: 3, previewWidth: 480 } },
  });
  const savedJson = jsonOf(saved);
  check(savedJson?.ok === true, `POST /config → ${saved?.status}`);
  check(savedJson?.config?.fps === 12 && savedJson?.config?.frames === 3, '改后的值回包正确');
  const onDisk = JSON.parse(readFileSync(join(HOME, 'see-world.json'), 'utf8'));
  check(onDisk.fps === 12 && onDisk.frames === 3, '配置落到了临时 DSH_HOME');
  const again = jsonOf(await callRoute(spec, { path: '/config' }));
  check(again?.config?.fps === 12, '再读回来还是 12（不是只有回包对）');

  const badPatch = await callRoute(spec, { method: 'POST', path: '/config', body: { patch: { fps: 999 } } });
  const badJson = jsonOf(badPatch);
  check(badJson?.config?.fps === 30 && (badJson?.warnings ?? []).length > 0, `越界的 fps 被夹到 30 并给警告（${badJson?.warnings?.[0] ?? '无警告'}）`);

  const missing = await callRoute(spec, { method: 'POST', path: '/config', body: {} });
  check(missing.status === 400, `缺 patch → ${missing.status}`);

  // 信任栅栏：非 loopback 的 Host 必须拒
  const evil = await callRoute(spec, { path: '/status', headers: { host: 'evil.example.com' } });
  check(evil.status === 403, `非 loopback Host → ${evil.status}`);
  const cross = await callRoute(spec, {
    path: '/status',
    headers: { host: '127.0.0.1:56149', 'sec-fetch-site': 'cross-site' },
  });
  check(cross.status === 403, `cross-site → ${cross.status}`);
  const sameOrigin = await callRoute(spec, {
    path: '/status',
    headers: { host: '127.0.0.1:56149', origin: 'http://127.0.0.1:56149' },
  });
  check(sameOrigin.status === 200, `同源 Origin 放行 → ${sameOrigin.status}`);

  const notFound = await callRoute(spec, { path: '/nope' });
  check(notFound.status === 404, `未知路由 → ${notFound.status}`);

  if (!noCam) {
    const started = await callRoute(spec, { method: 'POST', path: '/control', body: { action: 'start' } });
    const startedJson = jsonOf(started);
    check(startedJson?.ok === true && startedJson?.running === true, `POST /control start → running=${startedJson?.running}`);

    // 自动回报的命门：面板 start 之后必须把"攒图"挂上，否则 autoReply 开着却永远不响
    const armed = await callRoute(spec, { path: '/status' });
    const armedJson = jsonOf(armed);
    check(armedJson?.monitoring === true, `start 之后监控挂上了（monitoring=${armedJson?.monitoring}）`);
    check(armedJson?.reply?.running === true || armedJson?.reply?.auto === true,
      `自动回报已就位（auto=${armedJson?.reply?.auto} running=${armedJson?.reply?.running}）`);

    // 等第一帧进 ring，再要 PNG
    await new Promise((r) => setTimeout(r, 1200));
    const frameOut = await callRoute(spec, { path: '/frame?w=480' });
    check(frameOut.status === 200 && frameOut.headers['content-type'] === 'image/png',
      `GET /frame → ${frameOut.status} ${frameOut.headers['content-type']}`);
    check(frameOut.body.length > 3000, `画面是真的 PNG（${frameOut.body.length} 字节）`);
    check(frameOut.body[1] === 0x50 && frameOut.body[2] === 0x4e && frameOut.body[3] === 0x47, 'PNG 魔数正确');

    // 实时预览：一次请求，服务端按帧写 —— 面板要有"视频"而不是"幻灯片"
    const live = await runStream(spec, { path: '/stream?w=320&fps=10', wantParts: 4 });
    check(/multipart\/x-mixed-replace/.test(String(live.headers['content-type'])), `预览是长连接（${live.headers['content-type']}）`);
    const text = live.body.toString('latin1');
    check(text.includes('--seeworldframe'), '分节标记正确');
    const isJpeg = /content-type: image\/jpeg/.test(text);
    const isPng = /content-type: image\/png/.test(text);
    check(isJpeg || isPng, `每一节都是图片（${isJpeg ? 'jpeg' : 'png'}）`);
    const jpgAt = live.body.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const pngAt = live.body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    check((isJpeg && jpgAt > 0) || (isPng && pngAt > 0), `预览里是真的图片字节（jpeg@${jpgAt} / png@${pngAt}）`);
    check(!isJpeg || live.body.length / 4 < 200 * 1024, `预览帧比 PNG 小得多（整段 ${Math.round(live.body.length / 1024)} KB）`);

    const before = wakes.length;
    const sent = await callRoute(spec, { method: 'POST', path: '/send', body: { sessionId: SESSION, seconds: 1.2 } });
    const sentJson = jsonOf(sent);
    check(sentJson?.ok === true && sentJson?.sessionId === SESSION, `POST /send → ${sentJson?.wake}`);
    check(wakes.length === before + 1, `送进会话 1 条消息（实际 ${wakes.length - before}）`);
    const last = wakes[wakes.length - 1];
    check(last?.images === 1, `消息里带 ${last?.images} 张图`);
    check(last?.role === 'user' && last?.source === 'see-world', '消息是 user + source=see-world');

    const stopped = await callRoute(spec, { method: 'POST', path: '/control', body: { action: 'stop' } });
    check(jsonOf(stopped)?.running === false, 'POST /control stop 关掉流');

    // 关掉之后面板还得活着 —— 它必须能说清"为什么没画面"，而不是干瞪眼
    const dark = jsonOf(await callRoute(spec, { method: 'GET', path: '/frame' }));
    check(dark?.ok === false, '关流后 /frame 是 ok:false（不是空图）');
    check(typeof dark?.reason === 'string' && dark.reason.length > 0, `空画面带 reason：${dark?.reason}`);
    check(typeof dark?.warnings?.[0] === 'string' && dark.warnings[0].length > 0, `空画面带人话：${dark?.warnings?.[0]}`);
    check(typeof dark?.hint === 'string', `空画面带 hint：${dark?.hint || '（空）'}`);
  }

  // 打不开的摄像头必须回 ok:false —— 面板点「开始」不能变成假成功
  const badDev = jsonOf(await callRoute(spec, {
    method: 'POST', path: '/control', body: { action: 'start', device: 'No Such Camera 9999' },
  }));
  check(badDev?.ok === false, `坏设备名 → ok:false（实际 ok=${badDev?.ok}）`);
  check(typeof badDev?.warnings?.[0] === 'string', `坏设备名带人话：${badDev?.warnings?.[0]}`);
  check(badDev?.running === false, '坏设备名下 running 是 false');

  const badAction = await callRoute(spec, { method: 'POST', path: '/control', body: { action: 'dance' } });
  check(badAction.status === 400, `非法 action → ${badAction.status}`);

  // 自动回报：状态里要能看到节奏，面板那个下拉要能改绑
  const st = jsonOf(await callRoute(spec, { method: 'GET', path: '/status' }));
  check(st?.reply && typeof st.reply === 'object', 'status 里有 reply 段');
  check(typeof st?.reply?.auto === 'boolean', `reply.auto = ${st?.reply?.auto}`);
  check(Number.isFinite(st?.reply?.intervalSec), `reply.intervalSec = ${st?.reply?.intervalSec}`);
  check(Array.isArray(st?.sessions), `sessions 是数组（${st?.sessions?.length ?? '?'} 个）`);

  const bound = jsonOf(await callRoute(spec, {
    method: 'POST', path: '/control', body: { action: 'bind', sessionId: 'sess-other' },
  }));
  check(bound?.ok === true && bound?.sessionId === 'sess-other', `bind → ${bound?.sessionId}`);
  const boundSt = jsonOf(await callRoute(spec, { method: 'GET', path: '/status' }));
  check(boundSt?.reply?.sessionId === 'sess-other', `bind 之后 status 里是 sess-other（${boundSt?.reply?.sessionId}）`);

  const noTarget = await callRoute(spec, { method: 'POST', path: '/control', body: { action: 'bind' } });
  check(noTarget.status === 200 && jsonOf(noTarget)?.ok === false, 'bind 不给 sessionId → ok:false');

  // 关掉自动回报要真的落到配置里（不能只是前端看起来变了）
  const noAuto = jsonOf(await callRoute(spec, {
    method: 'POST', path: '/config', body: { patch: { autoReply: false, replyIntervalSec: 7 } },
  }));
  check(noAuto?.config?.autoReply === false, `POST /config autoReply=false → ${noAuto?.config?.autoReply}`);
  check(noAuto?.config?.replyIntervalSec === 7, `间隔改成 7 秒 → ${noAuto?.config?.replyIntervalSec}`);
}

try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 清不掉也无所谓 */ }

console.log(fails ? `\n失败 ${fails} 项` : '\n全部通过');
process.exit(fails ? 1 : 0);
