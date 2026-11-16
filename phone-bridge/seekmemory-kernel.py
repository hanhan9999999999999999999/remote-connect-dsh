"""SeekMemory 内核的最小 HTTP 服务（本项目自建，vendor 引用 _ref/Seekmemory）。

为什么需要这一层：
  SeekMemory 仓库自带的 HTTP 入口只有两个
    - scripts/runtime_http.py  → /healthz + /runtime/events + /runtime/context（不含记忆读写）
    - adapters/console/server.py → /api/<action>（管理台：列表/详情/图谱/人格包，不含 recall/capture）
  而 DSH 适配器（adapters/dsh/src/kernel-client.js）要的是 7 个端点的「内核契约」：
    GET  /healthz  POST /capture  POST /recall  GET /persona  GET /status
    GET  /extract/plan  POST /extract/commit
  所以这里照 adapters/console/runtime.py（70 行、零宿主耦合的组装范例）补一层薄壳，
  只暴露契约要求的端点，不碰任何宿主概念。

用法：
  python phone-bridge/seekmemory-kernel.py --data-dir <目录> --port 8791 --token <32+ 字符>
  然后会在数据目录里写 runtime.json（端口/令牌/pid），供适配器或脚本读取。

契约符合性由 SeekMemory 自带的脚本验收：
  node _ref/Seekmemory/adapters/dsh/scripts/check-kernel-contract.mjs --runtime <runtime.json>
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
VENDOR = (HERE.parent / "_ref" / "Seekmemory").resolve()

# 照 scripts/console_http.py 的做法：给源码目录一个稳定包名，让包内相对导入可用，
# 同时又不用 import main.py（那个入口会去绑定 AstrBot 钩子）。
_pkg = type(sys)("_seekmemory_kernel")
_pkg.__path__ = [str(VENDOR)]
sys.modules[_pkg.__name__] = _pkg

ConsoleRuntime = importlib.import_module(
    f"{_pkg.__name__}.adapters.console.runtime"
).ConsoleRuntime
Source = importlib.import_module(f"{_pkg.__name__}.core.domain.memory.source").Source
make_source_id = importlib.import_module(
    f"{_pkg.__name__}.core.domain.memory.source"
).make_source_id

# ConsoleRuntime 把 RecallService 只交给了 ManagementService，没有挂成 self.recall，
# 所以这里按 adapters/console/runtime.py 同样的方式自己再组装一份（依赖同样来自 vendor）。
_mod_open_store = importlib.import_module(f"{_pkg.__name__}.store").open_store
_mod_cache = importlib.import_module(f"{_pkg.__name__}.store.cache").Cache
_mod_graph = importlib.import_module(f"{_pkg.__name__}.core.graph").Graph
_mod_budget = importlib.import_module(f"{_pkg.__name__}.app.budget").ContextBudget
_mod_retriever = importlib.import_module(f"{_pkg.__name__}.recall.retriever").HybridRetriever
_mod_recall = importlib.import_module(f"{_pkg.__name__}.services.recall_service").RecallService
_mod_status = importlib.import_module(f"{_pkg.__name__}.services.status_service").StatusService
_mod_management = importlib.import_module(
    f"{_pkg.__name__}.services.management_service"
).ManagementService
_mod_packs = importlib.import_module(f"{_pkg.__name__}.adapters.persona_packs").FilePersonaPacks

HOST_CONTRACT = 1


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


class Kernel:
    """持有一个本地数据库，所有访问都串到同一个线程。

    为什么必须串线程：SQLite 连接不能跨线程用（`check_same_thread` 默认 True），
    而 HTTP 每个请求一个线程。SeekMemory 自己的 ConsoleWorker 也是用
    `ThreadPoolExecutor(max_workers=1)` 解决同一问题，这里照做。
    """

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self._ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="seekmemory-kernel")
        # 构造也放进那唯一的线程里，否则连接会绑定到主线程
        self._build(data_dir)

    def _build(self, data_dir: Path) -> None:
        def _make():
            store = _mod_open_store(str(data_dir / "memory.db"))
            cache = _mod_cache(store.artifacts)
            cache.load()
            graph = _mod_graph(store.artifacts)
            recall = _mod_recall(
                cache=cache,
                graph=graph,
                artifacts=store.artifacts,
                sources=store.sources,
                budget=_mod_budget(),
                config={}.get,
                owner_umo=lambda: "dsh:YG",
                hybrid_retriever=_mod_retriever(graph, cache),
            )
            management = _mod_management(
                store.artifacts,
                store.sources,
                store.ledger,
                cache,
                recall,
                packs=_mod_packs(VENDOR / "persona_seeds", data_dir / "persona_packs"),
                dreams=store.dreams,
            )
            status = _mod_status(artifacts=store.artifacts, ledger=store.ledger)

            # 披露策略按「单用户私有助手」调：这个库默认假设「可能有旁观者」，
            # 于是记忆算出来只够 HINT 档，永远只回一句「你隐约记得有件相关的事」——
            # 存了等于没存。这里三处一起放宽：全文门槛 0.55→0.25、private 的敏感折损
            # 0.2→0.05、同说话人的上下文亲和 0.70→1.0、private 的范围先验 0.8→1.0。
            # 依据：本机只有 YG 一个人用，没有旁听者，记忆本就该被说出来。
            _disc = importlib.import_module(f"{_pkg.__name__}.core.domain.memory.disclosure")
            _disc.FULL_MIN = 0.25
            _disc._SCOPE_SENSITIVITY["private"] = 0.05
            _disc._SCOPE_PRIOR["private"] = 1.0
            _disc._SPEAKER_CONTEXT_AFFINITY = 1.0
            # 这里在构建阶段，logger 还没就绪，直接打到 stderr（会被重定向进 kernel.err）
            print(
                f"disclosure tuned: FULL_MIN={_disc.FULL_MIN} "
                f"private_sens={_disc._SCOPE_SENSITIVITY['private']} "
                f"private_prior={_disc._SCOPE_PRIOR['private']} "
                f"speaker_affinity={_disc._SPEAKER_CONTEXT_AFFINITY}",
                file=sys.stderr, flush=True,
            )

            return {"store": store, "recall": recall, "management": management, "status": status}

        parts = self._run(_make)
        self.store = parts["store"]
        self.recall_service = parts["recall"]
        self.management = parts["management"]
        self.status_service = parts["status"]
        self.captured = 0

    def _run(self, fn):
        return self._ex.submit(fn).result()

    def capture(self, body: dict) -> dict:
        session = str(body.get("session") or body.get("session_id") or "")
        role = str(body.get("role") or "user")
        text = str(body.get("text") or "")
        speaker = str(body.get("speaker_id") or body.get("subject_key") or "")
        at = str(body.get("at") or "") or _now_iso()
        msg_id = str(body.get("msg_id") or "")
        if not text.strip():
            raise ValueError("text empty")
        sid = make_source_id(
            event_id=msg_id,
            session_id=session,
            speaker_id=speaker,
            role=role,
            text=text,
            at=at,
        )
        src = Source(
            id=sid,
            turn_id=msg_id,
            session_id=session,
            speaker_id=speaker,
            role=role if role in ("user", "assistant", "system", "tool", "external") else "user",
            text=text,
            at=at,
            metadata={"subject_key": str(body.get("subject_key") or "")},
        )
        with_meta = self._run(lambda: self.store.sources.append_sources([src]))
        self.captured += 1
        return {"ok": True, "source_id": sid, "accepted": True, "written": with_meta}

    def recall(self, body: dict) -> dict:
        query = str(body.get("query") or "")
        session = str(body.get("session") or body.get("session_id") or "")
        speaker = str(body.get("speaker_id") or "")
        private = bool(body.get("private"))
        block, info = self._run(
            lambda: self.recall_service.query(
                query, session_id=session, private=private, speaker=speaker
            )
        )
        return {"ok": True, "block": block or "", "info": info if isinstance(info, dict) else {}}

    def persona(self, subject_key: str) -> dict:
        def _get():
            try:
                return self.status_service.persona()
            except Exception:
                return None

        p = self._run(_get)
        if isinstance(p, dict):
            return {"ok": True, "text": str(p.get("text") or p.get("summary") or ""), "revision": p.get("revision", 0), "raw": p}
        return {"ok": True, "text": "", "revision": 0}

    def _status_dict(self) -> dict:
        """状态：把 status_service 能给的都拿出来，任何一项失败都不影响整体。"""
        out = {"ready": True, "checks": []}
        try:
            out["checks"].append({"name": "ledger", "ok": bool(self.status_service.ledger_valid()), "detail": "账本哈希链"})
        except Exception as exc:
            out["checks"].append({"name": "ledger", "ok": False, "detail": type(exc).__name__})
        try:
            out["persona"] = self.status_service.persona()
        except Exception:
            out["persona"] = None
        try:
            out["records"] = len(self.management.catalog())
        except Exception:
            out["records"] = None
        return out

    def status(self) -> dict:
        base = self._run(self._status_dict)
        base.update({
            "ok": True,
            "host_contract": HOST_CONTRACT,
            "runtime_contract": 1,
            "kernel": "seekmemory-min",
            "captured": self.captured,
            "data_dir": str(self.data_dir),
        })
        return base

    def close(self) -> None:
        try:
            self._run(self.store.close)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    kernel: Kernel
    token: str

    def log_message(self, *_args: Any) -> None:
        return

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth(self) -> bool:
        if self.headers.get("authorization") != f"Bearer {self.token}":
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            obj = json.loads(raw or b"{}")
            return obj if isinstance(obj, dict) else {}
        except (TypeError, ValueError):
            return {}

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        query = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        if path == "/healthz":
            self._json(200, {
                "ok": True,
                "version": "0.1.0-seekmemory-min",
                "host_contract": HOST_CONTRACT,
                "runtime_contract": 1,
            })
            return
        if not self._auth():
            return
        if path == "/persona":
            self._json(200, self.kernel.persona(query.get("subject_key", "")))
            return
        if path == "/status":
            self._json(200, self.kernel.status())
            return
        if path == "/extract/plan":
            # 抽取循环本轮不启用：204 是契约允许的「没事干」
            self._json(204, {})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if not self._auth():
            return
        body = self._body()
        try:
            if path == "/capture":
                self._json(200, self.kernel.capture(body))
                return
            if path == "/recall":
                self._json(200, self.kernel.recall(body))
                return
            if path == "/extract/commit":
                self._json(200, {"ok": True, "written": 0, "skipped": 0})
                return
        except ValueError as exc:
            self._json(400, {"error": type(exc).__name__, "detail": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - 契约要求永不 500 崩掉宿主
            self._json(500, {"error": type(exc).__name__, "detail": str(exc)})
            return
        self._json(404, {"error": "not_found"})


def main() -> int:
    parser = argparse.ArgumentParser(description="SeekMemory 最小内核服务")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--token", default=os.environ.get("SEEKMEMORY_KERNEL_TOKEN", ""))
    args = parser.parse_args()

    token = args.token
    if len(token) < 16:
        print("需要 --token（≥16 字符）或环境变量 SEEKMEMORY_KERNEL_TOKEN", file=sys.stderr)
        return 2
    if not VENDOR.is_dir():
        print(f"找不到 SeekMemory 源码：{VENDOR}", file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir).expanduser().resolve()
    kernel = Kernel(data_dir)
    Handler.kernel = kernel
    Handler.token = token

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    endpoint = {
        "port": server.server_address[1],
        "token": token,
        "pid": os.getpid(),
        "version": "0.1.0-seekmemory-min",
        "host_contract": HOST_CONTRACT,
        "runtime_contract": 1,
        "data_dir": str(data_dir),
        "started_at": _now_iso(),
    }
    (data_dir / "runtime.json").write_text(json.dumps(endpoint, ensure_ascii=False), encoding="utf-8")
    print(f"SeekMemory kernel: http://127.0.0.1:{server.server_port}  (runtime.json 已写)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        kernel.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
