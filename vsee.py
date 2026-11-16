"""vsee — 用主模型的多模态接口「看图」（重建版）。

背景
----
本文件在 2026-11 被误删，按唯一调用方 ``tools/see_image.py`` 的实际用法重建：

* ``see_image.py:53``  ``import vsee``（从项目根导入）
* ``see_image.py:159`` ``got = vsee._extract_frames(video, frames)``  → 必须返回 list
* ``see_image.py:192`` ``cfg = vsee._load_cfg()``                   → 必须返回 dict
* ``see_image.py:194`` ``vsee.ask(resolved, q, model, max_side, verbose=False, max_tokens=...)``
                       的第三个位置参数是 model，返回**字符串**

多模态调用方式沿用项目既有约定（不另发明一套）：

* ``llm.LLMConfig``   —— 鉴权与 provider 解析（含 ``custom_providers.runtime_config`` 覆盖）
* ``llm.build_multimodal_content`` —— 本地图片 → ``{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}``
* ``llm.chat_once_cached`` —— 非流式取全文，返回 ``{"text": ...}``

**不硬编码任何 API key**：按 ``model_config.json`` → ``custom_providers`` →
``fallback_chain`` → 环境变量的顺序解析；全都没有就抛 ``VseeError``（中文、可读）。
``_load_cfg`` 本身绝不抛，读不到就给默认 dict。
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Iterable

# ─────────────────────────── 路径 ───────────────────────────

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))


class VseeError(RuntimeError):
    """看图链路的可读错误（中文），供 see_image.py 原样回显给用户。"""


# ─────────────────────────── 配置 ───────────────────────────

#: 明知支持图片输入的模型前缀（与 llm._VISION_MODEL_PREFIXES 保持同步，
#: 万一 llm.py 不方便导入时的兜底判断）
_FALLBACK_VISION_PREFIXES = ("glm-5.3-flash", "deepseek-flash", "deepseek-v4-flash-vision")

#: server.py 视觉回退用的模型名 —— 项目既有约定，不新造名字
_DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp"
_DEFAULT_VISION_BASE = "https://api.deepseek.com"

#: 环境变量兜底（按 provider 取）
_ENV_KEYS = {
    "deepseek": ("DEEPSEEK_API_KEY",),
    "zhipu": ("ZHIPU_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"),
    "openrouter": ("OPENROUTER_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
}


def _read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f) or default
    except Exception:
        return default


def _is_vision_model(model: str) -> bool:
    """模型名是否支持图片。优先问 llm.py，避免两套白名单漂移。"""
    if not model:
        return False
    try:
        import llm  # noqa: WPS433  （惰性导入：vsee 要能在 llm 出问题时仍可 import）
        return bool(llm.is_vision_model(model))
    except Exception:
        mid = str(model).lower()
        if "vision" in mid:
            return True
        return any(mid == p or mid.startswith(p + "-") or mid.startswith(p + ":")
                   for p in _FALLBACK_VISION_PREFIXES)


def _provider_key_from_configs(provider: str, top: dict) -> tuple[str, str]:
    """按 provider 找 key，返回 (key, 来源说明)。找不到返回 ("", "")。"""
    provider = (provider or "").lower()

    # ① 第三方源登记表（自定义 provider 的 key 存在这里）
    try:
        import custom_providers  # noqa: WPS433
        rt = custom_providers.runtime_config(ROOT_DIR, provider)
        if rt and rt.get("api_key"):
            return str(rt["api_key"]), f"custom_providers[{provider}]"
    except Exception:
        pass

    # ② fallback_chain 里同 provider 的条目
    for item in (top.get("fallback_chain") or []):
        if isinstance(item, dict) and (item.get("provider") or "").lower() == provider:
            if item.get("api_key"):
                return str(item["api_key"]), f"model_config.json fallback_chain[{provider}]"

    # ③ 环境变量
    for name in _ENV_KEYS.get(provider, ()):
        val = os.environ.get(name, "")
        if val:
            return val, f"环境变量 {name}"
    return "", ""


def _load_cfg() -> dict:
    """读看图配置。**绝不抛**，最差也给一份可用的默认 dict。

    返回键（``see_image.py`` 只消费 ``model``）::

        provider / model / base_url / api_key / max_tokens / protocol
        vision_model / vision_provider / vision_base_url
        key_source / config_path / self_vision / max_side / loaded

    ``model`` 一定是**最终要拿去发图**的视觉模型名：如果 ``model_config.json``
    里的主模型不支持图片，会自动换到 fallback_chain 里的视觉模型或项目约定的
    ``deepseek-v4-flash-vision-exp``。
    """
    cfg_path = os.path.join(ROOT_DIR, "model_config.json")
    top = _read_json(cfg_path, {}) or {}

    provider = str(top.get("provider") or "deepseek")
    model = str(top.get("model") or "deepseek-chat")
    base_url = str(top.get("base_url") or _DEFAULT_VISION_BASE).rstrip("/")
    api_key = str(top.get("api_key") or "")
    protocol = str(top.get("protocol") or "openai")
    try:
        max_tokens = int(top.get("max_tokens") or 4096)
    except Exception:
        max_tokens = 4096

    key_source = "model_config.json" if api_key else ""

    # 主模型不能看图 → 找一个能看的（连 provider/base_url/key 一起换，
    # 这是 server.py:2198 那段注释里记着的历史 bug：只换名字会把图打到不支持视觉的服务上）
    vision_model, vision_provider, vision_base_url = model, provider, base_url
    if not _is_vision_model(model):
        vision_model, vision_provider, vision_base_url = "", "", ""
        for item in (top.get("fallback_chain") or []):
            if not isinstance(item, dict):
                continue
            cand = str(item.get("model") or "")
            if cand and _is_vision_model(cand):
                vision_model = cand
                vision_provider = str(item.get("provider") or provider)
                vision_base_url = str(item.get("base_url") or base_url).rstrip("/")
                break
        if not vision_model:
            vision_model = _DEFAULT_VISION_MODEL
            vision_provider = "deepseek"
            vision_base_url = _DEFAULT_VISION_BASE

    if not api_key:
        api_key, key_source = _provider_key_from_configs(vision_provider, top)
    if not api_key and vision_provider != provider:
        api_key, key_source = _provider_key_from_configs(provider, top)

    # 模型级附加字段（第三方源可能要求额外 header / body）
    extra_headers, extra_body = {}, {}
    try:
        import custom_providers  # noqa: WPS433
        rt = custom_providers.runtime_config(ROOT_DIR, vision_provider)
        if rt:
            extra_headers = rt.get("extra_headers") or {}
            extra_body = rt.get("extra_body") or {}
    except Exception:
        pass

    return {
        "loaded": True,
        "config_path": cfg_path,
        "provider": vision_provider or provider,
        "model": vision_model or _DEFAULT_VISION_MODEL,
        "base_url": vision_base_url or base_url,
        "api_key": api_key,
        "key_source": key_source or ("无（未配置）" if not api_key else ""),
        "max_tokens": max_tokens,
        "protocol": protocol,
        "vision_model": vision_model or _DEFAULT_VISION_MODEL,
        "vision_provider": vision_provider or provider,
        "vision_base_url": vision_base_url or base_url,
        "extra_headers": extra_headers,
        "extra_body": extra_body,
        # see_image.py 的 self 模式开关（model_config.json 里的 self_vision）
        "self_vision": bool(top.get("self_vision")),
        "max_side": int(top.get("vsee_max_side") or 1024),
    }


# ─────────────────────────── ffmpeg 定位 ───────────────────────────


def _find_ffmpeg() -> str:
    """找 ffmpeg。本机 PATH 里没有，所以按「环境变量 → PATH → 常见目录」探测。"""
    env = os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if found:
        return found
    candidates = [
        os.path.join(ROOT_DIR, "bin", "ffmpeg.exe"),
        os.path.join(ROOT_DIR, "tunnel", "ffmpeg.exe"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
        r"D:\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        # 本机实测存在的一份（D:\qq音乐下载mp3\VipSongsDownload）—— 只读复用，不复制不移动
        r"D:\qq音乐下载mp3\VipSongsDownload\ffmpeg.exe",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return ""


def _run_ffmpeg(args: list[str], timeout: float = 120.0) -> tuple[int, str]:
    """跑一次 ffmpeg，返回 (returncode, stderr)。失败不抛。"""
    exe = _find_ffmpeg()
    if not exe:
        return -1, "找不到 ffmpeg（PATH 与环境变量 FFMPEG_BIN 都没有）"
    try:
        proc = subprocess.run(
            [exe] + args,
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.returncode, (proc.stderr or "")
    except Exception as exc:
        return -1, f"{type(exc).__name__}: {exc}"


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def _probe_duration(video: str) -> float:
    """用 ffmpeg -i 的输出解析时长（秒）；解析不到返回 0.0。"""
    _, err = _run_ffmpeg(["-hide_banner", "-i", video], timeout=30)
    m = _DURATION_RE.search(err or "")
    if not m:
        return 0.0
    h, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return h * 3600 + mm * 60 + ss


def _extract_frames(video: str, frames: int = 4) -> list[str]:
    """从视频抽帧到临时目录，返回**按时间排序的帧文件路径列表**。绝不抛。

    ``see_image.py:159`` 之后直接 ``got + files`` 并逐个 ``os.path.exists``，
    所以这里只返回真实存在的文件；抽不出来就返回 ``[]``（调用方会报
    「抽帧失败（找不到 ffmpeg 或视频不可读）」）。

    Parameters
    ----------
    video:
        视频绝对路径。调用方已做过存在性检查，这里再防御一次。
    frames:
        抽几帧，1~16，默认 4。
    """
    try:
        if not video or not os.path.isfile(video):
            return []
        try:
            n = max(1, min(16, int(frames or 4)))
        except Exception:
            n = 4

        outdir = tempfile.mkdtemp(prefix="vsee_frames_")
        duration = _probe_duration(video)
        outputs: list[str] = []

        if duration > 0:
            # 均匀取点，避开首尾 5%（片头黑场 / 片尾淡出截不到内容）
            span = duration * 0.9
            start = duration * 0.05
            step = span / n if n > 1 else 0.0
            for i in range(n):
                t = start + step * i if n > 1 else duration / 2
                out = os.path.join(outdir, f"frame_{i:02d}.jpg")
                # -ss 放在 -i 之后：精确 seek，短视频也能取到帧
                code, _ = _run_ffmpeg([
                    "-hide_banner", "-loglevel", "error",
                    "-i", video, "-ss", f"{t:.3f}",
                    "-frames:v", "1", "-q:v", "3", "-y", out,
                ], timeout=90)
                if code == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
                    outputs.append(out)
        else:
            # 时长未知：退化成一秒一帧，取前 n 帧
            code, _ = _run_ffmpeg([
                "-hide_banner", "-loglevel", "error",
                "-i", video, "-vf", "fps=1", "-frames:v", str(n),
                "-q:v", "3", os.path.join(outdir, "frame_%02d.jpg"),
            ], timeout=120)
            if code == 0:
                outputs = sorted(
                    os.path.join(outdir, f)
                    for f in os.listdir(outdir)
                    if f.lower().endswith(".jpg") and os.path.getsize(os.path.join(outdir, f)) > 0
                )
        return outputs
    except Exception:
        return []


# ─────────────────────────── 图片准备 ───────────────────────────


def _shrink_to_temp(path: str, max_side: int) -> str:
    """把图片缩到最长边 max_side 的 JPEG，返回临时文件路径（失败就回原路径）。"""
    try:
        from PIL import Image

        max_side = int(max_side or 1024)
        if max_side <= 0:
            return path
        with Image.open(path) as im:
            if max(im.size) <= max_side and path.lower().endswith((".jpg", ".jpeg", ".png")):
                return path
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            outdir = tempfile.mkdtemp(prefix="vsee_img_")
            out = os.path.join(outdir, "input.jpg")
            im.save(out, "JPEG", quality=90)
            return out
    except Exception:
        return path


def _bytes_to_temp(data: bytes) -> str:
    """bytes 图片落成临时文件（供 _shrink_to_temp / build_multimodal_content 使用）。"""
    outdir = tempfile.mkdtemp(prefix="vsee_bytes_")
    out = os.path.join(outdir, "raw.png")
    with open(out, "wb") as f:
        f.write(data)
    return out


def _normalize_images(image: Any) -> list[str]:
    """把 ask 的 image 参数归一成「本地图片路径列表」。"""
    if image is None:
        return []
    if isinstance(image, (bytes, bytearray)):
        return [_bytes_to_temp(bytes(image))]
    if isinstance(image, (str, os.PathLike)):
        return [os.fspath(image)]
    if isinstance(image, Iterable):
        out = []
        for item in image:
            if isinstance(item, (bytes, bytearray)):
                out.append(_bytes_to_temp(bytes(item)))
            elif isinstance(item, (str, os.PathLike)):
                out.append(os.fspath(item))
        return out
    return []


# ─────────────────────────── 主入口 ───────────────────────────


def _build_llm_config(cfg: dict):
    """按 vsee 的配置造一个 llm.LLMConfig（视觉目标）。"""
    import llm  # noqa: WPS433

    return llm.LLMConfig(
        provider=cfg.get("provider") or "deepseek",
        model=cfg.get("model") or _DEFAULT_VISION_MODEL,
        base_url=cfg.get("base_url") or _DEFAULT_VISION_BASE,
        api_key=cfg.get("api_key") or "",
        max_tokens=int(cfg.get("max_tokens") or 4096),
        protocol=cfg.get("protocol") or "openai",
        extra_headers=cfg.get("extra_headers") or None,
        extra_body=cfg.get("extra_body") or None,
    )


def ask(image: Any, question: str, model: str | None = None,
        max_side: int = 1024, verbose: bool = False,
        max_tokens: int = 4096, **kwargs) -> str:
    """把图片发给主模型的多模态接口，返回**文本答案**。

    参数
    ----
    image:
        本地图片路径 / 路径列表 / 原始 bytes。
    question:
        要问画面什么。
    model:
        指定模型；``None`` 时用 ``_load_cfg()["model"]``（已自动换成视觉模型）。
    max_side:
        发送前缩放的最长边（Pillow 处理，失败则发原图）。
    max_tokens:
        输出上限。推理型模型给小了会返回空 content（see_image.py 的注释提过）。
    verbose:
        为 True 时把请求摘要打到 stderr（**不打印 key**）。

    返回
    ----
    str
        模型回答；调用方会检查空串。

    异常
    ----
    VseeError
        没有可用密钥 / 没有可看的图片 / 模型返回空 / 上游报错。
        （``see_image.py`` 用 try/except 包着，会转成 ``{"error": ...}``）
    """
    # 参数别名：老调用点可能用 image_path / prompt 之类的名字
    image = kwargs.pop("image_path", image)
    question = kwargs.pop("prompt", question) or question

    cfg = _load_cfg()
    paths = _normalize_images(image)
    if not paths:
        raise VseeError("没有可看的图片：image 为空或类型不支持（要路径 / 路径列表 / bytes）")

    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        raise VseeError(f"图片不存在：{missing[0]}")

    target_model = str(model or cfg.get("model") or _DEFAULT_VISION_MODEL)
    provider = cfg.get("provider") or "deepseek"
    base_url = cfg.get("base_url") or _DEFAULT_VISION_BASE
    api_key = cfg.get("api_key") or ""

    # 用户显式指定了别的模型：如果它不是视觉模型，仍然要换 key/base_url 对应的源
    if model and model != cfg.get("model"):
        if not _is_vision_model(model):
            fallback_model = cfg.get("model") or _DEFAULT_VISION_MODEL
            if verbose:
                print(f"[vsee] {model} 不收图，改用 {fallback_model}", file=sys.stderr)
            target_model = fallback_model
        elif model.startswith("glm"):
            provider = "zhipu"
            base_url = "https://open.bigmodel.cn/api/paas/v4"
            api_key, cfg["key_source"] = _provider_key_from_configs("zhipu", {})

    if not api_key:
        raise VseeError(
            "没有可用的模型密钥：model_config.json 的 api_key 为空，"
            "custom_providers 未登记该源，fallback_chain 与环境变量也没有。"
            f"（目标 provider={provider}，model={target_model}）"
        )

    llm_cfg = _build_llm_config({
        **cfg,
        "provider": provider,
        "model": target_model,
        "base_url": base_url,
        "api_key": api_key,
        "max_tokens": int(max_tokens or cfg.get("max_tokens") or 4096),
    })

    # 缩放后再编码（省 token、也避开部分站点对超大 data URL 的拒绝）
    shrunk = [_shrink_to_temp(p, max_side) for p in paths]

    try:
        import llm  # noqa: WPS433
        content = llm.build_multimodal_content(question or "描述这张图。", shrunk)
    except Exception as exc:
        raise VseeError(f"构造多模态请求失败：{type(exc).__name__}: {exc}") from exc
    if not content:
        raise VseeError("图片编码失败（扩展名不在 jpg/png/gif/webp 之内？）")

    messages = [{"role": "user", "content": content}]
    if verbose:
        print(f"[vsee] model={target_model} provider={provider} "
              f"images={len(shrunk)} max_side={max_side} key={cfg.get('key_source')}",
              file=sys.stderr)

    try:
        import llm  # noqa: WPS433  （与上面同一个模块，重复 import 是缓存命中）
        result = llm.chat_once_cached(llm_cfg, messages)
    except Exception as exc:
        raise VseeError(f"调用模型失败：{type(exc).__name__}: {exc}") from exc

    if isinstance(result, dict):
        if result.get("error"):
            raise VseeError(f"模型返回错误：{result['error']}")
        text = str(result.get("text") or "").strip()
    else:
        text = str(result or "").strip()

    if not text:
        raise VseeError(
            f"模型返回空内容（model={target_model}, max_tokens={max_tokens}）；"
            "推理型模型给小了会只输出思考、不输出正文。"
        )
    return text


__all__ = ["ask", "_extract_frames", "_load_cfg", "VseeError", "ROOT_DIR"]
