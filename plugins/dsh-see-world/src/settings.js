/**
 * settings.js — 一份配置文件，两处读写（工具侧 / 设置页）。
 *
 * 设计要点：
 *   · **校验只做一次**：设置页不重复实现规则，只显示这里返回的 warnings。
 *     前端和后端各写一套规则，早晚会不一致，然后用户看到「明明填对了却不生效」。
 *   · **不认识的键原样保留**：用户手写进 json 的字段不该被网页保存一次就抹掉。
 *   · **写盘走临时文件 + rename**：设置页点保存时摄像头可能正在跑，半截文件会被
 *     下一次启动读到。
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dshHome } from './binaries.js';

/** 常见摄像头分辨率；也允许用户手填（这里只管提示，不拦）。 */
export const RESOLUTIONS = [
  [640, 480], [800, 600], [960, 540], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160],
];

export const DEFAULTS = {
  device: null,
  width: 1280,
  height: 720,
  fps: 10,
  frames: 4,
  quality: 1,
  monitor: true,
  ffmpegPath: null,
  /**
   * 面板里那口预览流的分辨率（宽度）。预览只是给人看个大概，所以默认 640；
   * 调大变清楚也变慢，因为每一帧都要重新压成 PNG 走 localhost。
   */
  previewWidth: 640,
  /** 点「看世界」时顺手把当前画面送进会话（而不是只开个面板）。 */
  sendOnOpen: true,
  /**
   * 自动回报：画面出现值得看的变化时，插件自己往绑定的会话里投一条消息
   * （带一张图），模型不用再调工具。关掉就变成"只有我开口它才看"。
   */
  autoReply: true,
  /** 两次自动回报的最小间隔（秒）。间隔越短越像直播，也越费 token。 */
  replyIntervalSec: 25,
  /** 自动回报时是否把那张图一起带上（关掉就只给一句话，让模型自己 peek）。 */
  replyAttach: true,
  /** 一段最多自动回报多少次；叫满就停，等你再开口。 */
  replyBudget: 20,
};

export function settingsPath(env = process.env) {
  const home = dshHome(env);
  return join(home ?? process.cwd(), 'see-world.json');
}

/** 读文件（坏 JSON 当空配置，不抛 —— 抛了用户连设置页都打不开）。 */
export function readRaw(env = process.env) {
  const path = settingsPath(env);
  try {
    if (!existsSync(path)) return { path, raw: {}, broken: null };
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return { path, raw: {}, broken: null };
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path, raw: {}, broken: '文件内容不是一个 JSON 对象' };
    }
    return { path, raw: parsed, broken: null };
  } catch (e) {
    return { path, raw: {}, broken: `读不了：${e?.message ?? e}` };
  }
}

const clampInt = (v, min, max) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return null;
};

/**
 * 把「用户填的」揉成「能跑的」，同时把每一处被改掉的都写进 warnings。
 *
 * 不抛错是刻意的：设置页的价值在于「告诉你哪里不对，同时让其余部分仍然可用」。
 */
export function normalize(input = {}) {
  const out = { ...DEFAULTS };
  const warnings = [];

  for (const [k, v] of Object.entries(input ?? {})) {
    if (!(k in DEFAULTS)) out[k] = v;       // 不认识的键原样留着
  }

  // device：空字符串 / null 都表示"自动挑第一个"
  if (input.device !== undefined) {
    const d = typeof input.device === 'string' ? input.device.trim() : '';
    out.device = d || null;
  }

  const width = clampInt(input.width ?? out.width, 160, 3840);
  const height = clampInt(input.height ?? out.height, 120, 2160);
  if (width === null || height === null) {
    warnings.push('分辨率不是数字，已经退回 1280×720。');
    out.width = 1280;
    out.height = 720;
  } else {
    if (width !== Number(input.width ?? width) || height !== Number(input.height ?? height)) {
      warnings.push(`分辨率被夹到 ${width}×${height}（允许 160×120 ~ 3840×2160）。`);
    }
    const known = RESOLUTIONS.some(([w, h]) => w === width && h === height);
    if (!known) warnings.push(`${width}×${height} 不是常见分辨率，摄像头可能拒绝这个尺寸（会退回驱动默认值）。`);
    out.width = width;
    out.height = height;
  }

  const fps = clampInt(input.fps ?? out.fps, 1, 30);
  if (fps === null || fps !== Number(input.fps ?? fps)) {
    warnings.push(`帧率必须是 1~30 的整数，已设为 ${fps ?? out.fps}。`);
  }
  out.fps = fps ?? out.fps;

  const frames = clampInt(input.frames ?? out.frames, 1, 9);
  if (frames === null || frames !== Number(input.frames ?? frames)) {
    warnings.push(`一次给的帧数必须是 1~9，已设为 ${frames ?? out.frames}。`);
  }
  out.frames = frames ?? out.frames;

  const quality = clampInt(input.quality ?? out.quality, 0, 3);
  if (quality === null || quality !== Number(input.quality ?? quality)) {
    warnings.push(`画质档位必须是 0~3，已设为 ${quality ?? out.quality}。`);
  }
  out.quality = quality ?? out.quality;

  const previewWidth = clampInt(input.previewWidth ?? out.previewWidth, 240, 1280);
  if (previewWidth === null) warnings.push('预览宽度不是数字，已设为 640。');
  out.previewWidth = previewWidth ?? out.previewWidth;

  for (const key of ['monitor', 'sendOnOpen', 'autoReply', 'replyAttach']) {
    if (input[key] === undefined) continue;
    const b = asBool(input[key]);
    if (b === null) warnings.push(`${key} 只认 true/false，已忽略这次填的值。`);
    else out[key] = b;
  }

  const interval = clampInt(input.replyIntervalSec ?? out.replyIntervalSec, 3, 600);
  if (interval === null || interval !== Number(input.replyIntervalSec ?? interval)) {
    warnings.push(`自动回报间隔必须是 3~600 秒，已设为 ${interval ?? out.replyIntervalSec} 秒。`);
  }
  out.replyIntervalSec = interval ?? out.replyIntervalSec;

  const budget = clampInt(input.replyBudget ?? out.replyBudget, 1, 200);
  if (budget === null || budget !== Number(input.replyBudget ?? budget)) {
    warnings.push(`自动回报次数上限必须是 1~200，已设为 ${budget ?? out.replyBudget}。`);
  }
  out.replyBudget = budget ?? out.replyBudget;

  if (input.ffmpegPath !== undefined) {
    const p = typeof input.ffmpegPath === 'string' ? input.ffmpegPath.trim() : '';
    out.ffmpegPath = p || null;
    if (p && !existsSync(p)) {
      warnings.push(`ffmpegPath 指向的文件不存在：${p}（会退回自动查找）。`);
    }
  }

  return { config: out, warnings };
}

/** 合并写入：只覆盖 patch 里出现的键，其余保留。 */
export function save(patch, env = process.env) {
  const { path, raw } = readRaw(env);
  const merged = { ...raw, ...(patch ?? {}) };
  // null 表示"删掉这个键"，让默认值重新生效
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const { config, warnings } = normalize(merged);

  const text = `${JSON.stringify({ ...merged, ...config }, null, 2)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    return { ok: false, path, config, warnings, error: `写不进 ${path}：${e?.message ?? e}` };
  }
  return { ok: true, path, config, warnings };
}

/** 读 + 归一（apply 时用这一次，运行期不再读盘）。 */
export function load(env = process.env) {
  const { path, raw, broken } = readRaw(env);
  const { config, warnings } = normalize(raw);
  if (broken) warnings.unshift(`${path}：${broken}`);
  return { path, config, warnings, raw };
}
