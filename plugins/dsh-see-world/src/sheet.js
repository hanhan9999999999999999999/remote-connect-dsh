/**
 * sheet.js — 把 N 帧拼成一张图。
 *
 * 一张图里装 4 帧和装 1 帧，**token 成本几乎一样**（按 14px 一格估算），
 * 而 4 帧能让人「有没有动 / 从哪动到哪」一眼看出来。所以只要是「过程」，
 * 就拼成一张；只有「我要看清一个细节」才单独出一张原图。
 *
 * 格子尺寸按帧数选：帧越多格子越小，但**小到看不清就不是图了**，
 * 所以 3×3 是上限（480×270 一格，人脸和桌面物件还认得出来）。
 */

import { applyGain, downscaleBox } from './analyze.js';
import { drawText, textWidth } from './font.js';
import { encodePng } from './png.js';

const GUTTER = 4;
const PAD = 6;
const HEADER_H = 26;

/** 帧数 → 版式。 */
export function planSheet(n) {
  if (n <= 1) return { cols: 1, rows: 1, tileW: 960 };
  if (n === 2) return { cols: 2, rows: 1, tileW: 640 };
  if (n === 3) return { cols: 3, rows: 1, tileW: 480 };
  if (n === 4) return { cols: 2, rows: 2, tileW: 640 };
  if (n <= 6) return { cols: 3, rows: 2, tileW: 480 };
  return { cols: 3, rows: 3, tileW: 480 };
}

function fillRect(rgb, width, height, x, y, w, h, color) {
  const x0 = Math.max(0, x); const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w); const y1 = Math.min(height, y + h);
  for (let yy = y0; yy < y1; yy += 1) {
    let p = (yy * width + x0) * 3;
    for (let xx = x0; xx < x1; xx += 1) {
      rgb[p] = color[0]; rgb[p + 1] = color[1]; rgb[p + 2] = color[2];
      p += 3;
    }
  }
}

/** 把一帧缩到格子大小（面积平均），可选亮度增益。 */
export function fitFrame(frame, tw, th, gain = 1) {
  const { rgb, width, height } = frame ?? {};
  if (!rgb || typeof rgb.length !== 'number' || !(width > 0) || !(height > 0)) {
    throw new Error(`sheet: 帧数据不对（rgb=${typeof rgb}, width=${width}, height=${height}）`);
  }
  if (rgb.length < width * height * 3) {
    throw new Error(`sheet: 帧数据长度不够（${rgb.length} < ${width * height * 3}）`);
  }
  const scaled = (width === tw && height === th) ? Buffer.from(rgb) : downscaleBox(rgb, width, height, tw, th);
  return applyGain(scaled, gain);
}

/**
 * 拼图。
 *
 * @param {object} o
 * @param {Array<{rgb:Buffer,width:number,height:number,at:number,label?:string,score?:number}>} o.frames
 * @param {string} [o.title] 顶部一行（相机、时间范围、帧数）
 * @param {number} [o.gain] 亮度归一系数（每格都乘）
 * @param {number} [o.quality] 0.5–1.5，整体缩放（看不清时可调大）
 * @returns {{png:Buffer,width:number,height:number,tileW:number,tileH:number,cols:number,rows:number}}
 */
export function buildSheet({ frames = [], title = '', gain = 1, quality = 1 } = {}) {
  const list = frames.slice(0, 9);
  const n = Math.max(1, list.length);
  const plan = planSheet(n);
  const scaleQ = Math.max(0.5, Math.min(1.5, quality));
  const tileW = Math.round((plan.tileW * scaleQ) / 2) * 2;
  const tileH = Math.round((tileW * 9 / 16) / 2) * 2;
  const { cols, rows } = plan;

  const contentW = cols * tileW + (cols - 1) * GUTTER;
  const contentH = rows * tileH + (rows - 1) * GUTTER;
  const width = contentW + PAD * 2;
  const height = contentH + PAD * 2 + HEADER_H;

  const rgb = Buffer.alloc(width * height * 3, 12);

  fillRect(rgb, width, height, 0, 0, width, HEADER_H, [18, 18, 20]);
  if (title) drawText(rgb, width, height, title, PAD, 6, { scale: 2, color: [232, 236, 242] });

  for (let i = 0; i < n; i += 1) {
    const f = list[i];
    const cx = PAD + (i % cols) * (tileW + GUTTER);
    const cy = PAD + HEADER_H + Math.floor(i / cols) * (tileH + GUTTER);
    const tile = f ? fitFrame(f, tileW, tileH, gain) : Buffer.alloc(tileW * tileH * 3, 30);
    for (let y = 0; y < tileH; y += 1) {
      tile.copy(rgb, ((cy + y) * width + cx) * 3, y * tileW * 3, y * tileW * 3 + tileW * 3);
    }
    if (!f) continue;
    // 左上角：这一帧的钟点；右上角：第几张（方便口述「第三张」）
    const stamp = f.label ?? `${i + 1}`;
    drawText(rgb, width, height, stamp, cx + 6, cy + 6, {
      scale: 2, color: [255, 255, 255], bg: [0, 0, 0], bgAlpha: 0.12, pad: 3,
    });
    const badge = `${i + 1}`;
    drawText(rgb, width, height, badge, cx + tileW - textWidth(badge, 2) - 8, cy + 6, {
      scale: 2, color: [255, 214, 102], bg: [0, 0, 0], bgAlpha: 0.12, pad: 3,
    });
  }

  return {
    png: encodePng(rgb, width, height, { level: 3 }),
    width, height, tileW, tileH, cols, rows,
  };
}

/** 单帧整图（snapshot 用）：不拼版，可带一行标题。 */
export function buildSingle({ frame, title = '', gain = 1, maxWidth = 1280 }) {
  const { rgb, width, height } = frame;
  let w = width;
  let h = height;
  if (w > maxWidth) {
    h = Math.round((height * maxWidth) / width);
    w = maxWidth;
  }
  const body = (w === width && h === height)
    ? applyGain(Buffer.from(rgb), gain)
    : applyGain(downscaleBox(rgb, width, height, w, h), gain);

  if (!title) return { png: encodePng(body, w, h, { level: 3 }), width: w, height: h };

  const headerH = 26;
  const outH = h + headerH;
  const out = Buffer.alloc(w * outH * 3, 14);
  fillRect(out, w, outH, 0, 0, w, headerH, [18, 18, 20]);
  drawText(out, w, outH, title, 6, 6, { scale: 2, color: [232, 236, 242] });
  body.copy(out, w * headerH * 3);
  return { png: encodePng(out, w, h + headerH, { level: 3 }), width: w, height: h + headerH };
}
