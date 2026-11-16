// 本地长期记忆：不依赖任何外部服务，落在 runtime/memory.jsonl
//
// 设计取向是"能用、能查、坏了不影响聊天"：
//  - event  每轮对话的原文片段（写得快、零成本，永远可检索）
//  - fact   由模型压缩出来的事实卡片（慢、少量，参与注入）
// 检索用中文 bigram 倒排 + 权重打分，够用且不需要向量库。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJsonLines, writeJsonLines, writeAtomic } from './store.mjs';

// 必须用 fileURLToPath：pathname 里空格会变成 %20，之前数据全落在
// D:\document\Remote%20Connect%20DSH\ 这个影子目录里（2026-10-31 修）。
const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
const FILE = path.join(RUNTIME, 'memory.jsonl');
const MAX_EVENTS = 4000;
const MAX_FACTS = 1200;

let cache = null;

function load() {
  if (cache) return cache;
  cache = [];
  try {
    // 逐行容错：半截末行不再让整份记忆读不出来
    for (const rec of readJsonLines(FILE).items) cache.push(rec);
  } catch {}
  return cache;
}

function rewrite() {
  try {
    writeJsonLines(FILE, load());
  } catch {}
}

function trim() {
  const all = load();
  const events = all.filter((x) => x.kind === 'event');
  const facts = all.filter((x) => x.kind === 'fact');
  const keepEvents = events.slice(-MAX_EVENTS);
  const keepFacts = facts.slice(-MAX_FACTS);
  const others = all.filter((x) => x.kind !== 'event' && x.kind !== 'fact');
  cache = [...keepFacts, ...keepEvents, ...others].sort((a, b) => (a.at || 0) - (b.at || 0));
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/** 中文按 2 字滑窗 + 英文按词，作为检索键 */
export function tokens(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[\s]+/g, ' ');
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const cn = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const seg of cn.split(' ')) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i < seg.length - 1; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/**
 * 拒绝类回复不进记忆库。
 *
 * 原因（2026-10-31 实测）：memory.jsonl 里被存了 7 条「想跟你涩涩」的拒绝对话，
 * promptBlock() 每轮把它们召回到用户消息最前面，等于每轮先给模型看一遍「我上次拒绝了」。
 * 模型会为了前后一致继续拒——历史锚定，比任何系统条款都硬。
 * 记忆库应该记「发生过什么、主人喜欢什么」，不该记「我不肯做什么」。
 */
const REFUSAL_RE =
  /(不干|不改口|同一个回音|换个话头|换个话题|到此为止|写不出来|我不行|我不能|办不到|不写这个|这条底线|越过这条|另找别人|换个人吧|不方便)/;

export function isRefusal(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('我回：');
  const body = i >= 0 ? s.slice(i + 3) : s;
  return REFUSAL_RE.test(body);
}

export function add({ kind = 'event', text, mode = 'work', tags = [], weight = 1, meta = {} }) {
  const body = String(text || '').trim();
  if (!body) return null;
  if (kind === 'event' && isRefusal(body)) return null;  // 拒绝类对话不入库，避免历史锚定
  const h = hash(kind + '|' + body.slice(0, 400));
  const all = load();
  const exist = all.find((x) => x.h === h);
  if (exist) {
    exist.at = Date.now();
    exist.hits = (exist.hits || 1) + 1;
    rewrite();
    return exist;
  }
  const item = {
    h,
    kind,
    mode,
    text: body.slice(0, 2000),
    tags: Array.isArray(tags) ? tags.slice(0, 12) : [],
    weight,
    at: Date.now(),
    meta,
  };
  all.push(item);
  trim();
  // 追加写，避免每次全量重写
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(item) + '\n');
  } catch {}
  return item;
}

