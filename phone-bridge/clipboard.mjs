// Windows 剪贴板：手机上能读/写电脑当前复制的东西。
// 只通过本机 PowerShell 的 Get-Clipboard / Set-Clipboard，不额外装依赖。
// 所有调用串行化：剪贴板是全局单例，两个请求同时写会互相抢。
//
// 编码坑：把中文直接塞进 PowerShell 的 stdin，会被按系统代码页（GBK）解码，
// 读回来就是乱码。这里统一走临时文件 + UTF-8，绕开控制台编码。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PS = process.env.PHONE_PS || 'powershell.exe';
const MAX = 64 * 1024;
const PRE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
let chain = Promise.resolve();

function tmpFile() {
  return path.join(os.tmpdir(), 'dsh-clip-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.txt');
}

// 用户名/临时目录里可能有单引号（O'Brien），拼进 PowerShell 单引号字符串要翻倍转义
function psq(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function run(script, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, ms: Date.now() - t0 });
    }
    let out = '', err = '', done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve({ ...r, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish({ ok: false, error: '剪贴板操作超时（电脑可能锁屏了）' }), timeoutMs || 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: (err.trim() || ('PowerShell 退出 ' + code)).slice(0, 300) });
      finish({ ok: true, out });
    });
  });
}

const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
};

export function read() {
  return serial(async () => {
    const f = tmpFile();
    const ps = PRE + "$v = Get-Clipboard -Raw; if ($null -eq $v) { $v = '' }; " +
      '[IO.File]::WriteAllText(' + psq(f) + ', $v, (New-Object Text.UTF8Encoding($false)))';
    const r = await run(ps);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) {
      try { fs.unlinkSync(f); } catch (_) {}
      if (r.ok) return { ok: false, error: '读不到剪贴板临时文件：' + e.message, ms: r.ms };
    }
    try { fs.unlinkSync(f); } catch (e) {}
    if (!r.ok) return r;
    return { ok: true, text: text.length > MAX ? text.slice(0, MAX) : text, truncated: text.length > MAX, length: text.length, ms: r.ms };
  });
}

export function write(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve({ ok: false, error: '文本为空' });
  if (s.length > MAX) return Promise.resolve({ ok: false, error: '文本太长（上限 64KB）' });
  return serial(async () => {
    const f = tmpFile();
    try { fs.writeFileSync(f, s, 'utf8'); }
    catch (e) { return { ok: false, error: '写临时文件失败：' + e.message }; }
    const ps = PRE + '$v = [IO.File]::ReadAllText(' + psq(f) + ', [Text.Encoding]::UTF8); Set-Clipboard -Value $v';
    const r = await run(ps);
    try { fs.unlinkSync(f); } catch (e) {}
    if (!r.ok) return r;
    return { ok: true, length: s.length, ms: r.ms };
  });
}

export const max = MAX;
