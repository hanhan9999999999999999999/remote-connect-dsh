#!/usr/bin/env python3
"""有界结果引用库（改造②）—— 超限工具输出落盘，模型按引用 id 翻页读回。

【它解决的问题】
工具结果超过阈值时，旧行为是原地砍中间：被砍掉的部分永久丢失，模型只能看到
开头和结尾。改造②把它们完整落盘，回给模型一个很短的摘要 + 引用 id，需要正文
时用 read_tool_output(id=...) 翻页取回。

【两条消费路径】
- server.py L199-214  → save(payload, topic_id=, tool_name=, is_json=) → 摘要 dict
- tools/tool_output.py → read_page(id, offset=, limit=, grep=, field=, fields=)
                          + stats()（tool_output_stats 工具）

【表结构是既成的，不是这里定的】
data/tool_outputs.db 里的 refs 表由更早的版本建好并留在了磁盘上：
    id TEXT PRIMARY KEY, topic_id TEXT, tool_name TEXT,
    path TEXT NOT NULL, total_bytes INTEGER, total_lines INTEGER,
    is_json INTEGER, created_at REAL
    CREATE INDEX idx_refs_created ON refs(created_at)
本模块严格照抄它 —— 正文落在 data/tool_outputs/<id>.txt，库里只存索引。
改动 schema 会让磁盘上已有的库读不出来，别动。

【纪律】
- 落盘异常绝不允许导致工具结果丢失：save() 抛异常时由调用方回退旧截断。
- 只读工具 read_tool_output 读的是 AI 自己的历史产出，不授予任何写权限。
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

# ── 路径 ────────────────────────────────────────────────────────────────
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, "data")
# 测试隔离开关：照 db.py 的 BIGEYE_DB_PATH 约定
DB_PATH = os.environ.get(
    "BIGEYE_TOOL_OUTPUTS_DB", os.path.join(DATA_DIR, "tool_outputs.db")
)
BLOB_DIR = os.path.join(os.path.dirname(DB_PATH), "tool_outputs")

# ── 参数 ────────────────────────────────────────────────────────────────
TTL_SECONDS = 24 * 3600          # 引用保留 24 小时
MAX_BLOB_BYTES = 32 * 1024 * 1024  # 单条正文上限 32MB，超过直接拒绝落盘
HEAD_LINES = 3                   # 摘要里给的开头行数
TAIL_LINES = 3                   # 摘要里给的结尾行数
PEEK_CHARS = 400                 # 摘要里每行最多截多少字符

_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
_lock = threading.Lock()


# ── 基础设施 ────────────────────────────────────────────────────────────
def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def init_db() -> None:
    """建表 + 索引。幂等，启动时调一次。"""
    os.makedirs(BLOB_DIR, exist_ok=True)
    with _lock:
        con = _connect()
        try:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS refs (
                    id          TEXT PRIMARY KEY,
                    topic_id    TEXT,
                    tool_name   TEXT,
                    path        TEXT NOT NULL,
                    total_bytes INTEGER NOT NULL DEFAULT 0,
                    total_lines INTEGER NOT NULL DEFAULT 0,
                    is_json     INTEGER NOT NULL DEFAULT 0,
                    created_at  REAL NOT NULL
                )
                """
            )
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_refs_created ON refs(created_at)"
            )
            con.commit()
        finally:
            con.close()


def _new_id() -> str:
    return "r-" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(8))


