# -*- coding: utf-8 -*-
"""SeekMemory 抽取器：把原始对话抽成可检索的记忆条目。

为什么单独一个进程：
- 内核（seekmemory-kernel.py）只负责契约端点，已通过 15 项检查，不想因为加了 LLM 调用把它的稳定性拖下水。
- 抽取慢、会失败、需要重试，天然应该独立跑；失败也不影响 capture 与 recall 的在线可用性。

数据流：
    sources（原始对话） --build_prompt--> DeepSeek --JSON--> build_plan --> artifacts.commit_many
                                                             ↑
                                                    这一步之后 recall 才有候选

用法：
    python seekmemory-extract.py --data-dir <dir> --api-key <key> [--once] [--interval 20]
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

VENDOR = Path(r"D:\document\Remote Connect DSH\_ref\Seekmemory")
DEFAULT_BASE = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"


def load_vendor():
    """给源码目录注入稳定包名，和内核用的是同一套技巧。"""
    if "seekmemory_vendor" in sys.modules:
        return sys.modules["seekmemory_vendor"]
    import types

    pkg = types.ModuleType("seekmemory_vendor")
    pkg.__path__ = [str(VENDOR)]
    sys.modules["seekmemory_vendor"] = pkg
    return pkg


def mod(name: str):
    pkg = load_vendor()
    full = f"{pkg.__name__}.{name}"
    return importlib.import_module(full)


def chat(base: str, key: str, model: str, prompt: str, timeout: int = 120) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return str(data["choices"][0]["message"]["content"] or "")


class Extractor:
    def __init__(self, data_dir: Path, base: str, key: str, model: str, log):
        self.data_dir = data_dir
        self.base = base
        self.key = key
        self.model = model
        self.log = log

        open_store = mod("store")
        absorb = mod("perceive.absorb")
        extract = mod("perceive.extract")
        self._dialogue_of = absorb.dialogue_of
        self._build_plan = absorb.build_plan
        self._build_prompt = extract.build_prompt

        store = open_store.open_store(str(data_dir / "memory.db"))
        self.store = store
        cache_mod = mod("store.cache")
        self.cache = cache_mod.Cache(store.artifacts)
        self.cache.load()

    def pending(self, limit: int = 40):
        """取出「还没有产生过任何 artifact」的 source。

        by_source_ids 反查是最可靠的判据：已抽取过的 source 一定挂在某条记忆上。
        """
        sources = self.store.sources.recent_sources(since="2000-01-01T00:00:00", limit=limit)
        index = {s.id: s for s in sources}
        used = set()
        for sid in list(index):
            if self.store.artifacts.by_source_ids([sid]):
                used.add(sid)
        # 按时间正序处理，聊天顺序不乱
        items = sorted(index.values(), key=lambda s: getattr(s, "at", "") or "")
        return [s for s in items if s.id not in used]

    def _turns(self, sources):
        """Source → DialogueTurn，并给每条编一个短号（u1/a1…）。

        build_plan 会拿 evidence_source_ids 去对 turn.source_id（`available` 字典的键），
        而 prompt 示例里的编号就是 u1/a1 这种短号 —— 所以这里把 source_id 设成短号，
        真实的 source 主键另存一列，提交 artifact 时用真 id 建关联。
        """
        contracts = mod("app.contracts")
        turns, real_ids = [], []
        un = an = 0
        for s in sources:
            role = str(getattr(s, "role", "user") or "user")
            if role == "user":
                un += 1
                num = f"u{un}"
            else:
                an += 1
                num = f"a{an}"
            text = str(getattr(s, "text", "") or "")
            turns.append(contracts.DialogueTurn(
                session_id=str(getattr(s, "session_id", "") or ""),
                speaker_id=str(getattr(s, "speaker_id", "") or ""),
                role=role,
                text=text,
                at=str(getattr(s, "at", "") or ""),
                source_id=num,
                reply_to=getattr(s, "reply_to", None),
            ))
            real_ids.append(str(getattr(s, "id", "") or getattr(s, "source_id", "") or ""))
        return turns, real_ids

    def _normalize(self, art, speaker: str = "YG"):
        """把 header 的主体与范围归一：subject_id=说话人、scope=private。

        SeekMemory 默认按「可能有旁观者」打分（subject 不匹配就按 _OTHER_SUBJECT_FIT
        压到 0.35，再乘 private 的 0.8 先验），结果私密记忆永远进不了 FULL 档。
        本机只有 YG 一人使用，这里在提交前把来源归一，分数才反映真实场景。
        """
        try:
            import dataclasses
            h = art.header
            changed = False
            subj = str(getattr(h, "subject_id", "") or "")
            scope = str(getattr(h, "scope", "") or "")
            new_subj = speaker if subj in ("", "user(我)", "user", "我") else subj
            new_scope = scope if scope in ("shared", "shadow", "secret") else "private"
            if new_subj != subj or new_scope != scope:
                h2 = dataclasses.replace(h, subject_id=new_subj, scope=new_scope)
                art = dataclasses.replace(art, header=h2)
                changed = True
            if changed:
                self.log(f"normalize subject={new_subj} scope={new_scope}")
            return art
        except Exception as e:                      # 库内部结构变化时不要因此丢数据
            self.log(f"normalize skipped: {type(e).__name__} {str(e)[:80]}")
            return art

    def run_once(self, min_pending: int = 1) -> dict:
        todo = self.pending()
        if len(todo) < min_pending:
            return {"ok": True, "skipped": True, "pending": len(todo)}
        # 不用 dialogue_of()：它会把 turn 投影成「对话行」，text 会被清空（实测拿到全空）。
        # 这里直接用自己转好的 DialogueTurn，build_plan / build_prompt 都吃这个形状。
        turns, real_ids = self._turns(todo)
        if not turns:
            return {"ok": True, "skipped": True, "pending": len(todo), "reason": "no turns"}
        lines = []
        for t in turns:
            who = "我" if getattr(t, "role", "") == "user" else "DSH"
            body = getattr(t, "text", "") or getattr(t, "content", "")
            if body:
                # 行首短号是硬要求：prompt 要求 evidence_source_ids 原样引用消息编号，
                # 编号对不上 build_plan 就静默丢弃（不报错、不计数）。
                lines.append(f"{t.source_id} {who}：{body}")
        if not lines:
            return {"ok": True, "skipped": True, "reason": "no text"}
        prompt = self._build_prompt(lines)
        t0 = time.time()
        raw = chat(self.base, self.key, self.model, prompt)
        elapsed = round(time.time() - t0, 1)
        plan = self._build_plan(turns, turns, raw, self.cache, "", log=self.log)
        arts = list(getattr(plan, "artifacts", ()) or ())
        if arts:
            writes = []
            for art in arts:
                # 把主体/范围归一成「本机唯一用户」，否则 subject_fit 会判成「别人」，
                # 披露分数掉到 HINT 档 —— 记忆存了却只回一句「你隐约记得有件相关的事」。
                art = self._normalize(art, speaker="YG")
                prev = self.store.artifacts.get(art.header.id)
                rev = (prev.header.revision if prev else 0) or 0
                # 提交时用真实 source 主键建关联（turns 里的 source_id 是 u1/a1 短号）
                num2real = {t.source_id: r for t, r in zip(turns, real_ids) if r}
                ev = list(getattr(art, "evidence", ()) or ())
                ids = tuple(num2real.get(x, x) for x in ev) or tuple(r for r in real_ids if r)
                writes.append((art, rev, ids))
            self.store.artifacts.commit_many(writes, op="create", reason="seekmemory-extract")
        self.log(
            f"extract ok {elapsed}s sources={len(todo)} turns={len(turns)} "
            f"artifacts={len(arts)} skipped={getattr(plan, 'skipped', 0)} "
            f"errors={len(getattr(plan, 'errors', ()) or ())}"
        )
        return {
            "ok": True,
            "elapsed": elapsed,
            "sources": len(todo),
            "turns": len(turns),
            "artifacts": len(arts),
            "skipped": getattr(plan, "skipped", 0),
            "errors": list(getattr(plan, "errors", ()) or ())[:5],
            "raw_head": raw[:600],
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--api-key", default=os.environ.get("DEEPSEEK_API_KEY", ""))
    ap.add_argument("--base-url", default=os.environ.get("SEEKMEMORY_LLM_BASE", DEFAULT_BASE))
    ap.add_argument("--model", default=os.environ.get("SEEKMEMORY_LLM_MODEL", DEFAULT_MODEL))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--min-pending", type=int, default=2)
    args = ap.parse_args()

    if not args.api_key:
        print(json.dumps({"ok": False, "error": "缺少 api-key（--api-key 或 DEEPSEEK_API_KEY）"}))
        return 2

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "extract.log"

    def log(msg: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass

    ex = Extractor(data_dir, args.base_url, args.api_key, args.model, log)
    if args.once:
        out = ex.run_once(min_pending=args.min_pending)
        print(json.dumps(out, ensure_ascii=False)[:1200])
        return 0 if out.get("ok") else 1

    log(f"loop start interval={args.interval}s min_pending={args.min_pending} model={args.model}")
    while True:
        try:
            out = ex.run_once(min_pending=args.min_pending)
            if not out.get("skipped"):
                log(
                    f"round sources={out.get('sources')} artifacts={out.get('artifacts')} "
                    f"elapsed={out.get('elapsed')}s"
                )
        except Exception as exc:  # 抽取失败不该让进程死
            log(f"round error {type(exc).__name__}: {str(exc)[:300]}")
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
