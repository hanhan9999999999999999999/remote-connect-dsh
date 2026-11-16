/**
 * 语音识别（把手机录的话变成文字）—— 用 Windows 自带 System.Speech，离线、免费、不联网。
 *
 * 流程：手机录音(m4a/webm/wav) → ffmpeg 转 16k/单声道/16bit PCM → 固定文件 runtime/asr/input.wav
 *      → 起一个 powershell 跑 tools/asr_once.ps1 → 读 stdout 的 OK|文本。
 *
 * 为什么每次起进程而不是常驻 worker（实测结论，别改回去）：
 *   PowerShell 5.1 + System.Speech 里，只要 Recognize() 出现在 while/for 循环体内，
 *   第一次调用就报「没有将任何音频数据提供给识别器」；而进程只跑一次、Recognize 只调一次
 *   就正常。常驻进程里必然要循环 → 必然失败。代价是每次 ~2 秒启动，可以接受。
 *
 * 另外：SetInputToWaveFile 用的路径必须是脚本里的字面量，param/$env/Get-Content 都会
 * 触发同样的报错（见 asr_once.ps1 顶部注释），所以这里固定写 input.wav。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 new URL(import.meta.url).pathname —— 路径里的空格会变成 %20
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'tools', 'asr_once.ps1');
const WORK_DIR = path.join(HERE, 'runtime', 'asr');
const INPUT_WAV = path.join(WORK_DIR, 'input.wav');
// 实测结论：base 比 small 稳。small 在低信噪比中文上容易「编句子」
// （把噪声翻成训练集里的常见句），幻觉比认错字危险得多，所以留 base。
const WHISPER_MODEL = path.join(HERE, 'models', 'ggml-base.bin');
const WHISPER_TXT = 'asr.txt';                 // whisper 的输出文件（相对 WORK_DIR）
const WHISPER_VAD = path.join(HERE, 'models', 'ggml-silero.bin');
const WHISPER_MIN_BYTES = 40 * 1024 * 1024;    // 模型文件小于这个数就当没装好
// 同音/近音纠正表：whisper 对专有名词容易听岔，靠这里补回来。
// 只做「整词替换」，不碰句子结构，避免误伤。
const FIXUPS = [
  // 「大肥鱼」三个字被听岔的花样，实测过的都列上
  // 名字三种错法：大肥X（字错）、大佛X（声母错）、大飛X（拼音近）
  [/大肥[云與与羽羽玉宇雨愚魚鱼余俞佛]/g, '大肥鱼'],
  [/大佛[云魚鱼玉宇]/g, '大肥鱼'],
  [/大飛[云魚鱼宇]/g, '大肥鱼'],
  [/大肥鱼鱼/g, '大肥鱼'],
  // whisper 中文经常吐繁体，做一轮常用字收敛（只换独立字，不动词义）
  [/什麼/g, '什么'], [/這麽|這麼/g, '这么'], [/那麽|那麼/g, '那么'],
  [/說/g, '说'], [/與/g, '与'], [/現在/g, '现在'], [/時間/g, '时间'],
  [/麼/g, '么'], [/嗎/g, '吗'], [/們/g, '们'], [/這/g, '这'], [/個/g, '个'],
  [/小代码[江酱將]/g, '小代码酱'],
  [/地希|地西|D ?S ?H/g, 'DSH'],
  // whisper 会把静音/噪声翻成字幕署名，这是它训练数据带来的幻觉
  [/[(（]\s*字幕[^)）]*[)）]/g, ''],
  [/[(（][A-Za-z][^)）]{0,12}[)）]/g, ''],
  // whisper 中文会在标点后补空格，统一收拾
  [/\s+/g, ' '],
];

const MAX_BYTES = 12 * 1024 * 1024;
const CHUNK_SEC = 28;   // 单段最长秒数（System.Speech 一次 Recognize 处理不完很长的音频）
const CHUNK_MIN = 12;   // 一段最短秒数，太短会把一句话切碎
const MAX_CHUNKS = 4;   // 一次最多几段（约 110 秒），再多就让用户分次说
const PAD_MS = 120;     // 每段前后补的静音毫秒数（避免识别器卡在字的半个音上）

let busy = false;

function ffmpegBin() {
  if (process.env.PHONE_FFMPEG) return process.env.PHONE_FFMPEG;
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(base)) {
      if (!/Gyan\.FFmpeg/i.test(d)) continue;
      for (const sub of fs.readdirSync(path.join(base, d))) {
        const p = path.join(base, d, sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return 'ffmpeg';
}

function run(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd: WORK_DIR });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('处理超时'));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (err += d.toString('utf8')));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('exit', (c) => {
      clearTimeout(t);
      if (c === 0) resolve(out);
      else reject(new Error((err || out || '命令失败').trim().slice(0, 300)));
    });
  });
}

function ffmpegDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin(), ['-i', file, '-hide_banner'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('exit', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      if (!m) return resolve(0);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    p.on('error', () => resolve(0));
  });
}

/**
 * 找静音点（返回每段静音的中间时刻，秒）。
 * 靠它把长录音切在"人停下来的地方"，而不是每 28 秒一刀切在字中间。
 */
