/**
 * jpeg.js — 用一个常驻 ffmpeg 把 rgb24 帧压成 JPEG。
 *
 * 为什么预览不能用 PNG：摄像头画面是传感器噪声，PNG 的无损压缩对它几乎无效
 * （本机实测 640×360 只有 343 KB，压不动），而且纯 JS 的滤波+deflate 每帧要 15~25 ms，
 * 一轮预览就把事件循环占满 —— ffmpeg 的 stdout 没人读，采集反而掉帧，看着就是"卡"。
 * JPEG 是这类画面的正解：同样一张 640×360 只要 30~60 KB，ffmpeg 里是 SIMD，1~2 ms 出图。
 *
 * 做法：一个常驻子进程（rawvideo 进、mjpeg 出），画面直接喂 stdin、从 stdout 读回带
 * SOI(FFD8)/EOI(FFD9) 的 JPEG。
 *
 * 三个坑，都踩过了：
 * 1) **要 `-avioflags direct`**：不加的话 ffmpeg 把 stdin 攒在自己的 avio 缓冲里，
 *    一直到管道关闭才吐第一帧 —— 预览会永远黑屏。
 * 2) **不能一帧一等**：rawvideo 解复用要读到下一帧才把上一帧交出来（喂第 N 帧、回第 N-1 帧）。
 *    所以这里**不返回 Promise**：推就是推，回来的 JPEG 存成 latest，调用方永远拿最新的那张，
 *    谁等谁都会死锁。
 * 3) 时间戳用 FIFO 陪着走：进来的 JPEG 配的是最早那帧的时间，面板上的钟才不会骗人。
 */

import { spawn } from 'node:child_process';

/** JPEG 的 SOI / EOI 标记。熵编码数据里的 FF 都会被填充成 FF00，所以不会撞上这两个。 */
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** 最多容忍 3 帧在飞：再多就说明下游跟不上，直接丢帧。 */
const MAX_QUEUE = 3;

export function createJpegEncoder({
  ffmpegPath,
  width,
  height,
  quality = 5,
  log = () => {},
  onBroken = null,
} = {}) {
  let child = null;
  let acc = Buffer.alloc(0);
  let pendingAt = [];        // 喂进去但还没回来的帧的时间戳，按顺序
  let latest = null;         // 最近一帧压好的 JPEG
  let latestAt = 0;
  let dead = false;
  let frames = 0;
  let lastPushedAt = 0;

  const args = () => [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-avioflags', 'direct',
    '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', `${width}x${height}`,
    '-i', 'pipe:0',
    '-an', '-sn', '-dn',
    '-c:v', 'mjpeg', '-q:v', String(quality),
    '-flush_packets', '1',
    '-f', 'mjpeg',
    'pipe:1',
  ];

  const kill = () => {
    if (!child) return;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    child = null;
  };

  const fail = (reason) => {
    dead = true;
    kill();
    pendingAt = [];
    onBroken?.(reason);
  };

  const start = () => {
    if (child || dead) return;
    try {
      child = spawn(ffmpegPath, args(), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`JPEG 编码器起不来：${e?.message ?? e}`);
      return;
    }
    child.on('error', (e) => fail(`JPEG 编码器错误：${e?.message ?? e}`));
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`jpeg: ${s.slice(0, 200)}`);
    });
    child.on('close', (code) => {
      if (!dead) fail(`JPEG 编码器退出（code ${code}）`);
    });
    child.stdout?.on('data', (chunk) => {
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
      // 一帧可能要分几次 data 到齐，所以循环取完整帧
      for (;;) {
        const startIdx = acc.indexOf(SOI);
        if (startIdx < 0) {
          // 末字节可能是被切开的 SOI 前半段，留着
          acc = acc.length && acc[acc.length - 1] === 0xff ? acc.subarray(acc.length - 1) : Buffer.alloc(0);
          break;
        }
        const endIdx = acc.indexOf(EOI, startIdx + 2);
        if (endIdx < 0) { if (startIdx > 0) acc = acc.subarray(startIdx); break; }
        const jpg = Buffer.from(acc.subarray(startIdx, endIdx + 2));
        acc = acc.subarray(endIdx + 2);
        frames += 1;
        latest = jpg;
        latestAt = pendingAt.shift() ?? Date.now();
      }
      // 别让残渣无限长（半帧卡住时）
      if (acc.length > 8 << 20) acc = Buffer.alloc(0);
    });
  };

  /** 同步判断能不能用（预览据此在 JPEG / PNG 之间选） */
  const canEncode = () => !dead;

  /**
   * 塞一帧 rgb24 进去。**不等返回**：压好的帧会出现在 `snapshot()` 里。
   * @returns {boolean} 这一帧有没有被吃进去（false = 积压 / 未就绪）
   */
  const push = (rgb, at = Date.now()) => {
    if (dead) return false;
    start();
    if (!child) return false;
    if (!rgb || rgb.length < width * height * 3) return false;
    // 同一帧不必重压：摄像头没出新画面时，预览也不该重复推
    if (at && at === lastPushedAt) return false;
    if (pendingAt.length >= MAX_QUEUE) return false;
    lastPushedAt = at;
    pendingAt.push(at);
    try {
      child.stdin.write(rgb);
      return true;
    } catch {
      pendingAt.pop();
      return false;
    }
  };

  /** 最近一帧压好的 JPEG（可能比刚推的晚一帧，这是 ffmpeg 管道的固有延迟）。 */
  const snapshot = () => (latest ? { jpg: latest, at: latestAt } : null);

  const close = () => {
    dead = true;
    pendingAt = [];
    latest = null;
    kill();
  };

  return {
    push,
    snapshot,
    canEncode,
    close,
    get stats() { return { width, height, quality, frames, dead, queued: pendingAt.length }; },
  };
}
