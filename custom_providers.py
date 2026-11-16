# -*- coding: utf-8 -*-
"""第三方模型源注册表（**重建版**）。

原文件在项目里被误删，本文件按 server.py / llm.py 现有的调用点重建：
注册表读写 → 归一化 → 协议探测 → 余额查询，四件事都在这一个模块里。

数据文件
--------
``<ROOT_DIR>/custom_providers.json``（UTF-8，缩进 2）。ROOT_DIR 由调用方传进来，
模块自己不猜项目根。结构::

    {
      "version": 1,
      "updated_at": 1699999999,
      "providers": [
        {
          "id": "my-relay",              # 源 id，也是 model_config.json 里的 provider 值
          "name": "我的中转",             # 显示名（前端「备注」）
          "base_url": "https://x/v1",    # 用户填的原始地址
          "api_base": "https://x/v1",    # 归一化/探测校正后的实际根
          "protocol": "openai",          # auto | openai | anthropic
          "api_key": "sk-...",
          "headers": {},
          "models": [{"id": "gpt-4o", "name": "gpt-4o"}],
          "vision": false,
          "enabled": true,
          "ctx_window": 0,
          "note": "",
          "balance_manual": {"value": 0.0, "currency": "CNY", "updated_at": 0},
          "balance_auth": {"user_id": "", "system_token": "", "refresh_token": ""},
          "created_at": 1699999999,
          "updated_at": 1699999999
        }
      ]
    }

设计约束（都是踩过的坑，改之前先读）
------------------------------------
* **永不抛异常**。这里是「设置页」的底座，任何一处抛都会把整个设置页打成 500。
  失败一律记 ``LAST_ERRORS`` 并返回安全默认值。
* ``_norm_item`` 必须补成**完整形状** —— server.py 里有 ``cp["models"]`` /
  ``cp["protocol"]`` / ``cp["api_key"]`` 这种下标访问，缺键直接 500。
* ``runtime_config`` 对**内置源返回 None**，让 llm.py 走自己的默认地址。
* 写盘是原子写 + 重试：Windows 上杀软/索引器会短暂占用目标文件。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from collections import deque
from urllib.parse import urlencode, urlsplit

import requests

# 协议取值。auto = 探测时两种都试。
PROTOCOLS = frozenset(("auto", "openai", "anthropic"))

# 内置源：这些 id 不允许被第三方记录占用，也不允许删除。
BUILTIN_IDS = frozenset(("deepseek", "zhipu", "openrouter", "dmxapi", "leadera"))

DATA_FILENAME = "custom_providers.json"
_DATA_VERSION = 1

# 前端靠这个字符识别「这是脱敏回显，不是真密钥」。改它前端就会把掩码当明文存回去。
MASK_CHAR = "•"

MAX_MODELS = 500

# 最近 50 条失败原因，供 /api/custom-providers/errors 之类的诊断入口取。
LAST_ERRORS: deque = deque(maxlen=50)

_LOCK = threading.RLock()

# 用户粘地址时最常见的错误是把接口路径也粘进来。这些后缀一律削掉。
_ENDPOINT_SUFFIXES = (
    "/chat/completions",
    "/completions",
    "/messages",
    "/responses",
    "/embeddings",
    "/models",
)

# one-api / new-api 的 quota 单位：500000 quota = 1 USD。
_QUOTA_PER_USD = 500000.0


# ── 错误缓冲 ──────────────────────────────────────────────
def _err(where: str, exc=None) -> None:
    """记一条可读的失败原因：stdout + 环形缓冲。绝不抛。"""
    try:
        if exc is None:
            text = str(where)
        else:
            text = "%s: %s: %s" % (where, type(exc).__name__, exc)
        LAST_ERRORS.append({"at": int(time.time()), "where": str(where), "error": text})
        try:
            print("[custom_providers] %s" % text)
        except Exception:
            pass
    except Exception:
        pass


def last_errors(n: int = 20) -> list:
    """最近 n 条失败原因（副本，调用方随便改）。"""
    try:
        count = max(int(n), 0)
    except Exception:
        count = 20
    with _LOCK:
        items = list(LAST_ERRORS)
    return items[-count:] if count else []


# ── 小工具 ────────────────────────────────────────────────
def _now() -> int:
    try:
        return int(time.time())
    except Exception:
        return 0


def _as_int(value, default: int = 0) -> int:
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


def _as_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    try:
        text = str(value).strip().lower()
    except Exception:
        return default
    if text in ("1", "true", "yes", "y", "on"):
        return True
    if text in ("0", "false", "no", "n", "off", ""):
        return False
    return default


def _as_float(value, default=None):
    if value is None or value == "":
        return default
    try:
        return float(value)
    except Exception:
        return default


def _clean_str(value, limit: int = 4000) -> str:
    if value is None:
        return ""
    try:
        if isinstance(value, bytes):
            text = value.decode("utf-8", "replace")
        else:
            text = str(value)
        return text.strip()[:limit]
    except Exception:
        return ""


# ── 地址 ──────────────────────────────────────────────────
def _looks_local(hostpart: str) -> bool:
    """判断是不是本机/内网地址（决定补 http:// 还是 https://）。"""
    try:
        host = (hostpart or "").split(":")[0].strip().lower()
    except Exception:
        return False
    if not host:
        return False
    if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"):
        return True
    if host.startswith("192.168.") or host.startswith("10.") or host.startswith("172.16."):
        return True
    for prefix in ("172.17.", "172.18.", "172.19.", "172.2", "172.30.", "172.31."):
        if host.startswith(prefix):
            return True
    if host.endswith(".local") or host.endswith(".lan") or host.endswith(".internal"):
        return True
    # 纯主机名（没有点）几乎一定是内网机器名
    return "." not in host


