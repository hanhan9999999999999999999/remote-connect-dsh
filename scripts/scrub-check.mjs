// 上传前的隐私闸：仓库里不允许出现公网地址、服务器 IP、令牌、本机用户名。
// 用法：node scripts/scrub-check.mjs        （有命中就 exit 1）
//      node scripts/scrub-check.mjs --list  （只列命中，不判失败）
//
// 为什么要有这个：2026-11-15 上传前发现过一个测试脚本把手机通道的真实令牌写死在源码里。
// 这种事靠人眼审不可靠，靠一条命令把品类查全才可靠。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onlyList = process.argv.includes('--list');

// 每一条都要足够具体，避免误报把闸门变成噪音
const RULES = [
  { name: '手机通道令牌（40+ 位十六进制）', re: /\b[0-9a-f]{40,}\b/ },
  { name: '本机用户目录', re: /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/i },
  { name: 'POSIX 家目录', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\/(?:\.dsh|projects?|src|code)\b/ },
  { name: '公网隧道域名（dsh 入口）', re: /https?:\/\/[a-z0-9.-]+\.(com|net|cn|io)\/dsh\b/i },
  { name: '裸 IP 入口', re: /https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?\/dsh\b/ },
  { name: '私钥块', re: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { name: '命令行里的明文令牌', re: /[?&]t=[0-9a-f]{24,}/ },
];

// 允许出现在仓库里的示例域名/文档 IP
const ALLOW = [
  /dsh\.example\.com/i,
  /example\.(com|org|net)/i,   // 文档示例域名
  /\b203\.0\.113\.\d+\b/,      // RFC 5737 文档地址
  /\b198\.51\.100\.\d+\b/,
  /\b192\.0\.2\.\d+\b/,
  /\b127\.0\.0\.1\b/,
  /\b0\.0\.0\.0\b/,
  /localhost/i,
  /[\\/]Users[\\/]me[\\/]/i,        // 文档示例：C:/Users/me/... 是占位用户名
  /[\\/]home[\\/]user[\\/]/i,       // 同上，Linux 侧占位
  /\b[0-9a-f]{40}\b(?=[^0-9a-f]|$)/,   // 40 位是 git 提交号，不是令牌
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|mp4|mp3|wav|apk|jar|zip|keystore)$/i.test(f))
  .filter((f) => !/^public\/vendor\//i.test(f));

let bad = 0;
for (const file of files) {
  let text = '';
  try {
    text = execFileSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (_) {
    continue;
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!rule.re.test(line)) continue;
      if (ALLOW.some((a) => a.test(line))) continue;
      if (/user-attachments|github\.com\//i.test(line)) continue;
      // 提交号那种 40 位 hex 会命中第一条规则，这里再兜一次
      if (rule.name.startsWith('手机通道令牌') && /^[0-9a-f]{40}$/.test((line.match(/\b[0-9a-f]{32,}\b/) || [''])[0])) continue;
      bad += 1;
      console.log(`${file}:${i + 1}  [${rule.name}]\n    ${line.trim().slice(0, 160)}`);
    }
  }
}

if (!bad) {
  console.log(`OK：${files.length} 个入库文件里没有发现公网地址 / 令牌 / 本机路径。`);
  process.exit(0);
}
console.log(`\n发现 ${bad} 处需要处理的内容${onlyList ? '（--list 模式，不判失败）' : ''}。`);
process.exit(onlyList ? 0 : 1);
