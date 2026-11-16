// 情感 → 语音参数（Edge TTS 的 prosody 三件套：rate / pitch / volume，外加停顿与切分粒度）
//
// 为什么只做 prosody：Edge 免费端点实测会在 SSML 解析阶段硬拒 mtts 的扩展标记。
//   · mstts:express-as → code=1007 "SSML is invalid"（合法 style 与瞎写 style 同错 = 元素级拒绝）
//   · <break time="200ms"/> → 同样 1007，连停顿都不给
//  （见 tools/voice/_probe-* 与 tmp/probe-style.mjs、tmp/probe-break.mjs 的实测记录）
// 所以「情感」在这套引擎里只能落到四个维度上：
//   rate / pitch / volume —— 音色本身的快慢高低轻重
//   gap                  —— 段与段之间停多久（前端播完一段等一下再播下一段；SSML 不给就自己造）
//   segMax               —— 一口气说多长才断开（疲惫的人说不了长句，兴奋的人一长串不带喘）
// 后两个是「听起来像真人」的关键：光调快慢仍然像机器，断句的节奏才像呼吸。
//
// 三个入口：
//   1) 显式标注：[[开心]]…[[/开心]] / [[撒娇:1.4]]，优先级最高
//   2) 整体指定：调用方传 forceEmotion
//   3) 自动推断：没标注时按措辞、标点、emoji 猜（规则保守，拿不准就 neutral，宁可平一点也不要尬）
//
// 重要：参数一旦变化，音频就变了。任何缓存 key 都必须把参数指纹算进去，
// 否则「同一句、不同情绪」会互相命中缓存，表现是播放出来永远只有第一次那个语气，极难排查。

/**
 * 每一档的三件事：
 *   rate/pitch/volume —— 送进 SSML prosody 的百分比（'default' = 不动）
 *   gap               —— 这一段说完停多少毫秒（0–600 之间才合理，太长会像卡带）
 *   segMax            —— 这一档一口气最多说多少字再断开
 * 数值不是拍脑袋：围绕中性档上下摆，越大越极端，靠近的几档刻意留出可辨识但不夸张的差。
 */
export const EMOTIONS = {
  // ---- 基线 ----
  neutral:   { label: '平静', rate: 'default', pitch: 'default', volume: 'default', gap: 90, segMax: 380 },

  // ---- 正向 ----
  happy:     { label: '开心', rate: '+12%', pitch: '+8%',  volume: '+5%',  gap: 80,  segMax: 380 },
  excited:   { label: '兴奋', rate: '+18%', pitch: '+12%', volume: '+10%', gap: 50,  segMax: 460 },
  playful:   { label: '俏皮', rate: '+10%', pitch: '+9%',  volume: '+4%',  gap: 80,  segMax: 400 },
  proud:     { label: '得意', rate: '+2%',  pitch: '+7%',  volume: '+7%',  gap: 110, segMax: 380 },
  grateful:  { label: '感谢', rate: '-2%',  pitch: '+5%',  volume: '-2%',  gap: 130, segMax: 360 },

  // ---- 亲昵 ----
  gentle:    { label: '温柔', rate: '-12%', pitch: '+4%',  volume: '-6%',  gap: 150, segMax: 340 },
  coaxing:   { label: '撒娇', rate: '-14%', pitch: '+10%', volume: '-8%',  gap: 170, segMax: 320 },
  shy:       { label: '害羞', rate: '-8%',  pitch: '+9%',  volume: '-14%', gap: 180, segMax: 300 },
  tsundere:  { label: '傲娇', rate: '+8%',  pitch: '+2%',  volume: '+8%',  gap: 110, segMax: 360 },

  // ---- 调侃 ----
  teasing:   { label: '调侃', rate: '-3%',  pitch: '-5%',  volume: 'default', gap: 120, segMax: 360 },

  // ---- 负向 ----
  sad:       { label: '低落', rate: '-18%', pitch: '-8%',  volume: '-10%', gap: 260, segMax: 260 },
  wronged:   { label: '委屈', rate: '-16%', pitch: '-6%',  volume: '-16%', gap: 240, segMax: 280 },
  helpless:  { label: '无奈', rate: '-10%', pitch: '-3%',  volume: '-8%',  gap: 200, segMax: 320 },
  tired:     { label: '疲惫', rate: '-20%', pitch: '-12%', volume: '-8%',  gap: 300, segMax: 240 },
  sleepy:    { label: '困倦', rate: '-26%', pitch: '-14%', volume: '-16%', gap: 360, segMax: 220 },
  cold:      { label: '冷淡', rate: '-8%',  pitch: '-5%',  volume: '-12%', gap: 170, segMax: 340 },

  // ---- 张力 ----
  angry:     { label: '生气', rate: '+14%', pitch: '+6%',  volume: '+12%', gap: 70,  segMax: 380 },
  surprised: { label: '惊讶', rate: '+16%', pitch: '+14%', volume: '+8%',  gap: 60,  segMax: 420 },
  worried:   { label: '担心', rate: '+6%',  pitch: '+6%',  volume: '-4%',  gap: 130, segMax: 340 },
  nervous:   { label: '紧张', rate: '+12%', pitch: '+7%',  volume: '+3%',  gap: 90,  segMax: 380 },
  curious:   { label: '好奇', rate: '+8%',  pitch: '+8%',  volume: '+2%',  gap: 100, segMax: 380 },
  serious:   { label: '认真', rate: '-6%',  pitch: '-2%',  volume: '+2%',  gap: 130, segMax: 400 },
};

