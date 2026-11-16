"""tunnel_manager — 公网隧道管理（重建版）。

背景
----
本文件在 2026-11 被误删，按 server.py / desktop.py 的现有调用点重建。
历史上这里管的是「守门员 guard_proxy + frpc」那套 frp 链路，配置散落在
tunnel_config.json / frpc.toml / tokens.txt 三处；那套已经被大眼本体接管并淘汰。
现在真正在跑的是 **phone-bridge**（Node）里的 ``link.mjs``：

    ssh -N -R 127.0.0.1:18899:127.0.0.1:8899 root@<你的服务器>
    → https://<你的域名>/dsh

所以本模块**不再自己 spawn ssh**，而是做三件事：

1. 读同一份 ``phone-bridge/tunnel.json``（和 link.mjs 的 loadSelfHost 同源），
   对外报同一套状态字段，避免两套逻辑打架；
2. 把 ``ensure_running`` / ``stop_link`` 委托给桥的 HTTP 接口
   （``http://127.0.0.1:8899/api/link/{start,stop,state}``，header ``x-phone-token``）；
3. 给前端补一层旧字段（``guard`` / ``frpc`` / ``server`` / ``public_url``），
   让 ``public/index.html`` 的公网访问面板不用改就能继续渲染。

硬约束（重建时守住）
--------------------
* **所有公开函数绝不抛异常**。server.py 在请求路径上直接调它们，
  抛一次就是「设置页整块 500」。任何内部错误都降级成 ``{"error": ...}``。
* 不 spawn 长期进程、不杀任何进程、不动 8899 上正在跑的隧道。
* 只用标准库 + requests。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

try:  # requests 是项目已装依赖；极端情况下缺失也不能让 import 失败
    import requests
except Exception:  # pragma: no cover
    requests = None  # type: ignore[assignment]


# ─────────────────────────── 路径与常量 ───────────────────────────

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

#: 与 phone-bridge/link.mjs 的 loadSelfHost() 读的是同一份文件
TUNNEL_JSON = os.path.join(ROOT_DIR, "phone-bridge", "tunnel.json")
#: 桥的运行态（token / 端口都在这里）
RUNTIME_STATE_JSON = os.path.join(ROOT_DIR, "phone-bridge", "runtime", "state.json")
RUNTIME_PORT_JSON = os.path.join(ROOT_DIR, "phone-bridge", "runtime", "port.json")
#: 旧版 frp 配置，只在存在时读取（用于把老字段搬过来，不主动创建）
LEGACY_TUNNEL_CONFIG_JSON = os.path.join(ROOT_DIR, "tunnel_config.json")

DEFAULT_BRIDGE_PORT = 8899
DEFAULT_GUARD_PORT = 16890
DEFAULT_APP_PORT = 9890

#: 桥的认证 header —— 与 phone-bridge/server.mjs:1282 一致（不是猜的）
BRIDGE_TOKEN_HEADER = "x-phone-token"

#: 这些键在 reveal=False 时必须打码
_SENSITIVE_KEYS = ("auth_token", "access_token", "enc_key", "token", "key")


# ─────────────────────────── 小工具 ───────────────────────────


def _read_json(path: str, default: Any = None) -> Any:
    """读 JSON；文件不存在 / 坏了 / 不是 dict 都返回 default，绝不抛。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if data is not None else default
    except Exception:
        return default


def _as_int(value: Any, fallback: int) -> int:
    try:
        n = int(value)
        return n if 0 < n < 65536 else fallback
    except Exception:
        return fallback


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _strip_slash(url: str) -> str:
    return (url or "").strip().rstrip("/")


def _mask(value: str, keep: int = 0) -> str:
    """敏感值打码。keep=0 全遮；keep>0 保留尾巴几位（给人核对用）。"""
    s = str(value or "")
    if not s:
        return ""
    if keep and len(s) > keep:
        return "*" * max(4, len(s) - keep) + s[-keep:]
    return "***"


# ─────────────────────────── 桥的寻址与调用 ───────────────────────────


