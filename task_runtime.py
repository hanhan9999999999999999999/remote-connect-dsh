# -*- coding: utf-8 -*-
"""task_runtime.py — 任务（task/topic）级运行状态（重建版）

【为什么有这个模块】
server.py 里每个任务（topic_id）可以单独钉一个 provider/model；对话主循环还需要
按任务统计「本轮上下文预算 / 已用 input tokens / 当前轮 token / 轮数」，供
`/api/attention` 顶栏工作记忆环和 `/api/task-model` 使用。原实现随另外几个本地模块
一起被误删，这里按现有调用点重建。

【调用点（server.py）】
  - ``import task_runtime``（顶层，导入时绝不抛异常、不写盘）
  - ``task_runtime.snapshot(get_model_config(), task_runtime.load_selection(get_db(), tid), resolve)``
  - ``task_runtime.usage(tid)``
  - ``task_runtime.save_selection(self.db, tid, provider, model)``
  - ``task_runtime.begin(tid, model, budget)``
  - ``task_runtime.record(tid, prompt_tokens, model, budget)``

【两条存储】
  用量：纯内存（进程重启即清零，符合「本轮」语义）。
  选择：内存缓存 + chat.db 的 meta 表（键 ``task_model_<tid>``）。

【永不抛异常】
所有对外的函数都内部 try/except，出错只 ``_log_degrade`` 并返回安全默认值。
server.py 的主循环拿它当「读取用量」用，绝不能因为统计失败把对话搞挂。
"""

from __future__ import annotations

import copy
import json
import os
import sqlite3
import sys
import threading
import time

__all__ = (
    "begin",
    "record",
    "usage",
    "reset",
    "stats",
    "snapshot",
    "save_selection",
    "load_selection",
    "clear_selection",
    "SELECTION_KEY",
)

# 持久化键名。历史上有过两个别名，读取时全部兜一遍（旧库直接升级也能读到）。
SELECTION_KEY = "task_model"
_SELECTION_READ_KEYS = ("task_model", "task_runtime_model", "model_selection")

# 内存里最多跟踪多少个任务。超过就按 updated_at 淘汰最旧的一半 ——
# 这是个纯统计缓存，丢一两条只影响顶栏那一圈数字，不影响任何持久数据。
_MAX_TASKS = 2048

_states: dict[str, dict] = {}
_lock = threading.RLock()

# 选择的进程内缓存：tid -> {"provider","model","saved_at"}。
# 命中时不再打库；写库失败也留在这里，至少本次进程内是对的。
_mem_selection: dict[str, dict] = {}


# ── 小工具 ────────────────────────────────────────────────
def _log_degrade(msg: str) -> None:
    """降级日志。永远不抛异常。"""
    try:
        print("[task_runtime] 降级: %s" % (msg,), file=sys.stderr)
    except Exception:
        pass


def _now() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0


def _safe_int(value, default: int = 0) -> int:
    """把预算/token 这类值安全转 int（容忍 '200000'、'200000.0'、None）。"""
    if value is None or value == "":
        return default
    try:
        return int(value)
    except Exception:
        pass
    try:
        return int(float(value))
    except Exception:
        return default


def _norm_tid(topic_id) -> str:
    """topic_id 规范化：只接受非空标量，统一成 str。"""
    if topic_id is None:
        return ""
    try:
        if isinstance(topic_id, bytes):
            text = topic_id.decode("utf-8", "replace")
        elif isinstance(topic_id, (str, int, float)):
            text = str(topic_id)
        else:
            return ""
        text = text.strip()
        if not text or len(text) > 256:
            return ""
        return text
    except Exception:
        return ""


# ── 内存状态 ──────────────────────────────────────────────
def _blank_state(tid: str, model: str = "", budget=0, now: float = 0.0) -> dict:
    return {
        "topic_id": tid,
        "model": str(model or ""),
        "budget": max(_safe_int(budget, 0), 0),
        "used": 0,
        "latest": 0,
        "peak": 0,
        "turns": 0,
        "started_at": now,
        "updated_at": now,
    }


def _view_locked(st: dict, now: float) -> dict:
    """把内部状态投影成对外 dict（含派生字段）。调用方需持有 _lock。"""
    budget = _safe_int(st.get("budget"), 0)
    used = _safe_int(st.get("used"), 0)
    latest = _safe_int(st.get("latest"), 0)
    peak = _safe_int(st.get("peak"), 0)
    turns = _safe_int(st.get("turns"), 0)
    out = {
        "topic_id": st.get("topic_id") or "",
        "model": st.get("model") or "",
        "budget": budget,
        "used": used,
        "latest": latest,
        "input": latest,
        "peak": peak,
        "turns": turns,
    }
    out["remaining"] = max(budget - used, 0) if budget > 0 else 0
    try:
        out["pct"] = round(used * 100.0 / budget, 2) if budget > 0 else 0.0
    except Exception:
        out["pct"] = 0.0
    started = st.get("started_at") or now or 0.0
    out["started_at"] = started
    try:
        out["elapsed"] = round(max(float(now) - float(started), 0.0), 1)
    except Exception:
        out["elapsed"] = 0.0
    return out


