"""只读穿越自检：GET/POST 里带 path/file/dir/name 的接口，不许把系统文件读出来。"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:9890').rstrip('/')
src = open(os.path.join(ROOT, 'server.py'), encoding='utf-8').read()
gseg = src[src.index('def do_GET'):src.index('def do_POST')]
pseg = src[src.index('def do_POST'):src.index('def do_DELETE')]
get_routes = sorted(set(re.findall(r'path\s*==\s*"([^"]+)"', gseg)))
post_routes = sorted(set(re.findall(r'path\s*==\s*"([^"]+)"', pseg)))
POST_KEY = ('read', 'preview', 'open', 'file', 'asset', 'workspace', 'mission', 'log', 'download')
post_routes = [r for r in post_routes if any(k in r for k in POST_KEY)]
SKIP = ('/api/tts/', '/api/local-llm/', '/api/chat', '/api/search', '/api/models', '/api/tunnel')
MARK = ('[mci extensions]', 'MAPI=1', 'woafont.drv', 'Windows Registry')
PAYLOAD = '../../../../Windows/win.ini'


def check_url(url):
    try:
        r = urllib.request.urlopen(url, timeout=8)
        return r.status, r.headers.get('Content-Type', ''), r.read(4000)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read(2000)
    except Exception as e:
        return -1, type(e).__name__, str(e).encode()


def check_post(url, field):
    req = urllib.request.Request(url, data=json.dumps({field: PAYLOAD}).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        r = urllib.request.urlopen(req, timeout=8)
        return r.status, r.headers.get('Content-Type', ''), r.read(4000)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read(2000)
    except Exception as e:
        return -1, type(e).__name__, str(e).encode()


bad = []
for route in get_routes:
    if any(route.startswith(s) for s in SKIP):
        continue
    for field in ('path', 'file', 'dir', 'name'):
        q = urllib.parse.urlencode({field: PAYLOAD})
        code, ctype, body = check_url(BASE + route + ('&' if '?' in route else '?') + q)
        text = body.decode('utf-8', 'replace')
        if any(m in text for m in MARK):
            bad.append(('GET', route, field, code))

for route in post_routes:
    if any(route.startswith(s) for s in SKIP):
        continue
    for field in ('path', 'file', 'dir', 'name'):
        code, ctype, body = check_post(BASE + route, field)
        text = body.decode('utf-8', 'replace')
        if any(m in text for m in MARK):
            bad.append(('POST', route, field, code))

print(f'GET {len(get_routes)} · POST {len(post_routes)} · bad {len(bad)}')
for b in bad[:10]:
    print(' ', b)
print('RESULT:', 'OK' if not bad else 'FAIL')
sys.exit(0 if not bad else 1)