def normalize_base_url(base: str) -> str:
    """把用户粘进来的地址收拾成「一个根」：补 scheme、去尾斜杠、削接口后缀。

    只做**不需要联网**就能确定的事。少一层 /v1 这种只能靠 probe 实测，
    所以这里不强行拼 /v1：拼错了反而会把一个能用的地址改成不能用的。
    """
    text = _clean_str(base)
    if not text:
        return ""
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", text):
        try:
            hostpart = text.split("/")[0]
        except Exception:
            hostpart = text
        text = ("http://" if _looks_local(hostpart) else "https://") + text
    # 削掉末尾的接口路径（可能连着好几层）
    changed = True
    while changed:
        changed = False
        lowered = text.lower().rstrip("/")
        for suffix in _ENDPOINT_SUFFIXES:
            if lowered.endswith(suffix):
                text = text.rstrip("/")[: -len(suffix)]
                changed = True
                break
    # 去掉查询串/锚点（粘贴整条请求时会有）
    for sep in ("?", "#"):
        if sep in text:
            text = text.split(sep, 1)[0]
    text = text.rstrip("/")
    return text


def _host_of(host: str) -> str:
    """netloc（含端口，小写）——判重/挑适配器都按它说话。"""
    text = _clean_str(host)
    if not text:
        return ""
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
        return (parts.netloc or "").lower()
    except Exception:
        return ""


def _origin_of(host: str) -> str:
    """scheme://netloc —— 厂商接口基本都挂在站点根上。"""
    text = _clean_str(host)
    if not text:
        return ""
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
        return "%s://%s" % (parts.scheme or "https", (parts.netloc or "").lower())
    except Exception:
        return ""


def _without_v1(host: str) -> str:
    """去掉末尾的 /v1（one-api 的账单接口挂在站点根，不在 /v1 下面）。"""
    text = _clean_str(host).rstrip("/")
    if text.lower().endswith("/v1"):
        text = text[:-3].rstrip("/")
    return text


# ── id / 密钥 ─────────────────────────────────────────────
def _is_ascii_id(s: str) -> bool:
    try:
        text = str(s)
        return bool(re.match(r"^[a-z0-9][a-z0-9._-]*$", text))
    except Exception:
        return False


def _slug(s: str, limit: int = 40) -> str:
    """把中文/空格/符号的名字压成一个能用做 provider id 的 slug。"""
    text = _clean_str(s).lower()
    if not text:
        return ""
    out = []
    for ch in text:
        if ("a" <= ch <= "z") or ("0" <= ch <= "9"):
            out.append(ch)
        elif ch in "._-":
            out.append(ch)
        elif ch in " \t_/\\|:":
            out.append("-")
        # 中文等非 ASCII 直接丢掉（id 要能进 URL 和文件名）
    slug = re.sub(r"-{2,}", "-", "".join(out)).strip("-._")
    return slug[:limit]


def mask_key(s: str) -> str:
    """密钥脱敏。**掩码字符必须是 ``•``**（server.py 用它识别脱敏回显）。

    ``sk-1234567890abcdef`` → ``sk-••••cdef``

    空值返回空串 —— 前端用 ``has_key`` 判断有没有配密钥，不看这里。
    """
    text = _clean_str(s)
    if not text:
        return ""
    if len(text) <= 8:
        return MASK_CHAR * len(text)
    head = text[:3]
    tail = text[-4:]
    return "%s%s%s" % (head, MASK_CHAR * 4, tail)


def data_path(root) -> str:
    """数据文件的绝对路径（ROOT_DIR 传空时退化为当前工作目录）。"""
    try:
        base = _clean_str(root) if root else ""
    except Exception:
        base = ""
    if not base:
        base = os.getcwd()
    return os.path.join(os.path.abspath(base), DATA_FILENAME)


# ── 存储 ──────────────────────────────────────────────────
def _quarantine(path: str) -> None:
    """损坏的 JSON 不删、不覆盖：改名留档（.corrupt-<时间戳>），再当空表继续跑。

    用户的密钥全在这个文件里，宁可留一份看不懂的垃圾，也不能悄悄抹掉。
    """
    try:
        if not path or not os.path.isfile(path):
            return
        target = "%s.corrupt-%s" % (path, int(time.time()))
        os.replace(path, target)
        _err("quarantine %s -> %s" % (path, os.path.basename(target)))
    except Exception as exc:
        _err("quarantine", exc)


def _read_store(root) -> dict:
    """读整个仓库（信封结构）。文件不存在/坏掉都返回空表，绝不抛。"""
    path = data_path(root)
    empty = {"version": _DATA_VERSION, "updated_at": 0, "providers": []}
    try:
        if not os.path.isfile(path):
            return empty
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception as exc:
        _err("read %s" % path, exc)
        _quarantine(path)
        return empty
    if not isinstance(raw, dict):
        _quarantine(path)
        return empty
    providers = raw.get("providers")
    if providers is None and isinstance(raw.get("items"), list):
        providers = raw.get("items")
    if not isinstance(providers, list):
        providers = []
    return {
        "version": _as_int(raw.get("version"), _DATA_VERSION) or _DATA_VERSION,
        "updated_at": _as_int(raw.get("updated_at"), 0),
        "providers": [item for item in providers if isinstance(item, dict)],
    }


def _write_store(root, store: dict) -> bool:
    """原子写：先写同目录 tmp，fsync，再 os.replace。

    Windows 上杀软/索引器偶尔短暂占用目标文件，replace 会抛 PermissionError，
    重试几次就够了（不重试的话用户会看到「保存失败」但数据其实没落盘）。
    """
    path = data_path(root)
    payload = {
        "version": _as_int(store.get("version"), _DATA_VERSION) or _DATA_VERSION,
        "updated_at": _now(),
        "providers": store.get("providers") if isinstance(store.get("providers"), list) else [],
    }
    tmp = "%s.tmp-%s" % (path, uuid.uuid4().hex[:8])
    try:
        parent = os.path.dirname(path) or "."
        if not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except Exception:
                pass
        last = None
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                return True
            except PermissionError as exc:
                last = exc
                time.sleep(0.05 * (attempt + 1))
            except Exception as exc:
                last = exc
                break
        _err("write %s" % path, last)
        return False
    except Exception as exc:
        _err("write %s" % path, exc)
        return False
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


