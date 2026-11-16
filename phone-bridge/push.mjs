/**
 * Web Push：主人没在看 App 的时候，回复像微信一样弹通知。
 *
 * 为什么需要：手机 App 关掉/切后台时，SSE 断了，页面里的 Notification 根本不会执行——
 * 只有走系统推送通道（FCM）由 Service Worker 在后台接收，才能真正弹出来。
 * 前提：https 或 localhost（安全上下文），所以公网地址 https://<你的域名>/dsh 可用，
 * 局域网 http://192.168.x.x:8899 不行。
 *
 * 订阅存在 runtime/push.json（含 VAPID 私钥，别外传）。
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const FILE = path.join(process.cwd(), 'runtime', 'push.json');

let cache = null;
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = null;
  }
  if (!cache || !cache.keys || !cache.keys.publicKey) {
    const keys = webpush.generateVAPIDKeys();
    cache = { keys, subs: [], createdAt: Date.now() };
    save();
  }
  if (!Array.isArray(cache.subs)) cache.subs = [];
  webpush.setVapidDetails('mailto:master@localhost', cache.keys.publicKey, cache.keys.privateKey);
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

export function publicKey() {
  return load().keys.publicKey;
}

export function count() {
  return load().subs.length;
}

export function subscribe(sub) {
  if (!sub || !sub.endpoint) return { ok: false, error: 'no endpoint' };
  const c = load();
  const i = c.subs.findIndex((x) => x.endpoint === sub.endpoint);
  const item = { endpoint: sub.endpoint, keys: sub.keys || {}, at: Date.now() };
  if (i >= 0) c.subs[i] = item;
  else c.subs.push(item);
  save();
  return { ok: true, total: c.subs.length };
}

export function unsubscribe(endpoint) {
  const c = load();
  const before = c.subs.length;
  c.subs = c.subs.filter((x) => x.endpoint !== endpoint);
  save();
  return { ok: true, removed: before - c.subs.length };
}

/** 推一条给所有订阅者；失效订阅（410/404）自动清理。 */
export async function send({ title, body, url, tag }) {
  const c = load();
  if (!c.subs.length) return { sent: 0, total: 0 };
  const payload = JSON.stringify({ title: title || 'DSH', body: body || '', url: url || '/', tag: tag || 'dsh-reply' });
  let sent = 0;
  const dead = [];
  await Promise.all(
    c.subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' });
        sent += 1;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
      }
    })
  );
  if (dead.length) {
    c.subs = c.subs.filter((x) => !dead.includes(x.endpoint));
    save();
  }
  return { sent, total: c.subs.length, dead: dead.length };
}

export function stats() {
  const c = load();
  return { subscriptions: c.subs.length, createdAt: c.createdAt || null, endpointHosts: c.subs.map((s) => {
    try { return new URL(s.endpoint).host; } catch { return '?'; }
  }) };
}
