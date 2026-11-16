// 定时提醒：存盘 + 到点触发 + 中文时间解析
// 目标：手机上说「明早九点叫我」，桥接直接排一条提醒，到点推回手机。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime');
const FILE = path.join(RUNTIME, 'reminders.json');
const MAX = 200;

let items = load();
let timer = null;

/** 从磁盘重新载入（备份还原后用）。 */
export function reload() {
  items = load();
  return items.length;
}

function load() {
  const arr = readJson(FILE, [], { quiet: true });
  return Array.isArray(arr) ? arr : [];
}

function save() {
  try {
    if (items.length > MAX) items = items.slice(-MAX);
    writeJson(FILE, items);
  } catch {
    /* 忽略落盘失败，内存里还有 */
  }
}

function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 中文/数字时间解析：返回 { at, label } 或 null */
export function parseWhen(text, now = Date.now()) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return null;
  const base = new Date(now);
  const mk = (d, h, mi) => {
    const x = new Date(d);
    x.setHours(h, mi, 0, 0);
    return x;
  };
  const fmt = (t) => {
    const d = new Date(t);
    const today = new Date(now);
    const sameDay = d.toDateString() === today.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `今天 ${hh}:${mm}`;
    const tm = new Date(now + 86400000);
    if (d.toDateString() === tm.toDateString()) return `明天 ${hh}:${mm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  };

  // 1) 相对时间：N 分钟后 / N 小时后 / N 秒后 / 半小时后 / 一个半小时后
  let m = s.match(/(\d+)\s*个?\s*半?\s*小时\s*(?:之?后|以后)/);
  if (m) {
    const h = Number(m[1]);
    const half = /半个?小时/.test(m[0]) ? 0.5 : 0;
    const at = now + (h + half) * 3600000;
    return { at, label: fmt(at), kind: 'rel' };
  }
  m = s.match(/(半)\s*个?\s*小时\s*(?:之?后|以后)/);
  if (m) {
    const at = now + 0.5 * 3600000;
    return { at, label: fmt(at), kind: 'rel' };
  }
  m = s.match(/(\d+)\s*分钟\s*(?:之?后|以后)/);
  if (m) {
    const at = now + Number(m[1]) * 60000;
    return { at, label: fmt(at), kind: 'rel' };
  }
  m = s.match(/(\d+)\s*秒\s*(?:之?后|以后)/);
  if (m) {
    const at = now + Number(m[1]) * 1000;
    return { at, label: fmt(at), kind: 'rel' };
  }

  // 2) 绝对时间：X点[Y分] / X:Y / X点半
  m = s.match(/(\d{1,2})[点:：时](\d{1,2})?分?/);
  if (!m) {
    // 「九点」这类中文数字
    const cn = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const m2 = s.match(/(十[一二]?|[零一二两三四五六七八九])\s*[点:：时](\s*(十[一二]?|[零一二三四五六七八九十])\s*分?)?/);
    if (m2) {
      let h = cn[m2[1]];
      if (h === undefined) return null;
      let mi = 0;
      if (m2[3] !== undefined) mi = cn[m2[3]] ?? 0;
      if (/半/.test(s)) mi = 30;
      m = [m2[0], String(h), String(mi)];
    }
  }
  if (m) {
    const h = Number(m[1]);
    let mi = Number(m[2] || 0);
    // 「11点半」数字后面没有分值，但整句里有「点半」
    if (!m[2] && /\d\s*[点:：时]\s*半|点半|时半/.test(s)) mi = 30;
    if (h > 24 || mi > 59) return null;
    // 下午/晚上：1-11 点顺延 12 小时
    const pm = /下午|晚上|傍晚|夜里|今晚/.test(s);
    const noon = /中午/.test(s);
    let hour = h;
    if (pm && h < 12) hour = h + 12;
    if (noon && h < 12) hour = 12;
    if (h === 24) hour = 0;
    let d = new Date(base);
    if (/后天/.test(s)) d.setDate(d.getDate() + 2);
    else if (/明天|明早|明晚|明日/.test(s)) d.setDate(d.getDate() + 1);
    let at = mk(d, hour, mi).getTime();
    if (at <= now + 5000) {
      // 没说哪天且今天已过点 → 顺延到明天
      const t = new Date(at);
      t.setDate(t.getDate() + 1);
      at = t.getTime();
    }
    return { at, label: fmt(at), kind: 'abs' };
  }
  return null;
}

export function add({ text, at, label, mode, source }) {
  if (!at || !Number.isFinite(at)) throw new Error('时间不对');
  const it = {
    id: id(),
    text: String(text || '').slice(0, 200),
    at: Number(at),
    label: label || '',
    mode: mode || 'work',
    source: source || 'user',
    done: false,
    createdAt: Date.now(),
  };
  items.push(it);
  items.sort((a, b) => a.at - b.at);
  save();
  return it;
}

export function remove(rid) {
  const n = items.length;
  items = items.filter((x) => x.id !== rid);
  save();
  return items.length !== n;
}


export function ack(rid) {
  const it = items.find((x) => x.id === rid);
  if (!it) return false;
  it.acked = true;
  save();
  return true;
}

export function list({ includeDone = false } = {}) {
  const now = Date.now();
  return items
    .filter((x) => includeDone || !x.done)
    .map((x) => ({ ...x, past: x.at <= now }));
}

export function pendingCount() {
  return items.filter((x) => !x.done).length;
}

/** 到点的（未触发）提醒 */
function due(now) {
  return items.filter((x) => !x.done && x.at <= now);
}

/** 启动扫描：每 20 秒查一次，触发回调 */
export function start(onFire) {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    const hit = due(now);
    if (!hit.length) return;
    for (const it of hit) {
      it.done = true;
      it.firedAt = now;
    }
    save();
    for (const it of hit) {
      try {
        onFire(it);
      } catch {
        /* 单个失败不影响其它 */
      }
    }
  }, 20000);
  timer.unref?.();
}

/** 从一句话里读出提醒并建好（「提醒我明早九点叫我」） */
export function tryFromText(text, { mode } = {}) {
  const s = String(text || '');
  if (!/提醒|叫我|记得|别忘了|定时|闹钟/.test(s)) return null;
  const t = parseWhen(s);
  if (!t) return null;
  // 只留「提醒内容」，去掉时间词与指令词
  let body = s
    .replace(/提醒我?|叫我|记得|别忘了|定时|闹钟/g, '')
    .replace(/(明天|明早|明晚|后天|今天|今晚|下午|上午|中午|晚上|早上)/g, '')
    .replace(/\d{1,2}\s*[点:：时]\s*\d{0,2}\s*分?/g, '')
    .replace(/(十[一二]?|[零一二两三四五六七八九])\s*[点:：时]\s*(半|[零一二三四五六七八九十]+分?)?/g, '')
    .replace(/半?个?\s*半?\s*小时\s*(之后|以后)?/g, '')
    .replace(/\d+\s*(分钟|秒)\s*(之后|以后)?/g, '')
    .replace(/[，,。.！!？?\s]/g, '')
    .trim();
  // 剥完时间词后如果什么都不剩（「提醒我明天九点叫我」），用原句当正文，别写成干巴巴的「到点了」
  if (!body || body.length <= 1) body = s.replace(/[，,。.！!？?\s]/g, '').slice(0, 40) || '到点了';
  return add({ text: body.slice(0, 80), at: t.at, label: t.label, mode, source: 'text' });
}