# ── 归一化 ────────────────────────────────────────────────
def _norm_models(value) -> list:
    """模型清单统一成 [{"id","name"}]。容忍字符串、别名、重复、以及历史垃圾数据。"""
    if value is None:
        return []
    if isinstance(value, (str, bytes)):
        items = [part for part in str(value).replace("\n", ",").split(",")]
    elif isinstance(value, (list, tuple, set)):
        items = list(value)
    else:
        return []
    out = []
    seen = set()
    for item in items:
        if isinstance(item, dict):
            mid = _clean_str(item.get("id") or item.get("name") or "")
            name = _clean_str(item.get("name") or mid)
        else:
            mid = _clean_str(item)
            name = mid
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append({"id": mid[:200], "name": (name or mid)[:200]})
        if len(out) >= MAX_MODELS:
            break
    return out


def _norm_headers(value) -> dict:
    """额外请求头必须是 {str: str}；值统一成字符串，避免 requests 报类型错。"""
    if not isinstance(value, dict):
        return {}
    out = {}
    for key, val in value.items():
        name = _clean_str(key, 200)
        if not name or val is None:
            continue
        out[name] = _clean_str(val, 2000)
    return out


def _norm_balance_manual(value) -> dict:
    """手填余额：{"value": float, "currency": str, "updated_at": int}；不合法就当没填。"""
    empty = {"value": 0.0, "currency": "CNY", "updated_at": 0}
    if not isinstance(value, dict):
        return empty
    amount = _as_float(value.get("value"), None)
    if amount is None or amount < 0:
        return empty
    currency = _clean_str(value.get("currency")).upper()[:8] or "CNY"
    return {
        "value": round(float(amount), 4),
        "currency": currency,
        "updated_at": _as_int(value.get("updated_at"), 0),
    }


def _norm_balance_auth(value) -> dict:
    """平台管理凭据。三个字段都是敏感值（user_id 不算秘密但要回显）。"""
    empty = {"user_id": "", "system_token": "", "refresh_token": ""}
    if not isinstance(value, dict):
        return empty
    return {
        "user_id": _clean_str(value.get("user_id"), 200),
        "system_token": _clean_str(value.get("system_token"), 4000),
        "refresh_token": _clean_str(value.get("refresh_token"), 4000),
    }


def _norm_item(raw: dict) -> dict:
    """把一条记录补成**完整形状**（所有键都存在）。

    这一点是硬要求：server.py 里有 ``cp["models"]`` / ``cp["protocol"]`` /
    ``cp["api_key"]`` / ``cp["name"]`` 这种下标访问，缺键会直接把请求打成 500。
    """
    item = raw if isinstance(raw, dict) else {}
    base_url = _clean_str(item.get("base_url"), 500)
    api_base = _clean_str(item.get("api_base"), 500) or normalize_base_url(base_url)
    protocol = _clean_str(item.get("protocol")).lower()
    if protocol not in PROTOCOLS:
        protocol = "openai"
    pid = _clean_str(item.get("id"), 80)
    created = _as_int(item.get("created_at"), 0) or _now()
    return {
        "id": pid,
        "name": _clean_str(item.get("name"), 160) or pid or "未命名源",
        "base_url": base_url,
        "api_base": api_base,
        "protocol": protocol,
        "api_key": _clean_str(item.get("api_key"), 4000),
        "headers": _norm_headers(item.get("headers")),
        "models": _norm_models(item.get("models")),
        "vision": _as_bool(item.get("vision"), False),
        "enabled": _as_bool(item.get("enabled"), True),
        "ctx_window": max(_as_int(item.get("ctx_window"), 0), 0),
        "note": _clean_str(item.get("note"), 2000),
        "balance_manual": _norm_balance_manual(item.get("balance_manual")),
        "balance_auth": _norm_balance_auth(item.get("balance_auth")),
        "created_at": created,
        "updated_at": _as_int(item.get("updated_at"), 0) or created,
    }


def _load_items(root) -> list:
    """读出全部记录（已归一化）。任何异常都变成空列表。"""
    store = _read_store(root)
    return [_norm_item(item) for item in store.get("providers") or [] if isinstance(item, dict)]


def _save_items(root, items: list) -> bool:
    return _write_store(root, {"version": _DATA_VERSION, "providers": list(items)})


def _find_index(items: list, pid: str) -> int:
    """按 id 找下标：先精确，再忽略大小写（历史数据里可能改了大小写）。"""
    want = _clean_str(pid)
    if not want:
        return -1
    for index, item in enumerate(items):
        if _clean_str(item.get("id")) == want:
            return index
    lowered = want.lower()
    for index, item in enumerate(items):
        if _clean_str(item.get("id")).lower() == lowered:
            return index
    return -1


def _unique_id(items: list, want: str, host: str = "") -> str:
    """生成一个不撞车的源 id（同时避开内置源）。"""
    taken = {_clean_str(item.get("id")).lower() for item in items}
    base = _slug(want) or _slug(host) or "relay"
    if base in BUILTIN_IDS:
        base = base + "-custom"
    candidate = base
    if candidate.lower() not in taken and candidate not in BUILTIN_IDS:
        return candidate
    for index in range(2, 999):
        candidate = "%s-%d" % (base, index)
        if candidate.lower() not in taken and candidate not in BUILTIN_IDS:
            return candidate
    return "%s-%s" % (base, uuid.uuid4().hex[:6])


# ── 读接口 ────────────────────────────────────────────────
def load_all(root) -> list:
    """全部第三方源（含明文 api_key —— 只给服务端自己用，别直接回前端）。

    server.py 依赖这里每个 dict 都有 id/name/protocol/api_key/models/enabled。
    """
    try:
        return _load_items(root)
    except Exception as exc:
        _err("load_all", exc)
        return []


def get(root, pid: str):
    """按 id 取单条原始记录（含明文 key）；没有就 None。"""
    try:
        items = _load_items(root)
        index = _find_index(items, pid)
        return dict(items[index]) if index >= 0 else None
    except Exception as exc:
        _err("get", exc)
        return None


