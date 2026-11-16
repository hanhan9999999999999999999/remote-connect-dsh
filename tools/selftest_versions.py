"""version_store 自检：只留最近 N 份、拒绝可疑 zip 成员、备份与被回滚存档不同名。

不碰真实 data/versions —— 全部在临时目录里做。
"""
import json
import os
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import version_store as vs  # noqa: E402

tmp = tempfile.mkdtemp(prefix="vs_selftest_")
try:
    vs.STORE = os.path.join(tmp, "versions")
    vs.INDEX = os.path.join(vs.STORE, "index.json")
    os.makedirs(vs.STORE, exist_ok=True)

    # current_hash 假起来：每存一份就变一次，才能造出 N 份不同存档
    counter = {"n": 0}
    vs.current_hash = lambda: ("%064x" % counter["n"])

    made = []
    for i in range(vs.MAX_KEEP + 3):
        counter["n"] = i
        made.append(vs.snapshot("t%d" % i)["name"])
    left = vs.list_archives()
    assert len(left) == vs.MAX_KEEP, "应只留 %d 份，实际 %d" % (vs.MAX_KEEP, len(left))
    names = [a["name"] for a in left]
    assert made[0] not in names, "最老的一份应该被裁掉"
    assert made[-1] in names, "最新的一份不该被裁掉"

    # 可疑成员必须拒绝（zip slip）
    bad = os.path.join(vs.STORE, "evil.zip")
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("../escape.txt", "x")
    try:
        vs.restore("evil.zip", label="selftest")
        raise AssertionError("带 .. 的存档应该被拒绝")
    except ValueError as e:
        assert "拒绝" in str(e) or "非法" in str(e), str(e)
    assert not os.path.exists(os.path.join(tmp, "escape.txt")), "不该往上层写文件"

    # 同一秒连存两份：名字必须不同（否则备份会盖掉要回滚的那份）
    counter["n"] = 99
    a = vs.snapshot("same-second-a")["name"]
    b = vs.snapshot("same-second-b")["name"]
    assert a != b, "同秒快照重名：%s" % a

    idx = json.load(open(vs.INDEX, encoding="utf-8"))
    assert isinstance(idx, list) and len(idx) <= vs.MAX_KEEP, "index 不该超过上限"
    print("RESULT: OK | kept %d | names %s" % (len(left), a != b))
finally:
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