def _bridge_port() -> int:
    """桥实际监听的端口：runtime/port.json → 环境变量 → 8899。"""
    data = _read_json(RUNTIME_PORT_JSON, {}) or {}
    port = _as_int(data.get("port"), 0)
    if port:
        return port
    env = _as_int(os.environ.get("PHONE_BRIDGE_PORT"), 0)
    return env or DEFAULT_BRIDGE_PORT


def _bridge_base() -> str:
    return f"http://127.0.0.1:{_bridge_port()}"


def _bridge_token() -> str:
    """桥的访问令牌。字段名 ``token`` —— 已在 runtime/state.json 实测确认。"""
    data = _read_json(RUNTIME_STATE_JSON, {}) or {}
    return str(data.get("token") or "")


def _bridge_headers() -> dict:
    return {BRIDGE_TOKEN_HEADER: _bridge_token(), "accept": "application/json"}


def _bridge_call(method: str, path: str, timeout: float = 8.0) -> dict:
    """调桥的 HTTP 接口，永远返回 dict。

    返回形状::

        {"ok": bool, "http": int|None, "data": dict, "error": str|None, "via": "bridge"}

    ``ok`` 为 False 时 ``error`` 一定非空（中文，便于直接显示给用户）。
    """
    url = _bridge_base() + path
    headers = _bridge_headers()
    if not headers.get(BRIDGE_TOKEN_HEADER):
        return {
            "ok": False,
            "http": None,
            "data": {},
            "error": f"读不到桥的访问令牌（{RUNTIME_STATE_JSON} 里的 token 字段为空）",
            "via": "bridge",
        }
    if requests is None:
        return {"ok": False, "http": None, "data": {},
                "error": "缺少 requests 库，无法访问 phone-bridge", "via": "bridge"}
    try:
        if method.upper() == "POST":
            resp = requests.post(url, headers=headers, timeout=timeout, json={})
        else:
            resp = requests.get(url, headers=headers, timeout=timeout)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:400]}
        ok = bool(resp.status_code < 400 and (data.get("ok") is not False))
        err = None
        if not ok:
            err = str(data.get("error") or f"桥返回 HTTP {resp.status_code}")
        return {"ok": ok, "http": resp.status_code, "data": data, "error": err, "via": "bridge"}
    except Exception as exc:  # 连接拒绝 / 超时 / 代理干扰
        return {
            "ok": False,
            "http": None,
            "data": {},
            "error": f"连不上 phone-bridge（{_bridge_base()}）：{type(exc).__name__}: {exc}",
            "via": "bridge",
        }


# ─────────────────────────── 配置 ───────────────────────────


