#!/usr/bin/env python3
"""
API Raw Logger — captures every LLM API request/response body to a dedicated DB table.

Never loses a response: save_raw_response is called whether the stream finishes
normally or errors out.
"""
import json
import os
import sys
import sqlite3
import threading
import time
import uuid


def _db_path():
    """独立日志库路径。

    api_raw_logs 与主业务 messages 表共用 chat.db 会导致：
    - 日志 body 可达数 MB，写入持锁过久 → 主库 add_message 超时 → database is locked
    - 日志无限增长把 chat.db 撑到 GB 级，WAL checkpoint 期间持写锁
    拆到独立 api_logs.db 后，日志写入只锁自己，主库永不阻塞，且日志可无限保留。
    """
    base = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else base
    return os.path.join(data_dir, "data", "api_logs.db")


_ENABLED = False  # 默认关闭：仅开发者模式开启时才写日志，避免浪费资源


def set_enabled(on):
    """开关日志记录（由 server 根据开发者模式设置调用）。"""
    global _ENABLED
    _ENABLED = bool(on)


class ApiLogger:
    """Thread-safe logger for raw LLM API calls."""

    def __init__(self, db_path=None):
        self._db_path = db_path or _db_path()
        self._lock = threading.Lock()
        self._schema_ready = False
        # 关闭状态下不建表、不写库，零开销。
        # 但开关是运行时可切的（设置页打开开发者模式），所以真正建表放到
        # 第一次读写时做 —— 见 _ensure_schema_once()。
        if _ENABLED:
            self._ensure_schema_once()

    def _ensure_schema_once(self):
        """幂等建表：表已存在时只做一次，之后走内存标志位。

        以前的 bug：只在 __init__ 且 _ENABLED 为真时建表。开发者模式是后来
        打开的，于是 fetch_logs()/save_request() 撞上 no such table，
        /api/raw-api-logs 直接 500。
        """
        if self._schema_ready:
            return
        self._ensure_schema()
        self._schema_ready = True

    def _conn(self):
        c = sqlite3.connect(self._db_path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=30000")
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        return c

    def _ensure_schema(self):
        c = self._conn()
        try:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS api_raw_logs (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic_id    TEXT,
                    direction   TEXT NOT NULL CHECK(direction IN ('request','response')),
                    model       TEXT,
                    url         TEXT,
                    body        TEXT NOT NULL DEFAULT '',
                    status_code INTEGER,
                    duration_ms REAL,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    log_group   TEXT,
                    created_at  REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_raw_logs(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_api_logs_group  ON api_raw_logs(log_group);
            """)
            c.commit()
        finally:
            c.close()

    def save_request(self, topic_id, url, body_json, model=""):
        """Save a raw API request. Returns log_group tag for pairing with response."""
        if not _ENABLED:
            return None
        self._ensure_schema_once()
        log_group = uuid.uuid4().hex[:12]
        body_text = json.dumps(body_json, ensure_ascii=False, default=str)
        with self._lock:
            c = self._conn()
            try:
                now = time.time()
                c.execute(
                    """INSERT INTO api_raw_logs
                       (topic_id, direction, model, url, body, log_group, created_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (topic_id, 'request', model, url, body_text, log_group, now)
                )
                c.commit()
                return log_group
            finally:
                c.close()

    def save_response(self, log_group, raw_body, status_code=200, duration_ms=0,
                      input_tokens=0, output_tokens=0):
        """Save a raw API response, paired with its request via log_group."""
        if not _ENABLED or not log_group:
            return
        self._ensure_schema_once()
        with self._lock:
            c = self._conn()
            try:
                now = time.time()
                c.execute(
                    """INSERT INTO api_raw_logs
                       (direction, body, status_code, duration_ms,
                        input_tokens, output_tokens, log_group, created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    ('response', raw_body, status_code, duration_ms,
                     input_tokens, output_tokens, log_group, now)
                )
                c.commit()
            finally:
                c.close()

    def fetch_logs(self, limit=50, offset=0, topic_id=None):
        """Fetch logged entries, newest first. Returns list of dicts.

        按 topic 过滤时要连 response 一起取：response 行本身不存 topic_id，
        只有 request 行带。以前的 SQL 直接 WHERE topic_id=?，导致开发者面板
        永远只看得到请求、看不到回复。现在按 log_group 归属过滤。
        """
        self._ensure_schema_once()
        with self._lock:
            c = self._conn()
            try:
                if topic_id:
                    rows = c.execute(
                        """SELECT * FROM api_raw_logs
                           WHERE topic_id = ?
                              OR (log_group IS NOT NULL AND log_group IN (
                                    SELECT log_group FROM api_raw_logs
                                    WHERE topic_id = ? AND log_group IS NOT NULL))
                           ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                        (topic_id, topic_id, limit, offset)
                    ).fetchall()
                else:
                    rows = c.execute(
                        """SELECT * FROM api_raw_logs ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                        (limit, offset)
                    ).fetchall()

                result = []
                for row in rows:
                    entry = dict(row)
                    # Trim huge bodies for listing
                    body = entry.get("body", "")
                    if body and len(body) > 500:
                        entry["body_preview"] = body[:500] + "..."
                    else:
                        entry["body_preview"] = body
                    result.append(entry)
                return result
            finally:
                c.close()

    def count_logs(self, topic_id=None):
        """Count total entries (topic filter follows log_group, like fetch_logs)."""
        self._ensure_schema_once()
        with self._lock:
            c = self._conn()
            try:
                if topic_id:
                    row = c.execute(
                        """SELECT COUNT(*) as cnt FROM api_raw_logs
                           WHERE topic_id = ?
                              OR (log_group IS NOT NULL AND log_group IN (
                                    SELECT log_group FROM api_raw_logs
                                    WHERE topic_id = ? AND log_group IS NOT NULL))""",
                        (topic_id, topic_id)
                    ).fetchone()
                else:
                    row = c.execute("SELECT COUNT(*) as cnt FROM api_raw_logs").fetchone()
                return row["cnt"] if row else 0
            finally:
                c.close()

    def stats(self):
        """One-shot overview for the devtools panel: counts + size + time span."""
        self._ensure_schema_once()
        with self._lock:
            c = self._conn()
            try:
                row = c.execute(
                    """SELECT COUNT(*) AS total,
                              SUM(CASE WHEN direction='request'  THEN 1 ELSE 0 END) AS requests,
                              SUM(CASE WHEN direction='response' THEN 1 ELSE 0 END) AS responses,
                              MIN(created_at) AS first_at,
                              MAX(created_at) AS last_at,
                              SUM(LENGTH(COALESCE(body,''))) AS bytes
                       FROM api_raw_logs"""
                ).fetchone()
                out = dict(row) if row else {}
                out["enabled"] = bool(_ENABLED)
                try:
                    out["db_bytes"] = os.path.getsize(self._db_path)
                except OSError:
                    out["db_bytes"] = 0
                return out
            finally:
                c.close()

    def clear(self):
        """Drop every logged row (devtools 'clear logs' button)."""
        self._ensure_schema_once()
        with self._lock:
            c = self._conn()
            try:
                n = c.execute("SELECT COUNT(*) FROM api_raw_logs").fetchone()[0]
                c.execute("DELETE FROM api_raw_logs")
                c.commit()
                return int(n or 0)
            finally:
                c.close()


# ── Global singleton ──────────────────────────────────
_logger = None


def get_logger():
    global _logger
    if _logger is None:
        _logger = ApiLogger()
    return _logger


def save_raw_request(topic_id, url, body_json, model=""):
    """Convenience: save request, return log_group."""
    return get_logger().save_request(topic_id, url, body_json, model)


def save_raw_response(log_group, raw_body, status_code=200, duration_ms=0,
                      input_tokens=0, output_tokens=0):
    """Convenience: save response."""
    get_logger().save_response(log_group, raw_body, status_code, duration_ms,
                                input_tokens, output_tokens)
