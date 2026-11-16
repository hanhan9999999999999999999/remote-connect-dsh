/**
 * 读 DSH 的会话存档（~/.dsh/sessions），给手机端做「挑选历史对话」。
 *
 * 存储形态：<root>/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd
 *   - 多帧拼接的 zstd，逐帧自解压；帧内是 JSONL 记录
 *   - 记录类型：session / user/message / assistant/message / session/title / tool/call ...
 *
 * v2 性能设计（旧实现一进历史抽屉要等十几秒）：
 *   1. 每个存档一个「帧累加器」：记住已经解到第几个字节，文件追加时只解压新尾帧。
 *      正在聊的会话每轮都在长，旧实现每次都把整份 26 MB 存档重解压一遍。
 *   2. 累加器落磁盘索引 runtime/session-index.json，重启后不用重新扫 118 MB 存档。
 *   3. 正文预览有条数上限（PREVIEW_CAP），列表/搜索/翻页都在这段窗口里做，
 *      内存和索引文件都是有界的。
 *
 * 全程只读投影，不改动任何存档。
 */
import fs from 'node:fs';
import { readJson, writeJson } from './store.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const SESSIONS_ROOT =
  process.env.PHONE_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions');

/** 每个会话在内存里保留的正文条数上限（尾部）。翻更早时超出这段就不再回溯。 */
const PREVIEW_CAP = 400;
/** 单条正文预览的字符上限：再长对手机端也没用，还占内存和索引。 */
const PREVIEW_CHARS = 900;
/**
 * 落磁盘索引时进一步压缩，控制索引文件体积（当前约 5 MB）。
 * 索引里留 240 条是为了「重启后搜全部」还有足够深度；
 * 再老的正文要靠会话文件本身，重新打开该会话时才会重新解压。
 */
const INDEX_PREVIEWS = 240;
const INDEX_PREVIEW_CHARS = 200;
const INDEX_VERSION = 2;

/** 判断是不是 harness 注入的上下文（不是人打的字），这类不往手机端显示。 */
function isInjected(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (s.startsWith('[附件] 手机发来')) return false; // 桥接自己拼的摘要，保留
  if (s.startsWith('Current runtime context')) return true;
  if (s.startsWith('[Compressed conversation')) return true;
  if (s.startsWith('<system-reminder>')) return true;
  if (s.startsWith('<hindsight_knowledge')) return true;
  if (s.includes('<available_skills>')) return true;
  if (s.includes('This snapshot supersedes earlier runtime-context')) return true;
  // 每次运行时注入的时间戳 / 环境说明（DSH 自己加的，不是人说的话）
  if (s.startsWith('Time sampled while preparing')) return true;
  if (s.startsWith('Browser time zone for this request')) return true;
  if (s.startsWith('Elapsed since the preceding')) return true;
  // 清空上下文这类系统动作留下的占位
  if (/^\[Compressed conversation section\]/.test(s)) return true;
  if (s.includes('<goal_round>') || s.startsWith('<goal_complete>')) return true;
  return false;
}

/** 扫描拼接在一起的 zstd 帧边界（只读帧头，不解压）。返回的 offset 相对 buffer。 */
function scanFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    let ok = true;
    for (;;) {
      if (buffer.length - offset < 3) { ok = false; break; }
      const header = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = header & 1;
      const type = (header >>> 1) & 3;
      const size = header >>> 3;
      offset += type === 1 ? 1 : size;
      if (last) break;
    }
    // 末帧可能正写到一半：只收完整帧，剩下的字节下次再读
    if (!ok || offset > buffer.length) break;
    if (checksum) offset += 4;
    frames.push({ start, end: Math.min(offset, buffer.length) });
    if (offset >= buffer.length) break;
  }
  return frames;
}

