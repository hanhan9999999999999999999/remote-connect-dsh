/**
 * dsh-remote-connect — host half.
 *
 * 一个插件，两件远程互联的事：
 *   /dsh-remote-connect-api/*   → 配对、发现、同步（插件 / 技能 / 规则 / 配置 / 会话）
 *   /dsh-phone-api/*         → 手机通道（启停 phone-bridge、换端口、配对码）
 *   /dsh-remote-connect-api/phone/* → 面板用的手机通道代理，同进程直连，不走回环 HTTP
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
import { api as phoneApi, apply as applyPhone, configure as configurePhone, installed as phoneInstalled, bridgeDir as phoneBridgeDir } from './host/phone.mjs'

export const inject = ['webServer']

const PREFIX = '/dsh-remote-connect-api'
const MAX_BODY = 1024 * 1024

export function apply(ctx, config = {}) {
  // 手机通道先挂：它的路由是 /dsh-phone-api/*，和这里的 /dsh-remote-connect-api/* 不冲突
  configurePhone(config?.phone ?? config ?? {})
  try {
    applyPhone(ctx, config?.phone ?? config ?? {})
  } catch (err) {
    // 手机通道挂了不能把远程互联一起带下去
    ctx.logger?.warn?.(`[remote-connect] 手机通道未挂载：${err?.message ?? err}`)
  }

  const webServer = ctx.get('webServer')
  let service = null
  let ready = null
  const logger = new Logger({ file: path.join(dataHome(), 'remote-connect.log') })

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
  // 这三条要把参数带下去：过去固定 GET/空体，等于「换端口」「改配对码」永远做不成
  reg('POST', '/phone/start', async (body) => phone('/start', 'POST', body ?? {}).catch(unavailable))
  reg('POST', '/phone/stop', async () => phone('/stop', 'POST', {}).catch(unavailable))
  reg('POST', '/phone/port', async (body) => phone('/port', 'POST', body ?? {}).catch(unavailable))
  reg('POST', '/phone/paircode', async (body) => phone('/paircode', 'POST', body ?? {}).catch(unavailable))

  ctx.effect?.(() => () => {
    for (const d of dispose) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    service?.server?.stop?.().catch(() => {})
  }, 'remote-connect: routes')
}

let phoneApiPromise
async function loadPhoneBridgeApi() {
  if (globalThis.__dshRemoteConnectPhone) return globalThis.__dshRemoteConnectPhone
  if (!phoneApiPromise) {
    // 同一个包里，直接拿模块出口，不再跨包 import('../dsh-phone-bridge/index.js')
    phoneApiPromise = Promise.resolve(phoneApi ?? null)
  }
  return phoneApiPromise
}

function unavailable(err) {
  const noBridge = !phoneInstalled()
  return {
    ok: false,
    installed: !noBridge,
    error: noBridge ? '本机还没装手机通道（phone-bridge）' : '手机通道暂时没响应',
    hint: noBridge ? `把 phone-bridge 放到 ${phoneBridgeDir()}，或设置 config.bridgeDir` : undefined,
    detail: err?.message,
  }
}

// 错误码 → HTTP 状态码。写死一张表，别的模块新加错误码时默认 500（并且会带可读 message），
// 不会因为漏了一个分支就把「内容太大」这种可操作的事说成 500。
const STATUS = {
  // 认证
  BAD_PASSWORD: 401,
  LOCKED_OUT: 401,
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,
  // 权限 / 密钥不符
  KEY_MISMATCH: 403,
  // 找不到
  PEER_UNKNOWN: 404,
  TASK_UNKNOWN: 404,
  SYNC_UNKNOWN: 404,
  // 状态冲突（做不了，但不是参数错）
  NOT_CONNECTED: 409,
  NEED_PASSWORD: 409,
  NO_PASSWORD: 409,
  PORT_IN_USE: 409,
  SYNC_BUSY: 409,
  NO_JOURNAL: 409,
  ALREADY_ROLLED_BACK: 409,
  // 参数 / 内容不对
  BAD_INPUT: 400,
  BAD_JSON: 400,
  NO_HOST: 400,
  METHOD: 400,
  CATEGORY: 400,
  EMPTY: 400,
  BAD_PLUGIN_ID: 400,
  PATH_ESCAPE: 400,
  VERSION_MISMATCH: 400,
  // 太大
  TOO_LARGE: 413,
  BODY_TOO_LARGE: 413,
  // 对端的问题（网关类）
  NETWORK: 502,
  TIMEOUT: 502,
  NOT_DSH_LINK: 502,
  BAD_RESPONSE: 502,
  BAD_ENVELOPE: 502,
  PHONE_BAD_RESPONSE: 502,
  NO_PORT: 502,
}

export function statusFor(code) {
  return STATUS[code] ?? 500
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