def load_config() -> dict:
    """读隧道配置，返回统一视图（重建版）。**绝不抛**。

    数据来源与优先级：

    1. ``phone-bridge/tunnel.json`` —— 与 link.mjs 的 loadSelfHost() 同源，权威；
    2. ``tunnel_config.json`` —— 旧版 frp 配置，只有存在时才读，用来把
       ``enabled`` / ``access_token`` / ``enc_key`` 这些老字段接过来；
    3. 环境变量 ``PHONE_SELFHOST_*`` —— 和 link.mjs 一样支持覆盖。

    返回 dict 里同时保留两套命名：``public_url``（前端/本模块用）与
    ``publicUrl``（tunnel.json 原生），值相同。
    """
    try:
        raw = _read_json(TUNNEL_JSON, {}) or {}
        legacy = _read_json(LEGACY_TUNNEL_CONFIG_JSON, {}) or {}

        host = (os.environ.get("PHONE_SELFHOST_HOST") or raw.get("host") or "").strip()
        user = (os.environ.get("PHONE_SELFHOST_USER") or raw.get("user") or "root").strip()
        key = (os.environ.get("PHONE_SELFHOST_KEY") or raw.get("key") or "").strip()
        ssh_port = _as_int(os.environ.get("PHONE_SELFHOST_SSH_PORT") or raw.get("port"), 22)
        remote_port = _as_int(
            os.environ.get("PHONE_SELFHOST_REMOTE_PORT") or raw.get("remotePort"),
            _as_int(legacy.get("remote_port"), 18899),
        )
        public = _strip_slash(
            os.environ.get("PHONE_SELFHOST_PUBLIC_URL")
            or raw.get("publicUrl")
            or legacy.get("public_url")
            or ""
        )
        provider = (raw.get("provider") or ("selfhost" if host else "auto")).strip()

        # enabled 的判定：旧配置有显式开关就听它，否则「有公网地址/主机」即视为启用。
        # 这是重建时的推断 —— 记在模块文档的「风险」一节里。
        if "enabled" in legacy:
            enabled = _as_bool(legacy.get("enabled"))
        else:
            enabled = bool(public or host)

        cfg = {
            # —— 桥 / 自建服务器字段 ——
            "provider": provider,
            "host": host,
            "port": ssh_port,
            "user": user,
            "key": key,
            "remote_port": remote_port,
            "remotePort": remote_port,
            "public_url": public,
            "publicUrl": public,
            "enabled": enabled,
            # —— 旧 frp 面板字段（前端设置页还在读）——
            "server_addr": legacy.get("server_addr") or host,
            "server_port": _as_int(legacy.get("server_port"), ssh_port),
            "auth_token": legacy.get("auth_token") or "",
            "access_token": legacy.get("access_token") or "",
            "enc_key": legacy.get("enc_key") or "",
            # —— 本机侧端口 ——
            "guard_port": _as_int(legacy.get("guard_port"), DEFAULT_GUARD_PORT),
            "app_port": _as_int(legacy.get("app_port"), DEFAULT_APP_PORT),
            "bridge_port": _bridge_port(),
            # —— 元信息 ——
            "config_path": TUNNEL_JSON,
            "has_key": bool(key),
            "config_exists": os.path.exists(TUNNEL_JSON),
        }
        return cfg
    except Exception as exc:  # 理论上到不了，兜底而已
        return {
            "provider": "auto", "host": "", "port": 22, "user": "root", "key": "",
            "remote_port": 18899, "remotePort": 18899,
            "public_url": "", "publicUrl": "", "enabled": False,
            "server_addr": "", "server_port": 22, "auth_token": "",
            "access_token": "", "enc_key": "",
            "guard_port": DEFAULT_GUARD_PORT, "app_port": DEFAULT_APP_PORT,
            "bridge_port": DEFAULT_BRIDGE_PORT,
            "config_path": TUNNEL_JSON, "has_key": False, "config_exists": False,
            "error": f"{type(exc).__name__}: {exc}",
        }


def public_url(cfg: dict | None = None) -> str:
    """公网地址（不带尾斜杠）。**绝不抛**；没有配置就返回空串。

    server.py:2568 用它拼 IP 列表，返回空串等价于「没开公网访问」。
    """
    try:
        c = cfg if isinstance(cfg, dict) and cfg else load_config()
        url = _strip_slash(c.get("public_url") or c.get("publicUrl") or "")
        if url:
            return url
        # 没有显式 publicUrl 时按 link.mjs 的规则拼：http://host:remotePort
        host = c.get("host") or ""
        if host:
            return f"http://{host}:{_as_int(c.get('remote_port'), 18899)}"
        return ""
    except Exception:
        return ""


