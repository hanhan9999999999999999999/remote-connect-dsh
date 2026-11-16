"""访问口令（DSH_TOKEN）的判定逻辑：不开 socket，直接喂假的 Handler 实例。"""
import email.message
import sys

sys.path.insert(0, r'D:\document\Remote Connect DSH')
import server  # noqa: E402

H = server.Handler


def make(path, cookie=None, header=None):
    h = H.__new__(H)
    h.path = path
    h.headers = email.message.Message()
    if cookie:
        h.headers['Cookie'] = cookie
    if header:
        h.headers['X-DSH-Token'] = header
    return h


cases = []
old = server.ACCESS_TOKEN
try:
    server.ACCESS_TOKEN = 'tok123'
    cases.append(('无口令被挡', make('/api/topics')._check_auth(), False))
    cases.append(('健康检查放行', make('/api/health')._check_auth(), True))
    q = make('/api/topics?token=tok123')
    cases.append(('query 通过', q._check_auth(), True))
    cases.append(('query 会种 cookie', getattr(q, '_token_from_query', False), True))
    cases.append(('头通过', make('/api/topics', header='tok123')._check_auth(), True))
    cases.append(('cookie 通过', make('/api/topics', cookie='a=1; dsh_token=tok123')._check_auth(), True))
    cases.append(('错口令被挡', make('/api/topics?token=nope')._check_auth(), False))

    server.ACCESS_TOKEN = ''
    cases.append(('默认不设口令时全放行', make('/api/topics')._check_auth(), True))
finally:
    server.ACCESS_TOKEN = old

bad = 0
for name, got, want in cases:
    if bool(got) != bool(want):
        bad += 1
        print('BAD', name, 'got', got, 'want', want)
print('RESULT:', 'OK' if bad == 0 else 'FAIL', '| cases', len(cases))
sys.exit(0 if bad == 0 else 1)
