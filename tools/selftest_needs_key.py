import sys
sys.path.insert(0, r'D:\document\Remote Connect DSH')
import server


class C:
    def __init__(self, provider, has_key):
        self.provider = provider
        self.api_key = "sk-test" if has_key else ""


cases = [
    (C('deepseek', False), True),
    (C('deepseek', True), False),
    (C('custom', False), True),
    (C('ollama', False), False),
    (C('local', False), False),
    (C('', False), False),
]
bad = 0

# _net_note：常见网络异常要翻成人话（超时 / 拒绝 / 域名）
class _NE(Exception):
    def __init__(self, winerror=None, msg=''):
        super().__init__(msg)
        self.winerror = winerror

_net_cases = [
    (_NE(10060, 'timed out'), '超时'),
    (_NE(10061, 'refused'), '连接被拒绝'),
    (_NE(11001, 'getaddrinfo failed'), '域名解析失败'),
    (TimeoutError('timed out'), '超时'),
]
for _e, _want in _net_cases:
    _got = server._net_note(_e)
    if _want not in _got:
        print('net_note FAIL', repr(_e), '->', _got)
        bad += 1
for cfg, want in cases:
    got = server._needs_model_key(cfg)
    if got != want:
        bad += 1
        print('BAD', cfg.provider, bool(cfg.api_key), 'got', got, 'want', want)

# 不该有的旧写法：preflight 里再抄一份 provider 元组
src = open(r'D:\document\Remote Connect DSH\server.py', encoding='utf-8').read()
dup = src.count('"deepseek", "zhipu", "openai", "moonshot", "qwen", "siliconflow", "custom"')
print('provider tuple copies', dup)

print('RESULT:', 'OK' if bad == 0 and dup == 1 else 'FAIL', '| cases', len(cases))
sys.exit(0 if bad == 0 and dup == 1 else 1)