export const DEFAULT_EMOTION = 'neutral';

// 全局语速偏移（百分点）。主人反馈「手机端语速有点小快」→ 所有情绪统一往慢处挪，
// 只改这一处：平静档从 1.0x 变成 0.92x，开心/兴奋档也不再飚得太快。
export const RATE_SHIFT = -8;

/** 把 'default' / '+12%' / '-3%' 统一换算成偏移后的百分比串，保证缓存 key 跟着变 */
export function shiftRate(rate) {
  return scalePct(rate, 1, RATE_SHIFT);
}

/** 按强度缩放百分比（'default' 视为 0%，但只要全局语速偏移非零，它也要跟着挪） */
function scalePct(pct, intensity, shift) {
  const s = String(pct == null ? 'default' : pct).trim();
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(s);
  const sh = shift || 0;
  if (!m) {
    if (!sh) return s;
    const out = Math.round(sh * 10) / 10;
    return (out >= 0 ? '+' : '') + out + '%';
  }
  const base = Number(m[1]) * (intensity == null ? 1 : intensity);
  const out = Math.round((base + sh) * 10) / 10;
  return (out >= 0 ? '+' : '') + out + '%';
}

/** 强度只接受 0.4–2.0，NaN/负数/离谱值一律夹回来 */
function clampIntensity(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(2, Math.max(0.4, n));
}

/** 百分比夹在区间里：极端档位再乘强度会失控（疲惫 -20% ×1.6 再叠全局慢速就念不动了） */
function clampPct(pct, lo, hi) {
  const s = String(pct == null ? 'default' : pct).trim();
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(s);
  if (!m) return s;
  const v = Math.min(hi, Math.max(lo, Number(m[1])));
  const out = Math.round(v * 10) / 10;
  return (out >= 0 ? '+' : '') + out + '%';
}

