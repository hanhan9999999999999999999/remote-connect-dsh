#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Feiyu CosyVoice3 local TTS service for the phone bridge.

Runs natively on Windows (no WSL): loads Fun-CosyVoice3-0.5B-2512 once, keeps it on
the GPU, exposes a small localhost JSON/HTTP API. The phone bridge (tts.mjs) treats
this as one more engine next to Edge/OneCore and falls back automatically when the
service is down.

Why a separate process: the model needs ~4.3 GB VRAM and a 5 GB working set. Keeping
it out of the Node bridge means the bridge can restart in a second and the model does
not have to be reloaded; and a model crash cannot take the phone channel down.

API (all JSON unless noted):
  GET  /health                -> {ok, ready, loading, style, styles, device, sampleRate, pid, uptime}
  GET  /styles                -> {ok, styles:[{id,label,candidate,referenceText}]}
  POST /tts {text, style?, speed?, seed?, format?}
                              -> audio/wav (default) or {ok, path, seconds, ...} with format=json
  POST /warmup {style?}       -> {ok, ms, style}
  POST /shutdown              -> {ok}   (localhost only, token required)

Auth: every /tts, /warmup, /shutdown request must carry `X-Feiyu-Token` matching the
token written to <state-dir>/service.json. /health and /styles stay open on loopback so
the bridge and doctor can probe readiness before they know the token.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import logging.handlers
import os
import re
import signal
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

SERVICE_NAME = "feiyu-tts"
SERVICE_VERSION = "1.3.0"
DEFAULT_PORT = 8898
MAX_TEXT = 800
MAX_BODY = 1 << 20
DEFAULT_SEED = 42
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"

# Reference audio is discovered from <pkg>/references/*.wav with a same-named .txt
# transcript. These aliases only stabilise the public style ids the phone stores;
# unknown files still get a generated id, so adding or removing a voice never needs
# a code change.
STYLE_ALIASES = {
    "可爱": "cute",
    "温柔大姐姐": "gentle",
    "小鲸鱼": "whale",
    "八重神子": "yae",
    "菲比": "phoebe",
    "弗洛洛": "fururu",
    "卡芙卡": "kafka",
    # 带情绪后缀的名字映射到同一个 id。参考音改名（给文件补情绪标签）时，
    # 手机端存下来的 style id 必须保持不变，否则声线会一夜之间变成 style-xxxxxx。
    # 两个名字都留着 = 改名前后的目录都能认出同一把嗓子。
    "八重神子+傲娇": "yae",
    "卡芙卡+温柔": "kafka",
    "小鲸鱼+撒娇": "whale",
    "温柔": "gentle",
    "弗洛洛+难过": "fururu",
    "菲比+开心": "phoebe",
}

log = logging.getLogger("feiyu-tts")


def slug_for(name: str) -> str:
    """Stable ASCII style id for a reference file stem."""
    name = str(name or "").strip()
    if name in STYLE_ALIASES:
        return STYLE_ALIASES[name]
    ascii_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if ascii_id:
        return ascii_id
    return "style-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:6]


# --------------------------------------------------------------------------- config
def default_home() -> Path:
    env = os.environ.get("FEIYU_HOME")
    if env:
        return Path(env)
    for cand in (Path(r"D:\feiyu"), Path.home() / "feiyu"):
        if (cand / "models" / "FeiyuVoice-CosyVoice3").is_dir():
            return cand
    return Path(r"D:\feiyu")


