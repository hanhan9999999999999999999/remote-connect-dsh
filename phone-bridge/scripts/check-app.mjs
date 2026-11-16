// 检查 public/app.html 里所有内联 script 的语法（页面本身没法 node --check）
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const file = process.argv[2] || path.join(ROOT, 'public', 'app.html');
const html = fs.readFileSync(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i += 1;
  const attrs = m[1] || '';
  const code = m[2] || '';
  if (/\bsrc\s*=/.test(attrs) || !code.trim()) continue;
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(code, { filename: file + ':' + line });
  } catch (e) {
    bad += 1;
    console.log(`[语法错误] script#${i} 起始行 ${line}: ${e.message}`);
    const pos = /:(\d+)/.exec(String(e.stack || ''));
    if (pos) console.log(String(e.stack).split('\n').slice(0, 4).join('\n'));
  }
}
console.log(bad === 0 ? `OK：${i} 个内联 script 全部通过` : `有 ${bad} 个 script 报错`);
process.exit(bad === 0 ? 0 : 1);