// 中文别名 → 规范名。我写语音文案时随手用哪个都认。
const ALIASES = {
  平静: 'neutral', 普通: 'neutral', 正常: 'neutral', 淡淡: 'neutral', 平淡: 'neutral',
  开心: 'happy', 高兴: 'happy', 愉快: 'happy', 欢快: 'happy', 明朗: 'happy',
  兴奋: 'excited', 激动: 'excited', 雀跃: 'excited',
  俏皮: 'playful', 调皮: 'playful', 活泼: 'playful', 逗: 'playful',
  得意: 'proud', 骄傲: 'proud', 显摆: 'proud', 神气: 'proud',
  感谢: 'grateful', 谢谢: 'grateful', 感动: 'grateful', 感激: 'grateful',
  温柔: 'gentle', 轻声: 'gentle', 柔和: 'gentle', 体贴: 'gentle', 暖暖: 'gentle',
  撒娇: 'coaxing', 黏人: 'coaxing', 软软: 'coaxing', 赖: 'coaxing', 嘟嘟: 'coaxing',
  害羞: 'shy', 脸红: 'shy', 不好意思: 'shy', 羞: 'shy',
  傲娇: 'tsundere', 别扭: 'tsundere', 嘴硬: 'tsundere', 哼哼: 'tsundere',
  调侃: 'teasing', 坏笑: 'teasing', 打趣: 'teasing', 揶揄: 'teasing',
  低落: 'sad', 难过: 'sad', 伤心: 'sad', 失落: 'sad', 沮丧: 'sad',
  委屈: 'wronged', 不公: 'wronged', 想哭: 'wronged', 可怜: 'wronged',
  无奈: 'helpless', 叹气: 'helpless', 没办法: 'helpless', 摊手: 'helpless',
  疲惫: 'tired', 累: 'tired', 懒: 'tired', 乏力: 'tired', 精疲力尽: 'tired',
  困倦: 'sleepy', 困: 'sleepy', 想睡: 'sleepy', 迷糊: 'sleepy', 朦胧: 'sleepy',
  冷淡: 'cold', 冷漠: 'cold', 疏离: 'cold', 平静无波: 'cold',
  生气: 'angry', 恼: 'angry', 赌气: 'angry', 火大: 'angry', 凶: 'angry',
  惊讶: 'surprised', 吃惊: 'surprised', 震惊: 'surprised', 意外: 'surprised',
  担心: 'worried', 忧虑: 'worried', 不安: 'worried', 着急: 'worried',
  紧张: 'nervous', 慌: 'nervous', 心跳: 'nervous',
  好奇: 'curious', 疑问: 'curious', 探究: 'curious',
  认真: 'serious', 严肃: 'serious', 正经: 'serious', 郑重: 'serious',
};

/** 把任意写法（英文名 / 中文别名 / 大小写混乱）规范化成 EMOTIONS 的 key，认不出返回 null */
export function normalizeEmotion(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (EMOTIONS[low]) return low;
  if (ALIASES[raw]) return ALIASES[raw];
  return null;
}

/**
 * 解析标签里的写法：'开心' / '开心:1.5' / 'happy:0.7'
 * @returns {{key:string|null, intensity:number}}
 */
export function parseEmotionSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return { key: null, intensity: 1 };
  const m = /^([^:：]+)[:：]\s*([0-9]*\.?[0-9]+)\s*$/.exec(raw);
  if (m) return { key: normalizeEmotion(m[1]), intensity: clampIntensity(m[2]) };
  return { key: normalizeEmotion(raw), intensity: 1 };
}

/**
 * 取某情感的实际参数。未知情感回落 neutral（不抛错，语音宁可平也不能不出声）。
 * gap / segMax 也跟着强度走：情绪越强，断得越碎（疲惫）/ 连得越长（兴奋）。
 */
export function emotionParams(name, intensity) {
  const k = normalizeEmotion(name) || DEFAULT_EMOTION;
  const p = EMOTIONS[k];
  const it = clampIntensity(intensity);
  // 强度不按比例线性放大：1.6 倍就乘 1.6 的话，疲惫档会直接慢到念不动。
  // 用「超出 1 的部分只算六成」，听感上够拉开，又不至于失真。
  const eff = 1 + (it - 1) * 0.6;
  return {
    key: k,
    label: p.label,
    rate: clampPct(scalePct(p.rate, eff, RATE_SHIFT), -30, 30),
    pitch: clampPct(scalePct(p.pitch, eff, 0), -18, 20),
    volume: clampPct(scalePct(p.volume, eff, 0), -24, 24),
    gap: Math.round(Math.min(600, (p.gap == null ? 90 : p.gap) * (0.6 + 0.4 * it))),
    segMax: p.segMax == null ? 380 : p.segMax,
    intensity: it,
  };
}

