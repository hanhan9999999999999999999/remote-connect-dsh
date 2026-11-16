// 语音引擎路由与音色注册表的单测。
//
// 为什么单测这两个：
//   resolveEngine：手机端会带着「上一次选的音色」和「刚切的引擎」一起发过来，
//     两者不同族时必须自动纠正，否则 worker 拿到不存在的 voice 会静默失败（没声音、无报错）。
//   allVoices / isFeiyuVoice：肥鱼音色是从本机 references 目录动态发现的，注册表可能
//     还没同步（服务没起/刚启动），旧 id 不能把整条链路带崩。
import assert from 'node:assert';
import {
  resolveEngine, cacheStemFor, emotionParams, allVoices, isFeiyuVoice,
  defaultFeiyuVoice, feiyuVoices, VOICES, DEFAULT_VOICE, DEFAULT_FEIYU_VOICE,
} from '../tts.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

console.log('--- resolveEngine 引擎/音色同族 ---');
t('显式 feiyu + 合法肥鱼音色：原样保留', () => {
  eq(resolveEngine('feiyu-cute', 'feiyu'), { engine: 'feiyu', voice: 'feiyu-cute', asked: 'feiyu-cute' });
});
t('显式 feiyu + Edge 音色：换成肥鱼默认音色', () => {
  const r = resolveEngine('zh-CN-XiaoxuanNeural', 'feiyu');
  eq(r.engine, 'feiyu');
  eq(r.voice, defaultFeiyuVoice());
});
t('显式 edge + 肥鱼音色：换成 Edge 默认音色', () => {
  const r = resolveEngine('feiyu-cute', 'edge');
  eq(r.engine, 'edge');
  eq(r.voice, DEFAULT_VOICE);
});
t('不传引擎 + 肥鱼音色：按音色归属走 feiyu', () => {
  eq(resolveEngine('feiyu-cute', '').engine, 'feiyu');
});
t('不传引擎 + OneCore 音色：走 onecore', () => {
  eq(resolveEngine('Huihui', ''), { engine: 'onecore', voice: 'Huihui', asked: 'Huihui' });
});
t('未知音色：老规矩走 onecore', () => {
  eq(resolveEngine('no-such-voice', '').engine, 'onecore');
});
t('已删除的肥鱼音色：落到当前可用音色，不硬用死 id', () => {
  const r = resolveEngine('feiyu-ghost', 'feiyu');
  eq(r.engine, 'feiyu');
  assert.ok(feiyuVoices().some((v) => v.id === r.voice), `${r.voice} 不在当前音色表里`);
});
t('后端已不认识的 feiyu-* 前缀：仍识别为肥鱼族', () => {
  assert.strictEqual(isFeiyuVoice('feiyu-whatever'), true);
  assert.strictEqual(isFeiyuVoice('zh-CN-XiaoxuanNeural'), false);
});

console.log('--- 音色表 ---');
t('allVoices = Edge 9 + 肥鱼兜底 2', () => {
  eq(allVoices().length, VOICES.length + feiyuVoices().length);
  assert.ok(allVoices().some((v) => v.engine === 'feiyu'));
});
t('默认肥鱼音色来自注册表第一项', () => {
  eq(defaultFeiyuVoice(), feiyuVoices()[0].id);
  eq(defaultFeiyuVoice(), DEFAULT_FEIYU_VOICE);
});

console.log('--- 缓存 key 的引擎隔离 ---');
const np = emotionParams('neutral');
t('同一句话，Edge 与肥鱼 key 不同', () => {
  assert.notStrictEqual(
    cacheStemFor('你好', 'feiyu-cute', 'neutral', np, 'edge'),
    cacheStemFor('你好', 'feiyu-cute', 'neutral', np, 'feiyu'),
  );
});
t('肥鱼 key 稳定（同输入同 key）', () => {
  eq(
    cacheStemFor('你好', 'feiyu-cute', 'neutral', np, 'feiyu'),
    cacheStemFor('你好', 'feiyu-cute', 'neutral', np, 'feiyu'),
  );
});
t('Edge 历史 key 不因引擎参数改变', () => {
  eq(
    cacheStemFor('你好', DEFAULT_VOICE, 'neutral', np),
    cacheStemFor('你好', DEFAULT_VOICE, 'neutral', np, 'edge'),
  );
});
t('不同肥鱼音色不共用缓存', () => {
  assert.notStrictEqual(
    cacheStemFor('你好', 'feiyu-cute', 'neutral', np, 'feiyu'),
    cacheStemFor('你好', 'feiyu-gentle', 'neutral', np, 'feiyu'),
  );
});

console.log(`\n合计 ${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
