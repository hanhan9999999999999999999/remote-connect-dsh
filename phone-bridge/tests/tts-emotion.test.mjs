// tts.mjs 里两个纯函数的单测：cacheStemFor（缓存 key）与 planSegments（分段计划）
//
// 为什么专门测这两个：
//   cacheStemFor 错 → "同一句话换个情绪听起来还是上次那个语气"，而且只在特定句子出现，极难复现
//   planSegments 错/不确定 → synthFirst 与 synthParts 算出不一样的分段，长回复后半段错位
// 两者都不会抛错、都只在"长文本 + 情绪切换"时暴露，只能靠单测兜住。
import assert from 'node:assert';
import {
  cacheStemFor, planSegments, emotionParams, EMOTIONS, DEFAULT_EMOTION,
} from '../tts.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const V = 'zh-CN-XiaoxuanNeural';
const np = emotionParams('neutral');

console.log('--- cacheStemFor 确定性 ---');
t('同输入同 key', () => eq(cacheStemFor('你好', V, 'neutral', np), cacheStemFor('你好', V, 'neutral', np)));
t('两次调用长度都是 16', () => eq(cacheStemFor('你好', V, 'neutral', np).length, 16));

console.log('--- cacheStemFor 隔离性 ---');
t('不同情感不同 key', () => {
  assert.notStrictEqual(
    cacheStemFor('你好', V, 'neutral', np),
    cacheStemFor('你好', V, 'happy', emotionParams('happy')),
  );
});
t('同情感不同参数不同 key', () => {
  const a = cacheStemFor('你好', V, 'happy', emotionParams('happy'));
  const b = cacheStemFor('你好', V, 'happy', { rate: '-99%', pitch: '+1%', volume: '+1%' });
  assert.notStrictEqual(a, b);
});
t('不同文本不同 key', () => {
  assert.notStrictEqual(
    cacheStemFor('你好', V, 'neutral', np),
    cacheStemFor('你好呀', V, 'neutral', np),
  );
});
t('不同音色不同 key', () => {
  assert.notStrictEqual(
    cacheStemFor('你好', V, 'neutral', np),
    cacheStemFor('你好', 'zh-CN-XiaoyiNeural', 'neutral', np),
  );
});
t('中文别名与英文名得到同一 key', () => {
  // 别名在 normalizeEmotion 层解析，调用方传什么写法都应该落到同一个 emoKey 上
  assert.strictEqual(
    cacheStemFor('你好', V, 'happy', emotionParams('开心')),
    cacheStemFor('你好', V, 'happy', emotionParams('happy')),
  );
});

console.log('--- RATE_SHIFT 真的进了 key ---');
t('neutral 的 key 用的是偏移后的 rate，不是原始 default', () => {
  const shifted = cacheStemFor('测试', V, 'neutral', emotionParams('neutral'));
  const raw = cacheStemFor('测试', V, 'neutral', EMOTIONS.neutral);
  assert.notStrictEqual(shifted, raw, '若相等，说明 emotionParams 没套 RATE_SHIFT，语速偏移不生效');
});
t('emotionParams 确实改了 neutral 的 rate', () => {
  assert.notStrictEqual(emotionParams('neutral').rate, 'default');
});

console.log('--- planSegments 确定性 ---');
t('同输入两次结果完全一致', () => {
  const s = '[[开心]]太好啦！[[/开心]][[疲惫]]可是我好困……[[/疲惫]]算了，先这样。';
  eq(planSegments(s, '', 380), planSegments(s, '', 380));
});
t('长文本两次结果也一致', () => {
  const s = ('今天天气不错我们去公园散步吧。'.repeat(12)) + '哈哈真的吗！';
  eq(planSegments(s, '', 60), planSegments(s, '', 60));
});

console.log('--- planSegments 内容 ---');
t('空文本返回空数组', () => eq(planSegments('', '', 380), []));
t('纯空格返回空数组', () => eq(planSegments('   \n  ', '', 380), []));
t('无标签短句是一段 neutral', () => {
  const r = planSegments('今天天气不错。', '', 380);
  eq(r.length, 1);
  eq(r[0].emotion, 'neutral');
});
t('不同情感标签切成两段', () => {
  const r = planSegments('[[开心]]太好啦！[[/开心]][[疲惫]]可是好困。[[/疲惫]]', '', 380);
  eq(r.length, 2);
  eq(r[0].emotion, 'happy');
  eq(r[1].emotion, 'tired');
});
t('相邻同情感合并成一段', () => {
  const r = planSegments('[[开心]]太好啦！[[/开心]][[开心]]真棒。[[/开心]]', '', 380);
  eq(r.length, 1);
  eq(r[0].emotion, 'happy');
});
t('合并后文本不丢字', () => {
  const r = planSegments('[[开心]]A[[/开心]][[开心]]B[[/开心]]', '', 380);
  eq(r[0].text, 'AB');
});
t('forceEmotion 覆盖全部推断', () => {
  const r = planSegments('哈哈真的吗！唉算了……', 'gentle', 380);
  eq(r.every((x) => x.emotion === 'gentle'), true);
});
t('超长文本按 segMax 切开', () => {
  // 注意：planSegments 把 segMax 钳到最小 120（防止把段切碎、间隙比声音还多），
  // 所以这里必须用 >120 的文本、并且 segMax 传 ≥120，才能观察到切分行为
  const s = '甲'.repeat(70) + '。' + '乙'.repeat(70) + '。';   // 142 字，两句各 71 字
  const r = planSegments(s, '', 120);
  assert.ok(r.length > 1, '应被切开');
  assert.ok(r.every((x) => x.text.length <= 120), '每段不超过 segMax');
});
t('segMax 低于 120 时被钳到 120（有意为之）', () => {
  const s = '甲'.repeat(70) + '。' + '乙'.repeat(70) + '。';   // 142 字
  eq(planSegments(s, '', 10).length, planSegments(s, '', 120).length);
});
t('切开的段保持原情感', () => {
  const r = planSegments('[[开心]]' + '啊'.repeat(200) + '。[[/开心]]', '', 120);
  assert.ok(r.length > 1);
  eq(r.every((x) => x.emotion === 'happy'), true);
});
t('情感标签不会漏进待合成文本', () => {
  const s = '[[开心]]太好啦[[/开心]]';
  const r = planSegments(s, '', 380);
  assert.ok(r.every((x) => !x.text.includes('[[') && !x.text.includes(']]')), '标签残留会被念出来');
});
t('每段文本非空且已 trim', () => {
  const r = planSegments('  [[开心]]  太好啦  [[/开心]]   普通一句  ', '', 380);
  assert.ok(r.every((x) => x.text.length > 0 && x.text === x.text.trim()));
});

console.log(`\n合计 ${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
