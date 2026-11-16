# -*- coding: utf-8 -*-
"""Hot-reload test for feiyu-tts-service style discovery.

Runs without loading the model (--no-preload): only the references scan and the
fingerprint/rescan path are exercised. Usage:

    python tests/feiyu-styles.test.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent / "tools" / "feiyu-tts-service.py"

spec = importlib.util.spec_from_file_location("feiyu_service", SERVICE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def make_wav(path: Path, seconds: float = 0.2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * int(24000 * seconds))


def touch_pair(refs: Path, name: str, text: str, mtime: float | None = None) -> None:
    wav = refs / (name + ".wav")
    make_wav(wav)
    txt = refs / (name + ".txt")
    txt.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(wav, (mtime, mtime))
        os.utime(txt, (mtime, mtime))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="feiyu-styles-"))
    pkg = tmp / "models" / "FeiyuVoice-CosyVoice3"
    refs = pkg / "references"
    refs.mkdir(parents=True)
    touch_pair(refs, "可爱", "可爱参考文本", 1_700_000_000)
    touch_pair(refs, "卡芙卡", "卡芙卡参考文本", 1_700_000_100)

    cfg = mod.Config(["--home", str(tmp), "--state-dir", str(tmp / "state"), "--no-preload"])
    eng = mod.Engine(cfg)
    assert set(eng.styles) == {"cute", "kafka"}, eng.styles.keys()
    assert eng.styles["cute"]["referenceText"] == "可爱参考文本"

    # 1) 新增一个音色：不重建 Engine，下一次扫描就应该出现
    touch_pair(refs, "菲比", "菲比参考文本", 1_700_000_200)
    assert eng.maybe_reload_styles(min_interval=0) is True
    assert set(eng.styles) == {"cute", "kafka", "phoebe"}, eng.styles.keys()
    assert eng.styles["phoebe"]["label"] == "菲比"

    # 2) 改参考文本：指纹变化 → 重新扫描，合成用到的文本同步更新
    touch_pair(refs, "可爱", "改过的可爱参考文本", 1_700_000_300)
    assert eng.maybe_reload_styles(min_interval=0) is True
    assert eng.styles["cute"]["referenceText"] == "改过的可爱参考文本"

    # 3) 没变化时不重复扫描
    assert eng.maybe_reload_styles(min_interval=0) is False

    # 4) 删掉正在使用的音色：列表移除，当前风格清空（下次合成回落默认）
    eng.current_style = "kafka"
    (refs / "卡芙卡.wav").unlink()
    (refs / "卡芙卡.txt").unlink()
    assert eng.maybe_reload_styles(min_interval=0) is True
    assert "kafka" not in eng.styles
    assert eng.current_style == ""

    # 5) 目录被清空时保留旧列表，不能把用户音色表清成空
    before = dict(eng.styles)
    for p in refs.iterdir():
        p.unlink()
    assert eng.maybe_reload_styles(min_interval=0) is False
    assert eng.styles == before

    print("feiyu-styles: 5/5 passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
