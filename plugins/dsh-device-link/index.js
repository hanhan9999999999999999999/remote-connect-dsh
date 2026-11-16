/**
 * @local/dsh-device-link — host half.
 *
 * Mounts the Device Link service on the local DSH web server:
 *   /dsh-device-link-api/*   → configuration, discovery, pairing, sync tasks
 *   /dsh-device-link-api/phone/* → thin proxy over the phone-bridge plugin
 *
 * Every route is same-origin only (no CORS headers are sent), so a foreign page
 * cannot drive the service through the browser.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID, AppError, Logger } from './host/util.mjs'
import { LinkService } from './host/service.mjs'
import { assertPluginId } from './host/deps.mjs'
import { dataHome } from './host/config.mjs'

export const inject = ['webServer']

const PREFIX = '/dsh-device-link-api'
const MAX_BODY = 1024 * 1024

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  let service = null
  let ready = null
  const logger = new Logger({ file: path.join(dataHome(), 'device-link.log') })

  const getService = () => {
    if (!service) service = new LinkService({ logger })
    if (!ready) ready = service.init().catch((err) => {
      logger.error('host', `初始化失败：${err.stack ?? err.message}`)
      throw err
    })
    return ready.then(() => service)
  }

  const dispose = []
  const reg = (method, route, handler) => {
    const d = webServer.register({
      kind: 'exact',
      path: `${PREFIX}${route}`,
      async handler(req, res) {
        if (String(req.method).toUpperCase() !== method) {
          return send(res, 405, { ok: false, error: { code: 'METHOD', message: `请用 ${method}` } })
        }
        try {
          const body = await readBody(req)
          const out = await handler(body, req)
          send(res, 200, { ok: true, data: out ?? null })
        } catch (err) {
          const code = err instanceof AppError ? err.code : 'INTERNAL'
          const status = statusFor(code)
          if (status >= 500) logger.error('host', `${method} ${route} 失败：${err.stack ?? err.message}`)
          send(res, status, {
            ok: false,
            error: { code, message: err.message ?? String(err), extra: err.extra ?? undefined },
          })
        }
      },
    })
    if (typeof d === 'function') dispose.push(d)
  }

  /* ---------------- status & configuration ---------------- */
  reg('GET', '/status', async () => (await getService()).status())
  reg('GET', '/diagnostics', async () => (await getService()).diagnostics())
  reg('GET', '/logs', async () => ({ lines: await (await getService()).logs(300) }))
  reg('POST', '/config', async (body) => (await getService()).updateConfig(body ?? {}))
  reg('GET', '/deps', async () => (await getService()).pluginDeps())
  reg('POST', '/deps/install', async (body) => {
    const ids = Array.isArray(body?.ids) ? body.ids.map(assertPluginId) : undefined
    return (await getService()).installPluginDeps(ids)
  })
  reg('POST', '/device/name', async (body) => (await getService()).setDeviceName(body?.name))
  reg('POST', '/password/set', async (body) => (await getService()).setPassword(body?.password))
  reg('POST', '/password/rotate', async () => (await getService()).rotatePassword())
  reg('POST', '/server/start', async () => (await getService()).serverStart().then(() => (service.status())))
  reg('POST', '/server/stop', async () => (await getService()).serverStop().then(() => service.status()))

  /* ---------------- discovery & pairing ---------------- */
  reg('POST', '/discover', async (body) =>
    (await getService()).discover({ timeoutMs: body?.timeoutMs, extraHosts: body?.extraHosts }),
  )
  reg('POST', '/connect', async (body) => (await getService()).connect(body ?? {}))
  reg('POST', '/peer/disconnect', async (body) => (await getService()).disconnect(body?.id))
  reg('POST', '/peer/forget', async (body) => (await getService()).forget(body?.id))
  reg('POST', '/peer/rename', async (body) => (await getService()).renamePeer(body?.id, body?.name))
  reg('POST', '/peer/probe', async (body) => (await getService()).probePeer(body?.id))
  reg('POST', '/inventory', async (body) =>
    (await getService()).remoteInventory(body?.peerId, { cats: body?.cats, includeSecrets: Boolean(body?.includeSecrets) }),
  )

  /* ---------------- sync tasks ---------------- */
  reg('POST', '/sync', async (body) => {
    const svc = await getService()
    return svc.startSync({
      peerId: body?.peerId,
      direction: body?.direction === 'pull' ? 'pull' : 'push',
      cats: body?.cats,
      includeSecrets: Boolean(body?.includeSecrets),
    })
  })
  reg('POST', '/task/status', async (body) => {
    const svc = await getService()
    const t = svc.task(body?.id)
    if (!t) throw new AppError('TASK_UNKNOWN', '找不到这个任务')
    return t
  })
  reg('POST', '/task/cancel', async (body) => (await getService()).cancelTask(body?.id))
  reg('POST', '/remote/syncs', async (body) => (await getService()).remoteSyncs(body?.peerId))
  reg('POST', '/remote/rollback', async (body) =>
    (await getService()).remoteRollback(body?.peerId, body?.syncId),
  )
  reg('POST', '/local/syncs', async () => ({ syncs: await (await getService()).localSyncs(20) }))
  reg('POST', '/local/rollback', async (body) => (await getService()).rollbackLocal(body?.syncId))

  /* ---------------- phone bridge proxy ---------------- */
  const phone = async (route, method = 'GET', payload) => {
    // 同进程直连优先：127.0.0.1 回环请求没有 renderer token，会被浏览器访问策略 403
    const local = await loadPhoneBridgeApi();
    if (local) {
      if (route === '/status') return local.status();
      if (route === '/start') return local.start(payload);
      if (route === '/stop') return local.stop();
      if (route === '/port') return local.port(payload);
      if (route === '/paircode') return local.paircode(payload);
    }
    const port = webServer.port
    if (!port) throw new AppError('NO_PORT', '本机 Web 服务还没起来')
    const url = `http://127.0.0.1:${port}/dsh-phone-api${route}`
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new AppError('PHONE_BAD_RESPONSE', `手机通道返回了无法解析的内容（HTTP ${res.status}）`, {
        status: res.status,
        body: text.slice(0, 400),
      })
    }
  }
  reg('GET', '/phone/status', async () => phone('/status').catch(unavailable))
  reg('POST', '/phone/start', async () => phone('/start', 'POST', {}).catch(unavailable))
  reg('POST', '/phone/stop', async () => phone('/stop', 'POST', {}).catch(unavailable))
  reg('GET', '/phone/port', async () => phone('/port').catch(unavailable))
  reg('GET', '/phone/paircode', async () => phone('/paircode').catch(unavailable))

  ctx.effect?.(() => () => {
    for (const d of dispose) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    service?.server?.stop?.().catch(() => {})
  }, 'device-link: routes')
}