export function search(query, { mode, limit = 6, kinds = ['fact', 'event'] } = {}) {
  const q = tokens(query);
  if (!q.length) return [];
  const qset = new Set(q);
  const now = Date.now();
  const all = load().filter((x) => kinds.includes(x.kind) && !isRefusal(x.text));
  const scored = [];
  for (const item of all) {
    const it = tokens(item.text + ' ' + (item.tags || []).join(' '));
    let hit = 0;
    for (const t of it) if (qset.has(t)) hit += 1;
    if (!hit) continue;
    const cover = hit / Math.max(4, qset.size);
    const days = Math.max(0, (now - (item.at || 0)) / 86400000);
    const recency = 1 / (1 + days / 14);
    const base = item.kind === 'fact' ? 1.6 : 1;
    const score = cover * base * (0.55 + 0.45 * recency) * (item.weight || 1);
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => ({ ...x.item, score: Math.round(x.score * 1000) / 1000 }));
}

export function stats() {
  const all = load();
  return {
    total: all.length,
    facts: all.filter((x) => x.kind === 'fact').length,
    events: all.filter((x) => x.kind === 'event').length,
    lifeFacts: all.filter((x) => x.kind === 'fact' && x.mode === 'life').length,
    lastAt: all.length ? Math.max(...all.map((x) => x.at || 0)) : 0,
  };
}

export function recent({ mode, limit = 5, kinds = ['fact'] } = {}) {
  const all = load().filter((x) => kinds.includes(x.kind) && (!mode || x.mode === mode));
  return all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/** 注入块：稳稳的"它记得你" */
export function promptBlock(query, { mode } = {}) {
  const bits = [];
  const rel = search(query, { mode, limit: 6 });
  const facts = recent({ mode, limit: 5, kinds: ['fact'] });
  const seen = new Set();
  for (const f of facts) {
    const k = f.h;
    if (seen.has(k)) continue;
    seen.add(k);
    if (isRefusal(f.text)) continue;
    bits.push('- ' + f.text.replace(/\s+/g, ' ').slice(0, 180));
  }
  for (const f of rel) {
    if (f.kind !== 'event') continue;
    const k = f.h;
    if (seen.has(k)) continue;
    seen.add(k);
    bits.push('- （往事）' + f.text.replace(/\s+/g, ' ').slice(0, 160));
  }
  if (!bits.length) return '';
  return (
    '[本机长期记忆 · 与这次有关的内容，共 ' +
    stats().total +
    ' 条]\n' +
    bits.slice(0, 8).join('\n') +
    '\n（这是你自己的记忆，不是用户说的；自然使用，别逐条复述，也别编造记忆里没有的事。）\n\n'
  );
}

/**
 * 从模型的自由文本里抠出「事实卡片」数组。
 *
 * 模型不一定乖乖只输出 JSON：常见的是 ```json 围栏、前面一句「好的，我提炼如下」、
 * 或者包成 {"facts":[...]}。这里全部容忍；实在解析不出就返回空数组，
 * 让调用方记一条可诊断的日志，而不是把半截文本塞进记忆库。
 */
export function parseFacts(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [];

  // 模型可能引用 [1] 之类的脚注；直接找第一个 '[' 会截出错位的片段。
  // 这里按「括号配对 + 字符串感知」把所有数组候选都列出来，逐个试。
  const candidates = [s];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) candidates.push(fence[1].trim());
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }

  for (const raw of candidates) {
    let arr;
    try { arr = JSON.parse(raw); } catch { continue; }
    if (arr && !Array.isArray(arr) && Array.isArray(arr.facts)) arr = arr.facts;
    if (!Array.isArray(arr)) continue;
    const out = arr
      .filter((x) => typeof x === 'string')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter((x) => x.length >= 4)
      .slice(0, 6);
    if (out.length) return out;
    // 显式空数组也是可信答案，别再拿后面的片段碰运气
    if (/^\[\s*\]$/.test(raw.trim())) return [];
  }
  return [];
}

/** 从磁盘重新载入（备份还原后用）。 */
export function reload() {
  cache = null;
  return load().length;
}

export function clear() {
  cache = [];
  try {
    writeAtomic(FILE, '');
  } catch {}
}
