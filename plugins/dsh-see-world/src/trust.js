/**
 * trust.js — 给 `/api/see-world` 的信任栅栏。
 *
 * 前缀比内核自己的 `/api` 长，webServer 按「最长前缀优先」分发，所以这些请求
 * **不会经过内核准入**。不设防的话，任何能连上 loopback 的进程都能改配置、调摄像头。
 *
 * 两层：组合里有 `connection` 就用内核同一套判定；没有就复刻一份结构等价的
 * （Host 必须是 loopback 防 DNS rebinding、不许跨站、Origin/Referer 必须同源）。
 * 判定自己出错一律拒 —— 不因为"检查坏了"就放行。
 */

const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

function authority(value, fallbackScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${fallbackScheme ?? 'http'}://${value.trim()}`);
  } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/** 桌面版把页面从 `dsh-app://app` 转发到 loopback 时会留下这个 Referer。 */
function isDesktopRelay(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === '';
  } catch { return false; }
}

export function structuralReason(req) {
  const headers = req?.headers ?? {};
  const host = authority(headers.host, 'http');
  if (host === null || !LOOPBACK.has(host.hostname)) return 'host-not-loopback';
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site';

  for (const header of ['origin', 'referer']) {
    const raw = headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (header === 'referer' && isDesktopRelay(raw)) {
      if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers';
      continue;
    }
    const origin = authority(raw.trim());
    if (origin === null) return `${header}-invalid`;
    if (origin.scheme !== host.scheme || origin.hostname !== host.hostname || origin.port !== host.port) {
      return `${header}-mismatch`;
    }
  }
  return undefined;
}

/** `undefined` = 放行，否则是要回给调用方的 HTTP 状态码。 */
export function rejectionFor(req, connection) {
  const admit = connection?.admit;
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req);
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined;
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403;
      return status;
    } catch { return 503; }
  }

  const reject = connection?.requestRejection;
  if (typeof reject === 'function') {
    try {
      const status = reject.call(connection, req);
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403;
      return status;
    } catch { return 503; }
  }

  return structuralReason(req) === undefined ? undefined : 403;
}
