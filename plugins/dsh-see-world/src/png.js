/**
 * png.js — 纯 JS 的 PNG 编码，不 spawn ffmpeg。
 *
 * 摄像头每秒 10 帧，出图要快：ffmpeg 光启动就 95~150 ms，这笔固定成本不能每张付。
 * PNG 本身只是「签名 + IHDR + IDAT(zlib) + IEND」，每块带 CRC32；
 * 唯一容易搞错的是**扫描线每行前面要加一个滤波类型字节**，忘了它会得到一张斜掉的图。
 *
 * 编码器原型来自 dsh-see-now（Apache-2.0）的 src/png.js，这里保留同一份实现以免行为漂移。
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * RGB 原始像素 → PNG 字节。
 *
 * 滤波不是可选项：摄像头画面是**传感器噪声**，不滤波等于把噪声原样喂给 deflate，
 * 640×360 能压出 480 KB（几乎没压），既慢又大。Paeth（滤波类型 4）用左、上、左上
 * 三个邻居预测当前像素，残差接近 0，同样的画面能小一个数量级 —— 这也是 libpng/ffmpeg
 * 对照片类图像默认挑的那一种。
 *
 * @param {Buffer|Uint8Array} rgb 长度必须是 width*height*3（rgb24，与 ffmpeg rawvideo 一致）
 * @param {number} width
 * @param {number} height
 * @param {{level?: number, filter?: 'paeth'|'none'}} [opts] level 1–9，默认 6；实时场景 1–3 已够
 * @returns {Buffer}
 */
export function encodePng(rgb, width, height, { level = 6, filter = 'paeth' } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`bad size ${width}x${height}`);
  }
  const need = width * height * 3;
  if (!rgb || rgb.length < need) {
    throw new RangeError(`rgb too small: ${rgb?.length ?? 0} < ${need}`);
  }

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  if (filter === 'none') {
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0;              // 滤波 0 = None
      const from = y * stride;
      if (typeof rgb.copy === 'function') rgb.copy(raw, rowStart + 1, from, from + stride);
      else raw.set(rgb.subarray(from, from + stride), rowStart + 1);
    }
  } else {
    const bpp = 3;
    const zero = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 4;              // 滤波 4 = Paeth
      const from = y * stride;
      const prevFrom = (y - 1) * stride;
      const hasPrev = y > 0;
      for (let i = 0; i < stride; i += 1) {
        const cur = rgb[from + i];
        const a = i >= bpp ? rgb[from + i - bpp] : 0;
        const b = hasPrev ? rgb[prevFrom + i] : zero[i];
        const c = hasPrev && i >= bpp ? rgb[prevFrom + i - bpp] : 0;
        raw[rowStart + 1 + i] = (cur - paeth(a, b, c)) & 0xff;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 2;    // 颜色类型 2 = truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;   // 非隔行

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 一张测试卡：4×4 十六个色相。
 *
 * **验证「图真的到了模型那里」用**：模型如果描述得出「十六个彩色方块、四行四列」，
 * 说明整条链路通了，而不是只收到一条文本。
 */
export function testCard(width = 320, height = 180) {
  const rgb = Buffer.alloc(width * height * 3);
  const cols = 4;
  const rows = 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = Math.min(cols - 1, Math.floor((x / width) * cols));
      const cy = Math.min(rows - 1, Math.floor((y / height) * rows));
      const [r, g, b] = hslToRgb((cy * cols + cx) / 16, 0.72, 0.55);
      const inner = (x % Math.floor(width / cols)) > 1 && (y % Math.floor(height / rows)) > 1;
      const p = (y * width + x) * 3;
      rgb[p] = inner ? r : 18;
      rgb[p + 1] = inner ? g : 18;
      rgb[p + 2] = inner ? b : 20;
    }
  }
  return { rgb, width, height };
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
