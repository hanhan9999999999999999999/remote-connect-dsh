/**
 * 端口窥探层：只回答一个问题——「这个端口上现在有谁在听」。
 *
 * 从 `phone.mjs` 里拆出来的原因很简单：那里原本同时管目录探测、端口文件、进程归属、
 * 启停编排和 HTTP 接口，五百多行里最脏的一段（解析 `netstat -ano` 的输出、认领自己的
 * 桥接进程）反而最难单独测。拆出来以后解析部分是纯函数，能直接喂字符串断言。
 *
 * 这里不碰 health()（那需要发 HTTP，属于桥接自己的事）；只认命令行特征，
 * 认不出来就让上层去问「这个端口到底在服务我不」。
 */
import { execFile } from 'node:child_process';

/** netstat 结果缓存 2 秒——一次启停会连着问好几遍，别每次都起一个 netstat.exe。 */
const CACHE_MS = 2000;
let cache = { at: 0, map: new Map(), valid: false };

/**
 * 解析 `netstat.exe -ano` 的输出，返回 `Map<端口, pid[]>`。
 *
 * 只认 `LISTENING` 行；UDP 行没有 LISTENING 状态，天然被排除。
 * 同一端口被多个进程监听（IPv4/IPv6 各一个）时按顺序收集，去重。
 */
export function parseNetstat(stdout) {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (!(port > 0) || !(pid > 0)) continue;
    const arr = map.get(port);
    if (arr) {
      if (!arr.includes(pid)) arr.push(pid);
    } else {
      map.set(port, [pid]);
    }
  }
  return map;
}

/** 缓存作废（杀掉进程、换端口之后必须调，否则 2 秒内看到的还是旧身影）。 */
export function invalidateNetstat() {
  cache.valid = false;
}

/**
 * 全量监听表（带 2 秒缓存）。拿不到 netstat 时返回空表，不抛错。
 *
 * 这个插件本身只在 Windows 上跑，但测试要在 Linux CI 上过：所以找不到
 * `netstat.exe` 时不反复起进程、直接返回空表（「谁在听」这件事在那边没有意义）。
 * 缓存用 valid 标记而不是看 `map.size`——空表也是有效结果，不该每 2 秒重探一次。
 */
export function netstatListeners() {
  return new Promise((resolve) => {
    if (cache.valid && Date.now() - cache.at < CACHE_MS) return resolve(cache.map);
    if (process.platform !== 'win32') {
      cache = { at: Date.now(), map: new Map(), valid: true };
      return resolve(cache.map);
    }
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const map = err && !stdout ? new Map() : parseNetstat(stdout);
      cache = { at: Date.now(), map, valid: true };
      resolve(map);
    });
  });
}

/** 这个端口上的全部 LISTENING pid。 */
export async function listenerPids(port) {
  const map = await netstatListeners();
  return (map.get(Number(port)) || []).slice();
}

/** 命令行像不像我们自己的桥接（phone-bridge/server.mjs）。 */
export function isBridgeCmd(cmdline) {
  return /server\.mjs/i.test(String(cmdline || ''));
}

/** 从 from 往后找第一个没人监听的端口；一个都找不到返回 0。 */
export async function pickFreePort(from) {
  const map = await netstatListeners();
  const start = Math.max(1024, Math.min(65535, Number(from) || 8899));
  for (let p = start; p <= Math.min(65535, start + 60); p++) {
    if (!map.get(p)) return p;
  }
  return 0;
}