/** 读文件的一段字节（增量解析用）。 */
function readRange(file, from, to) {
  const len = to - from;
  if (len <= 0) return null;
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (!n) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

const pickText = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c && (c.type === 'text' || c.type === 'input-text') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();

function clip(s, n = PREVIEW_CHARS) {
  const t = String(s || '').replace(/\r/g, '').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 助手消息的可读正文。
 * 真实文本优先；没有文本就退到工具调用清单；再没有就退到 reasoning 摘要。
 * 旧实现只看 text，纯工具轮次的会话会变成「0 条正文」，点进去一片空白。
 */
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = pickText(content);
  if (text) return clip(text);
  const tools = content
    .filter((c) => c && c.type === 'tool-call')
    .map((c) => c.name)
    .filter(Boolean);
  if (tools.length) return clip(`⏺ ${[...new Set(tools)].join('、')}`, 160);
  const think = content.find((c) => c && c.type === 'reasoning' && typeof c.text === 'string');
  if (think) return clip(`…${String(think.text).replace(/\s+/g, ' ')}`, 200);
  return '';
}

/** 标题清洗：去掉 markdown 噪音，太长截断。注意别把词里的下划线/连字符也剃掉（ops_bash 会变成 opsbash）。 */
function cleanTitle(t, n = 60) {
  const s = String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t>#*+~-]+/gm, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 会话目录 → 记录文件（优先 zstd，其次明文），顺便带回 stat 少一次系统调用。 */
function locate(dir) {
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
    const file = path.join(dir, name);
    try {
      return { file, stat: fs.statSync(file) };
    } catch {}
  }
  return null;
}

function newState() {
  return {
    id: '',
    cwd: '',
    createdAt: 0,
    title: null,
    preset: null,
    permission: null,
    users: 0,
    assistants: 0,
    turns: 0,
    lastTime: 0,
    firstUser: null,
    previewCount: 0,
    previews: [],
    byteEnd: 0,
    size: 0,
    mtimeMs: 0,
  };
}

function pushPreview(s, role, text, time) {
  if (!text) return;
  s.previewCount += 1;
  s.previews.push({ role, text, time: typeof time === 'number' ? time : 0 });
  if (s.previews.length > PREVIEW_CAP) s.previews.splice(0, s.previews.length - PREVIEW_CAP);
}

/** 把一条存档记录折进累加器。 */
function ingest(s, r) {
  if (!r || typeof r !== 'object') return;
  if (typeof r.time === 'number' && r.time > s.lastTime) s.lastTime = r.time;
  switch (r.type) {
    case 'session':
      if (r.id) s.id = String(r.id);
      if (typeof r.cwd === 'string') s.cwd = r.cwd;
      if (typeof r.createdAt === 'number') s.createdAt = r.createdAt;
      if (typeof r.agentPreset === 'string') s.preset = r.agentPreset;
      else if (typeof r.preset === 'string') s.preset = r.preset;
      break;
    case 'session/title': {
      const t = r.data?.title ?? r.title;
      if (t) s.title = String(t);
      break;
    }
    case 'agent/preset': {
      const p = r.data?.name ?? r.data?.preset ?? r.data?.id ?? r.data?.value;
      if (p) s.preset = String(p);
      break;
    }
    case 'permission/preset': {
      const p = r.data?.preset ?? r.data?.name ?? r.data?.value;
      if (p) s.permission = String(p);
      break;
    }
    case 'turn/start':
      s.turns += 1;
      break;
    case 'user/message': {
      s.users += 1;
      const t = pickText(r.data?.content);
      // 注入的运行时上下文 / 系统提示不展示给手机端
      if (t && !isInjected(t)) {
        if (!s.firstUser) s.firstUser = t;
        pushPreview(s, 'user', clip(t), r.time);
      }
      break;
    }
    case 'assistant/message': {
      s.assistants += 1;
      const t = assistantText(r.data?.message);
      if (t) pushPreview(s, 'assistant', t, r.time);
      break;
    }
    default:
      break;
  }
}

/* ---------------------------------------------------------------- 累加器缓存 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE =
  process.env.PHONE_SESSION_INDEX || path.join(HERE, 'runtime', 'session-index.json');
const sumCache = new Map(); // file -> state
let indexDirty = false;
let indexTimer = null;
let indexLoaded = false;

function indexLoad() {
  if (indexLoaded) return;
  indexLoaded = true;
  try {
    const raw = readJson(INDEX_FILE, null, { quiet: true });
    if (!raw || raw.v !== INDEX_VERSION || !raw.files) return;
    for (const [file, entry] of Object.entries(raw.files)) {
      if (!entry || typeof entry.mtimeMs !== 'number') continue;
      const s = Object.assign(newState(), entry);
      if (!Array.isArray(s.previews)) s.previews = [];
      sumCache.set(file, s);
    }
  } catch {
    // 没有索引文件或损坏：就当空的，下次重建
  }
}

function indexSaveSoon() {
  indexDirty = true;
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    if (!indexDirty) return;
    indexDirty = false;
    try {
      const files = {};
      for (const [file, s] of sumCache.entries()) {
        files[file] = {
          ...s,
          previews: s.previews
            .slice(-INDEX_PREVIEWS)
            .map((p) => ({ role: p.role, text: String(p.text || '').slice(0, INDEX_PREVIEW_CHARS), time: p.time })),
        };
      }
      writeJson(INDEX_FILE, { v: INDEX_VERSION, at: Date.now(), files });
    } catch {
      // 索引写不进去不影响功能
    }
  }, 1500);
  if (indexTimer.unref) indexTimer.unref();
}

/** 增量更新一个存档：只解压上次之后新增的帧。 */
function updateOne(file, stat, idHint) {
  const prev = sumCache.get(file);
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return prev;

  let s = prev;
  let from = 0;
  const zstd = file.endsWith('.zstd');
  // 存档被重写 / 截断 / 大小没变但内容变了 → 整个重建
  if (!s || !zstd || stat.size < s.byteEnd || (stat.size === s.byteEnd && stat.mtimeMs !== s.mtimeMs)) {
    s = newState();
  } else {
    from = s.byteEnd;
  }
  if (idHint && !s.id) s.id = idHint;

  if (stat.size > from) {
    const tail = readRange(file, from, stat.size);
    if (tail && tail.length) {
      if (!zstd) {
        for (const line of tail.toString('utf8').split('\n')) {
          if (!line) continue;
          let rec = null;
          try { rec = JSON.parse(line); } catch { continue; }
          ingest(s, rec);
        }
        s.byteEnd = stat.size;
      } else {
        for (const f of scanFrames(tail)) {
          let text;
          try {
            text = zlib.zstdDecompressSync(tail.subarray(f.start, f.end)).toString('utf8');
          } catch {
            continue;
          }
          for (const line of text.split('\n')) {
            if (!line) continue;
            let rec = null;
            try { rec = JSON.parse(line); } catch { continue; }
            ingest(s, rec);
          }
          s.byteEnd = from + f.end; // 只推进到完整帧的末尾
        }
      }
    }
  }

  s.size = stat.size;
  s.mtimeMs = stat.mtimeMs;
  sumCache.set(file, s);
  if (sumCache.size > 2000) {
    // 兜底淘汰：按最后活动时间丢掉最旧的一半（索引里有 byteEnd，重建很便宜）。
    // 阈值不能贴着实际会话数走：以前是 200，而本机有 203 个会话 ——
    // 每更新一条就淘汰 100 条，下一次列历史又得整份解压重建，接口稳定慢 5 秒。
    const sorted = [...sumCache.entries()].sort(
      (a, b) => (a[1].lastTime || 0) - (b[1].lastTime || 0)
    );
    for (const [f] of sorted.slice(0, 1000)) if (f !== file) sumCache.delete(f);
  }
  indexSaveSoon();
  return s;
}

/** 累加器 → 对外的会话摘要。 */
function view(s) {
  // 标题优先真人说的话；退而求其次用一条像话的正文，别拿「⏺ 工具名」当标题
  const firstPreview =
    s.previews.find((p) => p.role === 'user') ||
    s.previews.find((p) => !/^[⏺…]/.test(String(p.text || ''))) ||
    s.previews[0];
  const title =
    cleanTitle(s.title || s.firstUser || (firstPreview && firstPreview.text)) || '(无标题)';
  return {
    id: s.id,
    cwd: s.cwd,
    createdAt: s.createdAt,
    updatedAt: s.lastTime || s.createdAt || 0,
    title,
    messages: s.users + s.assistants,
    preset: s.preset,
    permission: s.permission,
    turns: s.turns,
    previews: s.previews,
    previewCount: s.previewCount,
  };
}

/* ------------------------------------------------------------------ 对外接口 */

/** 后台预热会话索引（避免用户第一次「搜全部」时等几秒）。 */
export function warmIndex() {
  try {
    collectSessions();
  } catch {
    // 预热失败无所谓
  }
}

/** 列出所有历史会话（按最后活动时间倒序），带正文预览。 */
export function collectSessions() {
  const out = [];
  indexLoad();
  let cwdDirs = [];
  try {
    cwdDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const cwdDir of cwdDirs) {
    const cwdPath = path.join(SESSIONS_ROOT, cwdDir.name);
    let dirs = [];
    try {
      dirs = fs.readdirSync(cwdPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.name.startsWith('session-')) continue;
      const info = locate(path.join(cwdPath, d.name));
      if (!info) continue;
      let s;
      try {
        s = updateOne(info.file, info.stat, d.name);
      } catch {
        continue;
      }
      if (!s) continue;
      // 只有 header、没有任何对话的空会话不往历史列表里塞
      if (!s.users && !s.assistants) continue;
      out.push(view(s));
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

/** 历史列表（不带正文，省流量）。 */
export function listSessions({ limit = 60 } = {}) {
  return collectSessions()
    .slice(0, limit)
    .map(({ previews, ...rest }) => rest);
}

/**
 * 跨所有会话搜索正文（手机端「搜全部」用）。
 * 返回 [{ sessionId, title, at, role, snippet, full }]，按命中顺序（最近的会话优先）。
 */
export function searchAll(q, { limit = 40, perSession = 6, maxSessions = 40 } = {}) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return [];
  const hits = [];
  const sessions = collectSessions().slice(0, maxSessions);
  for (const s of sessions) {
    let n = 0;
    for (const p of s.previews || []) {
      const t = String(p.text || '');
      const i = t.toLowerCase().indexOf(kw);
      if (i < 0) continue;
      const from = Math.max(0, i - 24);
      const to = Math.min(t.length, i + kw.length + 60);
      const snippet =
        (from > 0 ? '…' : '') + t.slice(from, to).replace(/\s+/g, ' ') + (to < t.length ? '…' : '');
      hits.push({
        sessionId: s.id,
        title: s.title,
        at: p.time || s.updatedAt || 0,
        role: p.role,
        snippet,
        full: t.slice(0, 600),
      });
      n += 1;
      if (n >= perSession) break;
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export function cacheStats() {
  let previews = 0;
  for (const s of sumCache.values()) previews += s.previews.length;
  return { sessions: sumCache.size, previews };
}

/** 读某个会话的正文（手机端展示用），从末尾往前取 limit 条（skip 用来「加载更早」）。 */
export function readTranscript(id, { limit = 40, skip = 0 } = {}) {
  if (!/^session-[A-Za-z0-9-]+$/.test(String(id || ''))) return null;
  indexLoad();
  let cwdDirs = [];
  try {
    cwdDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  const dirName = String(id);
  for (const cwdDir of cwdDirs) {
    const dir = path.join(SESSIONS_ROOT, cwdDir.name, dirName);
    const info = locate(dir);
    if (!info) continue;
    let s;
    try {
      s = updateOne(info.file, info.stat, dirName);
    } catch {
      continue;
    }
    if (!s) continue;

    const v = view(s);
    const total = s.previewCount;
    const avail = s.previews.length;
    const base = Math.max(0, total - avail); // 已经被 PREVIEW_CAP 挤掉的条数
    const end = Math.max(0, total - Math.max(0, skip));
    const wantStart = Math.max(0, end - Math.max(1, limit));
    const from = Math.max(wantStart, base);
    const to = Math.max(from, end);
    const items = s.previews.slice(from - base, to - base);
    const clamped = wantStart < base; // 想翻的那段已经不在缓存窗口里了
    return {
      id: v.id,
      cwd: v.cwd,
      title: v.title,
      messages: v.messages,
      updatedAt: v.updatedAt,
      items,
      total,
      hasMore: !clamped && from > 0,
      truncated: base > 0,
      skip: Math.max(0, skip),
    };
  }
  return null;
}

/** 按 id 取出该会话的原始记录（只读，诊断/统计用）。 */
export function recordsOf(id) {
  const sid = String(id || '');
  if (!/^session-[A-Za-z0-9-]+$/.test(sid)) return [];
  let cwdDirs = [];
  try {
    cwdDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const cwdDir of cwdDirs) {
    const dir = path.join(SESSIONS_ROOT, cwdDir.name, sid);
    const info = locate(dir);
    if (!info) continue;
    const raw = readRange(info.file, 0, info.stat.size);
    if (!raw) return [];
    const out = [];
    const push = (line) => {
      if (!line) return;
      try { out.push(JSON.parse(line)); } catch {}
    };
    if (!info.file.endsWith('.zstd')) {
      for (const line of raw.toString('utf8').split('\n')) push(line);
      return out;
    }
    for (const f of scanFrames(raw)) {
      let text;
      try {
        text = zlib.zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) push(line);
    }
    return out;
  }
  return [];
}

/** 导出用的助手全文：优先正文，没有正文退工具名 / 推理摘要。不裁剪长度。 */
function assistantFull(message) {
  const m = message || {};
  const parts = [];
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c && c.type === 'text' && c.text) parts.push(String(c.text));
  }
  if (parts.length) return parts.join('\n\n').trim();
  const tools = (Array.isArray(m.content) ? m.content : [])
    .filter((c) => c && (c.type === 'tool_use' || c.type === 'tool-use' || c.type === 'tool_call'))
    .map((c) => c.name || c.tool || '');
  const uniq = [...new Set(tools.filter(Boolean))];
  if (uniq.length) return `（工具调用：${uniq.join('、')}）`;
  const think = (m.reasoning || m.reasoning_content || '').toString().replace(/\s+/g, ' ').trim();
  if (think) return `（推理片段）${think.slice(0, 400)}`;
  return '';
}

/**
 * 整份会话的完整记录（导出 / 备份用）：不走预览缓存，直接解全部帧。
 * 代价是重解压一次（26 MB 的会话约 0.3~0.5 s），只在用户点「导出」时调用。
 */
export function fullTranscript(id, { limit = 0 } = {}) {
  const sid = String(id || '');
  if (!/^session-[A-Za-z0-9-]+$/.test(sid)) return null;
  const recs = recordsOf(sid);
  if (!recs.length) return null;
  const s = newState();
  s.id = sid;
  for (const r of recs) ingest(s, r);
  const items = [];
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'user/message') {
      const t = pickText(r.data?.content);
      if (t && !isInjected(t)) items.push({ role: 'user', text: String(t).trim(), time: r.time || 0 });
    } else if (r.type === 'assistant/message') {
      const t = assistantFull(r.data?.message);
      if (t) items.push({ role: 'assistant', text: t, time: r.time || 0 });
    }
  }
  const v = view(s);
  const total = items.length;
  const keep = limit > 0 ? Math.max(0, total - limit) : 0;
  return {
    id: sid,
    cwd: v.cwd,
    title: v.title,
    createdAt: s.createdAt || 0,
    updatedAt: v.updatedAt,
    items: keep ? items.slice(keep) : items,
    total,
    truncated: keep > 0,
  };
}

export function sessionCwd(id) {
  const t = readTranscript(id, { limit: 1 });
  return t?.cwd ?? null;
}