def public_list(root) -> list:
    """给前端的列表：**绝不带明文 key**（前端字段见 index.html 的 cpSectionHtml）。

    返回项里的 balance_auth 只保留 `has_token / token_masked / user_id / has_refresh`，
    令牌本体一律不出现。
    """
    out = []
    try:
        for item in _load_items(root):
            auth = item.get("balance_auth") or {}
            token = _clean_str(auth.get("system_token"))
            out.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "base_url": item["base_url"],
                    "api_base": item["api_base"],
                    "protocol": item["protocol"],
                    "has_key": bool(item["api_key"]),
                    "api_key_masked": mask_key(item["api_key"]),
                    "headers": dict(item["headers"]),
                    "models": [dict(model) for model in item["models"]],
                    "model_count": len(item["models"]),
                    "vision": item["vision"],
                    "enabled": item["enabled"],
                    "ctx_window": item["ctx_window"],
                    "note": item["note"],
                    "balance_manual": dict(item["balance_manual"]),
                    "balance_auth": {
                        "user_id": auth.get("user_id") or "",
                        "has_token": bool(token),
                        "token_masked": mask_key(token),
                        "has_refresh": bool(_clean_str(auth.get("refresh_token"))),
                    },
                    "created_at": item["created_at"],
                    "updated_at": item["updated_at"],
                }
            )
    except Exception as exc:
        _err("public_list", exc)
    return out


def _dup_reason(items: list, cand: dict) -> str:
    """判重，返回文案或空串。文案的**用词有前端语义**，改之前先看 index.html:16834：

    * 文案里含「协议」→ 前端把视线滚到协议选择器（同一把密钥换协议是允许的）
    * 文案里**不含**「协议」→ 前端聚焦备注输入框（说明这是重名，改个备注就好）

    规则：
    * 同站点 + 同一把密钥 + 同协议 → 重复；换协议可以并存
    * 备注（name）全局唯一 —— 列表就是靠备注区分同站点的多个源，重名会让人分不清
    * 没有密钥（本地服务）不按密钥判重 —— 同一个 localhost 挂多个模型很常见
    """
    try:
        name = _clean_str(cand.get("name")).lower()
        key = _clean_str(cand.get("api_key"))
        host = _host_of(cand.get("api_base") or cand.get("base_url"))
        protocol = _clean_str(cand.get("protocol")).lower() or "openai"
        pid = _clean_str(cand.get("id"))
        for item in items:
            if _clean_str(item.get("id")) == pid:
                continue
            if name and _clean_str(item.get("name")).lower() == name:
                return "备注「%s」已被同名列占用，换一个备注即可" % _clean_str(cand.get("name"))
            if not key:
                continue
            other_key = _clean_str(item.get("api_key"))
            if other_key != key:
                continue
            other_host = _host_of(item.get("api_base") or item.get("base_url"))
            other_proto = _clean_str(item.get("protocol")).lower() or "openai"
            if other_host and host and other_host != host:
                continue
            if other_proto != protocol:
                # 换协议是允许并存的（同一把密钥既走 openai 又走 anthropic 是常见用法）
                continue
            return "这个站点 + 这把密钥 + 同协议已经存在（「%s」）；换一个协议或改备注就能并存" % item.get("name")
    except Exception as exc:
        _err("_dup_reason", exc)
    return ""


# ── 写接口 ────────────────────────────────────────────────
def upsert(root, item):
    """新增或部分更新一个源。返回 ``(saved, created, dup_err)``。

    合并语义（调用点依赖）：

        * ``None`` → **不动**该字段（表单不回显敏感值，传 None 表示"没改"）
        * ``{}`` → 显式清空（仅对 balance_manual / balance_auth 有意义）
        * ``id`` 为空/不存在 → 新建，自动生成 id

    ``saved`` 永远是完整记录（server.py 会读 saved["api_base"]/["protocol"]/["headers"]）。
    失败返回 ``(None, False, 原因)``，绝不抛。
    """
    try:
        if not isinstance(item, dict):
            return None, False, "参数不是对象"
        if item.get("id") and _clean_str(item.get("id")) in BUILTIN_IDS:
            return None, False, "内置源不能通过这里修改"
        with _LOCK:
            items = _load_items(root)
            pid = _clean_str(item.get("id"))
            index = _find_index(items, pid)
            created = index < 0
            if created:
                base = {
                    "id": "",
                    "name": "",
                    "base_url": "",
                    "api_base": "",
                    "protocol": "openai",
                    "api_key": "",
                    "headers": {},
                    "models": [],
                    "vision": False,
                    "enabled": True,
                    "ctx_window": 0,
                    "note": "",
                    "balance_manual": {},
                    "balance_auth": {},
                }
                merged = dict(base)
                merged.update({key: val for key, val in item.items() if val is not None})
                merged["id"] = ""
                host = _host_of(merged.get("base_url"))
                merged["id"] = _unique_id(items, merged.get("name") or host, host)
            else:
                merged = dict(items[index])
                for key, val in item.items():
                    if val is None:
                        continue
                    if key in ("balance_manual", "balance_auth") and val == {}:
                        merged[key] = {}
                        continue
                    merged[key] = val
            merged["base_url"] = normalize_base_url(merged.get("base_url"))
            if not merged.get("api_base") or merged.get("api_base") == merged.get("base_url"):
                pass
            merged["api_base"] = normalize_base_url(merged.get("api_base") or merged.get("base_url"))
            if not merged.get("name"):
                merged["name"] = merged["id"]
            if not merged.get("base_url"):
                return None, False, "地址不能为空"
            if not merged.get("api_base"):
                return None, False, "地址无法识别"
            reason = _dup_reason(items, merged)
            if reason:
                return None, created, reason
            record = _norm_item(merged)
            record["created_at"] = merged.get("created_at") or (items[index].get("created_at") if not created else _now())
            record["updated_at"] = _now()
            if created:
                items.append(record)
            else:
                items[index] = record
            if not _save_items(root, items):
                return None, created, "保存失败（数据文件写不进去）"
            return record, created, ""
    except Exception as exc:
        _err("upsert", exc)
        return None, False, "%s: %s" % (type(exc).__name__, exc)


def remove(root, pid: str) -> bool:
    """删除一个源。内置源/不存在/写盘失败都返回 False（server 会提示"未找到"）。"""
    try:
        want = _clean_str(pid)
        if not want or want in BUILTIN_IDS:
            return False
        with _LOCK:
            items = _load_items(root)
            index = _find_index(items, want)
            if index < 0:
                return False
            items.pop(index)
            return _save_items(root, items)
    except Exception as exc:
        _err("remove", exc)
        return False