let phoneApiPromise
async function loadPhoneBridgeApi() {
  if (globalThis.__dshPhoneBridge) return globalThis.__dshPhoneBridge
  if (!phoneApiPromise) {
    phoneApiPromise = import(new URL('../dsh-phone-bridge/index.js', import.meta.url)).then(
      (m) => m?.api ?? null,
      () => null,
    )
  }
  const api = await phoneApiPromise
  if (!api) phoneApiPromise = undefined
  return api
}

function unavailable(err) {
  return {
    ok: false,
    installed: false,
    error: err?.code === 'NO_PORT' ? err.message : '手机通道插件未安装或未启动',
    detail: err?.message,
  }
}

function statusFor(code) {
  if (code === 'BAD_PASSWORD' || code === 'LOCKED_OUT') return 401
  if (code === 'NOT_CONNECTED' || code === 'NEED_PASSWORD' || code === 'NO_PASSWORD') return 409
  if (code === 'PEER_UNKNOWN' || code === 'TASK_UNKNOWN') return 404
  if (code === 'NO_HOST' || code === 'METHOD') return 400
  if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'NOT_DSH_LINK') return 502
  return 500
}

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new AppError('BODY_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new AppError('BAD_JSON', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

// Keep a stable id for the module loader / diagnostics.
export const id = APP_ID
export const __file = fileURLToPath(import.meta.url)
