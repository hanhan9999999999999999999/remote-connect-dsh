#!/usr/bin/env node
// 语音输出工具（轻量版：只保留 Edge 在线合成 + Windows SAPI 离线兜底）
//
//   node tools/voice/say.mjs --text "主人，我回来啦"            # 默认晓萱音色，mp3 落到 voice-out/
//   node tools/voice/say.mjs --text "..." --out voice-out/a.mp3
//   node tools/voice/say.mjs --text "哼，才不是为你" --emotion 傲娇   # 指定语气
//   node tools/voice/say.mjs --text "太好了！" --emotion auto        # 按措辞自动猜
//   echo "长文本" | node tools/voice/say.mjs
//   node tools/voice/say.mjs --engine sapi --text "离线兜底"    # 本机 Huihui，无网也能响，输出 wav
//   node tools/voice/say.mjs --list-voices
//
// 引擎：
//   edge  —— 微软 Edge TTS 在线合成（默认 zh-CN-XiaoxuanNeural 晓萱），mp3，音质最好
//   sapi  —— Windows System.Speech 本机合成（默认 Microsoft Huihui Desktop），wav，断网可用
//
// 情感：Edge 免费端点实测会硬拒 mstts:express-as（整条 SSML 判 invalid，见 emotion.mjs 头注释），
// 所以「语气」只能做到语速/音高/音量这一层。三档参数表与手机端共用同一个 emotion.mjs，
// 保证「同一句话，电脑端和手机端听起来是同一个语气」。
//
// 实现说明：edge 走 edge-worker.cjs（从 @memef1f1y/dsh-plugin-tts 的 lib/index.mjs 里抽出来的
// 零依赖 worker，Sec-MS-GEC v2 协议），文本从 stdin 传入，避免命令行编码问题。
// 已知小毛病：Edge 首次请求偶发 websocket 1006 或 audio too small: 0，重跑一次即可。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EMOTIONS, DEFAULT_EMOTION, emotionParams, inferEmotion, segmentByEmotion, stripEmotionTags, normalizeEmotion } from './emotion.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'edge-worker.cjs');

const VOICES = {
  'zh-CN-XiaoxuanNeural': '晓萱 · 女声，温柔（默认，鲸鱼音色就用的这个）',
  'zh-CN-XiaoxiaoNeural': '晓晓 · 女声，清亮',
  'zh-CN-XiaoyiNeural': '晓伊 · 女声，活泼',
  'zh-CN-YunxiNeural': '云希 · 男声，年轻',
  'zh-CN-YunyangNeural': '云扬 · 男声，播报',
  'en-US-AriaNeural': 'Aria · 英语女声',
  'ja-JP-NanamiNeural': '七海 · 日本語',
};

function parseArgs(argv) {
  // rate/pitch/volume 故意不给默认值：要能区分「没传」和「传了 default」，
  // 这样 --emotion 给的参数才不会把用户显式写的 --rate 覆盖掉。
  const out = { engine: 'edge', voice: 'zh-CN-XiaoxuanNeural' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--text': out.text = next(); break;
      case '--file': out.file = next(); break;
      case '--out': out.out = next(); break;
      case '--voice': out.voice = next(); break;
      case '--rate': out.rate = next(); break;
      case '--pitch': out.pitch = next(); break;
      case '--volume': out.volume = next(); break;
      case '--emotion': out.emotion = next(); break;
      case '--engine': out.engine = next(); break;
      case '--list-voices': out.listVoices = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(2); }
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

function defaultOut(engine) {
  const dir = path.join(process.cwd(), 'voice-out');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = engine === 'edge' ? 'mp3' : 'wav';
  return path.join(dir, `voice-${stamp}.${ext}`);
}

function runEdge(text, opt, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, '--', opt.voice, opt.rate, opt.pitch, opt.volume], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('合成超时（>50s）')); }, 50000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = /^OK (.+)$/m.exec(stdout);
      if (code === 0 && ok) {
        const produced = ok[1].trim();
        mkdirSync(path.dirname(outPath), { recursive: true });
        copyFileSync(produced, outPath);
        resolve(outPath);
      } else {
        reject(new Error(`worker 失败(code=${code}): ${(stderr || stdout).trim().slice(0, 400)}`));
      }
    });
    child.stdin.end(text, 'utf8');
  });
}

