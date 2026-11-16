"""聊天链路自检：起一个 OpenAI 兼容的本地桩（127.0.0.1:11434），
把当前模型临时切到桩上，真发一条消息，确认回复落库、再切回原模型。

- 11434 被真正的 Ollama 占着时打印 SKIP 并退出 0。
- 任何失败都会在 finally 里切回原 provider/model，不会把配置留在桩上。
"""
import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "http://127.0.0.1:9890"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 11434
MODEL = "stub-selftest"
TITLE = "聊天链路自检"

REPLY = "你好，我是本地桩，这条回复来自自检。"


class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/v1/models"):
            self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}
        if not self.path.rstrip("/").endswith("/v1/chat/completions"):
            self._json(404, {"error": "not found"})
            return
        usage = {"prompt_tokens": 8, "completion_tokens": 12, "total_tokens": 20}
        msgs = body.get("messages") or []
        saw_tool = any(m.get("role") == "tool" for m in msgs)
        users = [m for m in msgs if m.get("role") == "user"]
        last_user = str((users[-1].get("content") if users else "") or "")
        want_tool = (not saw_tool) and any("读文件" in str(m.get("content") or "") for m in users)
        if not body.get("stream"):
            if saw_tool:
                self._json(200, {
                    "id": "stub", "object": "chat.completion", "created": 0, "model": MODEL,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "读到了 hello.txt。工具调用这一路是通的。"},
                                 "finish_reason": "stop"}],
                    "usage": usage,
                })
            elif want_tool:
                msg = {"role": "assistant", "content": "", "tool_calls": [{
                    "id": "call_stub_1", "type": "function",
                    "function": {"name": "read_file", "arguments": json.dumps({"path": "hello.txt"})}}]}
                self._json(200, {"id": "stub", "object": "chat.completion", "created": 0, "model": MODEL,
                                 "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls"}],
                                 "usage": usage})
            else:
                self._json(200, {
                    "id": "stub", "object": "chat.completion", "created": 0, "model": MODEL,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY},
                                 "finish_reason": "stop"}],
                    "usage": usage,
                })
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        base = {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": MODEL}

        def send(delta, finish=None):
            obj = dict(base)
            obj["choices"] = [{"index": 0, "delta": delta, "finish_reason": finish}]
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            send({"role": "assistant", "content": ""})
            if saw_tool:
                for _p in ("读到了 hello.txt。", "工具调用这一路是通的。"):
                    send({"content": _p})
                    time.sleep(0.05)
                send({}, "stop")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
                return
            if want_tool:
                send({"tool_calls": [{
                    "index": 0, "id": "call_stub_1", "type": "function",
                    "function": {"name": "read_file", "arguments": json.dumps({"path": "hello.txt"})}}]})
                send({}, "tool_calls")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
                return
            # 分几段吐，顺带覆盖增量拼接；带「慢」的请求放慢，用于测停止
            slow = "慢" in json.dumps(body, ensure_ascii=False)
            for i in range(0, len(REPLY), 6):
                send({"content": REPLY[i:i + 6]})
                time.sleep(0.25 if slow else 0.03)
            send({}, "stop")
        except (ConnectionAbortedError, ConnectionResetError, OSError):
            self.close_connection = True
            return
        try:
            self.wfile.write(("data: " + json.dumps({"id": "stub", "object": "chat.completion", "model": MODEL,
                                                     "choices": [], "usage": usage}, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (ConnectionAbortedError, ConnectionResetError, OSError):
            pass
        self.close_connection = True


class QuietServer(ThreadingHTTPServer):
    """停止用例会主动断开连接，socketserver 默认会打一整段 traceback —— 静音。"""

    def handle_error(self, request, client_address):
        pass


def call(path, obj=None):
    data = None if obj is None else json.dumps(obj).encode()
    r = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=90))


def main():
    try:
        srv = QuietServer(("127.0.0.1", PORT), Stub)
    except OSError:
        print("RESULT: SKIP | port 11434 busy (Ollama?)")
        return 0
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()

    cfg = call("/api/project-config")
    old_provider, old_model = cfg.get("provider"), cfg.get("model")
    tid = None
    tid2 = None
    tid3 = None
    ok = False
    detail = ""
    try:
        sw = call("/api/switch-model", {"provider": "ollama", "model_id": MODEL})
        if not sw.get("success"):
            raise RuntimeError("switch-model failed: %s" % sw)

        t = call("/api/topic/new", {"title": TITLE})
        tid = t["id"]
        data = call("/api/chat", {"message": "自检：请回一句", "topic_id": tid})
        resp = str(data.get("response") or "")
        if REPLY not in resp:
            raise RuntimeError("回复里没有桩内容：%r" % resp[:120])

        msgs = call("/api/messages?topic_id=" + tid).get("messages") or []
        ai = [m for m in msgs if m.get("role") == "ai"]
        if not ai or REPLY not in (ai[-1].get("text") or ""):
            raise RuntimeError("AI 回复没有落库")
        detail = "reply %d chars / msgs %d" % (len(resp), len(msgs))

        # ── 停止：发一条慢的，1 秒后打 stop，确认它很快收尾而不是等满整段
        t2 = call("/api/topic/new", {"title": TITLE + "-stop"})
        tid2 = t2["id"]
        res = {}

        def _send_slow():
            t0 = time.time()
            try:
                res["data"] = call("/api/chat", {"message": "慢一点，我要中途停", "topic_id": tid2})
            except Exception as e:
                res["err"] = "%s: %s" % (type(e).__name__, e)
            res["secs"] = time.time() - t0

        th_send = threading.Thread(target=_send_slow, daemon=True)
        th_send.start()
        # 等 cancel 事件登记（agent 启动要一两秒），期间 404 就重试
        stop = {}
        for _ in range(20):
            time.sleep(0.3)
            try:
                stop = call("/api/stop-thinking", {"topic_id": tid2})
                if stop.get("status") in ("cancelling", "stopped"):
                    break
            except urllib.error.HTTPError as e:
                stop = {"status": "http-%s" % e.code}
        stop_try = time.time()
        th_send.join(timeout=15)
        took = float(res.get("secs") or 99)
        if stop.get("status") not in ("cancelling", "stopped"):
            raise RuntimeError("stop-thinking 没接住：%s" % stop)
        if took > 8:
            raise RuntimeError("停止后还是等了 %.1fs" % took)
        detail += " / stop %.1fs" % took

        # ── 工具调用：桩回 tool_call(read_file hello.txt)，看工具结果有没有喂回、最终文本有没有出来
        t3 = call("/api/topic/new", {"title": TITLE + "-tool"})
        tid3 = t3["id"]
        ws = os.path.join(ROOT, "data", "missions", tid3, "workspace")
        os.makedirs(ws, exist_ok=True)
        with open(os.path.join(ws, "hello.txt"), "w", encoding="utf-8") as f:
            f.write("桩工具读取成功\n")
        d3 = call("/api/chat", {"message": "读文件 hello.txt 看看", "topic_id": tid3})
        if "工具" not in str(d3.get("response") or ""):
            raise RuntimeError("工具轮的最终文本不对：%r" % str(d3.get("response"))[:120])
        msgs3 = call("/api/messages?topic_id=" + tid3).get("messages") or []
        tool_msgs = [m for m in msgs3 if m.get("role") == "tool"]
        if not tool_msgs or "hello.txt" not in (tool_msgs[0].get("text") or ""):
            raise RuntimeError("工具结果没落库：%s" % str(msgs3)[:160])
        detail += " / tool ok"
        for _t3 in (tid3,):
            try:
                call("/api/topic/delete", {"topic_id": _t3})
            except Exception:
                pass
        ok = True
        try:
            call("/api/topic/delete", {"topic_id": tid2})
            for it in (call("/api/recycle/list").get("items") or []):
                if str(it.get("title") or "") in (TITLE + "-stop", TITLE):
                    call("/api/recycle/delete", {"dir_name": it.get("dir_name")})
        except Exception:
            pass
    except Exception as e:
        detail = "%s: %s" % (type(e).__name__, e)
    finally:
        try:
            call("/api/switch-model", {"provider": old_provider, "model_id": old_model})
        except Exception as e:
            detail += " | restore failed: %s" % e
        for _t in (tid, tid2, tid3):
            if not _t:
                continue
            try:
                call("/api/topic/delete", {"topic_id": _t})
                # 只摘掉自己这两条快照，别动用户回收站里的别的东西
                items = call("/api/recycle/list").get("items") or []
                for it in items:
                    if str(it.get("title") or "") in (TITLE, TITLE + "-stop", TITLE + "-tool"):
                        call("/api/recycle/delete", {"dir_name": it.get("dir_name")})
            except Exception:
                pass
            # 自检自己造的 workspace（hello.txt）也一并收掉，别在 data/missions 里留垃圾
            try:
                shutil.rmtree(os.path.join(ROOT, "data", "missions", _t), ignore_errors=True)
            except Exception:
                pass
        srv.shutdown()
        srv.server_close()
    print(("RESULT: OK | " if ok else "RESULT: FAIL | ") + detail)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