def runtime_config(root, provider: str):
    """给 llm.py / server.py 用的运行时配置；**内置源返回 None**。

    llm.py 用下标取 base_url / api_key / protocol / extra_headers，
    所以这四个键必须永远在（哪怕值是空串/空 dict）。
    """
    try:
        pid = _clean_str(provider)
        if not pid or pid in BUILTIN_IDS:
            return None
        record = get(root, pid)
        if not record or not record.get("enabled", True):
            return None
        return {
            "base_url": record.get("api_base") or record.get("base_url") or "",
            "api_key": record.get("api_key") or "",
            "protocol": record.get("protocol") or "openai",
            "extra_headers": dict(record.get("headers") or {}),
            "extra_body": {},
            "ctx_window": _as_int(record.get("ctx_window"), 0),
            "vision": bool(record.get("vision")),
        }
    except Exception as exc:
        _err("runtime_config", exc)
        return None


# ── HTTP ──────────────────────────────────────────────────
def _req(method, url, headers=None, json_body=None, timeout=10, auth=None):
    """发一个请求，永不抛。返回 ``(status, json_obj, text)``；status=0 表示连接失败。"""
    try:
        response = requests.request(
            method=method.upper(),
            url=url,
            headers=dict(headers or {}),
            json=json_body,
            timeout=timeout,
            allow_redirects=True,
        )
        status = int(response.status_code)
        text = ""
        try:
            text = response.text or ""
        except Exception:
            text = ""
        data = None
        try:
            data = response.json()
        except Exception:
            data = None
        return status, data, text
    except Exception as exc:
        _err("request %s %s" % (method, url), exc)
        return 0, None, ""


def _short(status: int) -> str:
    try:
        code = int(status)
    except Exception:
        return ""
    return ("HTTP %d" % code)[:160]


def _note_for(status: int) -> str:
    """把 HTTP 状态翻成人话，前端「测试连接」的 tried 列表直接显示它。"""
    try:
        code = int(status)
    except Exception:
        return "无法连接"
    table = {
        0: "连不上（域名错 / 端口不通 / 被墙）",
        200: "通",
        201: "通",
        204: "通",
        301: "被重定向（地址可能少了路径）",
        302: "被重定向（地址可能少了路径）",
        400: "参数不对（多半是协议选错了）",
        401: "密钥无效或已过期",
        402: "余额不足",
        403: "密钥无权访问这个接口",
        404: "这个路径没有接口（少写/多写了 /v1 或路径）",
        405: "方法不对（这个地址不是对话接口）",
        408: "超时",
        429: "限流（稍后再试）",
        500: "上游服务出错",
        502: "网关错误（中转站没连上上游）",
        503: "服务不可用",
        504: "网关超时",
    }
    if code in table:
        return table[code]
    if 200 <= code < 300:
        return "通"
    if 400 <= code < 500:
        return "请求被拒（%d）" % code
    return "服务端错误（%d）" % code


def _fold(headers: dict) -> set:
    try:
        return {str(key).strip().lower() for key in (headers or {})}
    except Exception:
        return set()


def _auth_headers(protocol: str, api_key: str, extra=None) -> dict:
    """按协议构造鉴权头。站点自定义头（extra）优先，我们只补缺。"""
    out = dict(extra or {})
    present = _fold(out)
    key = _clean_str(api_key)
    if not key:
        return out
    proto = (_clean_str(protocol) or "openai").lower()
    if proto == "anthropic":
        if "x-api-key" not in present:
            out["x-api-key"] = key
        if "anthropic-version" not in present:
            out["anthropic-version"] = "2023-06-01"
    else:
        if "authorization" not in present:
            out["Authorization"] = "Bearer %s" % key
    if "content-type" not in present:
        out["Content-Type"] = "application/json"
    return out


def _probe_protocols(proto: str) -> list:
    text = (_clean_str(proto) or "auto").lower()
    if text in ("openai", "anthropic"):
        return [text]
    return ["openai", "anthropic"]


def _root_candidates(base: str) -> list:
    """同一个地址的候选根：用户填了具体路径就以它为准，否则试 /v1 和裸根。

    「少写一层 /v1」是最常见的配置错误，但自动加 /v1 也可能把一个本身带前缀的
    地址改坏 —— 所以只在 path 为空时补。
    """
    text = normalize_base_url(base)
    if not text:
        return []
    try:
        parts = urlsplit(text)
        path = (parts.path or "").strip("/")
    except Exception:
        return [text]
    if path:
        return [text]
    origin = _origin_of(text)
    return [text + "/v1", text]


def _extract_models(payload) -> list:
    """从各家 /models 的返回里薅出模型清单。"""
    if not isinstance(payload, dict):
        return []
    rows = payload.get("data")
    if rows is None:
        rows = payload.get("models")
    if not isinstance(rows, list):
        return []
    out = []
    seen = set()
    for row in rows:
        if isinstance(row, dict):
            mid = _clean_str(row.get("id") or row.get("name") or row.get("model") or "")
            name = _clean_str(row.get("name") or row.get("display_name") or mid)
        else:
            mid = _clean_str(row)
            name = mid
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append({"id": mid[:200], "name": (name or mid)[:200]})
        if len(out) >= MAX_MODELS:
            break
    return out


def _chat_path(proto: str) -> str:
    return "/messages" if (_clean_str(proto) or "").lower() == "anthropic" else "/chat/completions"


def _chat_body(proto: str, model: str = "") -> dict:
    if (_clean_str(proto) or "").lower() == "anthropic":
        return {
            "model": model or "claude-3-haiku-20240307",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        }
    return {
        "model": model or "gpt-4o-mini",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}],
    }


def _advice_for(status: int, ok: bool) -> str:
    try:
        code = int(status or 0)
    except Exception:
        code = 0
    if ok:
        return ""
    if code == 0:
        return "连不上：检查地址拼写、端口、以及这台机器能不能访问它"
    if code in (401, 403):
        return "密钥被拒：确认这把密钥属于这个站点，且没有多余空格"
    if code == 404:
        return "路径不存在：多半少写/多写了 /v1，或者地址填成了具体接口而不是站点根"
    if code in (400, 405):
        return "协议不匹配：试试把协议从「自动」改成 openai 或 anthropic"
    if code == 429:
        return "限流：这不代表配置错，稍后再试"
    if code >= 500:
        return "上游出错：站点自己有问题，或中转站没连上它的上游"
    return ""


