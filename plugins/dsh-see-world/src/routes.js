/**
 * routes.js — 网页那一半（设置页 / 面板）背后要的几条接口，全在 `/api/see-world/` 下。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET  | `/status`   | 采集状态 + 当前生效配置 + ffmpeg 来源（面板每 1 秒轮询一次） |
 * | GET  | `/frame`    | 最新一帧 PNG（`?w=` 指定宽度；取不到时回 `{ok:false,reason,hint}`） |
 * | GET  | `/stream`   | 实时预览长连接（`multipart/x-mixed-replace`，`?w=&fps=`） |
 * | GET  | `/devices`  | 枚举摄像头（设置页下拉框） |
 * | GET  | `/config`   | 配置文件的现状、默认值、分辨率候选、校验警告 |
 * | POST | `/config`   | `{patch}`：改配置，校验后落盘，需要的话当场换设备/重启流 |
 * | POST | `/control`  | `{action:"start"|"stop"}`：开/关采集流（不开就不占摄像头） |
 * | POST | `/send`     | `{sessionId,seconds}`：抓一张当前画面，**作为图片消息送进会话** |
 *
 * ## 两条边界
 *
 * · 每个请求先过信任栅栏（`trust.js`）：这些路径不经过内核准入。
 * · 值不合适一律回 200 + `{ok:false, warnings}`：用户的心智是"它没接受我的数"，
 *   不是"接口坏了"；前端不用先判 HTTP 状态再解析 body。
 */

import { rejectionFor } from './trust.js';

/** 与 client.js 里的 API 常量必须一致。 */
export const ROUTE_PREFIX = '/api/see-world';

const BODY_LIMIT = 64 << 10;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

/**
 * @param deps - 全部是函数（不是值）：眼睛和配置都在 apply 的闭包里变，传值会拿到旧快照。
 */
export function createRoutes(deps) {
  const {
    log,
    status,
    frame,
    devices,
    config,
    saveConfig,
    control,
    send,
    stream,
    connection,
  } = deps;

  const safe = (name, fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      log?.(`${name} 失败：${String(e?.message ?? e)}`);
      return { ok: false, warnings: [`${name} 出错：${String(e?.message ?? e)}`] };
    }
  };

  return async function handle(req, res) {
    const rejected = rejectionFor(req, connection?.());
    if (rejected !== undefined) {
      json(res, rejected, { ok: false, warnings: ['请求不被信任'] });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      json(res, 400, { ok: false, warnings: ['请求路径无法解析'] });
      return;
    }

    const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname;
    const query = (() => {
      try { return new URL(req.url ?? '/', 'http://localhost').searchParams; } catch { return new URLSearchParams(); }
    })();
    const method = String(req.method ?? 'GET').toUpperCase();

    try {
      // ── 实时预览：一条长连接，按帧往里写（multipart/x-mixed-replace） ──────
      // 这条也不是 JSON：浏览器把它当"会自己变的图片"，<img> 收到一帧就换一帧。
      if (route === '/stream') {
        if (method !== 'GET') { json(res, 405, { ok: false, warnings: ['只支持 GET'] }); return; }
        const width = Number(query.get('w')) || 480;
        const fps = Number(query.get('fps')) || 12;
        if (typeof stream !== 'function') {
          json(res, 503, { ok: false, warnings: ['这个部署没有实时预览能力'] });
          return;
        }
        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=seeworldframe',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const stop = stream({ res, width, fps });
        let closed = false;
        const done = () => {
          if (closed) return;
          closed = true;
          try { stop(); } catch { /* ignore */ }
        };
        req.on('close', done);
        req.on('aborted', done);
        res.on('close', done);
        return;
      }

      // ── 画面：这一条不走 JSON ────────────────────────────────────────────
      if (route === '/frame') {
        if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { ok: false, warnings: ['只支持 GET'] }); return; }
        const shot = await safe('取画面', () => frame({ maxWidth: Number(query.get('w')) || 640 }))();
        if (!shot || !shot.png) {
          json(res, 200, {
            ok: false,
            reason: shot?.reason ?? 'no-frame',
            warnings: [shot?.warnings?.[0] ?? '现在没有画面（采集没开或者刚开还没收到帧）'],
            hint: shot?.hint ?? '',
          });
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': shot.png.length,
          'x-see-world-at': String(shot.at ?? ''),
          'x-see-world-gain': String(shot.gain ?? ''),
        });
        res.end(shot.png);
        return;
      }

      if (route === '/status' || route === '/') {
        if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { ok: false, warnings: ['只支持 GET'] }); return; }
        const payload = await safe('读状态', () => status())();
        json(res, 200, { ok: true, ...payload });
        return;
      }

      if (route === '/devices') {
        if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { ok: false, warnings: ['只支持 GET'] }); return; }
        const payload = await safe('枚举设备', () => devices())();
        json(res, 200, { ok: true, ...payload });
        return;
      }

      if (route === '/config') {
        if (method === 'GET' || method === 'HEAD') {
          const payload = await safe('读配置', () => config())();
          json(res, 200, { ok: true, ...payload });
          return;
        }
        if (method !== 'POST') { json(res, 405, { ok: false, warnings: ['只支持 GET / POST'] }); return; }

        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          json(res, 400, { ok: false, warnings: [`请求体不是合法 JSON：${e?.message ?? e}`] });
          return;
        }
        const patch = body && typeof body === 'object' ? body.patch : undefined;
        if (!patch || typeof patch !== 'object') {
          json(res, 400, { ok: false, warnings: ['缺少 patch 对象'] });
          return;
        }
        const result = await safe('保存配置', () => saveConfig(patch))();
        json(res, 200, { ok: result?.ok !== false, ...result });
        return;
      }

      if (route === '/control') {
        if (method !== 'POST') { json(res, 405, { ok: false, warnings: ['只支持 POST'] }); return; }
        let body;
        try { body = await readJson(req); } catch (e) {
          json(res, 400, { ok: false, warnings: [`请求体不是合法 JSON：${e?.message ?? e}`] });
          return;
        }
        const action = String(body?.action ?? '').toLowerCase();
        if (action !== 'start' && action !== 'stop' && action !== 'bind') {
          json(res, 400, { ok: false, warnings: ['action 必须是 start / stop / bind'] });
          return;
        }
        const result = await safe('开关采集', () => control(action, {
          device: body?.device,
          sessionId: typeof body?.sessionId === 'string' ? body.sessionId : null,
        }))();
        json(res, 200, { ok: result?.ok !== false, action, ...result });
        return;
      }

      if (route === '/send') {
        if (method !== 'POST') { json(res, 405, { ok: false, warnings: ['只支持 POST'] }); return; }
        let body;
        try { body = await readJson(req); } catch (e) {
          json(res, 400, { ok: false, warnings: [`请求体不是合法 JSON：${e?.message ?? e}`] });
          return;
        }
        const result = await safe('送画面进会话', () => send({
          sessionId: typeof body?.sessionId === 'string' ? body.sessionId : null,
          seconds: Number(body?.seconds ?? 1.2),
          frames: Number(body?.frames ?? 0) || undefined,
          note: typeof body?.note === 'string' ? body.note : '',
        }))();
        json(res, 200, { ok: result?.ok !== false, ...result });
        return;
      }

      json(res, 404, { ok: false, warnings: [`没有这条路由：${route || '/'}`] });
    } catch (e) {
      // 兜底：异常也要变成结构化答复，别让连接断掉 —— 前端在等 JSON。
      log?.(`接口异常 ${e?.stack ?? e}`);
      json(res, 500, { ok: false, warnings: [String(e?.message ?? e)] });
    }
  };
}