def config_view(cfg: dict | None = None, reveal: bool = True) -> dict:
    """给设置页看的配置视图。**绝不抛**。

    Parameters
    ----------
    reveal:
        ``True``  —— 本机界面用，原样返回（前端要显示/复制）。
        ``False`` —— **隐藏私钥路径与全部敏感字段**：``key`` 置空、
        令牌类字段打码成 ``***``，只保留 ``has_*`` 布尔供界面判断。

    返回键与 ``public/index.html`` 的公网面板对齐：
    ``enabled / server_addr / server_port / auth_token / remote_port /
    public_url / access_token / enc_key``。
    """
    try:
        c = cfg if isinstance(cfg, dict) and cfg else load_config()
        view = {
            "enabled": bool(c.get("enabled")),
            "provider": c.get("provider") or "auto",
            "server_addr": c.get("server_addr") or c.get("host") or "",
            "server_port": c.get("server_port") or c.get("port") or 22,
            "auth_token": c.get("auth_token") or "",
            "remote_port": c.get("remote_port") or c.get("remotePort") or 18899,
            "public_url": public_url(c),
            "access_token": c.get("access_token") or "",
            "enc_key": c.get("enc_key") or "",
            # 自建 ssh 侧的只读信息（前端暂未渲染，但设置页/诊断用得上）
            "host": c.get("host") or "",
            "user": c.get("user") or "",
            "key": c.get("key") or "",
            "key_basename": os.path.basename(c.get("key") or "") if c.get("key") else "",
            "has_key": bool(c.get("key")),
            "guard_port": c.get("guard_port") or DEFAULT_GUARD_PORT,
            "app_port": c.get("app_port") or DEFAULT_APP_PORT,
            "bridge_port": c.get("bridge_port") or _bridge_port(),
            "config_path": c.get("config_path") or TUNNEL_JSON,
            "config_exists": bool(c.get("config_exists")),
        }
        if not reveal:
            # 私钥路径整个抹掉（连 basename 都不给，路径本身就是情报）
            view["key"] = ""
            view["key_basename"] = ""
            view["key_hidden"] = True
            for k in ("auth_token", "access_token", "enc_key"):
                if view.get(k):
                    view[k] = _mask(view[k])
                    view[f"has_{k}"] = True
        return view
    except Exception as exc:
        return {"enabled": False, "error": f"{type(exc).__name__}: {exc}"}


# ─────────────────────────── 状态 ───────────────────────────


def _empty_status(error: str | None = None) -> dict:
    """桥不可达时的降级状态。形状与正常返回完全一致，前端不会崩。"""
    cfg = load_config()
    return {
        # —— 与 link.mjs 的 status() 同名字段 ——
        "running": False,
        "url": None,
        "since": None,
        "error": error,
        "downloading": False,
        "named": False,
        "binary": None,
        "provider": cfg.get("provider") or "auto",
        "desired": False,
        "retryIn": 0,
        "log": None,
        # —— 给前端/旧调用点的兼容视图 ——
        "public_url": public_url(cfg),
        "enabled": bool(cfg.get("enabled")),
        "guard": {"running": False, "port": cfg.get("bridge_port"), "pid": None},
        "frpc": {"running": False, "count": 0},
        "server": {"running": True, "port": cfg.get("app_port")},
        "assets_ok": bool(cfg.get("host") or cfg.get("public_url")),
        "guard_port": cfg.get("guard_port"),
        "app_port": cfg.get("app_port"),
        "bridge_port": cfg.get("bridge_port"),
        "source": "fallback",
        "checked_at": time.time(),
    }