def _evict_locked() -> None:
    """超过 _MAX_TASKS 时按 updated_at 淘汰最旧的一半。调用方需持有 _lock。"""
    try:
        if len(_states) <= _MAX_TASKS:
            return
        ordered = sorted(_states.items(), key=lambda kv: kv[1].get("updated_at", 0) or 0)
        drop = max(len(ordered) // 2, 1)
        for key, _ in ordered[:drop]:
            _states.pop(key, None)
    except Exception:
        pass


# ── 用量：写 ──────────────────────────────────────────────
def begin(topic_id, model: str = "", budget=0) -> dict:
    """开始一个新的大轮：重置该任务的 token 计数，记录模型与预算。

    语义：用户每发一条新消息（非「继续」）都会调用一次；旧计数作废，
    但 provider/model 选择不受影响（那是 save_selection 的事）。

    返回：同 usage() 的 dict；topic_id 非法时返回 {}。
    """
    tid = _norm_tid(topic_id)
    if not tid:
        return {}
    try:
        now = _now()
        with _lock:
            _states[tid] = _blank_state(tid, model, budget, now)
            _evict_locked()
            return _view_locked(_states[tid], now)
    except Exception as exc:
        _log_degrade("begin failed: %s" % exc)
        return {}


def record(topic_id, input_tokens=0, model: str = "", budget=0) -> dict:
    """记录一轮请求的 input tokens（累加 used / 刷新 latest / turns+1）。

    参数：
      topic_id      任务 id
      input_tokens  本轮请求的 prompt_tokens（拿不到真实值时调用方会传估算值）
      model         当前实际使用的模型（可空）
      budget        上下文预算（可空；传了就更新，传 0/None 保留旧值）

    返回：同 usage() 的 dict；topic_id 非法时返回 {}。
    """
    tid = _norm_tid(topic_id)
    if not tid:
        return {}
    try:
        tokens = max(_safe_int(input_tokens, 0), 0)
        now = _now()
        with _lock:
            st = _states.get(tid)
            if st is None:
                st = _blank_state(tid, model, budget, now)
                _states[tid] = st
            st["used"] = _safe_int(st.get("used"), 0) + tokens
            st["latest"] = tokens
            st["peak"] = max(_safe_int(st.get("peak"), 0), tokens)
            st["turns"] = _safe_int(st.get("turns"), 0) + 1
            if model:
                st["model"] = str(model)
            new_budget = _safe_int(budget, 0)
            if new_budget > 0:
                st["budget"] = new_budget
            st["updated_at"] = now
            _evict_locked()
            return _view_locked(st, now)
    except Exception as exc:
        _log_degrade("record failed: %s" % exc)
        return {}


# ── 用量：读/清 ───────────────────────────────────────────
def usage(topic_id) -> dict:
    """读取该任务当前用量。没有记录（或 topic_id 为空）返回 {}。"""
    tid = _norm_tid(topic_id)
    if not tid:
        return {}
    try:
        now = _now()
        with _lock:
            st = _states.get(tid)
            if st is None:
                return {}
            return _view_locked(st, now)
    except Exception as exc:
        _log_degrade("usage failed: %s" % exc)
        return {}


def reset(topic_id) -> bool:
    """清掉一个任务的内存用量（任务删除/切换时可选调用）。"""
    tid = _norm_tid(topic_id)
    if not tid:
        return False
    try:
        with _lock:
            return _states.pop(tid, None) is not None
    except Exception as exc:
        _log_degrade("reset failed: %s" % exc)
        return False


def stats() -> dict:
    """诊断用：当前内存里有多少活任务。"""
    try:
        with _lock:
            snapshot_items = list(_states.values())
            total = sum(_safe_int(item.get("used"), 0) for item in snapshot_items)
            return {
                "active_tasks": len(snapshot_items),
                "total_used": total,
                "max_tasks": _MAX_TASKS,
            }
    except Exception as exc:
        _log_degrade("stats failed: %s" % exc)
        return {"active_tasks": 0, "total_used": 0, "max_tasks": _MAX_TASKS}


# ── 选择：持久化 ──────────────────────────────────────────
def _db_file_path(db) -> str:
    """从各种 db 参数里推断 sqlite 文件路径；推不出返回 ""。"""
    raw = getattr(db, "path", None)
    if raw:
        try:
            if isinstance(raw, (str, bytes, os.PathLike)):
                return os.fsdecode(raw)
            return str(raw)
        except Exception:
            pass
    if isinstance(db, (str, bytes, os.PathLike)):
        try:
            return os.fsdecode(db)
        except Exception:
            return ""
    try:
        if isinstance(db, sqlite3.Connection):
            for row in db.execute("PRAGMA database_list").fetchall():
                if len(row) >= 3 and row[1] == "main":
                    return row[2] or ""
    except Exception:
        return ""
    return ""


def _direct_conn(db):
    """返回 (connection, 是否本函数新建)。推不出路径时返回 (None, False)。"""
    if isinstance(db, sqlite3.Connection):
        return db, False
    path = _db_file_path(db)
    if not path:
        return None, False
    try:
        parent = os.path.dirname(os.path.abspath(path)) or "."
        if not os.path.isdir(parent):
            return None, False
        return sqlite3.connect(path, timeout=10, check_same_thread=True), True
    except Exception as exc:
        _log_degrade("open db failed: %s" % exc)
        return None, False


def _raw_get(db, key: str, tid: str):
    """读一个 topic meta 值。返回 str/None。"""
    getter = getattr(db, "get_topic_meta", None)
    if callable(getter):
        try:
            return getter(tid, key)
        except Exception as exc:
            _log_degrade("get_topic_meta(%s) failed: %s" % (key, exc))
    conn, own = _direct_conn(db)
    if conn is None:
        return None
    try:
        row = conn.execute("SELECT value FROM meta WHERE key=?", ("%s_%s" % (key, tid),)).fetchone()
        return row[0] if row else None
    except Exception:
        return None
    finally:
        if own:
            try:
                conn.close()
            except Exception:
                pass


def _raw_set(db, key: str, tid: str, value: str) -> bool:
    """写一个 topic meta 值。成功 True。"""
    setter = getattr(db, "set_topic_meta", None)
    if callable(setter):
        try:
            setter(tid, key, value)
            return True
        except Exception as exc:
            _log_degrade("set_topic_meta(%s) failed: %s" % (key, exc))
    conn, own = _direct_conn(db)
    if conn is None:
        return False
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ("%s_%s" % (key, tid), value),
        )
        conn.commit()
        return True
    except Exception as exc:
        _log_degrade("sqlite set failed: %s" % exc)
        return False
    finally:
        if own:
            try:
                conn.close()
            except Exception:
                pass


