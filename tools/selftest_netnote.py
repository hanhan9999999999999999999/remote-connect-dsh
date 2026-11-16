"""日志可读性回归：网络异常要翻成中文，不能把 GBK 乱码原样打进控制台。"""
import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

ok = True


def check(label, got, want_part):
    global ok
    good = want_part in got
    ok = ok and good
    print(('ok  ' if good else 'FAIL') + ' ' + label + ' -> ' + got)


check('urlerror-10061', server._net_note(urllib.error.URLError(OSError(10061, 'refused'))), '连接被拒绝')
check('oserror-10054', server._net_note(OSError(10054, 'x')), '连接被远端关闭')
check('timeout', server._net_note(TimeoutError('timed out')), '超时')
note = server._net_note(OSError(99999, '目标计算机积极拒绝'))
print('fallback-ascii ->', note)
ok = ok and note.isascii()

print('RESULT:', 'OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)
