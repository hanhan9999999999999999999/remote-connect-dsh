"""兜底自检：handler 里没被 catch 的异常要变成 JSON 500，而不是把连接断掉。"""
import os
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import server  # noqa: E402

srv = server.create_server(port=0, host='127.0.0.1')
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.3)

orig = server.Handler._do_GET


def boom(self):
    if self.path.startswith('/api/__boom'):
        raise RuntimeError('自检用的假异常')
    return orig(self)


server.Handler._do_GET = boom
ok = False
code = None
body = ''
try:
    urllib.request.urlopen(f'http://127.0.0.1:{port}/api/__boom', timeout=10)
except urllib.error.HTTPError as e:
    code = e.code
    body = e.read().decode('utf-8', 'replace')
except Exception as e:
    body = f'EXC {e}'
finally:
    server.Handler._do_GET = orig
    srv.shutdown()

ok = code == 500 and '"error"' in body and 'JSON' not in body[:1]
print(f'status {code} body {body[:120]}')
print('RESULT:', 'OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)
