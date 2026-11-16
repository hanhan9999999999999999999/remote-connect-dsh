// emotion.mjs 单测：规范化、推断、标签切分、缓存指纹
import assert from 'node:assert';
import {
  EMOTIONS, DEFAULT_EMOTION, normalizeEmotion, emotionParams, emotionKey, shiftRate,
  inferEmotion, segmentByEmotion, stripEmotionTags,
} from '../../tools/voice/emotion.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

console.log('--- normalizeEmotion ---');
t('中文别名', () => eq(normalizeEmotion('开心'), 'happy'));
t('英文原名', () => eq(normalizeEmotion('tsundere'), 'tsundere'));
t('大小写', () => eq(normalizeEmotion('HAPPY'), 'happy'));
t('带空格', () => eq(normalizeEmotion('  撒娇  '), 'coaxing')); // 撒娇已独立成档（2026-11-01）
t('认不出返回 null', () => eq(normalizeEmotion('胡说八道'), null));
t('空值', () => eq(normalizeEmotion(''), null));
t('null', () => eq(normalizeEmotion(null), null));

console.log('--- emotionParams / 回落 ---');
t('未知情感回落 neutral', () => eq(emotionParams('不存在').rate, emotionParams('neutral').rate));
t('undefined 回落 neutral', () => eq(emotionParams(undefined).label, '平静'));
t('傲娇参数', () => eq(emotionParams('傲娇').rate, shiftRate(EMOTIONS.tsundere.rate)));

console.log('--- emotionKey 指纹 ---');
t('不同情感不同 key', () => {
  assert.notStrictEqual(emotionKey('happy'), emotionKey('sad'));
});
t('同情感写法不同但 key 相同', () => eq(emotionKey('开心'), emotionKey('happy')));
t('neutral 与空等价', () => eq(emotionKey(''), emotionKey('neutral')));

console.log('--- inferEmotion ---');
const cases = [
  ['哼，才不是为你呢', 'tsundere'],
  ['随便你啦', 'tsundere'],
  ['哈哈，真的吗', 'excited'],          // 『真的假的/太棒了』类先命中；这里靠哈哈→happy？见下
  ['太好了吧', 'excited'],
  ['唉，算了没关系', 'sad'],
  ['好困，想睡觉了', 'sleepy'], // 困倦与疲惫分开了
  ['晚安，早点休息', 'gentle'], // 叮嘱不是困
  ['慢慢来，别急', 'gentle'],
  ['我明天去公司开会', 'neutral'],
  ['这个函数返回 undefined', 'neutral'],
  ['你确定吗？', 'teasing'],
  ['真的吗！！！', 'excited'],
  ['气死了，烦死', 'angry'],
];
for (const [text, want] of cases) {
  t(`推断「${text}」→ ${want}`, () => {
    const got = inferEmotion(text);
    // 『哈哈，真的吗』既像 happy 又像 excited，接受两者之一
    if (text === '哈哈，真的吗') assert.ok(got === 'happy' || got === 'excited', '实际 ' + got);
    else eq(got, want, `实际 ${got}`);
  });
}
t('空串→neutral', () => eq(inferEmotion(''), 'neutral'));

console.log('--- segmentByEmotion ---');
t('单标签', () => {
  const segs = segmentByEmotion('[[撒娇]]哼，才不[[/撒娇]]');
  eq(segs.length, 1);
  eq(segs[0].emotion, 'coaxing'); // 撒娇独立成档（2026-11-01 扩充情绪表）
  eq(segs[0].text, '哼，才不');
});
t('标签 + 普通文本混合', () => {
  const segs = segmentByEmotion('[[开心]]太好了[[/开心]]我明天去公司');
  eq(segs.length, 2);
  eq(segs[0].emotion, 'happy');
  eq(segs[0].text, '太好了');
  eq(segs[1].emotion, 'neutral');
  eq(segs[1].text, '我明天去公司');
});
t('未闭合标签吃到段尾', () => {
  const segs = segmentByEmotion('先说正事[[温柔]]然后我陪你');
  eq(segs.length, 2);
  eq(segs[1].emotion, 'gentle');
  eq(segs[1].text, '然后我陪你');
});
t('强制情感覆盖推断', () => {
  const segs = segmentByEmotion('哼，才不是为你', 'happy');
  eq(segs[0].emotion, 'happy');
});
t('无标签纯文本走推断', () => {
  const segs = segmentByEmotion('唉，算了吧');
  eq(segs[0].emotion, 'sad');
});
t('空文本也有兜底', () => {
  const segs = segmentByEmotion('');
  eq(segs.length, 1);
  eq(segs[0].emotion, DEFAULT_EMOTION);
});

console.log('--- stripEmotionTags ---');
t('去掉成对标签', () => eq(stripEmotionTags('[[开心]]太好了[[/开心]]'), '太好了'));
t('去掉未闭合标签', () => eq(stripEmotionTags('[[温柔]]我陪你'), '我陪你'));
t('无标签原样返回', () => eq(stripEmotionTags('普通文本'), '普通文本'));

console.log(`\n合计 ${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
