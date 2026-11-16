"""文件晶体召回自测：临时库 + 假 embedder，验证「有分数、不带 embedding / 整段 content」。

跑法：python tools\\selftest_crystal_recall.py   （check-all.bat 第一段会调）
"""
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import memory.file_crystal_store as fcs  # noqa: E402


def _fake_embed(text):
    # 固定维度、随文本变化的小向量：只要两段文字有共同词就高分
    v = [0.0] * fcs.EMBEDDING_DIM
    for ch in str(text or ""):
        v[ord(ch) % fcs.EMBEDDING_DIM] += 1.0
    return v


def main():
    tmp = tempfile.mkdtemp(prefix="crystal_recall_")
    try:
        db = os.path.join(tmp, "crystal.db")
        src = os.path.join(tmp, "note.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 部署笔记\n\n## 结论\n静态资源走 gzip，端口 9890。\n\n## 下一步\n补缩略图缓存。\n")

        real_embed = fcs.embed
        fcs.embed = _fake_embed
        try:
            store = fcs.FileCrystalStore(db_path=db)
            built = store.build_file_crystals(src, force_rebuild=True)
            n = built.get("new_crystals", 0) + built.get("total_slices", 0)
            rows = store.recall("静态资源 gzip", top_k=3)
        finally:
            fcs.embed = real_embed

        assert n > 0, "没有建出任何晶体"
        assert rows, "召回为空"
        first = rows[0]
        assert isinstance(first.get("score"), float), "召回结果没有 score"
        assert 0.0 <= first["score"] <= 1.0, "score 越界：%r" % (first["score"],)
        assert "embedding" not in first, "召回结果仍然带 embedding"
        assert "content" not in first, "召回结果仍然带整段 content"
        assert first.get("summary"), "召回结果没有 summary"
        assert first.get("source_path"), "召回结果没有 source_path"
        print("crystals=%d recalls=%d score=%.3f" % (n, len(rows), first["score"]))
        print("RESULT: OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
