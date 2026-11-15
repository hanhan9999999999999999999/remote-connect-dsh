/**
 * analyze.js — 把一帧像素变成「几个数」，靠这些数决定该不该留这一帧。
 *
 * 摄像头和屏幕不一样：
 *   - 屏幕上「变了」通常是内容变了；摄像头里「变了」可能是人动了、也可能是灯在闪、
 *     也可能是自动曝光在调。所以这里分开算**运动**（相邻帧）和**偏离参考**（相对稳定背景）。
 *   - 摄像头经常过曝/欠曝（实测这台机器整幅画面接近纯白），所以亮度单独统计并做归一化，
 *     否则拼出来的图在模型眼里只有一片白。
 */

/** 打分网格：64×36 = 2304 格，一格约等于画面的 1/64 宽。 */
export const GRID_W = 64;
export const GRID_H = 36;

/** 亮度超过这个值算「过曝」（0–255）。 */
export const CLIP_HIGH = 246;
/** 低于这个值算「死黑」。 */
export const CLIP_LOW = 8;

/**
 * 整块缩图（面积平均）。用于把捕获帧缩成拼图格子。
 *
 * 面积平均而不是最近邻：摄像头帧缩到一半以下时，最近邻会把细密纹理变成噪点，
 * 模型看到的是「雪花」而不是「桌上有一叠纸」。
 *
 * @returns {Buffer} dw*dh*3
 */
export function downscaleBox(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 3);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor(dy * yRatio);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((dy + 1) * yRatio)));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor(dx * xRatio);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((dx + 1) * xRatio)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let p = (y * sw + x0) * 3;
        for (let x = x0; x < x1; x += 1) {
          r += src[p]; g += src[p + 1]; b += src[p + 2];
          p += 3; n += 1;
        }
      }
      const q = (dy * dw + dx) * 3;
      out[q] = (r / n) | 0;
      out[q + 1] = (g / n) | 0;
      out[q + 2] = (b / n) | 0;
    }
  }
  return out;
}

/**
 * 帧 → 打分网格。**抽样**而不是全量：64×36 的格子上，每格采 4×4 个点就够稳定，
 * 全量平均在 1280×720 上要 92 万次内积，10fps 就吃掉三成 CPU。
 *
 * @returns {Uint8Array} GRID_W*GRID_H*3
 */
export function gridOf(rgb, width, height, gw = GRID_W, gh = GRID_H) {
  const grid = new Uint8Array(gw * gh * 3);
  const stepX = Math.max(1, Math.floor(width / (gw * 4)));
  const stepY = Math.max(1, Math.floor(height / (gh * 4)));
  for (let gy = 0; gy < gh; gy += 1) {
    const y0 = Math.floor((gy * height) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gh));
    for (let gx = 0; gx < gw; gx += 1) {
      const x0 = Math.floor((gx * width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gw));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = y0; y < y1; y += stepY) {
        let p = (y * width + x0) * 3;
        for (let x = x0; x < x1; x += stepX) {
          r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2];
          p += stepX * 3; n += 1;
        }
      }
      const q = (gy * gw + gx) * 3;
      grid[q] = (r / n) | 0;
      grid[q + 1] = (g / n) | 0;
      grid[q + 2] = (b / n) | 0;
    }
  }
  return grid;
}

/** 一帧的曝光统计（全画幅抽样，不只是网格）。 */
export function exposureOf(rgb, width, height) {
  let sum = 0; let n = 0; let high = 0; let low = 0;
  const step = 7;                       // 质数步长，避免和画面里的规则纹理共振
  const total = width * height;
  for (let i = 0; i < total; i += step) {
    const p = i * 3;
    const v = (rgb[p] * 0.299 + rgb[p + 1] * 0.587 + rgb[p + 2] * 0.114) | 0;
    sum += v; n += 1;
    if (v >= CLIP_HIGH) high += 1;
    if (v <= CLIP_LOW) low += 1;
  }
  return { meanV: n ? sum / n : 0, clipHigh: n ? high / n : 0, clipLow: n ? low / n : 0 };
}

/**
 * 两张网格的差异。
 *
 * `score` 是平均绝对差（0–255），`moved` 是「明显变了的格子占比」（0–1）。
 * 两个都要看：**整体缓慢推镜** score 不高但 moved 很广；**一只手指快速划过** moved 很小但 score 尖。
 *
 * @returns {{score:number, moved:number, peak:number}}
 */
export function diffGrid(a, b, tau = 12) {
  let sum = 0; let peak = 0; let moved = 0;
  const cells = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    const m = d / 3;
    sum += m;
    if (m > peak) peak = m;
    if (m > tau) moved += 1;
  }
  return { score: sum / cells, moved: moved / cells, peak };
}

/** 参考帧的慢速更新（只吸收「安静」的像素，动的东西不会被吸进去）。 */
export function blendReference(ref, cur, { alpha = 0.04, tau = 14 } = {}) {
  for (let i = 0; i < ref.length; i += 3) {
    const d = Math.abs(ref[i] - cur[i]) + Math.abs(ref[i + 1] - cur[i + 1]) + Math.abs(ref[i + 2] - cur[i + 2]);
    if (d / 3 > tau) continue;          // 变了的地方不更新，否则人走过之后背景会糊成一片
    ref[i] += (cur[i] - ref[i]) * alpha;
    ref[i + 1] += (cur[i + 1] - ref[i + 1]) * alpha;
    ref[i + 2] += (cur[i + 2] - ref[i + 2]) * alpha;
  }
}

/**
 * 亮度归一系数。
 *
 * 摄像头全自动曝光经常会「对着窗户就整幅白」。给模型看的图先按均值拉到 118 附近，
 * 上限 2.6×：**只提亮不硬压**，压暗会把已经过曝的高光挤成一片死色。
 */
export function gainFor(meanV, { target = 118, max = 2.6, min = 0.75 } = {}) {
  if (!Number.isFinite(meanV) || meanV <= 0) return 1;
  const g = target / meanV;
  return Math.min(max, Math.max(min, g));
}

/** 原地乘增益（拼图前对格子做，一次只碰要用的像素）。 */
export function applyGain(rgb, gain) {
  if (!Number.isFinite(gain) || Math.abs(gain - 1) < 0.02) return rgb;
  for (let i = 0; i < rgb.length; i += 1) {
    const v = rgb[i] * gain;
    rgb[i] = v > 255 ? 255 : v;
  }
  return rgb;
}

/**
 * 变化够不够「值得叫醒模型」。
 *
 * 阈值故意分开：`score` 高是**画面真变了**（灯开关、人进画面），
 * `moved` 高是**大片区域在动**（有人走过来）—— 只用一个数会把
 * 「整幅慢慢变亮」和「有人坐下」判成同一件事。
 */
export function isNotable({ score = 0, moved = 0 } = {}, { scoreAt = 16, movedAt = 0.22 } = {}) {
  return score >= scoreAt || moved >= movedAt;
}

/** 亮度一句话（给人看，也给模型校准判断）。 */
export function exposureWord({ meanV = 0, clipHigh = 0, clipLow = 0 } = {}) {
  if (clipHigh > 0.35) return '严重过曝（画面大半是白的）';
  if (clipHigh > 0.12) return '偏亮，高光有点爆';
  if (clipLow > 0.35) return '几乎全黑';
  if (clipLow > 0.12) return '偏暗';
  if (meanV < 55) return '暗';
  if (meanV > 190) return '亮';
  return '正常';
}
