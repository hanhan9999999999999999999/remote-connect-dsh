// 待办清单：和「定时提醒」分工不同 —— 提醒是到点喊你，待办是等你来做。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime');
const FILE = path.join(RUNTIME, 'todos.json');
const MAX = 200;

let items = [];
try {
  const raw = readJson(FILE, { items: [] }, { quiet: true });
  if (Array.isArray(raw && raw.items)) items = raw.items;
} catch (_) {}

/** 从磁盘重新载入（备份还原后用，不然内存里还是旧的）。 */
export function reload() {
  const raw = readJson(FILE, { items: [] }, { quiet: true });
  items = Array.isArray(raw && raw.items) ? raw.items.slice() : [];
  return items.length;
}

function save() {
  try {
    writeJson(FILE, { items });
  } catch (_) {}
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function list() {
  // 未完成在前；未完成里「有到期时间的」按到期时间升序排前面，其余按创建时间倒序
  // （没有 due 的待办永远排在「快到期」的后面 —— 手机上先看到要赶时间的）
  return items.slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (!a.done) {
      const ad = a.due || 0;
      const bd = b.due || 0;
      if (ad && bd) return ad - bd;
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
    }
    return (b.at || 0) - (a.at || 0);
  });
}

export function stats() {
  const open = items.filter((x) => !x.done).length;
  return { total: items.length, open, done: items.length - open };
}

export function add(text, { source = 'manual', due = null } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return null;
  const dup = items.find((x) => !x.done && x.text === t);
  if (dup) return dup;
  const it = { id: uid(), text: t, done: false, at: Date.now(), source, due: due || null, notified: false };
  items.push(it);
  if (items.length > MAX) items = items.slice(-MAX);
  save();
  return it;
}

export function toggle(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  it.done = !it.done;
  it.doneAt = it.done ? Date.now() : null;
  save();
  return it;
}

export function setDue(id, at) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  it.due = at ? Number(at) : null;
  it.notified = false;
  save();
  return it;
}

export function remove(id) {
  const n = items.length;
  items = items.filter((x) => x.id !== id);
  if (items.length !== n) { save(); return true; }
  return false;
}

// 到点该提醒的（未完成、有 due、没通知过、已过时间）
export function dueNow(now = Date.now()) {
  return items.filter((x) => !x.done && x.due && !x.notified && x.due <= now);
}

export function markNotified(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  it.notified = true;
  it.notifiedAt = Date.now();
  save();
  return it;
}

export function clearDone() {
  const n = items.length;
  items = items.filter((x) => !x.done);
  save();
  return n - items.length;
}

// 从一句话里认「记一下：xxx」「待办：xxx」「提醒我以后 xxx」
const TRIG = /^(?:记一下|记个|记下|加个待办|待办|todo|添加待办)[:：,，\s]*(.+)$/i;
const TRIG2 = /^(?:提醒我|帮我记(?:一下)?)[:：,，\s]*(.+)$/i;

export function tryFromText(text, parseWhen) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return null;
  const mDirect = s.match(TRIG);
  const mViaRemind = s.match(TRIG2);
  const m = mDirect || mViaRemind;
  if (!m) return null;
  // 「提醒我明天九点叫我」这类带时间的，交给定时提醒，别记成待办
  if (mViaRemind && /[0-9一二三四五六七八九十]+\s*[点:：时]|分钟后|小时后|明天|明早|今晚/.test(s)) return null;
  const body = String(m[1] || '').replace(/^[，,。\s]+/, '').trim();
  if (body.length < 1) return null;
  // 句子里带时间就顺手记个 due（不建提醒，避免响两次）；不带时间就是普通待办
  let due = null;
  let label = '';
  let clean = body;
  const timeReG = /((?:明天|明早|明晚|后天|今晚|今天)?\s*(?:上午|下午|晚上|中午)?\s*[0-9一二三四五六七八九十]+\s*[点:：时]\s*[0-9一二三四五六七八九十]*\s*分?半?|[0-9]+\s*分钟后|半个?小时?后|一个半小时后|[0-9]+\s*个小时后|明天|明早|明晚|后天|今晚)/g;
  const hasTime = /((?:明天|明早|明晚|后天|今晚|今天)?\s*(?:上午|下午|晚上|中午)?\s*[0-9一二三四五六七八九十]+\s*[点:：时]|[0-9]+\s*分钟后|半个?小时?后|一个半小时后|[0-9]+\s*个小时后|明天|明早|明晚|后天|今晚)/.test(body);
  if (typeof parseWhen === 'function' && hasTime) {
    const w = parseWhen(body, Date.now());
    if (w && w.at) {
      due = w.at;
      label = w.label || '';
      clean = body.replace(timeReG, '').replace(/[，,。；;\s]+$/g, '').replace(/^[，,。；;\s]+/g, '').replace(/[，,。；;]{2,}/g, '，').trim();
    }
  }
  const it = add(clean || body, { source: 'chat', due });
  return it ? { item: it, at: due, label } : null;
}
