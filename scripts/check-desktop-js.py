"""把 index.html 里的内联 <script> 逐个导出来用 node --check 语法检查。

phone-bridge 的 `npm run check` 查的是手机端 app.html，管不到桌面 public/index.html ——
而桌面端一旦有语法错，整块主脚本会静默失效（所有全局函数消失、页面看着还在），
所以这里单独留一条检查。
"""
import io, os, re, subprocess, sys, tempfile

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'index.html')
html = io.open(P, encoding='utf-8').read()
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
print('inline scripts:', len(blocks))

bad = 0
tmpdir = tempfile.mkdtemp(prefix='dshjs-')
for i, b in enumerate(blocks):
    if not b.strip():
        continue
    f = os.path.join(tmpdir, 'b%d.js' % i)
    io.open(f, 'w', encoding='utf-8').write(b)
    r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
    if r.returncode != 0:
        bad += 1
        err = (r.stderr or '').strip().splitlines()
        print('  BLOCK %d FAIL (%d chars)' % (i, len(b)))
        for line in err[:6]:
            print('    ' + line)
    else:
        print('  block %d ok (%d chars)' % (i, len(b)))

print('RESULT:', 'FAIL' if bad else 'OK', '| bad blocks:', bad)
sys.exit(1 if bad else 0)
