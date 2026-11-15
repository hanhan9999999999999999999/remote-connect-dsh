#!/usr/bin/env node
/**
 * selftest.mjs — 不启 DSH，直接拿真摄像头跑一遍。
 *
 * 为什么先跑这个：插件接进宿主之后，任何问题都会变成"模型那边好像不太对"。
 * 这一层把宿主排除掉，只看三件事 —— **设备通不通、图对不对、拼版看不看得清**。
 * 图落在 .out/，人可以直接打开看。
 *
 *   node scripts/selftest.mjs
 *   node scripts/selftest.mjs --device "4K AutoFocus Webcam" --seconds 4
 *   node scripts/selftest.mjs --ffmpeg "D:\\tools\\ffmpeg\\bin\\ffmpeg.exe"
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFfmpeg } from '../src/binaries.js';
import { listDevices } from '../src/capture.js';
import { createEye } from '../src/session.js';
import { buildSheet } from '../src/sheet.js';
import { exposureOf, gainFor, exposureWord } from '../src/analyze.js';
import { testCard } from '../src/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, '.out');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const t0 = Date.now();
const stamp = (ms) => `${((ms - t0) / 1000).toFixed(2)}s`;
const say = (m) => console.log(`[${stamp(Date.now())}] ${m}`);

mkdirSync(outDir, { recursive: true });

say(`node ${process.version} · ${process.platform}`);

// 0) 纯 JS 编码器先自检：连一张测试卡都写不出来，后面全是白搭
{
  const card = buildSheet({
    frames: [{ ...testCard(640, 360), at: Date.now(), label: 'TEST' }],
    title: 'TEST CARD 4X4',
    gain: 1,
  });
  const p = join(outDir, 'testcard.png');
  writeFileSync(p, card.png);
  say(`测试卡 ${card.width}×${card.height} → ${p} (${card.png.length} 字节)`);
}

const ff = resolveFfmpeg({
  env: process.env,
  platform: process.platform,
  settings: arg('ffmpeg') ? { ffmpegPath: arg('ffmpeg') } : {},
});
const ffmpegPath = ff.path;
say(`ffmpeg → ${ffmpegPath}  (来源 ${ff.source})`);

// 1) 设备
const found = await listDevices({ ffmpegPath, platform: process.platform, timeoutMs: 12_000 });
if (!found.devices?.length) {
  say(`列设备失败：${found.reason}`);
  if (found.raw) say(found.raw.split('\n').slice(-8).join('\n'));
  process.exit(1);
}
for (const d of found.devices) say(`  设备 ${d.name}  [${d.kind}]`);
const device = arg('device', (found.devices.find((d) => d.kind === 'video') ?? found.devices[0]).name);
say(`使用设备：${device}`);

// 2) 眼睛
const eye = createEye({
  ffmpegPath, device, width: 1280, height: 720, fps: 10, maxFrames: 4, quality: 1,
  log: (m) => say(`  · ${m}`),
});

const opened = await eye.open();
say(`打开：${opened.ok ? 'OK' : `失败 ${opened.error?.reason} ${opened.error?.message}`}`);
if (!opened.ok) { eye.close(); process.exit(1); }

// 3) look
const seconds = Number(arg('seconds', '3'));
const look = await eye.look({ seconds, maxFrames: 4 });
if (!look.ok) {
  say(`look 失败：${look.error?.reason} ${look.error?.message}`);
  eye.close();
  process.exit(1);
}
const lookPath = join(outDir, `look-${Date.now()}.png`);
writeFileSync(lookPath, look.sheet.png);
say(`look ${seconds}s → ${look.sheet.width}×${look.sheet.height} 图 ${look.sheet.png.length} 字节`
  + `｜${look.sheet.frames.length} 帧 / 采样 ${look.samples} 次 / 最大变动 ${look.movedMax.toFixed(2)}`);
say(`  亮度 ${exposureWord(look.sheet.exposure)} 均值 ${Math.round(look.sheet.exposure.meanV)}/255 增益 ×${look.sheet.gain.toFixed(2)}`);
say(`  → ${lookPath}`);

// 4) snapshot（原分辨率）
const shot = await eye.snapshot();
if (shot.ok) {
  const p = join(outDir, `still-${Date.now()}.png`);
  writeFileSync(p, shot.png);
  say(`snapshot → 原图 ${shot.source.width}×${shot.source.height} 出图 ${shot.width}×${shot.height}`
    + ` ${shot.png.length} 字节 / ${shot.ms}ms${shot.degraded ? ' (降级)' : ''}`);
  say(`  → ${p}`);
} else {
  say(`snapshot 失败：${shot.error?.reason} ${shot.error?.message}`);
}

// 5) 状态
const st = eye.status();
say(`状态：运行 ${st.running}｜${st.frames} 帧 / 分析 ${st.analysed} 次｜重开 ${st.restarts} 次｜出图 ${st.sheets} 张`);
eye.close();
say('已关闭');
