// 统一落盘层：原子写 + 上一版备份 + 坏档隔离。
//
// 为什么需要它（都是这台机器上真踩过的）：
// 1) 直接 writeFileSync 写用户数据，进程被杀或断电会在文件中间留下半截；
// 2) 半截 JSON 下次 JSON.parse 失败 → 各模块的 catch 一律「当作空数据」；
// 3) 紧接着第一次改动又 save() 一遍，把残留也覆盖掉 —— 数据就这么永久没了
//    （messages.jsonl 被写成 0 字节、历史全丢，就是这一类）。
//
// 这里做三件事：
//   writeAtomic(file, data)      写临时文件 → fsync → rename，同分区内是原子的
//   readJson(file, fallback)     主档坏了先挪成 .corrupt-<时间戳>，再回退 .bak
//   readJsonLines(file)          逐行 JSON，坏行跳过并计数，不再让一行毁掉全部历史
//
// 约定：备份只留一版（file.bak）；坏档只留最近 5 个，避免无限堆。

import fs from 'node:fs';
import path from 'node:path';

const CORRUPT_KEEP = 5;

function mkParent(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (_) {}
}

function stamp() {
  // 到毫秒：同一秒内连坏两次时不能撞名（撞名会 rename 覆盖掉前一份证据）
  return new Date().toISOString().replace(/[-:.TZ]/g, '');
}

/** 找一个不存在的名字，避免覆盖已有的坏档。 */
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const p = `${base}-${i}`;
    if (!fs.existsSync(p)) return p;
  }
  return `${base}-${process.pid}`;
}

/** 原子写：先写 .tmp，fsync 落盘，再 rename 覆盖目标。 */
export function writeAtomic(file, data, { backup = true } = {}) {
  mkParent(file);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, buf, 0, buf.length, 0);
    try {
      fs.fsyncSync(fd);
    } catch (_) {
      /* 某些文件系统不支持 fsync，忽略 */
    }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
  if (backup) {
    try {
      if (fs.existsSync(file)) writeAtomic(file + '.bak', fs.readFileSync(file), { backup: false });
    } catch (_) {
      /* 备份失败不挡写入 */
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
  return file;
}

export function writeJson(file, obj, { pretty = false, backup = true } = {}) {
  return writeAtomic(file, JSON.stringify(obj, null, pretty ? 2 : 0), { backup });
}

/** 把坏档挪走（留证据，别静默删除），并只保留最近 CORRUPT_KEEP 个。 */
function quarantine(file, quiet) {
  let moved = null;
  try {
    if (!fs.existsSync(file)) return null;
    moved = uniquePath(`${file}.corrupt-${stamp()}`);
    fs.renameSync(file, moved);
  } catch (_) {
    return null;
  }
  if (!quiet) console.warn(`[store] 坏档已隔离：${path.basename(moved)}`);
  try {
    const dir = path.dirname(file);
    const base = path.basename(file) + '.corrupt-';
    const olds = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(base))
      .sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - CORRUPT_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch (_) {}
    }
  } catch (_) {}
  return moved;
}

function readParsed(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 读 JSON：主档 → 主档坏了就隔离 → .bak → fallback。永不抛。
 * @returns {{value:any, source:'main'|'bak'|'fallback', quarantined:string|null, error:Error|null}}
 */
export function readJsonInfo(file, fallback = null, { quiet = false } = {}) {
  let error = null;
  try {
    return { value: readParsed(file), source: 'main', quarantined: null, error: null };
  } catch (e) {
    error = e;
    // ENOENT 说明没有主档（第一次运行，或崩在 rename 之前）——不算坏档，不隔离
    if (e && e.code !== 'ENOENT') quarantine(file, quiet);
  }
  try {
    return { value: readParsed(file + '.bak'), source: 'bak', quarantined: null, error };
  } catch (_) {}
  return { value: fallback, source: 'fallback', quarantined: null, error };
}

export function readJson(file, fallback = null, opts = {}) {
  return readJsonInfo(file, fallback, opts).value;
}

/**
 * 读 JSONL（每行一个 JSON）：坏行跳过并计数。
 * 旧实现是 `.map(JSON.parse)`，一行半截就整份历史都读不出来。
 * @returns {{items:any[], bad:number, bytes:number}}
 */
export function readJsonLines(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { items: [], bad: 0, bytes: 0 };
  }
  const items = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch (_) {
      bad++;
    }
  }
  if (bad) console.warn(`[store] ${path.basename(file)} 有 ${bad} 行坏数据，已跳过`);
  return { items, bad, bytes: Buffer.byteLength(raw) };
}

export function writeJsonLines(file, list) {
  const body = list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : '');
  return writeAtomic(file, body);
}

/** 体检用：文件大小 / 修改时间 / 备份 / 坏档数量。 */
export function statOf(file) {
  const out = { file: path.basename(file), size: 0, mtimeMs: 0, bak: false, corrupt: 0, backups: 0 };
  try {
    const st = fs.statSync(file);
    out.size = st.size;
    out.mtimeMs = st.mtimeMs;
  } catch (_) {}
  try {
    out.bak = fs.statSync(file + '.bak').size > 0;
  } catch (_) {}
  try {
    const dir = path.dirname(file);
    const corruptBase = path.basename(file) + '.corrupt-';
    const bakBase = path.basename(file) + '.bak-';
    const names = fs.readdirSync(dir);
    out.corrupt = names.filter((n) => n.startsWith(corruptBase)).length;
    out.backups = names.filter((n) => n.startsWith(bakBase)).length;
  } catch (_) {}
  return out;
}