function silencePoints(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin(),
      ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'],
      { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve([]));
    p.on('exit', () => {
      const pts = [];
      const re = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
      let m;
      while ((m = re.exec(err))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) pts.push((a + b) / 2);
      }
      resolve(pts);
    });
  });
}

/** 按静音点规划切段：每段不超过 CHUNK_SEC，且尽量落在停顿处 */
function planChunks(total, points) {
  const plan = [];
  let cur = 0;
  let guard = 0;
  while (cur < total - 0.4 && guard < 20) {
    guard += 1;
    const limit = Math.min(cur + CHUNK_SEC, total);
    if (limit >= total - 0.4) { plan.push({ start: cur, dur: total - cur }); break; }
    const lo = cur + CHUNK_MIN;
    let cut = 0;
    for (const pt of points) if (pt >= lo && pt <= limit && pt > cut) cut = pt;
    const end = cut || limit;
    plan.push({ start: cur, dur: end - cur });
    cur = end;
  }
  if (!plan.length) plan.push({ start: 0, dur: total });
  return plan.filter((x) => x.dur > 0.5);
}

async function transcode(input, output, ss, dur) {
  const args = ['-y', '-loglevel', 'error'];
  if (ss) args.push('-ss', String(ss));
  if (dur) args.push('-t', String(dur));
  args.push(
    '-i', input,
    '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
    // 前后各补一点静音：切点即使落在半个字上，识别器也有完整的起止
    '-af', `adelay=${PAD_MS}|${PAD_MS},apad=pad_dur=0.15`,
    // 关键：不带这两个参数会留 LIST/INFO 块，System.Speech 会拒绝解析
    '-map_metadata', '-1', '-fflags', '+bitexact', '-f', 'wav', output,
  );
  await run(ffmpegBin(), args, 60000);
}


/** whisper 的路子：ffmpeg 自带滤镜，模型缺失就返回 null 让调用方回退。 */

/**
 * 拼 whisper 滤镜串。
 * VAD 很关键：没有它，静音段会被「听」成字（实测出现过一个孤零零的「媽」，
 * 以及 (字幕:J Chong) 这种把噪声翻成字幕署名的幻觉）。
 */
function whisperFilter() {
  const esc = (p) => "'" + p.replace(/\\/g, '/').replace(/:/g, '\\:') + "'";
  let af = 'whisper=model=' + esc(WHISPER_MODEL) + ':language=zh';
  if (fs.existsSync(WHISPER_VAD) && fs.statSync(WHISPER_VAD).size > 500 * 1024) {
    af += ':vad_model=' + esc(WHISPER_VAD) + ':vad_threshold=0.5';
  }
  af += ':destination=' + WHISPER_TXT + ':format=text';
  return af;
}