/** 参数指纹：缓存 key 必须带上它，否则不同情绪（含不同强度）串味 */
export function emotionKey(name, intensity) {
  const p = emotionParams(name, intensity);
  return [p.key, p.rate, p.pitch, p.volume, p.intensity].join('~');
}

// ---- 文本推断 ----
// 规则顺序有意义：先看强信号（emoji、多个感叹号、明确情绪词），再看弱信号（尾缀、省略号），最后才 neutral。
// 每条规则都要求「命中位置靠近句尾」或「有明确标记」，避免把陈述句里的『累』当成疲惫。

const RULES = [
  // emoji 是最强的显式信号：人发 emoji 的时候情绪是明确的
  { e: 'surprised', re: /(😱|😲|😮|🤯|⁉️|❓❗)/u },
  { e: 'wronged', re: /(🥺|😭|🥹|💔)/u },
  { e: 'angry', re: /(😡|🤬|💢|😤)/u },
  { e: 'sleepy', re: /(😴|🥱|💤)/u },
  { e: 'shy', re: /(😳|😊|🙈|☺️)/u },
  { e: 'coaxing', re: /(🥰|😘|💗|💕|🤗)/u },
  { e: 'excited', re: /(🎉|🔥|✨|💯)/u },
  { e: 'sad', re: /(😢|😔|😞|🌧)/u },

  // 措辞
  { e: 'excited', re: /(太棒了|真的假的|天啊|天哪|太好了|耶+|哇+|冲鸭|绝了)/ },
  { e: 'angry', re: /(气死|讨厌|烦死|够了|别这样|生气了|谁准你)/ },
  // 注意顺序：『哼』归傲娇不归生气 —— 这是人设里最高频的语气，判成生气会立刻出戏
  { e: 'tsundere', re: /(才不|才没|随便你|管你|谁要|哼|别自作多情|不关我事)/ },
  // 撒娇：叠字 + 语气词，主人最吃这一套
  { e: 'coaxing', re: /(嘛[~～]*$|嘛嘛|好不好嘛|抱抱|亲亲|要嘛|人家|就一次|就一下)/ },
  { e: 'shy', re: /(害羞|脸红|别看|不许看|讨厌啦)/ },
  { e: 'happy', re: /(哈哈|嘿嘿|嘻嘻|笑死|开心|高兴|好呀|好啊|可以呀)/ },
  { e: 'surprised', re: /(诶[？?！!]|啊[？?]|真的吗|你居然|竟然|怎么会|不会吧)/ },
  { e: 'curious', re: /(为什么|怎么弄|是什么|哪来的|讲讲|说说看)/ },
  { e: 'worried', re: /(你还好吗|没事吧|要不要紧|当心|别熬夜|别太晚|小心点)/ },
  { e: 'grateful', re: /(谢谢你|谢谢|多亏|幸好有你|辛苦你了)/ },
  { e: 'proud', re: /(我就说|怎么样|服了吧|厉害吧|当然啦|小意思)/ },
  { e: 'wronged', re: /(凭什么|我又没|明明是|不是我|冤枉)/ },
  { e: 'sad', re: /(算了|可惜|难过|失落|伤心|想哭|孤单|舍不得|没关系)/ },
  { e: 'helpless', re: /(随便吧|没办法|反正|无所谓|摊手)/ },
  { e: 'tired', re: /(好累|累了|累死|熬不动|撑不住)/ },
  // gentle 排在 sleepy 之前：「晚安，早点休息」是叮嘱不是困，别把关心念成打瞌睡
  { e: 'gentle', re: /(早点休息|注意身体|慢慢来|别急|我陪你|摸摸头|乖乖)/ },
  { e: 'sleepy', re: /(好困|困了|想睡|睡觉了|晚安|睁不开眼)/ },
  { e: 'nervous', re: /(怎么办|来不及|完了完了|紧张|心跳得)/ },
  { e: 'serious', re: /(说正经的|认真说|记住|必须|一定要|这条重要)/ },
  { e: 'cold', re: /(随你|不必|不需要|没什么好说|就这样吧)/ },
  { e: 'teasing', re: /(是吗|哦[？?]|呵|你确定|猜猜|不告诉你|嘻嘻$)/ },
];