def probe(base_url, api_key="", protocol="auto", headers=None, timeout=15,
          probe_chat=True, model="") -> dict:
    """探测一个站点：拉模型清单 + 确认协议 + 校正实际根地址。永不抛。

    返回结构（前端 cpResultHtml / 保存前校正都按它取字段）::

        {"ok": bool, "protocol": "openai"|"anthropic"|"",
         "api_base": str,                 # 实测能用的根，保存时写成源的地址
         "models": [{"id","name"}], "latency_ms": int, "http_status": int,
         "tried": [{"proto","url","status","note"}],
         "error": str, "advice": str, "warning": str}
    """
    started = time.time()
    tried = []
    result = {
        "ok": False,
        "protocol": "",
        "api_base": "",
        "models": [],
        "latency_ms": 0,
        "http_status": 0,
        "tried": tried,
        "error": "",
        "advice": "",
        "warning": "",
    }
    try:
        base = normalize_base_url(base_url)
        if not base:
            result["error"] = "地址为空"
            result["advice"] = "填一个站点根地址，例如 https://api.example.com"
            return result
        extra = _norm_headers(headers)
        candidates = _root_candidates(base)
        protos = _probe_protocols(protocol)
        best_warning = ""
        for proto in protos:
            auth = _auth_headers(proto, api_key, extra)
            for root in candidates:
                url = "%s/models" % root.rstrip("/")
                status, payload, text = _req("GET", url, headers=auth, timeout=timeout)
                models = _extract_models(payload)
                tried.append(
                    {
                        "proto": proto,
                        "url": url,
                        "status": status,
                        "note": _note_for(status),
                    }
                )
                if status == 200 and models:
                    result.update(
                        {
                            "ok": True,
                            "protocol": proto,
                            "api_base": root,
                            "models": models,
                            "http_status": status,
                        }
                    )
                    if len(models) >= MAX_MODELS:
                        best_warning = "模型太多，只取了前 %d 个" % MAX_MODELS
                    if probe_chat:
                        chat_url = "%s%s" % (root.rstrip("/"), _chat_path(proto))
                        chat_status, _, _ = _req(
                            "POST",
                            chat_url,
                            headers=auth,
                            json_body=_chat_body(proto, model),
                            timeout=timeout,
                        )
                        tried.append(
                            {
                                "proto": proto,
                                "url": chat_url,
                                "status": chat_status,
                                "note": _note_for(chat_status),
                            }
                        )
                        if chat_status and chat_status not in (200, 201, 400, 422, 429):
                            best_warning = (
                                "模型清单通了，但对话接口返回 %d（%s），保存后可能发不出消息"
                                % (chat_status, _note_for(chat_status))
                            )
                    result["warning"] = best_warning
                    result["latency_ms"] = int((time.time() - started) * 1000)
                    return result
                if status == 200 and not models:
                    best_warning = "接口通了但没解析出模型清单，保存后仍需手动填模型"
                    if not result["api_base"]:
                        result.update(
                            {
                                "ok": True,
                                "protocol": proto,
                                "api_base": root,
                                "http_status": status,
                                "warning": best_warning,
                            }
                        )
        if not result["ok"]:
            last = tried[-1] if tried else {"status": 0}
            result["http_status"] = int(last.get("status") or 0)
            result["error"] = _note_for(result["http_status"]) or "探测失败"
            result["advice"] = _advice_for(result["http_status"], False)
            result["warning"] = best_warning
        result["latency_ms"] = int((time.time() - started) * 1000)
        return result
    except Exception as exc:
        _err("probe", exc)
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
        result["latency_ms"] = int((time.time() - started) * 1000)
        return result


# ── 余额 ──────────────────────────────────────────────────
def _vendor_of(host: str) -> str:
    netloc = _host_of(host)
    if not netloc:
        return ""
    if "deepseek" in netloc:
        return "deepseek"
    if "openrouter" in netloc:
        return "openrouter"
    if "bigmodel" in netloc or "zhipu" in netloc:
        return "zhipu"
    if "dmxapi" in netloc:
        return "dmxapi"
    if "leadera" in netloc:
        return "leadera"
    return ""


def _vendor_label(vendor: str) -> str:
    return {
        "deepseek": "DeepSeek",
        "openrouter": "OpenRouter",
        "zhipu": "智谱",
        "dmxapi": "DMXAPI",
        "leadera": "LeaderAI",
    }.get(vendor or "", "")


def _num_from(payload: dict, keys: list):
    """从 dict 里按候选键名取第一个能转成数字的值。"""
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key in payload:
            value = _as_float(payload.get(key), None)
            if value is not None:
                return value
    return None


def _bal_deepseek(base, key, headers, timeout, tried) -> dict:
    """DeepSeek 官方：GET /user/balance（余额按币种分条列出）。"""
    out = {"ok": False, "remaining": None, "currency": "", "error": ""}
    url = "%s/user/balance" % _origin_of(base)
    status, payload, _ = _req("GET", url, headers=_auth_headers("openai", key, headers), timeout=timeout)
    tried.append({"method": "GET", "url": url, "status": status, "note": _note_for(status)})
    if status != 200 or not isinstance(payload, dict):
        out["error"] = _note_for(status)
        return out
    rows = payload.get("balance_infos")
    if isinstance(rows, list) and rows:
        row = rows[0] if isinstance(rows[0], dict) else {}
        total = _as_float(row.get("total_balance"), None)
        currency = _clean_str(row.get("currency")).upper()
        if total is not None:
            out.update({"ok": True, "remaining": total, "currency": currency})
            return out
    out["error"] = "返回里没有余额字段"
    return out