async function transcribeWhisper() {
  try {
    if (!fs.existsSync(WHISPER_MODEL)) return null;
    if (fs.statSync(WHISPER_MODEL).size < WHISPER_MIN_BYTES) return null;
    const outPath = path.join(WORK_DIR, WHISPER_TXT);
    try { fs.unlinkSync(outPath); } catch {}
    // ffmpeg 滤镜里的路径要转义：反斜杠换正斜杠，冒号前加反斜杠，整体用单引号包住
    const modelArg = "'" + WHISPER_MODEL.replace(/\\/g, '/').replace(/:/g, '\\:') + "'";
    await run(
      ffmpegBin(),
      [
        '-y', '-loglevel', 'error',
        '-i', path.basename(INPUT_WAV),
        '-af', whisperFilter(),
        '-f', 'null', '-',
      ],
      180000,
    );
    if (!fs.existsSync(outPath)) return null;
    const text = fs.readFileSync(outPath, 'utf8').trim();
    try { fs.unlinkSync(outPath); } catch {}
    return text || null;
  } catch {
    return null;
  }
}

/** 同音词纠正。 */
function applyFixups(text) {
  let out = String(text || '');
  for (const [re, to] of FIXUPS) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').replace(/ ?([,.!?]) ?/g, '$1').trim();
}


/** 把一段音频转成文字。audio: Buffer；ext: m4a/webm/wav/ogg */
export async function transcribe(audio, ext = 'm4a') {
  if (!Buffer.isBuffer(audio) || audio.length < 400) throw new Error('录音太短了，再说一次？');
  if (audio.length > MAX_BYTES) throw new Error('录音太大了（超过 12MB）');
  if (busy) throw new Error('上一个录音还在识别，稍等一下');
  busy = true;
  const t0 = Date.now();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const src = path.join(WORK_DIR, 'source.' + (String(ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'));
  try {
    fs.writeFileSync(src, audio);
    const total = await ffmpegDuration(src);
    let plan = [{ start: 0, dur: 0 }];
    if (total > CHUNK_SEC) {
      plan = planChunks(total, await silencePoints(src));
      if (plan.length > MAX_CHUNKS) {
        throw new Error(`这条录音有 ${Math.round(total)} 秒，一次最多认 ${MAX_CHUNKS * CHUNK_SEC} 秒左右，分两次说？`);
      }
    }
    const texts = [];
    let engine = '';
    for (const seg of plan) {
      await transcode(src, INPUT_WAV, seg.start, seg.dur);
      if (!fs.existsSync(INPUT_WAV) || fs.statSync(INPUT_WAV).size < 1000) {
        if (plan.length > 1) continue;   // 多段时某段没声音，跳过继续
        throw new Error('这段录音里没有声音');
      }
      // 先走 whisper，不行再回退 System.Speech
      let piece = await transcribeWhisper();
      if (piece) {
        engine = 'whisper';
        piece = applyFixups(piece);
      } else {
        engine = 'system-speech';
        const out = await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
          90000,
        );
        const line = out.split(/\r?\n/).find((l) => /^(OK|ERR)\|/.test(l)) || '';
        if (line.startsWith('ERR|')) throw new Error(line.slice(4).trim() || '识别失败');
        piece = applyFixups(line.slice(3).trim());
      }
      if (piece) texts.push(piece);
    }
    return { text: texts.join('').trim(), ms: Date.now() - t0, chunks: plan.length, total: Math.round(total), engine: engine || 'system-speech' };
  } finally {
    busy = false;
    try { fs.unlinkSync(src); } catch {}
    try { fs.unlinkSync(INPUT_WAV); } catch {}
  }
}

export function status() {
  let whisper = false;
  try {
    whisper = fs.existsSync(WHISPER_MODEL) && fs.statSync(WHISPER_MODEL).size >= WHISPER_MIN_BYTES;
  } catch {}
  let vad = false;
  try {
    vad = fs.existsSync(WHISPER_VAD) && fs.statSync(WHISPER_VAD).size > 500 * 1024;
  } catch {}
  return {
    busy,
    script: SCRIPT,
    engine: whisper ? 'whisper' : 'system-speech',
    whisper,
    vad,
    model: path.basename(WHISPER_MODEL),
    ffmpeg: ffmpegBin(),
  };
}