def _log_degrade(msg: str) -> None:
    """落盘链路降级时留痕。绝不抛异常（调用方包在 except 里）。"""
    try:
        line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        with open(os.path.join(DATA_DIR, "toolrefs_degrade.log"), "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass
    try:
        print("[toolrefs] " + msg)
    except Exception:
        pass


# ── 写入 ────────────────────────────────────────────────────────────────
def save(
    payload: str,
    topic_id: Optional[str] = None,
    tool_name: Optional[str] = None,
    is_json: bool = False,
) -> Dict[str, Any]:
    """把超限正文落盘，返回给模型的摘要 dict。

    返回的 `_ref` 就是 read_tool_output(id=...) 要的 id；head/tail 让模型不必
    翻页就知道大概是什么内容。失败直接抛异常 —— 调用方据此回退旧截断。
    """
    if not isinstance(payload, str):
        payload = json.dumps(payload, ensure_ascii=False)
    raw_size = len(payload.encode("utf-8"))
    if raw_size > MAX_BLOB_BYTES:
        raise ValueError("正文 %d 字节超过上限 %d" % (raw_size, MAX_BLOB_BYTES))

    init_db()
    ref_id = _new_id()
    blob_path = os.path.join(BLOB_DIR, ref_id + ".txt")
    with open(blob_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(payload)

    lines = payload.split("\n")
    total_lines = len(lines)
    created = time.time()

    with _lock:
        con = _connect()
        try:
            con.execute(
                "INSERT INTO refs (id, topic_id, tool_name, path, total_bytes,"
                " total_lines, is_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (ref_id, topic_id, tool_name, blob_path, raw_size,
                 total_lines, 1 if is_json else 0, created),
            )
            con.commit()
        except Exception:
            # 索引没写进去就别留孤儿文件
            try:
                os.remove(blob_path)
            except Exception:
                pass
            raise
        finally:
            con.close()

    head = [ln[:PEEK_CHARS] for ln in lines[:HEAD_LINES]]
    tail = [ln[:PEEK_CHARS] for ln in lines[-TAIL_LINES:]] if total_lines > HEAD_LINES else []
    return {
        "_ref": ref_id,
        "tool": tool_name,
        "total_bytes": raw_size,
        "total_lines": total_lines,
        "is_json": bool(is_json),
        "head": head,
        "tail": tail,
        "nextAction": (
            '内容已完整落盘（%d 字节 / %d 行），本次只给摘要。'
            '用 read_tool_output(id="%s") 翻页读全文；'
            '只想要某个字段时加 field="stdout" 之类。' % (raw_size, total_lines, ref_id)
        ),
    }


# ── 读取 ────────────────────────────────────────────────────────────────
def _load_record(ref_id: str) -> Optional[Dict[str, Any]]:
    con = _connect()
    try:
        row = con.execute(
            "SELECT id, topic_id, tool_name, path, total_bytes, total_lines,"
            " is_json, created_at FROM refs WHERE id=?",
            (ref_id,),
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    keys = ("id", "topic_id", "tool_name", "path", "total_bytes",
            "total_lines", "is_json", "created_at")
    rec = dict(zip(keys, row))
    rec["is_json"] = bool(rec["is_json"])
    return rec


def _read_text(rec: Dict[str, Any]) -> Optional[str]:
    try:
        with open(rec["path"], "r", encoding="utf-8", newline="") as fh:
            return fh.read()
    except Exception:
        return None


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def read_page(
    id: str,
    offset: int = 0,
    limit: int = 512,
    grep: Optional[str] = None,
    field: Optional[str] = None,
    fields: Optional[str] = None,
) -> Dict[str, Any]:
    """翻页读一条引用。返回结构由 tools/tool_output.py 消费，别改字段名。"""
    rec = _load_record(id)
    if rec is None:
        return {"error": "找不到引用 %s（可能已被 TTL 清理或 id 写错）" % id}

    raw = _read_text(rec)
    if raw is None:
        return {"error": "引用 %s 的正文文件丢失：%s" % (id, rec["path"])}

    try:
        obj = json.loads(raw) if rec["is_json"] else None
    except Exception:
        obj = None

    meta = {
        "id": id,
        "tool": rec["tool_name"],
        "total_bytes": rec["total_bytes"],
        "total_lines": rec["total_lines"],
    }

    # ① 多字段概览投影：长值省略，一次性回答「里面都有什么」
    if fields and isinstance(obj, dict):
        wanted = [f.strip() for f in fields.split(",") if f.strip()]
        view: Dict[str, Any] = {}
        missing: List[str] = []
        for key in wanted:
            if key not in obj:
                missing.append(key)
                continue
            text = _as_text(obj[key])
            view[key] = text if len(text) <= PEEK_CHARS else (
                text[:PEEK_CHARS] + "…（共 %d 字符）" % len(text)
            )
        out = dict(meta)
        out.update({"mode": "fields", "fields": view, "available": list(obj.keys())[:30]})
        if missing:
            out["missing"] = missing
        return out

    # ② 单字段全文：最长字段（stdout/content）用这个，别按行翻，省轮次
    if field:
        if isinstance(obj, dict):
            if field not in obj:
                return {
                    "error": "字段 %s 不存在，可用: %s" % (field, list(obj.keys())[:30])
                }
            text = _as_text(obj[field])
        else:
            if field != "content":
                return {"error": "该引用不是 JSON，只有 field='content' 可用"}
            text = raw
        lines = text.split("\n")
        base = max(0, int(offset or 0))
        take = max(1, min(512, int(limit or 512)))
        sel = lines[base:base + take]
        out = dict(meta)
        out.update({
            "mode": "field",
            "field": field,
            "total_lines": len(lines),
            "offset": base,
            "lines": sel,
            "has_more": base + take < len(lines),
        })
        return out

    # ③ 普通翻页（可 grep）
    lines = raw.split("\n")
    base = max(0, int(offset or 0))
    take = max(1, min(512, int(limit or 512)))

    if grep:
        matched = [ln for ln in lines if grep in ln]
        sel = matched[base:base + take]
        out = dict(meta)
        out.update({
            "offset": base,
            "lines": sel,
            "has_more": base + take < len(matched),
            "matched_lines": len(matched),
            "grep": grep,
        })
        if not matched:
            out["note"] = "没有任何行包含 %r" % grep
        return out

    sel = lines[base:base + take]
    out = dict(meta)
    out.update({
        "offset": base,
        "lines": sel,
        "has_more": base + take < len(lines),
    })
    return out


# ── 维护 ────────────────────────────────────────────────────────────────
def cleanup(ttl_seconds: float = TTL_SECONDS) -> int:
    """删掉过期引用（DB 行 + 正文文件），返回清理条数。启动时调一次。"""
    init_db()
    cutoff = time.time() - float(ttl_seconds)
    with _lock:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT id, path FROM refs WHERE created_at < ?", (cutoff,)
            ).fetchall()
            if not rows:
                return 0
            for ref_id, blob in rows:
                try:
                    if blob and os.path.exists(blob):
                        os.remove(blob)
                except Exception as exc:
                    _log_degrade("cleanup unlink failed for %s: %s" % (ref_id, exc))
            con.executemany("DELETE FROM refs WHERE id=?", [(r[0],) for r in rows])
            con.commit()
            return len(rows)
        finally:
            con.close()


def stats() -> Dict[str, Any]:
    """引用库现状。tool_output_stats 工具直接返回它。"""
    init_db()
    con = _connect()
    try:
        row = con.execute(
            "SELECT COUNT(*), COALESCE(SUM(total_bytes), 0),"
            " MIN(created_at), MAX(created_at) FROM refs"
        ).fetchone()
    finally:
        con.close()
    count, stored_bytes, oldest, newest = row
    blob_files = 0
    blob_bytes = 0
    try:
        for name in os.listdir(BLOB_DIR):
            if not name.endswith(".txt"):
                continue
            blob_files += 1
            try:
                blob_bytes += os.path.getsize(os.path.join(BLOB_DIR, name))
            except Exception:
                pass
    except Exception:
        pass
    return {
        "count": int(count or 0),
        "stored_chars": int(stored_bytes or 0),   # 字段名沿用调用方的历史叫法
        "stored_bytes": int(stored_bytes or 0),
        "blob_files": blob_files,
        "blob_bytes": blob_bytes,
        "db_path": DB_PATH,
        "blob_dir": BLOB_DIR,
        "ttl_hours": TTL_SECONDS / 3600.0,
        "oldest": oldest,
        "newest": newest,
    }


def purge_all() -> int:
    """清空整个引用库（运维/测试用，正常流程不该调）。"""
    init_db()
    with _lock:
        con = _connect()
        try:
            rows = con.execute("SELECT id, path FROM refs").fetchall()
            for _ref_id, blob in rows:
                try:
                    if blob and os.path.exists(blob):
                        os.remove(blob)
                except Exception:
                    pass
            con.execute("DELETE FROM refs")
            con.commit()
            return len(rows)
        finally:
            con.close()


__all__ = [
    "init_db", "save", "read_page", "cleanup", "stats", "purge_all",
    "_log_degrade", "DB_PATH", "BLOB_DIR", "TTL_SECONDS",
]