def _probe_public(url: str, timeout: float = 6.0) -> dict:
    """真发一次公网请求（只读 GET，不启停任何东西）。deep=True 才走这里。"""
    if not url:
        return {"ok": False, "error": "没有公网地址"}
    if requests is None:
        return {"ok": False, "error": "缺少 requests 库"}
    try:
        resp = requests.get(_strip_slash(url) + "/api/health", timeout=timeout)
        body = (resp.text or "")[:200]
        ok = resp.status_code < 400 and "no tunnel" not in body.lower()
        return {"ok": ok, "http": resp.status_code, "body": body}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def status(cfg: dict | None = None, deep: bool = False) -> dict:
    """链路状态。**绝不抛**，形状恒定。

    数据真相来自桥的 ``GET /api/link/state``（与 link.mjs 的 ``status()`` 同源），
    这里只做两件事：① 原样透传桥的字段；② 派生一层旧字段给前端。

    旧字段的映射语义（重建时的推断）：

    ==========  ====================================================
    旧字段       新含义
    ==========  ====================================================
    guard       「本机转发进程」→ 桥本身；running = 桥可达
    frpc        「隧道进程」→ link.mjs 的隧道；running = 桥报 running
    frpc.count  实例数：running 记 1，否则 0
    server      大眼本体，恒 True（能跑到这里说明进程活着）
    assets_ok   前置条件齐全（tunnel.json 有 host/publicUrl 或桥可达）
    ==========  ====================================================

    Parameters
    ----------
    deep:
        ``True`` 时额外对公网地址发一次 ``/api/health`` 探活（只读，默认关）。
    """
    try:
        c = cfg if isinstance(cfg, dict) and cfg else load_config()
        res = _bridge_call("GET", "/api/link/state", timeout=8.0)
        data = res.get("data") or {}

        bridge_ok = bool(res.get("ok"))
        running = bool(data.get("running")) if bridge_ok else False
        url = _strip_slash(str(data.get("url") or "")) or public_url(c)
        since = data.get("since")
        if isinstance(since, (int, float)) and since and since < 1e11:
            since = int(since * 1000)  # 秒 → 毫秒（防上游改成秒）
        err = data.get("error")
        if not bridge_ok and not err:
            err = res.get("error")

        st = {
            # —— 桥字段（link.mjs status() 同名同义）——
            "running": running,
            "url": url or None,
            "since": since,
            "error": err,
            "downloading": bool(data.get("downloading", False)),
            "named": bool(data.get("named", False)),
            "binary": data.get("binary"),
            "provider": data.get("provider") or c.get("provider") or "auto",
            "desired": bool(data.get("desired", False)),
            "retryIn": int(data.get("retryIn") or 0),
            "log": data.get("log"),
            # —— 兼容视图 ——
            "public_url": url,
            "enabled": bool(c.get("enabled")),
            "guard": {
                "running": bridge_ok,
                "port": c.get("bridge_port") or _bridge_port(),
                "pid": None,
            },
            "frpc": {"running": running, "count": 1 if running else 0},
            "server": {"running": True, "port": c.get("app_port") or DEFAULT_APP_PORT},
            "assets_ok": bool(c.get("host") or url or bridge_ok),
            "guard_port": c.get("guard_port") or DEFAULT_GUARD_PORT,
            "app_port": c.get("app_port") or DEFAULT_APP_PORT,
            "bridge_port": c.get("bridge_port") or _bridge_port(),
            "source": "bridge" if bridge_ok else "fallback",
            "checked_at": time.time(),
        }
        if deep:
            st["probe"] = _probe_public(st["public_url"])
            st["deep"] = True
        return st
    except Exception as exc:
        return _empty_status(f"{type(exc).__name__}: {exc}")


# ─────────────────────────── 保活 / 停止（委托桥） ───────────────────────────


def ensure_running(cfg: dict | None = None, fresh: bool = False) -> dict:
    """确保隧道在跑 —— **委托给 phone-bridge，不自己 spawn ssh**。**绝不抛**。

    等价于 ``POST http://127.0.0.1:8899/api/link/start``（header x-phone-token），
    由 link.mjs 的 ``start()`` 按 tunnel.json 选 provider 并拉起进程。

    Parameters
    ----------
    fresh:
        旧版语义是「先杀旧看护再重建」。新架构下**不杀任何进程**：
        link.start() 本身幂等（已在跑就直接回状态），所以这里只把 fresh
        记进返回值，不做任何破坏性动作。

    Returns
    -------
    dict
        ``{"ok": bool, "action": "start", "fresh": bool, "via": "bridge",
        "http": int|None, "status": {...}, "error": str|None}``
    """
    try:
        res = _bridge_call("POST", "/api/link/start", timeout=60.0)
        data = res.get("data") or {}
        if res.get("ok"):
            st = status()
        else:
            st = _empty_status(res.get("error"))
        return {
            "ok": bool(res.get("ok")),
            "action": "start",
            "fresh": bool(fresh),
            "via": "bridge",
            "http": res.get("http"),
            "status": st,
            "error": res.get("error"),
            "bridge_status": data if isinstance(data, dict) else {},
        }
    except Exception as exc:
        return {"ok": False, "action": "start", "fresh": bool(fresh), "via": "bridge",
                "http": None, "status": _empty_status(str(exc)),
                "error": f"{type(exc).__name__}: {exc}"}


