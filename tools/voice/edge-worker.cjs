// edge-tts-worker — zero-dependency Edge TTS synthesis (Node >= 22).
// Transient failures are retried once with backoff; auth/voice errors fail fast.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const WSS_BASE = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const CRLF = String.fromCharCode(13, 10);
function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  const hash = crypto.createHash('sha256');
  hash.update(String(roundedTicks) + TRUSTED_CLIENT_TOKEN, 'ascii');
  return hash.digest('hex').toUpperCase();
}
function readStdin() {
  return new Promise(function (resolve, reject) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () { resolve(data); });
    process.stdin.on('error', reject);
  });
}
function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fail(msg) {
  console.error('ERR ' + msg);
  process.exit(1);
}
function isHardWorkerError(msg) {
  return /40[013]|1007|unsupported voice|empty text/i.test(String(msg || ''));
}
// 情感风格：mstts:express-as 是微软情感合成的标准外壳，Azure 语音服务原生支持。
// Edge 的免费朗读端点把 xmlns:mstts 命名空间认了，但认不认 style 属性要实测 —— 见 tools/voice/_probe-style.mjs。
// 关键约束：style 为空时下面拼出来的 SSML 必须和加这个功能之前逐字节一致，
// 这样所有老调用（phone-bridge、say.mjs、插件）的行为零变化，出了事可以直接判成"没开风格"。
function buildSsml(voice, lang, rate, pitch, volume, text, style, styleDegree, pauseMs) {
  const prosody = '<prosody rate="' + xmlEscape(rate) + '" pitch="' + xmlEscape(pitch) + '" volume="' + xmlEscape(volume) + '">' + xmlEscape(text) + '</prosody>';
  // 句尾留一口气：只在明确给了正整数时才插 <break>，
  // 不传的时候 SSML 与老实现逐字节一致（零回归的前提）。
  const px = pauseMs == null ? '' : String(pauseMs).trim();
  const tail = px && /^[0-9]+$/.test(px) && Number(px) > 0 && Number(px) <= 10000
    ? '<break time="' + px + 'ms"/>'
    : '';
  let body = prosody + tail;
  const st = style == null ? '' : String(style).trim();
  if (st && st.toLowerCase() !== 'default') {
    const degRaw = styleDegree == null ? '' : String(styleDegree).trim();
    const deg = degRaw && /^[0-9.]+$/.test(degRaw) ? ' styledegree="' + degRaw + '"' : '';
    body = '<mstts:express-as style="' + xmlEscape(st) + '"' + deg + '>' + body + '</mstts:express-as>';
  }
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' + lang + '">'
    + '<voice name="' + xmlEscape(voice) + '">' + body + '</voice></speak>';
}

function synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume, style, styleDegree, pauseMs) {
  return new Promise(function (resolve, reject) {
    const secMsGec = generateSecMsGecToken();
    const connectionId = crypto.randomBytes(16).toString('hex');
    const url = WSS_BASE + '?Ocp-Apim-Subscription-Key=' + TRUSTED_CLIENT_TOKEN + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=1-' + CHROMIUM_FULL_VERSION + '&ConnectionId=' + connectionId;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let settled = false;
    let pendingError = null;
    let errorTimer = null;
    function describeWsError(e) {
      try {
        if (!e || typeof e !== 'object') return 'websocket error: ' + String(e);
        const parts = [];
        if (e.type) parts.push('type=' + e.type);
        if (e.code !== undefined && e.code !== null && e.code !== '') parts.push('code=' + e.code);
        if (e.reason) parts.push('reason=' + String(e.reason).slice(0, 120));
        if (e.message) parts.push('message=' + String(e.message).slice(0, 200));
        else {
          const s = String(e);
          if (s && s !== '[object Event]' && s !== '[object ErrorEvent]' && s !== '[object Object]') {
            parts.push('detail=' + s.slice(0, 200));
          }
        }
        parts.push('url=api.msedgeservices.com/tts/v1');
        return 'websocket error (' + parts.join(' ') + ')';
      } catch (err) {
        return 'websocket error: ' + String(e);
      }
    }
    function finish() {
      if (settled) return;
      settled = true;
      if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) {
        try { ws.close(); } catch (e) {}
        reject('audio too small: ' + buf.length);
        return;
      }
      try {
        fs.writeFileSync(outPath, buf);
        try { ws.close(); } catch (e) {}
        resolve(buf.length);
      } catch (e) {
        reject('write ' + e.message);
      }
    }
    ws.onerror = function (e) {
      pendingError = describeWsError(e);
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(function () {
        if (!settled) {
          settled = true;
          errorTimer = null;
          reject(pendingError);
        }
      }, 1500);
    };
    ws.onclose = function (e) {
      if (settled) return;
      const code = e && e.code;
      const reason = e && e.reason;
      if (pendingError) {
        if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
        settled = true;
        reject(pendingError + ' closed code=' + code + ' reason=' + String(reason || '').slice(0, 120));
        return;
      }
      reject('closed early code=' + code + ' reason=' + reason);
    };
    ws.onmessage = function (event) {
      if (settled) return;
      if (typeof event.data === 'string') {
        if (event.data.indexOf('Path:turn.end') >= 0) { finish(); return; }
        return;
      }
      const raw = Buffer.from(event.data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length > 0) chunks.push(body);
      } else if (raw.length > 0) {
        chunks.push(raw);
      }
    };
    ws.onopen = function () {
      const requestId = crypto.randomBytes(16).toString('hex');
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const ssml = buildSsml(voice, lang, rate, pitch, volume, text, style, styleDegree, pauseMs);
      // 排查用：EDGE_TTS_DUMP_SSML=1 时把真正发出去的 SSML 打到 stderr（不干扰 stdout 的 OK 协议行）
      if (process.env.EDGE_TTS_DUMP_SSML === '1') {
        try { process.stderr.write('SSML ' + ssml + '\n'); } catch (e) {}
      }
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send('X-RequestId:' + requestId + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    };
    setTimeout(function () {
      if (!settled) {
        settled = true;
        if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
        try { ws.close(); } catch (e) {}
        reject('timeout after 20000ms without turn.end (endpoint slow or blocked)');
      }
    }, 20000);
  });
}
function findVoiceArgs() {
  const args = process.argv;
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-e') continue;
    if (a.indexOf('.cjs') >= 0 || a.indexOf('.mjs') >= 0 || a.indexOf('edge-tts-worker') >= 0) continue;
    out.push(a);
  }
  return out;
}
async function main() {
  const args = findVoiceArgs();
  // 位置参数（老写法，顺序不能动）：voice rate pitch volume [style] [styleDegree]
  // 另外支持显式写法 style=cheerful / style-degree=1.5：
  // 只想要风格时不用为了占位硬填 default default default，少一个填错的机会。
  const loose = Object.create(null);
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^(style|style-degree|degree|pause)=(.*)$/i.exec(args[i]);
    if (m) { loose[m[1].toLowerCase()] = m[2]; continue; }
    pos.push(args[i]);
  }
  const voice = pos[0] || 'zh-CN-XiaoxuanNeural';
  const rate = pos[1] || 'default';
  const pitch = pos[2] || 'default';
  const volume = pos[3] || 'default';
  const style = loose['style'] !== undefined ? loose['style'] : (pos[4] || '');
  const styleDegree = loose['style-degree'] !== undefined
    ? loose['style-degree']
    : (loose['degree'] !== undefined ? loose['degree'] : (pos[5] || ''));
  // 句尾停顿（毫秒）。只接受纯数字，空/非法一律当作不加，保持 SSML 与老版本一致。
  const pauseMs = loose['pause'] !== undefined ? loose['pause'] : (pos[6] || '');
  const text = (await readStdin()).trim();
  if (!text) return fail('empty text');
  const vparts = String(voice).split('-');
  const lang = (vparts.length >= 2 ? vparts[0] + '-' + vparts[1] : 'zh-CN');
  const outPath = path.join(os.tmpdir(), 'dsh-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.mp3');
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const size = await synthesizeOnce(voice, text, outPath, lang, rate, pitch, volume, style, styleDegree, pauseMs);
      console.log('OK ' + outPath);
      console.log('SIZE ' + size);
      process.exit(0);
    } catch (e) {
      lastErr = e;
      if (isHardWorkerError(String((e && e.message) || e))) break;
      if (attempt === 0) console.log('RETRY ' + String((e && e.message) || e).slice(0, 200));
      if (attempt === 0) await new Promise(function (r) { setTimeout(r, 800); });
    }
  }
  return fail(String(lastErr));
}
main().catch(function (e) {
  console.error('ERR fatal: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