/**
 * 从一句话猜情感。
 * @param {string} text 单句文本（不含情感标签）
 * @returns {string} EMOTIONS 的 key
 */
export function inferEmotion(text) {
  const s = String(text || '').trim();
  if (!s) return DEFAULT_EMOTION;

  // 强信号：连喊（两个以上感叹号）比任何词都说明情绪浓度
  const bangs = (s.match(/[！!]/g) || []).length;
  if (bangs >= 2) return 'excited';

  for (const r of RULES) {
    if (r.re.test(s)) return r.e;
  }

  // 弱信号：句尾省略号 → 欲言又止。短句给一点温柔，长句保持中性别加戏
  if (/[……]$/.test(s) || /\.{3,}$/.test(s)) {
    return s.length <= 24 ? 'gentle' : DEFAULT_EMOTION;
  }

  // 纯问句、陈述句：不加戏
  return DEFAULT_EMOTION;
}

/**
 * 把一段带标签的文本切成 [{text, emotion, intensity}]。
 * 标签写法：[[开心]]文字[[/开心]]、[[开心:1.5]]文字、[[开心]]文字（到段尾）
 * 没写标签的片段走 inferEmotion。
 *
 * @param {string} text
 * @param {string} [forceEmotion] 整体强制情感（相当于给整段套一个标签），优先级高于自动推断
 * @returns {{text:string, emotion:string, intensity:number, explicit:boolean}[]}
 */
export function segmentByEmotion(text, forceEmotion) {
  const src = String(text || '');
  const forcedSpec = parseEmotionSpec(forceEmotion);
  const forced = forcedSpec.key;
  const forcedIt = forcedSpec.intensity;
  const out = [];
  // 标签名放宽到「非 ]] 即可」，好让 [[开心:1.4]] 这种带强度的写法也能被识别
  const re = /\[\[\s*([^\[\]]+?)\s*\]\]([\s\S]*?)(?:\[\[\s*\/\s*[^\[\]]+?\s*\]\]|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const plain = src.slice(last, m.index);
      if (plain.trim()) {
        out.push({ text: plain, emotion: forced || inferEmotion(plain), intensity: forced ? forcedIt : 1, explicit: !!forced });
      }
    }
    const spec = parseEmotionSpec(m[1]);
    const body = m[2];
    if (body.trim()) {
      out.push({
        text: body,
        emotion: forced || spec.key || inferEmotion(body),
        intensity: forced ? forcedIt : spec.intensity,
        explicit: true,
      });
    }
    last = re.lastIndex;
  }
  if (last < src.length) {
    const plain = src.slice(last);
    if (plain.trim()) {
      out.push({ text: plain, emotion: forced || inferEmotion(plain), intensity: forced ? forcedIt : 1, explicit: !!forced });
    }
  }
  if (out.length === 0) out.push({ text: src, emotion: forced || DEFAULT_EMOTION, intensity: forced ? forcedIt : 1, explicit: !!forced });
  return out;
}

/** 去掉文本里的情感标签（只给需要纯文本的地方用，比如日志、聊天记录落库） */
export function stripEmotionTags(text) {
  return String(text || '')
    .replace(/\[\[\s*[^\[\]]+?\s*\]\]/g, '')
    .replace(/\[\[\s*\/\s*[^\[\]]+?\s*\]\]/g, '');
}

/** 给 UI / 文档用：一览表（含中文别名里最常用的那个当提示） */
export function emotionCatalog() {
  return Object.keys(EMOTIONS).map((k) => {
    const p = emotionParams(k);
    return { key: k, label: p.label, rate: p.rate, pitch: p.pitch, volume: p.volume, gap: p.gap, segMax: p.segMax };
  });
}
