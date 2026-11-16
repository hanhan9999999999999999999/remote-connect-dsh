"""自动备份的判据：没有备份要备；24 小时内不重复；超过 24 小时要备；坏数据当要备。"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

now = time.time()
cases = [
    ([], True, "一份都没有"),
    ([{"ts": int(now - 3600)}], False, "1 小时前刚备过"),
    ([{"ts": int(now - 25 * 3600)}], True, "25 小时前"),
    ([{"ts": int(now - 30 * 3600)}, {"ts": int(now - 3600)}], True, "只看最新那份（顺序由 _list_backups 保证）"),
    ([{"ts": "bad"}], True, "ts 坏了就别信，补一份"),
]
bad = 0
for items, want, why in cases:
    got = server._backup_due(items, now)
    if got != want:
        bad += 1
        print("FAIL", why, "want", want, "got", got)
print("RESULT:", "OK" if not bad else "FAIL", "| cases", len(cases))
sys.exit(1 if bad else 0)
