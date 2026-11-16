/**
 * _test_pipeline.mjs — pipeline.mjs 的自测，不依赖 server.mjs 跑起来。
 *   node _test_pipeline.mjs
 * 全绿才去改 server.mjs。
 */
import path from 'node:path';
import { Pipeline, STAGES, createContext, processMessage } from '../pipeline.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* ---------- 假业务模块：记录被调用的顺序 ---------- */
function fakeDeps(over = {}) {
  const calls = [];
  const broadcasts = [];
  const logs = [];
  const errs = [];
  const deps = {
    todos: {
      tryFromText: (text) => {
        calls.push('todo:' + text);
        return over.todo ? { item: { text: '问快递' }, at: null } : null;
      },
    },
    prefs: {
      tryFromText: (text) => {
        calls.push('pref:' + text);
        return over.pref || null;
      },
    },
    reminders: {
      parseWhen: () => 0,
      tryFromText: (text) => {
        calls.push('reminder:' + text);
        if (over.reminderThrow) throw new Error('parseWhen 炸了');
        return over.reminder || null;
      },
    },
    path,
    WORKDIR: 'D:\\document\\Remote Connect DSH\\phone-bridge\\workspace',
    humanSize: (n) => Math.round(n / 1024) + ' KB',
    log: (tag, msg) => logs.push(tag + ' | ' + msg),
    broadcast: (ev, data) => broadcasts.push(ev),
    catchErr: (tag, e) => errs.push(tag + ': ' + (e && e.message ? e.message : e)),
    ...over.deps,
  };
  return { deps, calls, broadcasts, logs, errs };
}

console.log('\n[1] 阶段顺序：todo → pref → reminder');
{
  const { deps, calls } = fakeDeps();
  await processMessage(deps, { text: '记一下 明天问快递' });
  const order = calls.map((c) => c.split(':')[0]);
  ok('依序调用', JSON.stringify(order) === JSON.stringify(['todo', 'pref', 'reminder']), JSON.stringify(order));
}

console.log('\n[2] todo 命中时 reminder 让位（原来的 TDZ 依赖）');
{
  const { deps, calls } = fakeDeps({ todo: true, reminder: { id: 'r1', label: '09:00', text: '叫我' } });
  const ctx = await processMessage(deps, { text: '记一下 明天问快递' });
  const hitRem = calls.some((c) => c.startsWith('reminder:'));
  ok('reminder 没被调用', !hitRem);
  ok('payload 里没有提醒提示', !ctx.compose().includes('提醒已经替你设好了'));
  ok('todoHandled 已置位', ctx.get('todoHandled') === true);
}

console.log('\n[3] 阶段抛错不牵连其他阶段（原来共用 try/catch 的重灾区）');
{
  const { deps, broadcasts, errs } = fakeDeps({ reminderThrow: true });
  const ctx = await processMessage(deps, { text: '明早九点叫我' });
  ok('错误被收集', ctx.errors.length === 1 && ctx.errors[0].stage === 'reminder', JSON.stringify(ctx.errors));
  ok('错误上报到 catchErr', errs.some((e) => e.startsWith('stage:reminder')));
  ok('后续阶段照常跑完（pref 已跑）', ctx.timings.some((t) => t.stage === 'pref'));
}

console.log('\n[4] abort 短路');
{
  const seen = [];
  const p = new Pipeline();
  p.use('a', 10, async (ctx, next) => {
    seen.push('a');
    ctx.abort('直接回这句');
    return next();
  });
  p.use('b', 20, async (ctx, next) => {
    seen.push('b');
    return next();
  });
  const ctx = await p.run(createContext({ text: 'x' }));
  ok('b 没跑', JSON.stringify(seen) === JSON.stringify(['a']), JSON.stringify(seen));
  ok('aborted = true', ctx.aborted === true);
  ok('reply 带出来', ctx.reply === '直接回这句');
}

console.log('\n[5] compose 拼接顺序 + 附件替换空 text');
{
  const { deps } = fakeDeps({ reminder: { id: 'r1', label: '09:00', text: '叫我' } });
  const files = [{ path: 'uploads/a.png', name: 'a.png', size: 2048, mime: 'image/png' }];
  const ctx = await processMessage(deps, {
    text: '',
    files,
    opts: { voice: true, editFrom: '原来的话' },
  });
  const body = ctx.compose();
  const iRem = body.indexOf('提醒已经替你设好了');
  const iAtt = body.indexOf('[附件]');
  const iEdit = body.indexOf('编辑后重发');
  const iVoice = body.indexOf('语音转的文字');
  ok('空 text + 附件 → 占位「（发来文件）」', body.startsWith('（发来文件）'), JSON.stringify(body.slice(0, 20)));
  ok('顺序：提醒 → 附件 → 编辑 → 语音', iRem < iAtt && iAtt < iEdit && iEdit < iVoice, `rem=${iRem} att=${iAtt} edit=${iEdit} voice=${iVoice}`);
  ok('段落之间是空行', body.includes('\n\n[附件]'));
}

console.log('\n[6] 没有命中任何东西 → payload 就是原话');
{
  const { deps } = fakeDeps();
  const ctx = await processMessage(deps, { text: '在吗' });
  ok('原样输出', ctx.compose() === '在吗', JSON.stringify(ctx.compose()));
  ok('没有阶段错误', ctx.errors.length === 0);
}

console.log('\n[7] 一个阶段不调 next() 但不 abort：后面的不跑，也不报错');
{
  const seen = [];
  const p = new Pipeline();
  p.use('a', 10, async (ctx) => {
    seen.push('a');
    return; // 不调 next
  });
  p.use('b', 20, async () => {
    seen.push('b');
  });
  const ctx = await p.run(createContext({ text: 'x' }));
  ok('只跑了 a', JSON.stringify(seen) === JSON.stringify(['a']), JSON.stringify(seen));
  ok('没报错', ctx.errors.length === 0);
}

console.log('\n[8] 阶段耗时被记录');
{
  const { deps } = fakeDeps();
  const ctx = await processMessage(deps, { text: '在吗' });
  ok('timings 有 6 条', ctx.timings.length === 6, String(ctx.timings.length));
  ok('每条都有 name/ms', ctx.timings.every((t) => t.stage && typeof t.ms === 'number'));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