class Config:
    def __init__(self, argv=None):
        here = Path(__file__).resolve().parent
        ap = argparse.ArgumentParser(description="Feiyu CosyVoice3 local TTS service")
        ap.add_argument("--home", default=str(default_home()), help="feiyu root (contains cosyvoice/, models/, venv/)")
        ap.add_argument("--python", default="", help="python used for the model (only informational)")
        ap.add_argument("--port", type=int, default=int(os.environ.get("FEIYU_TTS_PORT", DEFAULT_PORT)))
        ap.add_argument(
            "--port-tries",
            type=int,
            default=int(os.environ.get("FEIYU_TTS_PORT_TRIES", 10)),
            help="if the preferred port is taken, try this many ports (8898, 8899, …)",
        )
        ap.add_argument("--host", default=os.environ.get("FEIYU_TTS_HOST", "127.0.0.1"))
        ap.add_argument("--style", default=os.environ.get("FEIYU_TTS_STYLE", "cute"))
        ap.add_argument("--state-dir", default=os.environ.get("FEIYU_TTS_STATE_DIR", str(here / "state")))
        ap.add_argument("--cache-dir", default=os.environ.get("FEIYU_TTS_CACHE_DIR", ""))
        ap.add_argument("--no-preload", action="store_true", help="do not load the model at startup")
        ap.add_argument("--max-cache-mb", type=int, default=int(os.environ.get("FEIYU_TTS_CACHE_MB", 512)))
        self.args = ap.parse_args(argv)
        self.home = Path(self.args.home)
        self.pkg = self.home / "models" / "FeiyuVoice-CosyVoice3"
        self.repo = self.home / "cosyvoice"
        self.state_dir = Path(self.args.state_dir)
        self.cache_dir = Path(self.args.cache_dir) if self.args.cache_dir else self.state_dir / "cache"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- model