def _parse_selection(value):
    """把持久化值解析成 {"provider","model"}；解析不了返回 None。

    容忍三种历史写法：dict、JSON 字符串、"provider/model" 纯文本。
    """
    if value is None:
        return None
    data = None
    if isinstance(value, dict):
        data = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            data = parsed
        elif isinstance(parsed, (list, tuple)) and len(parsed) >= 2:
            data = {"provider": parsed[0], "model": parsed[1]}
        else:
            parts = [part for part in text.replace("\t", "/").replace("|", "/").split("/") if part]
            if len(parts) == 2:
                return {"provider": parts[0], "model": parts[1]}
            _log_degrade("parse selection failed: %s" % text[:80])
            return None
    else:
        return None
    try:
        provider = str(data.get("provider") or "").strip()
        model = str(data.get("model") or "").strip()
    except Exception:
        return None
    if not provider or not model:
        return None
    out = {"provider": provider, "model": model}
    if "saved_at" in data:
        out["saved_at"] = data.get("saved_at")
    return out


def save_selection(db, topic_id, provider, model) -> bool:
    """把某任务的 provider/model 选择持久化到 chat.db 的 meta 表。

    参数 db：db.Database / sqlite3.Connection / str|Path（chat.db 路径）。
    返回 True=写成功；False=参数不全或存储不可用（调用方不需要处理，下次读会回退默认）。
    """
    tid = _norm_tid(topic_id)
    prov = str(provider or "").strip()
    name = str(model or "").strip()
    if not tid or not prov or not name:
        return False
    try:
        payload = json.dumps(
            {"provider": prov, "model": name, "saved_at": _now()},
            ensure_ascii=False,
        )
        with _lock:
            _mem_selection[tid] = {"provider": prov, "model": name, "saved_at": _now()}
        return bool(_raw_set(db, SELECTION_KEY, tid, payload))
    except Exception as exc:
        _log_degrade("save_selection failed: %s" % exc)
        return False