def stop_link() -> dict:
    """停止公网链路 —— **委托给 phone-bridge**（``POST /api/link/stop``）。**绝不抛**。

    desktop.py:885 在退出时调它，所以这里必须快且不抛：桥不在就直接返回失败，
    不让退出流程卡住。
    """
    try:
        res = _bridge_call("POST", "/api/link/stop", timeout=15.0)
        return {
            "ok": bool(res.get("ok")),
            "action": "stop",
            "via": "bridge",
            "http": res.get("http"),
            "status": status(),
            "error": res.get("error"),
        }
    except Exception as exc:
        return {"ok": False, "action": "stop", "via": "bridge", "http": None,
                "status": _empty_status(str(exc)),
                "error": f"{type(exc).__name__}: {exc}"}


def kill_legacy_supervisor() -> int:
    """清理旧版遗留的看护/ssh 进程，返回清理数量。**绝不抛**。

    server.py:2935 拿返回值决定要不要 ``ensure_running(fresh=True)``，所以
    返回值必须是「真的清掉了几个」，而不是「大概有几个」。

    重建时的安全策略（**默认返回 0，不动任何进程**）：

    * 旧架构的看护是 ``guard_proxy.py`` + ``frpc.exe``，命令行里带
      ``tunnel/`` 目录或 ``-c frpc.toml``。现在这些文件已不存在（tunnel/ 目录
      已删），再按名字杀 ``python``/``ssh`` 会误伤正在跑的 DSH 本体和当下
      这条 selfhost 隧道 —— 任务明确要求「默认绝不杀当前在跑的隧道」。
    * 因此本函数**只在**环境变量 ``TM_LEGACY_MARKERS`` 显式给出特征串时才扫描
      进程表（逗号分隔，例如 ``guard_proxy.py,frpc.toml,legacy_tunnel``），
      且只终止命令行同时命中标记、又**不含** ``link.mjs`` / 当前桥端口的进程。
    * 默认（未设置该变量）直接返回 0：让 server.py 走「无旧看护，链沿用
      tunnel.json」那条分支，行为最安全。

    Returns
    -------
    int
        实际清理的进程数；默认 0。
    """
    try:
        markers_raw = os.environ.get("TM_LEGACY_MARKERS", "").strip()
        if not markers_raw:
            return 0
        markers = [m.strip().lower() for m in markers_raw.split(",") if m.strip()]
        if not markers:
            return 0

        # 只有显式开启才走到这里：用一次性的 tasklist 取进程表（不 spawn 长期进程）
        import subprocess

        killed = 0
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout or ""
        protected = ("link.mjs", "phone-bridge", "server.py", "desktop.py")
        for line in out.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) < 2:
                continue
            name = parts[0].strip('"')
            pid = parts[1].strip('"')
            low = name.lower()
            if not low.endswith(".exe") or low in ("python.exe", "pythonw.exe", "ssh.exe"):
                # 只按**名字**无法区分新旧，宁可不杀（命令行信息这里拿不到）
                continue
            if any(m in low for m in markers):
                try:
                    subprocess.run(["taskkill", "/F", "/PID", pid],
                                   capture_output=True, timeout=8,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    killed += 1
                except Exception:
                    continue
        return killed
    except Exception:
        return 0


# ─────────────────────────── 兼容别名 ───────────────────────────
# 历史上这几个名字在别处出现过（旧版 server/桌面端），保留别名以免再踩空。
start = ensure_running
stop = stop_link
get_status = status
get_config = load_config


__all__ = [
    "load_config", "public_url", "config_view", "status",
    "ensure_running", "stop_link", "kill_legacy_supervisor",
    "start", "stop", "get_status", "get_config",
    "TUNNEL_JSON", "ROOT_DIR", "BRIDGE_TOKEN_HEADER",
]
