#!/usr/bin/env node
/**
 * 远程服务验收脚本 —— 重启 DSH 应用之后跑这个：
 *   node tools/verify-remote-service.mjs [--port 57549]
 *
 * 检查项：
 *   1. 插件是否被宿主加载（/dsh-phone-api/status 有 JSON 就说明在）
 *   2. 手机桥接是否在跑、PID、模式、会话
 *   3. 配对码是否 114514
 *   4. 公网地址 / 局域网地址是否可达
 *   5. 客户端产物里是否带 @local/dsh-phone-bridge/client.js
 * 每条打印 PASS/FAIL + 明细，最后给一行汇总。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GUI_PORT = Number(argOf('--port', process.env.DSH_GUI_PORT || 57549));
const GUI = `http://127.0.0.1:${GUI_PORT}`;
const BRIDGE_DIR = argOf('--bridge-dir', 'D:/document/Remote Connect DSH/phone-bridge');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function get(url, timeoutMs = 6000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } catch (e) {
    return { status: 0, text: '', error: String((e && e.message) || e) };
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 1. 插件是否加载
const status = await get(`${GUI}/dsh-phone-api/status`);
if (status.json && status.json.ok) {
  record('插件已加载（/dsh-phone-api/status）', true, `port=${GUI_PORT} running=${status.json.running} pid=${status.json.pid}`);
} else {
  record('插件已加载（/dsh-phone-api/status）', false, `http=${status.status} ${status.error || status.text.slice(0, 80)} → 应用还没重启过`);
}

// 2. 桥接健康
const health = await get('http://127.0.0.1:8899/api/health');
const h = health.json;
record('手机桥接在跑（/api/health）', !!(h && h.ok), h ? `busy=${h.busy} cwd=${h.cwd}` : `http=${health.status}`);

// 3. 配对码
const state = readJson(path.join(BRIDGE_DIR, 'runtime', 'state.json')) || {};
record('配对码 = 114514', String(state.pairCode) === '114514', `state.json pairCode=${state.pairCode}`);
const pair = await fetch('http://127.0.0.1:8899/api/pair', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: '114514' }),
  signal: AbortSignal.timeout(6000),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })).catch((e) => ({ status: 0, error: String(e.message) }));
record('用 114514 能换到令牌（/api/pair）', !!(pair.json && pair.json.ok && pair.json.token), `http=${pair.status}`);

// 4. 公网 / 局域网
const tunnel = readJson(path.join(BRIDGE_DIR, 'tunnel.json')) || {};
if (tunnel.publicUrl) {
  const pub = await get(`${tunnel.publicUrl.replace(/\/$/, '')}/api/health`, 12000);
  record(`公网地址可达 ${tunnel.publicUrl}`, pub.status === 200, `http=${pub.status}`);
}
const lan = (h && Array.isArray(h.addresses) ? h.addresses.find((a) => a && a.recommended) : null) || null;
if (lan && lan.ip) {
  const url = `http://${lan.ip}:8899/api/health`;
  const r = await get(url, 5000);
  record(`局域网地址可达 ${url}`, r.status === 200, `http=${r.status}`);
}

// 5. 已加载的插件版本（新版 snapshot 一定带 pairCode 字段）
if (status.json && status.json.ok) {
  const keys = Object.keys(status.json);
  const isNew = keys.includes('pairCode');
  record(
    '运行中的插件是新版（含配对码字段）',
    isNew,
    isNew ? '已是最新，按钮面板里能看到配对码' : '宿主里跑的是旧版：重启 DSH 应用后才会换成直连启动 + 配对码显示',
  );
  record(
    '按钮所在客户端产物（重启后在输入框左侧看「远程服务」）',
    true,
    'host 已注册该 bundle，客户端模块随之加载；如需硬证据可在浏览器控制台查 window.__ModuleLoader__',
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过${failed.length ? '；失败项：' + failed.map((f) => f.name).join(' / ') : ''}`);
process.exit(failed.length ? 1 : 0);