def load_selection(db, topic_id):
    """读取某任务钉住的 provider/model。没有记录返回 None。

    返回：``{"provider": "...", "model": "...", "saved_at": 123.0?}``
    """
    tid = _norm_tid(topic_id)
    if not tid:
        return None
    try:
        with _lock:
            cached = _mem_selection.get(tid)
        if isinstance(cached, dict):
            return dict(cached)
        for key in _SELECTION_READ_KEYS:
            parsed = _parse_selection(_raw_get(db, key, tid))
            if parsed:
                with _lock:
                    _mem_selection[tid] = dict(parsed)
                return parsed
        return None
    except Exception as exc:
        _log_degrade("load_selection failed: %s" % exc)
        return None


def clear_selection(db, topic_id) -> bool:
    """清掉任务级选择（前端「跟随全局」时可用）。"""
    tid = _norm_tid(topic_id)
    if not tid:
        return False
    try:
        with _lock:
            _mem_selection.pop(tid, None)
        remover = getattr(db, "delete_topic_meta", None)
        if callable(remover):
            try:
                remover(tid, SELECTION_KEY)
                return True
            except Exception:
                pass
        conn, own = _direct_conn(db)
        if conn is None:
            return False
        try:
            conn.execute("DELETE FROM meta WHERE key=?", ("%s_%s" % (SELECTION_KEY, tid),))
            conn.commit()
            return True
        finally:
            if own:
                try:
                    conn.close()
                except Exception:
                    pass
    except Exception as exc:
        _log_degrade("clear_selection failed: %s" % exc)
        return False


# ── 选择：合成任务级配置 ──────────────────────────────────
def _clone_config(base, info: dict):
    """用 resolve 返回的字段克隆 base 同类型的配置对象。

    先按 LLMConfig 的完整签名构造；不认识的类型逐级降参；最后 copy+setattr。
    """
    provider = str(info.get("provider") or "").strip()
    model = str(info.get("model") or "").strip()
    base_url = str(info.get("base_url") or "").strip()
    api_key = str(info.get("api_key") or "").strip()
    protocol = str(info.get("protocol") or "openai").strip() or "openai"
    extra_headers = info.get("extra_headers")
    extra_body = info.get("extra_body")
    max_tokens = _safe_int(getattr(base, "max_tokens", 8192) or 8192, 8192)
    fallback_chain = getattr(base, "fallback_chain", None)
    kwargs = {
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "api_key": api_key,
        "max_tokens": max_tokens,
        "fallback_chain": fallback_chain,
        "protocol": protocol,
        "extra_headers": extra_headers,
        "extra_body": extra_body,
    }
    try:
        return type(base)(**kwargs)
    except Exception:
        pass
    try:
        return type(base)(
            provider=provider,
            model=model,
            base_url=base_url,
            api_key=api_key,
        )
    except Exception:
        pass
    try:
        clone = copy.copy(base)
        for key, value in kwargs.items():
            try:
                setattr(clone, key, value)
            except Exception:
                pass
        return clone
    except Exception:
        return base


def snapshot(model_config, selection, resolve):
    """把「全局模型配置 + 该任务的 provider/model 选择 + 凭据解析」合成任务级配置。

    参数：
      model_config  全局 LLMConfig（server.get_model_config() 的返回值）
      selection     load_selection() 的结果（dict / JSON 字符串 / None）
      resolve       回调 resolve(provider, model, old_config) -> dict，字段：
                    provider/model/base_url/api_key/protocol/extra_headers

    返回：与 model_config 同类型的配置对象。任何一步失败都回退 model_config，
          不抛异常（server.py 的 GET /api/task-model 的 except 只用于兜底日志）。
    """
    try:
        info = _parse_selection(selection)
        if not isinstance(info, dict):
            return model_config
        provider = info.get("provider") or ""
        model = info.get("model") or ""
        if not provider or not model:
            return model_config
        if not callable(resolve):
            return model_config
        try:
            resolved = resolve(provider, model, model_config)
        except Exception as exc:
            _log_degrade("resolve(%s/%s) 失败，回退全局模型: %s" % (provider, model, exc))
            return model_config
        if not isinstance(resolved, dict):
            _log_degrade("resolve(%s/%s) 未返回配置，回退全局模型" % (provider, model))
            return model_config
        merged = dict(resolved)
        merged.setdefault("provider", provider)
        merged.setdefault("model", model)
        if not str(merged.get("base_url") or "").strip():
            _log_degrade("resolve(%s/%s) 缺少 base_url，回退全局模型" % (provider, model))
            return model_config
        return _clone_config(model_config, merged)
    except Exception as exc:
        _log_degrade("snapshot failed: %s" % exc)
        return model_config