class Engine:
    """Owns the CosyVoice instance. One inference at a time (the GPU is the bottleneck)."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.RLock()          # serializes style switch + inference (re-entrant: synth calls apply_style)
        self.state_lock = threading.Lock()
        self.voice = None
        self.ready = False
        self.loading = False
        self.load_error = ""
        self.styles = {}
        self.skipped = []
        self.current_style = ""
        self.current_checkpoint = ""
        self.sample_rate = 24000
        self.started = time.time()
        self.infer_count = 0
        self.last_error = ""
        self._styles_sig = ""
        self._styles_checked = 0.0
        self._load_styles()
        self._styles_sig = self._refs_signature()

    def _refs_signature(self) -> str:
        """Cheap fingerprint of the references folder (names, sizes, mtimes).

        The folder is edited by hand while the service is running, so /health and
        /styles need a way to notice "something changed" without re-reading every
        wav on each poll. Hashing the directory listing is a few stat calls.
        """
        refs = self.cfg.pkg / "references"
        parts = []
        try:
            entries = sorted(refs.iterdir(), key=lambda p: p.name)
        except OSError:
            return ""
        for p in entries:
            if p.suffix.lower() not in (".wav", ".txt"):
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            parts.append("%s:%d:%d" % (p.name, st.st_size, int(st.st_mtime)))
        mf = self.cfg.pkg / "manifest.json"
        try:
            st = mf.stat()
            parts.append("manifest:%d:%d" % (st.st_size, int(st.st_mtime)))
        except OSError:
            pass
        return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()

    def maybe_reload_styles(self, min_interval: float = 1.5) -> bool:
        """Pick up reference files added/removed since the last scan.

        Throttled and non-blocking: while the GPU is busy synthesizing we skip the
        rescan and let the next /health or /styles poll try again. A failed scan
        keeps the previous list instead of wiping the user's voices.
        """
        now = time.time()
        if now - self._styles_checked < min_interval:
            return False
        self._styles_checked = now
        sig = self._refs_signature()
        if not sig or sig == self._styles_sig:
            return False
        if not self.lock.acquire(blocking=False):
            return False
        try:
            sig2 = self._refs_signature()
            if sig2 == self._styles_sig:
                return False
            before = set(self.styles)
            try:
                self._load_styles()
            except Exception as e:
                log.warning("style rescan failed, keeping previous list: %s", e)
                return False
            self._styles_sig = self._refs_signature()
            if self.current_style and self.current_style not in self.styles:
                # The voice being used was deleted from disk. Keep the loaded
                # checkpoint (the next style may share it) and let synth fall back.
                self.current_style = ""
            added = sorted(set(self.styles) - before)
            removed = sorted(before - set(self.styles))
            if added or removed:
                log.info("styles synced: +%s -%s (now %s)", added, removed, ", ".join(self.styles))
            return True
        finally:
            self.lock.release()

    def _load_styles(self):
        """Discover voices from references/*.wav (+ same-named .txt transcript).

        File layout beats a hardcoded table: the user edits this folder by hand, and a
        stale mapping used to turn every request into a 500.
        """
        mf = self.cfg.pkg / "manifest.json"
        data = {}
        if mf.is_file():
            try:
                data = json.loads(mf.read_text(encoding="utf-8-sig"))
            except Exception as e:
                log.warning("manifest unreadable (%s), using defaults", e)
        base_rel = data.get("base_model_dir") or "models/Fun-CosyVoice3-0.5B-2512"
        self.base_model = str(self.cfg.pkg / base_rel)
        self.base_llm = os.path.join(self.base_model, "llm.pt")
        manifest_styles = data.get("styles") or {}

        def checkpoint_for(style_id: str, ref_name: str):
            """Prefer the manifest entry for this style id, then any entry pointing at
            the same reference file, else the base model weights."""
            row = manifest_styles.get(style_id)
            if not row:
                for cand in manifest_styles.values():
                    if os.path.basename(str(cand.get("reference_audio") or "")) == ref_name:
                        row = cand
                        break
            if row and row.get("llm_checkpoint"):
                cp = str(self.cfg.pkg / row["llm_checkpoint"])
                if os.path.isfile(cp):
                    return cp, str(row.get("candidate") or "")
            return self.base_llm, "base"

        refs = self.cfg.pkg / "references"
        self.references_dir = str(refs)
        found = {}
        skipped = []
        for wav in sorted(refs.glob("*.wav")):
            txt = wav.with_suffix(".txt")
            text = ""
            if txt.is_file():
                try:
                    text = re.sub(r"\s+", " ", txt.read_text(encoding="utf-8-sig")).strip()
                except OSError as e:
                    log.warning("cannot read %s: %s", txt.name, e)
            if not text:
                skipped.append({"file": wav.name, "reason": "缺少同名 .txt 参考文本"})
                continue
            try:
                st = wav.stat()
            except OSError:
                continue
            style_id = slug_for(wav.stem)
            n = 2
            while style_id in found:
                style_id = "%s-%d" % (slug_for(wav.stem), n)
                n += 1
            checkpoint, candidate = checkpoint_for(style_id, wav.name)
            found[style_id] = {
                "id": style_id,
                "label": wav.stem,
                "candidate": candidate,
                "checkpoint": checkpoint,
                "checkpointKind": "base" if os.path.abspath(checkpoint) == os.path.abspath(self.base_llm) else "finetune",
                "reference": str(wav),
                "referenceText": text,
                "referenceFingerprint": hashlib.sha1(
                    ("%s|%d|%d" % (wav.name, st.st_size, int(st.st_mtime))).encode("utf-8")
                ).hexdigest()[:12],
                "referenceSeconds": round(_wav_seconds(wav), 2),
            }
        if not found:
            raise RuntimeError("no usable voice found in %s (need a .wav plus a .txt transcript)" % refs)
        preferred = str(data.get("default_style") or "")
        order = [preferred] if preferred in found else []
        order += [k for k in sorted(found) if k not in order]
        self.styles = {k: found[k] for k in order}
        self.skipped = skipped
        self.default_style = order[0]
        log.info("styles: %s (default=%s)%s", ", ".join(self.styles), self.default_style,
                 (" skipped: " + ", ".join(s["file"] for s in skipped)) if skipped else "")

    # -- loading -------------------------------------------------------------
    def _patch_torchaudio(self):
        # torchaudio >= 2.9 routes load() through torchcodec (absent here). Every wav we
        # touch is a plain PCM file, so soundfile is enough and adds no dependency.
        import soundfile as sf
        import torch
        import torchaudio

        def _sf_load(path, **kwargs):
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            return torch.from_numpy(data.T.copy()), sr

        torchaudio.load = _sf_load

    def load(self):
        with self.state_lock:
            if self.ready or self.loading:
                return
            self.loading = True
        try:
            import torch
            self._patch_torchaudio()
            sys.path.insert(0, str(self.cfg.repo))
            sys.path.append(str(self.cfg.repo / "third_party" / "Matcha-TTS"))
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
            torch.set_num_threads(int(os.environ.get("FEIYU_TTS_THREADS", "4")))
            from cosyvoice.cli.cosyvoice import AutoModel

            log.info("loading model: %s", self.base_model)
            t0 = time.perf_counter()
            self.voice = AutoModel(model_dir=self.base_model, fp16=False, load_trt=False, load_vllm=False)
            self.voice.model.llm.eval()
            self.sample_rate = int(self.voice.sample_rate)
            log.info("model loaded in %.1fs · device=%s · sr=%s", time.perf_counter() - t0,
                     "cuda" if torch.cuda.is_available() else "cpu", self.sample_rate)
            with self.state_lock:
                self.ready = True
                self.loading = False
            self.apply_style(self.cfg.args.style, initial=True)
        except Exception as e:  # keep the HTTP server alive so /health explains the failure
            log.error("model load failed: %s\n%s", e, traceback.format_exc())
            with self.state_lock:
                self.ready = False
                self.loading = False
                self.load_error = str(e)

    def apply_style(self, style: str, initial: bool = False):
        import torch

        if style not in self.styles:
            raise ValueError("unknown style: " + style)
        row = self.styles[style]
        with self.lock:
            if self.current_style == style and not initial:
                return
            if self.voice is None:
                raise RuntimeError("model not loaded")
            checkpoint = os.path.abspath(row["checkpoint"])
            if initial:
                # AutoModel already loaded the base llm.pt.
                self.current_checkpoint = os.path.abspath(self.base_llm)
            if checkpoint == self.current_checkpoint:
                self.current_style = style
                log.info("style=%s (weights already in memory, no swap)", style)
                return
            t0 = time.perf_counter()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            state = torch.load(checkpoint, map_location="cpu", weights_only=True)
            self.voice.model.llm.load_state_dict(state, strict=True)
            del state
            self.voice.model.llm.eval()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            self.current_style = style
            self.current_checkpoint = checkpoint
            log.info("style=%s loaded in %.2fs (%s)", style, time.perf_counter() - t0, row["candidate"] or "base")

    def resolve_style(self, value) -> str:
        """Accept an id, the reference file stem, or a Chinese alias."""
        raw = str(value or "").strip()
        if not raw:
            return self.default_style
        low = raw.lower()
        if low in self.styles:
            return low
        for style_id, row in self.styles.items():
            if raw == row["label"] or low == str(row["label"]).lower():
                return style_id
        alias = STYLE_ALIASES.get(raw)
        if alias and alias in self.styles:
            return alias
        raise KeyError(raw)

    # -- synthesis -----------------------------------------------------------
    def synth(self, text: str, style: str, speed: float, seed: int):
        """Returns (wav_bytes, meta). Raises on failure."""
        import numpy as np
        import soundfile as sf

        row = self.styles[style]
        with self.lock:
            if self.current_style != style:
                self.apply_style(style)
            import torch
            from cosyvoice.utils.common import set_all_random_seed

            set_all_random_seed(int(seed))
            t0 = time.perf_counter()
            chunks = []
            with torch.inference_mode():
                for piece in split_for_tts(text):
                    for item in self.voice.inference_zero_shot(
                        piece,
                        PROMPT_PREFIX + row["referenceText"],
                        row["reference"],
                        stream=False,
                        speed=float(speed),
                        text_frontend=True,
                    ):
                        chunks.append(item["tts_speech"].detach().cpu().numpy()[0])
            if not chunks:
                raise RuntimeError("model returned no audio")
            audio = np.concatenate(chunks)
            peak = float(np.abs(audio).max()) if audio.size else 0.0
            if not np.isfinite(audio).all() or peak < 1e-4:
                raise RuntimeError("model returned silent or non-finite audio")
            peak = float(np.abs(audio).max())
            gain = min(1.0, 0.98 / peak) if peak > 0 else 1.0
            pcm = np.clip(audio * gain, -1.0, 1.0)
            import io

            buf = io.BytesIO()
            sf.write(buf, pcm, self.sample_rate, format="WAV", subtype="PCM_16")
            self.infer_count += 1
            meta = {
                "style": style,
                "candidate": row["candidate"],
                "seconds": round(len(audio) / self.sample_rate, 3),
                "elapsed": round(time.perf_counter() - t0, 3),
                "sampleRate": self.sample_rate,
                "peak": round(peak, 4),
                "gain": round(gain, 4),
                "chars": len(text),
            }
            return buf.getvalue(), meta

    def styles_public(self):
        out = []
        for s in self.styles.values():
            out.append({
                "id": s["id"],
                "label": s["label"],
                "candidate": s["candidate"],
                "checkpointKind": s["checkpointKind"],
                "reference": os.path.basename(s["reference"]),
                "referenceText": s["referenceText"],
                "referenceSeconds": s["referenceSeconds"],
            })
        return out

    def health(self):
        # The phone polls /health every few seconds; piggyback the reference scan
        # here so a voice dropped into references/ shows up without a restart.
        self.maybe_reload_styles()
        cur = self.current_style or self.default_style
        cur_label = (self.styles.get(cur) or {}).get("label") or cur
        return {
            "ok": True,
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "ready": bool(self.ready),
            "loading": bool(self.loading),
            "loadError": self.load_error,
            "lastError": self.last_error,
            "style": cur,
            "styleLabel": cur_label,
            "defaultStyle": self.default_style,
            "styles": self.styles_public(),
            "skipped": self.skipped,
            "referencesDir": self.references_dir,
            "device": _device_name(),
            "sampleRate": self.sample_rate,
            "pid": os.getpid(),
            "uptime": round(time.time() - self.started, 1),
            "inferences": self.infer_count,
        }


def _device_name() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
        return "cpu"
    except Exception:
        return "unknown"


def _wav_seconds(path) -> float:
    """Duration of a PCM wav without pulling in ffprobe."""
    try:
        import wave

        with wave.open(str(path), "rb") as w:
            rate = w.getframerate() or 1
            return float(w.getnframes()) / float(rate)
    except Exception:
        return 0.0


def split_for_tts(text: str, limit: int = 180):
    """Split long text on sentence punctuation; CosyVoice quality drops on very long inputs."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for piece in re.split(r"(?<=[。！？!?；;\n])", text):
        if not piece:
            continue
        if len(cur) + len(piece) <= limit:
            cur += piece
            continue
        if cur:
            parts.append(cur.strip())
        while len(piece) > limit:
            cut = max(piece.rfind("，", 0, limit), piece.rfind(",", 0, limit), limit)
            parts.append(piece[:cut + 1].strip())
            piece = piece[cut + 1:]
        cur = piece
    if cur.strip():
        parts.append(cur.strip())
    return [p for p in parts if p]


# --------------------------------------------------------------------------- http
class Api:
    def __init__(self, cfg: Config, engine: Engine, token: str):
        self.cfg = cfg
        self.engine = engine
        self.token = token
        self.cache = cfg.cache_dir
        self.cache_hits = 0

    def cache_path(self, text, style, speed, seed, ref_fp=""):
        # ref_fp ties the cached wav to the exact reference audio behind the style, so
        # replacing a reference file invalidates old audio instead of replaying it.
        key = hashlib.sha1(
            ("v2|%s|%s|%.3f|%d|%s|%s" % (style, text, speed, seed, ref_fp, SERVICE_VERSION)).encode("utf-8")
        ).hexdigest()[:24]
        return self.cache / (key + ".wav")

    def prune_cache(self):
        limit = self.cfg.args.max_cache_mb * 1024 * 1024
        if limit <= 0:
            return
        files = []
        total = 0
        for p in self.cache.glob("*.wav"):
            try:
                st = p.stat()
            except OSError:
                continue
            files.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= limit:
            return
        files.sort()
        for _, size, p in files:
            if total <= limit:
                break
            try:
                p.unlink()
                total -= size
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FeiyuTTS/" + SERVICE_VERSION

    api: Api = None  # set by serve()

    # -- helpers -------------------------------------------------------------
    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def _send(self, code, payload=None, body=None, ctype="application/json; charset=utf-8", extra=None):
        if body is None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _authorized(self):
        # Loopback only; token protects against other local apps / stray browser tabs.
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return False
        return self.headers.get("X-Feiyu-Token", "") == self.api.token

    def _error(self, code, message):
        log.warning("http %s %s: %s", code, self.path, message)
        self._json(code, {"ok": False, "error": message})

    # -- routes --------------------------------------------------------------
    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/health":
            return self._json(200, self.api.engine.health())
        if route == "/styles":
            self.api.engine.maybe_reload_styles()
            return self._json(200, {
                "ok": True,
                "service": SERVICE_NAME,
                "version": SERVICE_VERSION,
                "defaultStyle": self.api.engine.default_style,
                "styles": self.api.engine.styles_public(),
                "skipped": self.api.engine.skipped,
            })
        if route in ("/", "/index.html"):
            return self._json(200, {
                "ok": True, "service": "feiyu-tts", "version": SERVICE_VERSION,
                "endpoints": ["GET /health", "GET /styles", "POST /tts", "POST /warmup"],
            })
        return self._error(404, "not found")

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/shutdown":
            if not self._authorized():
                return self._error(401, "bad token")
            self._json(200, {"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.2), os.kill(os.getpid(), signal.SIGTERM)), daemon=True).start()
            return
        if route not in ("/tts", "/warmup"):
            return self._error(404, "not found")
        if not self._authorized():
            return self._error(401, "bad token")
        try:
            body = self._read_json()
        except Exception as e:
            return self._error(400, "bad json: %s" % e)
        if route == "/warmup":
            return self._warmup(body)
        return self._tts(body)

    def _warmup(self, body):
        eng = self.api.engine
        if not eng.ready:
            if not eng.loading:
                threading.Thread(target=eng.load, daemon=True).start()
            return self._json(202, {"ok": True, "ready": False, "loading": True})
        style = str(body.get("style") or eng.current_style or eng.default_style)
        try:
            style = eng.resolve_style(style)
        except KeyError:
            return self._error(400, "unknown style: " + style)
        try:
            t0 = time.perf_counter()
            eng.apply_style(style)
            return self._json(200, {"ok": True, "style": style, "ms": round((time.perf_counter() - t0) * 1000)})
        except Exception as e:
            return self._error(400, str(e))

    def _tts(self, body):
        eng = self.api.engine
        text = str(body.get("text") or "").strip()
        if not text:
            return self._error(400, "empty text")
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT]
        try:
            style = eng.resolve_style(body.get("style") or eng.default_style)
        except KeyError as e:
            return self._error(400, "unknown style: %s (have: %s)" % (e.args[0], ", ".join(eng.styles)))
        ref_fp = eng.styles[style]["referenceFingerprint"]
        try:
            speed = float(body.get("speed") or 1.0)
        except Exception:
            speed = 1.0
        speed = min(1.5, max(0.5, speed))
        try:
            seed = int(body.get("seed") or DEFAULT_SEED)
        except Exception:
            seed = DEFAULT_SEED
        if not eng.ready:
            if not eng.loading:
                threading.Thread(target=eng.load, daemon=True).start()
            waited = 0.0
            while eng.loading and waited < 90:
                time.sleep(0.25)
                waited += 0.25
            if not eng.ready:
                return self._error(503, eng.load_error or "model not ready")
        cached = self.api.cache_path(text, style, speed, seed, ref_fp)
        if cached.is_file() and cached.stat().st_size > 2000:
            self.api.cache_hits += 1
            data = cached.read_bytes()
            meta = {"cached": True, "style": style, "bytes": len(data), "chars": len(text)}
        else:
            try:
                data, meta = eng.synth(text, style, speed, seed)
            except Exception as e:
                eng.last_error = str(e)
                log.error("synth failed: %s\n%s", e, traceback.format_exc())
                return self._error(500, "synth failed: %s" % e)
            try:
                cached.write_bytes(data)
                self.api.prune_cache()
            except OSError:
                pass
            meta["cached"] = False
        meta.update({"ok": True, "text": text, "style": style, "speed": speed, "seed": seed})
        if str(body.get("format") or "wav").lower() == "json":
            out = self.api.cache / ("resp-" + hashlib.sha1(data).hexdigest()[:16] + ".wav")
            if not out.exists():
                out.write_bytes(data)
            return self._json(200, {**meta, "path": str(out)})
        return self._send(200, body=data, ctype="audio/wav", extra={"X-Feiyu-Style": style, "X-Feiyu-Cached": "1" if meta["cached"] else "0"})


def _port_has_listener(host: str, port: int) -> bool:
    """True when something is already accepting TCP connections on this port.

    A plain bind() is not enough on Windows: HTTP servers set SO_REUSEADDR, which can
    silently bind the same port another process owns. A connect probe is the only
    reliable 'is somebody there' test, and it lets us move to the next port instead of
    pretending to listen while requests go to the other program.
    """
    import socket

    probe = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex((probe, int(port))) == 0
    except OSError:
        return False
    finally:
        s.close()


def serve(cfg: Config):
    token = hashlib.sha256(os.urandom(32)).hexdigest()
    engine = Engine(cfg)
    api = Api(cfg, engine, token)
    Handler.api = api
    state_file = cfg.state_dir / "service.json"

    class _Server(ThreadingHTTPServer):
        daemon_threads = True
        # POSIX reuses TIME_WAIT sockets; on Windows SO_REUSEADDR can hijack a live
        # port, so keep it off and rely on the connect probe above.
        allow_reuse_address = os.name != "nt"

    preferred = int(cfg.args.port)
    tries = max(1, int(cfg.args.port_tries))
    errors = []
    httpd = None
    port_used = None
    for offset in range(tries):
        cand = preferred + offset
        if _port_has_listener(cfg.args.host, cand):
            errors.append((cand, "已被其他程序监听"))
            log.warning("port %s busy: another listener is already there", cand)
            continue
        try:
            httpd = _Server((cfg.args.host, cand), Handler)
            port_used = cand
            if offset:
                log.warning("preferred port %s was busy; listening on %s instead", preferred, cand)
            break
        except OSError as e:
            errors.append((cand, str(e)))
            log.warning("port %s bind failed: %s", cand, e)
    if httpd is None:
        for cand, why in errors[:6]:
            log.error("  %s: %s", cand, why)
        log.error(
            "没有可用端口（%s–%s）。用 --port 指定空闲端口，或先停掉占用者。",
            preferred,
            preferred + tries - 1,
        )
        raise SystemExit(3)

    # 状态文件只在成功绑定之后写：起不来时不能留下一个“看起来在跑”的假 pid/端口。
    info = {
        "ok": True, "service": SERVICE_NAME, "pid": os.getpid(), "port": port_used,
        "host": cfg.args.host, "token": token, "style": engine.default_style,
        "version": SERVICE_VERSION, "python": sys.version.split()[0],
        "home": str(cfg.home), "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    state_file.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("state written: %s", state_file)

    def _stop(signum, frame):
        log.info("signal %s, shutting down", signum)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    if not cfg.args.no_preload:
        threading.Thread(target=engine.load, daemon=True).start()

    log.info("listening on http://%s:%s (model loading in background)", cfg.args.host, port_used)
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        log.info("bye")
        # 只删除自己的状态文件：并发重启时别把新进程刚写的 state 删掉。
        try:
            cur = json.loads(state_file.read_text(encoding="utf-8"))
            if int(cur.get("pid") or 0) == os.getpid():
                state_file.unlink()
        except (OSError, ValueError):
            pass


def main(argv=None):
    cfg = Config(argv)
    logfile = cfg.state_dir / "service.log"
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.handlers.RotatingFileHandler(logfile, maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(fh)
    log.addHandler(sh)
    log.info("feiyu-tts %s · home=%s · port=%s · style=%s", SERVICE_VERSION, cfg.home, cfg.args.port, cfg.args.style)
    serve(cfg)


if __name__ == "__main__":
    main()