def _bal_openrouter(base, key, headers, timeout, tried) -> dict:
    """OpenRouter：/credits 给出总额与已用；/auth/key 给出额度与用量。"""
    out = {"ok": False, "remaining": None, "total": None, "used": None, "currency": "USD", "error": ""}
    origin = _origin_of(base)
    auth = _auth_headers("openai", key, headers)
    url = "%s/api/v1/credits" % origin
    status, payload, _ = _req("GET", url, headers=auth, timeout=timeout)
    tried.append({"method": "GET", "url": url, "status": status, "note": _note_for(status)})
    if status == 200 and isinstance(payload, dict):
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        total = _as_float(data.get("total_credits"), None)
        used = _as_float(data.get("total_usage"), None)
        if total is not None:
            remaining = total - (used or 0.0)
            out.update({"ok": True, "remaining": remaining, "total": total, "used": used})
            return out
    url = "%s/api/v1/auth/key" % origin
    status, payload, _ = _req("GET", url, headers=auth, timeout=timeout)
    tried.append({"method": "GET", "url": url, "status": status, "note": _note_for(status)})
    if status == 200 and isinstance(payload, dict):
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        limit = _as_float(data.get("limit"), None)
        usage = _as_float(data.get("usage"), None)
        if limit is not None:
            out.update({"ok": True, "remaining": max(limit - (usage or 0.0), 0.0), "total": limit, "used": usage})
            return out
    out["error"] = _note_for(status)
    return out


def _bal_zhipu(base, key, headers, timeout, tried) -> dict:
    """智谱：官方没有公开的余额接口，按站点实际提供的几个候选路径试。

    ⚠ 重建说明：这几条路径是从站点控制台的请求里归纳的（原实现已丢失），
    404 是正常结果 —— 这时前端会退回「手填余额」。
    """
    out = {"ok": False, "remaining": None, "currency": "CNY", "error": ""}
    origin = _origin_of(base)
    auth = _auth_headers("openai", key, headers)
    paths = ("/api/paas/v4/balance", "/api/biz/customer/account/getCustomerAccount")
    for path in paths:
        url = "%s%s" % (origin, path)
        status, payload, _ = _req("GET", url, headers=auth, timeout=timeout)
        tried.append({"method": "GET", "url": url, "status": status, "note": _note_for(status)})
        if status != 200 or not isinstance(payload, dict):
            continue
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        amount = _num_from(data, ["balance", "remain", "amount", "total", "available"])
        if amount is not None:
            out.update({"ok": True, "remaining": amount})
            return out
    out["error"] = "智谱没有可用的公开余额接口，请手填余额"
    return out


def _bal_oneapi_quota(payload: dict, tried, url: str, status: int) -> dict:
    """解析 one-api / new-api 的 /api/user/self 返回：quota 是"配额单位"不是钱。"""
    out = {"ok": False, "remaining": None, "currency": "USD", "error": ""}
    if status != 200 or not isinstance(payload, dict):
        out["error"] = _note_for(status)
        return out
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    quota = _as_float(data.get("quota"), None)
    used = _as_float(data.get("used_quota"), None)
    if quota is None:
        out["error"] = "返回里没有 quota"
        return out
    remaining = quota / _QUOTA_PER_USD
    out.update({"ok": True, "remaining": round(remaining, 4)})
    if used is not None:
        out["used"] = round(used / _QUOTA_PER_USD, 4)
        out["total"] = round(remaining + out["used"], 4)
    return out


def _bal_platform(base, auth: dict, timeout, tried) -> dict:
    """平台凭据型站点（DMXAPI / LeaderAI）：余额记在账号上，不吃模型密钥。"""
    out = {"ok": False, "remaining": None, "currency": "CNY", "error": ""}
    if not isinstance(auth, dict):
        auth = {}
    token = _clean_str(auth.get("system_token"))
    user_id = _clean_str(auth.get("user_id"))
    if not token:
        out["error"] = "需要先填平台管理凭据（系统令牌）"
        return out
    origin = _origin_of(base)
    headers = {"Authorization": token if token.lower().startswith("bearer ") else "Bearer %s" % token}
    if user_id:
        headers["New-Api-User"] = user_id
    paths = ("/api/user/self", "/api/user/amount", "/api/user/quota")
    for path in paths:
        url = "%s%s" % (origin, path)
        status, payload, _ = _req("GET", url, headers=headers, timeout=timeout)
        tried.append({"method": "GET", "url": url, "status": status, "note": _note_for(status)})
        if status == 401 or status == 403:
            out["error"] = "平台令牌被拒（%s）" % _note_for(status)
            return out
        if status != 200 or not isinstance(payload, dict):
            continue
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        quota = _as_float(data.get("quota"), None)
        if quota is not None:
            parsed = _bal_oneapi_quota(payload, tried, url, status)
            if parsed.get("ok"):
                return parsed
        amount = _num_from(data, ["balance", "remain", "amount", "available", "total"])
        if amount is not None:
            out.update({"ok": True, "remaining": amount})
            return out
    out["error"] = out["error"] or "没有找到余额字段（这类站点通常要手填）"
    return out


def _bal_oneapi(base, key, headers, timeout, tried) -> dict:
    """one-api / new-api 中转站（第三方站的绝大多数）：两套接口都试。

    ① ``/v1/dashboard/billing/subscription`` + ``/v1/dashboard/billing/usage``
       （OpenAI 兼容账单接口，认 sk- 密钥）
    ② ``/api/user/self``（站点自有接口，认登录令牌）
    """
    out = {"ok": False, "remaining": None, "currency": "USD", "error": ""}
    root = _without_v1(base)
    auth = _auth_headers("openai", key, headers)
    sub_url = "%s/v1/dashboard/billing/subscription" % root
    status, payload, _ = _req("GET", sub_url, headers=auth, timeout=timeout)
    tried.append({"method": "GET", "url": sub_url, "status": status, "note": _note_for(status)})
    if status == 200 and isinstance(payload, dict):
        total = _as_float(payload.get("system_hard_limit_usd"), None)
        if total is None:
            total = _as_float(payload.get("hard_limit_usd"), None)
        if total is not None:
            usage_url = "%s/v1/dashboard/billing/usage" % root
            use_status, use_payload, _ = _req("GET", usage_url, headers=auth, timeout=timeout)
            tried.append({"method": "GET", "url": usage_url, "status": use_status, "note": _note_for(use_status)})
            used = 0.0
            if use_status == 200 and isinstance(use_payload, dict):
                used = _as_float(use_payload.get("total_usage"), 0.0) or 0.0
                used = round(used / 100.0, 4)  # 单位是美分
            out.update(
                {
                    "ok": True,
                    "remaining": round(max(total - used, 0.0), 4),
                    "total": total,
                    "used": used,
                }
            )
            return out
    self_url = "%s/api/user/self" % root
    status, payload, _ = _req("GET", self_url, headers=auth, timeout=timeout)
    tried.append({"method": "GET", "url": self_url, "status": status, "note": _note_for(status)})
    parsed = _bal_oneapi_quota(payload, tried, self_url, status)
    if parsed.get("ok"):
        return parsed
    out["error"] = _note_for(status) or "没有找到余额字段"
    return out


