// store.mjs 离线单测：不碰真实 runtime，全在临时目录里跑。
// node phone-bridge/_test_store.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic, writeJson, readJson, readJsonInfo, readJsonLines, writeJsonLines, statOf } from '../store.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-'));
let pass = 0;
let total = 0;
function ok(name, cond, extra) {
  total++;
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}
const P = (n) => path.join(root, n);
const readTxt = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
};
const tmpLeft = () => fs.readdirSync(root).filter((n) => n.includes('.tmp-'));
const corrupts = (n) => fs.readdirSync(root).filter((x) => x.startsWith(n + '.corrupt-'));

console.log('1) 原子写');
{
  const f = P('a.json');
  writeAtomic(f, 'hello');
  ok('内容写入正确', readTxt(f) === 'hello');
  ok('没有残留 .tmp', tmpLeft().length === 0);
  ok('返回值是路径', writeAtomic(f, 'x') === f);
  const f2 = P('sub/dir/b.txt');
  writeAtomic(f2, 'deep');
  ok('目录不存在会自动建', readTxt(f2) === 'deep');
  writeAtomic(P('bin.dat'), Buffer.from([1, 2, 3]));
  ok('Buffer 输入按字节落盘', fs.readFileSync(P('bin.dat')).length === 3);
}

console.log('2) 备份只留一版');
{
  const f = P('c.json');
  writeAtomic(f, 'v1');
  ok('第一次写没有 .bak', readTxt(f + '.bak') === null);
  writeAtomic(f, 'v2');
  ok('.bak 是上一版', readTxt(f + '.bak') === 'v1');
  writeAtomic(f, 'v3');
  ok('.bak 跟着更新', readTxt(f + '.bak') === 'v2');
  ok('.bak 不再有 .bak.bak', readTxt(f + '.bak.bak') === null);
}

console.log('3) readJson 正常 / 回退');
{
  const f = P('d.json');
  writeJson(f, { a: 1, b: [2, 3] });
  const r = readJsonInfo(f, null, { quiet: true });
  ok('正常读 source=main', r.source === 'main' && r.value.a === 1);
  ok('writeJson 非 pretty 也是单行', readTxt(f).indexOf('\n') === -1);
  writeJson(P('d2.json'), { a: 1, s: '中' }, { pretty: true });
  ok('pretty 可解析', readJson(P('d2.json')).s === '中');
}

console.log('4) 半截 JSON → 回退 .bak 并隔离坏档');
{
  const f = P('e.json');
  writeJson(f, { v: 'good' });
  writeJson(f, { v: 'good2' }); // 现在 .bak = {v:'good'}
  fs.writeFileSync(f, '{"v":"good2","brok'); // 模拟断电写坏
  const r = readJsonInfo(f, { v: 'fallback' }, { quiet: true });
  ok('回退到 .bak', r.source === 'bak' && r.value.v === 'good', r);
  ok('坏档被隔离成 .corrupt-*', corrupts('e.json').length === 1);
  ok('主档不再留在原处（没被后续写覆盖）', readTxt(f) === null);
  writeJson(f, { v: 'fresh' });
  ok('恢复后能正常写', readJson(f).v === 'fresh');
}

console.log('5) 没有 .bak 的坏档 → fallback');
{
  const f = P('g.json');
  fs.writeFileSync(f, 'not json at all');
  const r = readJsonInfo(f, { v: 'fb' }, { quiet: true });
  ok('返回 fallback', r.source === 'fallback' && r.value.v === 'fb');
  ok('坏档被隔离', corrupts('g.json').length === 1);
  const f2 = P('g2.json');
  fs.writeFileSync(f2, '');
  ok('空文件当作坏档 → fallback', readJsonInfo(f2, 7, { quiet: true }).value === 7);
}

console.log('6) 坏档只留最近 5 个');
{
  const f = P('h.json');
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(f, '{bad ' + i);
    readJsonInfo(f, null, { quiet: true });
  }
  const n = corrupts('h.json').length;
  ok('坏档数量被限制在 5', n === 5, n);
}

console.log('7) JSONL 容错');
{
  const f = P('m.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n');
  ok('正常三行', readJsonLines(f).items.length === 3);
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4'); // 末行半截
  const r = readJsonLines(f);
  ok('末行半截不毁全部', r.items.length === 3 && r.bad === 1, r);
  fs.writeFileSync(f, '{"a":1}\n\n  \n{"a":2}\n');
  ok('空行不算坏行', readJsonLines(f).items.length === 2 && readJsonLines(f).bad === 0);
  ok('文件不存在 → 空数组', readJsonLines(P('nope.jsonl')).items.length === 0);
  const g = P('w.jsonl');
  writeJsonLines(g, [{ x: 1 }, { x: 2 }]);
  ok('writeJsonLines 往返', readJsonLines(g).items[1].x === 2);
  ok('空数组写出 0 字节', (writeJsonLines(P('empty.jsonl'), []), readTxt(P('empty.jsonl'))) === '');
}

console.log('8) 大文件与连续写');
{
  const big = { s: 'x'.repeat(1024 * 1024) };
  const f = P('big.json');
  const t0 = Date.now();
  writeJson(f, big);
  const back = readJson(f);
  ok('1MB 往返无损', back && back.s.length === 1024 * 1024);
  // 这条不是跑分，只用来抓"写路径退化成 O(n²)/反复 fsync"这类回归。
  // 单次计时在 Windows 上会被 Defender 扫描和并发 IO 抖动顶到 300ms+（跑 e2e/截图时必挂），
  // 所以取 3 次里最快的一次，阈值放到 400ms——真回归是秒级，不会漏。
  let bestMs = Infinity;
  for (let i = 0; i < 3; i++) {
    const w0 = Date.now();
    writeJson(f, big);
    bestMs = Math.min(bestMs, Date.now() - w0);
  }
  ok('1MB 写入 < 400ms（3 次取最快）', bestMs < 400, Math.round(bestMs));
  for (let i = 0; i < 20; i++) writeJson(P('seq.json'), { i });
  ok('连续写后是最新值', readJson(P('seq.json')).i === 19);
  ok('连续写不留 .tmp', tmpLeft().length === 0);
}

console.log('9) statOf 体检');
{
  const f = P('s.json');
  writeJson(f, { a: 1 });
  writeJson(f, { a: 2 });
  fs.writeFileSync(f, '{oops');
  readJsonInfo(f, null, { quiet: true });
  const st = statOf(f);
  ok('size 读到（主档已隔离为 0）', st.size === 0, st);
  ok('bak=true', st.bak === true);
  ok('corrupt>=1', st.corrupt >= 1, st);

  // backups：还原备份留下的 .bak-<毫秒> 数量要多报出来（/api/diag 靠它看残留）
  const g = P('g.json');
  writeJson(g, { a: 1 });
  ok('没有 .bak-* 时 backups=0', statOf(g).backups === 0, statOf(g));
  for (let i = 0; i < 4; i++) fs.writeFileSync(g + '.bak-' + (1700000000000 + i), '{}');
  ok('backups 数到 4 个', statOf(g).backups === 4, statOf(g));
}

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (_) {}
console.log(`\nstore 单测：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
