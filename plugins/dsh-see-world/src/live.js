/**
 * 实时预览：把摄像头画面当视频推给面板。
 *
 * 为什么不用轮询：
 * 面板原来每 700ms 拿一张 /frame，等于 1.4 帧/秒 —— 那不是"画面"，那是幻灯片。
 * 而且每次轮询都新建一个 objectURL 换掉 <img> 的 src，浏览器每张都从头解码重绘，
 * 观感是"跳动"而不是"跟手"。真正的做法是**一条长连接**，服务端有新帧就往里写，
 * 浏览器按 multipart/x-mixed-replace 直接就地替换画面，不需要 JS 参与。
 *
 * 编码成本（本机实测，640×360 纯 JS PNG level 1）：缩放 5ms + 编码 <1ms，
 * 所以 10~15 帧/秒只占几十分之一核 —— 卡顿从来不是编码的锅，是取样太稀。
 */

export const BOUNDARY = 'seeworldframe';

/** 单个订阅者最多允许积压这么多字节，超了就丢帧（客户端慢不能拖垮采集）。 */
const MAX_BACKLOG = 3 << 20;

export function createPreview({ frame, log = () => {}, defaultFps = 12 }) {
  /** @type {Set<{res:any,width:number,fps:number,lastAt:number,misses:number,closed:boolean}>} */
  const clients = new Set();
  let timer = null;
  let busy = false;

  const writePart = (client, shot) => {
    const res = client.res;
    if (client.closed || res.writableEnded || res.destroyed) return false;
    // 客户端跟不上就丢掉这一帧：宁可少一帧，也不要让 TCP 缓冲区无限长
    const backlog = Number(res.writableLength) || 0;
    if (backlog > MAX_BACKLOG) return true;
    const type = shot.mediaType || 'image/png';
    // multipart 的第一段必须直接以 --boundary 开头（前面带 CRLF 有的解析器会当成空段，
    // 于是整条流被当成"永远还没开始"——面板看起来就是一块黑）
    const lead = client.parts === 0 ? '' : '\r\n';
    client.parts = (client.parts ?? 0) + 1;
    try {
      res.write(
        `${lead}--${BOUNDARY}\r\ncontent-type: ${type}\r\ncontent-length: ${shot.data.length}\r\n\r\n`,
      );
      res.write(shot.data);
      return true;
    } catch (e) {
      log(`预览写失败：${e?.message ?? e}`);
      client.closed = true;
      return false;
    }
  };

  // 取一帧（可能是 Promise：JPEG 要等常驻编码器回包），统一成普通对象
  const shoot = async (client) => {
    try {
      const shot = await Promise.resolve(frame({ maxWidth: client.width }));
      if (!shot?.ok) return shot ?? { ok: false };
      if (shot.data) return shot;
      if (shot.png) return { ...shot, data: shot.png, mediaType: 'image/png' };
      return { ok: false, reason: 'no-data' };
    } catch (e) {
      log(`预览取帧失败：${e?.message ?? e}`);
      return { ok: false, reason: 'error' };
    }
  };

  const tick = async () => {
    if (clients.size === 0) { stopTimer(); return; }
    if (busy) return;               // 上一轮还没收工，这轮跳过：预览只追最新画面
    busy = true;
    try {
      const now = Date.now();
      for (const client of [...clients]) {
        if (client.closed) { clients.delete(client); continue; }
        if (now - client.lastAt < client.minGap) continue;
        // 记下"这次尝试过了"，否则同一帧被跳过时 lastAt 不前进，
        // 20ms 的 tick 会把取帧（缩放+编码）当鼓点敲，白烧 CPU 还会饿死 ffmpeg 的 stdout。
        client.lastAt = now;
        // 每个订阅者按自己的宽度取图（缩放+增益在场内做，不缓存旧的，避免画面撒谎）
        const shot = await shoot(client);
        if (client.closed) { clients.delete(client); continue; }
        if (shot.skip) continue;        // 编码器正忙：这一拍跳过，不算失败
        if (!shot.ok || !shot.data) {
          client.misses += 1;
          // 连续取不到画面（没开流 / 致命错误）就收摊，让 <img> 的 onError 去说明原因
          if (client.misses > Math.max(6, client.fps * 3)) {
            client.closed = true;
            try { client.res.end(); } catch { /* ignore */ }
            clients.delete(client);
          }
          continue;
        }
        client.misses = 0;
        // 同一帧不重复发：摄像头没出新画面时别制造假的"流畅"
        if (shot.at && shot.at === client.lastFrameAt) continue;
        client.lastFrameAt = shot.at ?? 0;
        if (!writePart(client, shot)) clients.delete(client);
      }
    } finally {
      busy = false;
    }
  };

  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => { tick(); }, 16); // 16ms 一跳，真正的节流由每个订阅者的 minGap 决定
    timer.unref?.();
  };

  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  /**
   * 订阅一条预览流。
   * @returns {() => void} 退订（路由在 req 关闭时调用）
   */
  const subscribe = ({ res, width = 480, fps = defaultFps } = {}) => {
    const safeFps = Math.max(2, Math.min(30, Number(fps) || defaultFps));
    const client = {
      res,
      width: Math.max(160, Math.min(1280, Number(width) || 480)),
      fps: safeFps,
      minGap: Math.round(1000 / safeFps),
      lastAt: 0,
      lastFrameAt: 0,
      misses: 0,
      closed: false,
    };
    clients.add(client);
    startTimer();
    // 立刻给一帧，别让用户盯着黑框等
    shoot(client).then((shot) => {
      if (!client.closed && shot.ok && shot.data) {
        client.lastFrameAt = shot.at ?? 0;
        client.lastAt = Date.now();
        writePart(client, shot);
      }
    }).catch(() => {});
    return () => {
      client.closed = true;
      clients.delete(client);
      if (clients.size === 0) stopTimer();
    };
  };

  const closeAll = () => {
    for (const c of clients) {
      c.closed = true;
      try { c.res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    stopTimer();
  };

  return {
    subscribe,
    closeAll,
    get size() { return clients.size; },
  };
}