def _refresh_platform_token(base, auth: dict, timeout, tried) -> dict:
    """用 refresh_token 换一张新的登录令牌（LeaderAI 这类 JWT 站点）。

    只在 401/403 之后调用，且失败就当没这回事 —— 余额查询本身已经失败了，
    再抛异常只会把「查不到余额」升级成「设置页报错」。
    """
    try:
        if not isinstance(auth, dict):
            return {}
        refresh = _clean_str(auth.get("refresh_token"))
        if not refresh:
            return {}
        origin = _origin_of(base)
        url = "%s/api/auth/refresh" % origin
        status, payload, _ = _req(
            "POST",
            url,
            headers={"Content-Type": "application/json"},
            json_body={"refresh_token": refresh},
            timeout=timeout,
        )
        tried.append({"method": "POST", "url": url, "status": status, "note": _note_for(status)})
        if status != 200 or not isinstance(payload, dict):
            return {}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        token = _clean_str(data.get("token") or data.get("access_token") or data.get("accessToken"))
        if not token:
            return {}
        update = {"system_token": token}
        new_refresh = _clean_str(data.get("refresh_token") or data.get("refreshToken"))
        if new_refresh:
            update["refresh_token"] = new_refresh
        return update
    except Exception as exc:
        _err("refresh token", exc)
        return {}


def query_balance(base_url, api_key="", protocol="openai", headers=None, timeout=10,
                  depth="relay", balance_auth=None) -> dict:
    """查一个源的余额。**永不抛**，查不到就 ok=False 让调用点优雅降级。

    返回结构（server.py 的 ``_balance_now`` 与 /api/custom-providers/balance 都按它取）::

        {"ok": bool, "remaining": float|None, "currency": "CNY"|"USD"|"PTS"|"",
         "provider": str, "error": str, "advice": str,
         "tried": [{"method","url","status","note"}],
         "auth_update": dict|None,      # 轮换到的新令牌（server 会落盘且不回前端）
         "total": float|None, "used": float|None}

    depth 语义（_balance_now 用 relay 每 120s 轮询，别让它打太多请求）：

        * ``vendor`` —— 只跑已知厂商适配器
        * ``relay``  —— 厂商适配器 + one-api 系（≤4 个请求）
        * ``full``   —— 再加平台凭据型与刷新令牌
    """
    started = time.time()
    tried = []
    result = {
        "ok": False,
        "remaining": None,
        "currency": "",
        "provider": "",
        "error": "",
        "advice": "",
        "tried": tried,
        "auth_update": None,
        "total": None,
        "used": None,
    }
    try:
        base = normalize_base_url(base_url)
        if not base:
            result["error"] = "地址为空"
            return result
        level = (_clean_str(depth) or "relay").lower()
        if level not in ("vendor", "relay", "full"):
            level = "relay"
        vendor = _vendor_of(base)
        result["provider"] = _vendor_label(vendor)
        extra = _norm_headers(headers)
        key = _clean_str(api_key)
        auth = balance_auth if isinstance(balance_auth, dict) else {}

        # 平台凭据型站点优先（它们的模型密钥本来就不参与余额）
        if vendor in ("dmxapi", "leadera") and _clean_str(auth.get("system_token")):
            parsed = _bal_platform(base, auth, timeout, tried)
            result.update(parsed)
            if not parsed.get("ok") and level == "full":
                update = _refresh_platform_token(base, auth, timeout, tried)
                if update:
                    result["auth_update"] = update
                    retry_auth = dict(auth)
                    retry_auth.update(update)
                    parsed = _bal_platform(base, retry_auth, timeout, tried)
                    result.update(parsed)
                    result["auth_update"] = update
            if result.get("ok"):
                result["latency_ms"] = int((time.time() - started) * 1000)
                return result

        if vendor == "deepseek":
            parsed = _bal_deepseek(base, key, extra, timeout, tried)
        elif vendor == "openrouter":
            parsed = _bal_openrouter(base, key, extra, timeout, tried)
        elif vendor == "zhipu":
            parsed = _bal_zhipu(base, key, extra, timeout, tried)
        elif vendor in ("dmxapi", "leadera"):
            parsed = _bal_platform(base, auth, timeout, tried)
        elif level == "vendor":
            parsed = {"ok": False, "remaining": None, "currency": "", "error": "未知厂商，只跑了厂商适配器"}
        else:
            parsed = _bal_oneapi(base, key, extra, timeout, tried)
        result.update(parsed)

        if not result.get("ok") and level == "full" and vendor not in ("dmxapi", "leadera"):
            # 兜底：one-api 系再试一次（某些站点把账单接口挂在别的路径上）
            parsed = _bal_oneapi(base, key, extra, timeout, tried)
            if parsed.get("ok"):
                result.update(parsed)
            if not result.get("ok") and _clean_str(auth.get("system_token")):
                parsed = _bal_platform(base, auth, timeout, tried)
                if parsed.get("ok"):
                    result.update(parsed)

        if not result.get("ok"):
            result["error"] = result.get("error") or "查不到余额"
            result["advice"] = "这个站点没有开放余额接口，请在「手填余额」里记一笔"
            if vendor in ("dmxapi", "leadera"):
                result["advice"] = "DMXAPI / LeaderAI 这类站点要填「平台管理凭据」（系统令牌），模型密钥不参与余额查询。"
        result["latency_ms"] = int((time.time() - started) * 1000)
        return result
    except Exception as exc:
        _err("query_balance", exc)
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
        result["latency_ms"] = int((time.time() - started) * 1000)
        return result
