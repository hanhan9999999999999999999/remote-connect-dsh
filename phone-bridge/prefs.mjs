// 相处偏好：主人说过的"以后该怎么跟我说话"，跨会话保留。
//
// 为什么不用模型总结：抽一句话要走一次完整的 agent 冷启动（实测 74 秒起），
// 而且总结出来的"语气"经常是废话。这里走"用户开口就记下"的路线：
// 只要你说了类似「以后说话随意点」「别老给我列清单」，就原样存一条，
// 下次进相处模式时注入给模型。可控、即时、不花钱。
//
// 存 runtime/life-prefs.json：{ items: [{ text, at }], updatedAt }

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'runtime', 'life-prefs.json');
const MAX = 12;

function load() {
  const j = readJson(FILE, { items: [], updatedAt: 0 }, { quiet: true });
  return { items: Array.isArray(j && j.items) ? j.items : [], updatedAt: (j && j.updatedAt) || 0 };
}

function save(db) {
  try {
    db.updatedAt = Date.now();
    writeJson(FILE, db, { pretty: true });
  } catch (e) {
    /* 落盘失败不影响对话 */
  }
}

export function list() {
  return load().items;
}

export function text() {
  return list()
    .map((x) => String(x.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function add(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!t) return null;
  const db = load();
  if (db.items.some((x) => x.text === t)) return null;
  db.items.push({ text: t, at: Date.now() });
  while (db.items.length > MAX) db.items.shift();
  save(db);
  return t;
}

export function remove(at) {
  const db = load();
  const before = db.items.length;
  db.items = db.items.filter((x) => x.at !== at);
  if (db.items.length !== before) save(db);
  return before - db.items.length;
}

export function clear() {
  save({ items: [], updatedAt: Date.now() });
}

// 从一句话里认出「这是在教我以后怎么说话」
const TRIGGERS = [
  /以后[^。！？\n]{0,12}(?:说话|讲话|回复|回我|跟我)/,
  /(?:说话|讲话|回复|回我)[^。！？\n]{0,8}(?:随意|随意点|简单点|简短|别太长|别那么长|口语|直接点|温柔|别列清单|别老|不要总结|别总结)/,
  /(?:别老|不要老|别总是|别再)[^。！？\n]{0,10}(?:列|总结|解释|问|说教|讲道理|汇报)/,
  /下次[^。！？\n]{0,10}(?:别|不要)[^。！？\n]{0,10}/,
  /我(?:不)?喜欢(?:你)?[^。！？\n]{0,10}(?:说话|这么说|这样回|这种语气|这么答)/
];

const STRIP = /^(?:那|嗯|ok|好|行)?[，,、\s]*(?:你)?(?:以后|往后|记住|记一下|记得)[，,、\s]*/i;

export function tryFromText(raw) {
  const s = String(raw || '').trim();
  if (s.length < 4 || s.length > 200) return null;
  if (!TRIGGERS.some((re) => re.test(s))) return null;
  // 只留第一句，去掉"以后/记住"这种引导词，保留指令本身
  const first = s.split(/[。！？\n]/)[0].trim();
  const body = first.replace(STRIP, '').trim();
  if (body.length < 3) return null;
  return add(body);
}

// 注入给模型的一段（相处模式专用）
export function block() {
  const t = text();
  if (!t) return '';
  return (
    '\n\n（这是主人以前明确要求过的说话方式，按它来，别复述这段：\n' +
    t
      .split('\n')
      .map((x) => '- ' + x)
      .join('\n') +
    '）'
  );
}