function runSapi(text, outPath) {
  // 文本走临时文件，避免命令行转义；SAPI 只能输出 wav
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = path.join(os.tmpdir(), `voice-${Date.now()}.txt`);
  writeFileSync(tmp, text, 'utf8');
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    'try { $s.SelectVoice("Microsoft Huihui Desktop") } catch {}',
    `$s.SetOutputToWaveFile(${JSON.stringify(outPath)});`,
    `$s.Speak([System.IO.File]::ReadAllText(${JSON.stringify(tmp)}, [System.Text.Encoding]::UTF8));`,
    '$s.Dispose();',
  ].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => {
      if (code === 0 && existsSync(outPath) && statSync(outPath).size > 1000) resolve(outPath);
      else reject(new Error(`SAPI 失败(code=${code}): ${err.slice(0, 300)}`));
    });
  });
}

const opt = parseArgs(process.argv.slice(2));

if (opt.help) {
  console.log(`
用法：node tools/voice/say.mjs [选项]

  --text <文本>    要朗读的内容
  --file <path>    从文件读取文本
  --out <path>     输出路径（默认 voice-out/voice-<时间>.mp3）
  --voice <name>   Edge 音色，默认 zh-CN-XiaoxuanNeural（--list-voices 查看）
  --rate/--pitch/--volume  例如 +10% / -5% ；默认 default
  --emotion <语气>  按语气自动配语速/音高/音量。可用：
                    ${Object.keys(EMOTIONS).join(' / ')}
                    写 auto = 按措辞自动猜；写中文别名也行（开心/傲娇/温柔/生气…）
                    不写这个参数 = 一字不改的老行为
  --engine edge|sapi        edge=在线高质量 mp3（默认），sapi=本机离线 wav
  --list-voices    列出常用音色

  Edge 免费端点实测硬拒 express-as（整条 SSML 判 invalid），所以「语气」是语速+音高+音量
  这一层的模拟，不是微软原生的情感风格。想听差别明显的，试 happy / tired 这两个。
`);
  process.exit(0);
}

if (opt.listVoices) {
  for (const [id, desc] of Object.entries(VOICES)) console.log(`${id}  ${desc}`);
  process.exit(0);
}

let text = opt.text;
if (opt.file) text = readFileSync(opt.file, 'utf8');
if (!text) text = await readStdin();
text = String(text || '').trim();

// 情感标签：文本里写了 [[开心]]…[[/开心]] 就把标签剥掉（朗读不该念出标签本身），
// 并把第一个标签当成这次的语气。显式 --emotion 仍然优先于标签。
const segs0 = segmentByEmotion(text);
const tagHit = segs0.find((s) => s.explicit);
if (tagHit) text = stripEmotionTags(text).trim();

if (!text) {
  console.error('没有要朗读的文本（用 --text / --file / 管道）');
  process.exit(2);
}

// 语气决定顺序：--emotion 显式 > 文本内标签 > 不处理。
// 注意「不处理」必须是真的不改任何参数——老调用方（插件、脚本）的命令行里没有 --emotion，
// 它们的行为要和一个字都没改之前逐字节一致。所以这里不做自动推断，除非明确写 --emotion auto。
let emoKey = null;
if (opt.emotion === 'auto') emoKey = inferEmotion(text);
else if (opt.emotion) emoKey = normalizeEmotion(opt.emotion) || null;
else if (tagHit) emoKey = tagHit.emotion;

if (opt.emotion && opt.emotion !== 'auto' && !emoKey) {
  console.error(`未知语气: ${opt.emotion}（可用：${Object.keys(EMOTIONS).join(' / ')}，或 auto）`);
  process.exit(2);
}

const emoP = emoKey ? emotionParams(emoKey) : null;
// 显式写的 --rate/--pitch/--volume 永远压过语气给的值
opt.rate = opt.rate ?? (emoP ? emoP.rate : 'default');
opt.pitch = opt.pitch ?? (emoP ? emoP.pitch : 'default');
opt.volume = opt.volume ?? (emoP ? emoP.volume : 'default');
if (emoP) opt.emotionResolved = emoKey;

const outPath = path.resolve(opt.out || defaultOut(opt.engine));

try {
  let finalPath;
  if (opt.engine === 'sapi') finalPath = await runSapi(text, outPath);
  else finalPath = await runEdge(text, opt, outPath);
  console.log(finalPath);
} catch (e) {
  console.error('合成失败: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}
