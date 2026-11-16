/**
 * 会话层单元测试（离线，不碰真实存档）。
 *   node tests/sessions.test.mjs
 * 覆盖：增量帧解析、重写检测、预览上限与翻页、注入消息过滤、工具轮次兜底、
 *      空会话过滤、明文存档、索引落盘与重启复用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.join(os.tmpdir(), `dsh-phone-sess-test-${process.pid}`);
process.env.PHONE_SESSIONS_ROOT = ROOT;
process.env.PHONE_SESSION_INDEX = path.join(ROOT, 'index.json');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    return;
  }
  fails.push(`${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* ------------------------------------------------------------------ 造数据 */

const CWD_DIR = 'D--document-Remote-Connect-DSH';
const SID = 'session-test-0001';

function frame(records) {
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(body, 'utf8'));
}
function sessionDir(id = SID) {
  return path.join(ROOT, CWD_DIR, id);
}
function writeSession(id, groups) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(groups.map(frame)));
  return file;
}
const header = (id = SID, createdAt = 1700000000000) => ({
  type: 'session',
  version: 4,
  id,
  createdAt,
  cwd: 'D:\\document\\Remote Connect DSH',
  agentPreset: 'standard',
});
const userMsg = (text, time) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }] } });
const asstMsg = (text, time) => ({
  type: 'assistant/message',
  time,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const S = await import('../sessions.mjs');

  /* 1. 基本投影 */
  writeSession(SID, [
    [header(), { type: 'session/title', data: { title: '测试 会话 ✓' } }, userMsg('你好', 1700000001000)],
    [asstMsg('在的，你想做什么？', 1700000002000), userMsg('排查 bug', 1700000003000)],
  ]);
  let list = S.listSessions({ limit: 10 });
  eq('列表条数', list.length, 1);
  eq('标题', list[0]?.title, '测试 会话 ✓');
  eq('消息数', list[0]?.messages, 3);
  eq('preset 取 agentPreset', list[0]?.preset, 'standard');
  ok('列表不带正文', list[0] && list[0].previews === undefined);

  let t = S.readTranscript(SID, { limit: 10 });
  eq('正文 3 条', t?.total, 3);
  eq('正文角色顺序', t?.items.map((x) => x.role), ['user', 'assistant', 'user']);

  /* 2. 增量：追加新帧只解新增部分 */
  const file = path.join(sessionDir(), 'session.v4.jsonl.zstd');
  const before = fs.statSync(file).size;
  fs.appendFileSync(file, frame([asstMsg('我先看结构。', 1700000004000)]));
  list = S.listSessions({ limit: 10 });
  eq('追加后消息数 +1', list[0]?.messages, 4);
  t = S.readTranscript(SID, { limit: 10 });
  eq('追加后正文 +1', t?.total, 4);
  ok('追加确实变大了', fs.statSync(file).size > before);

  /* 3. 半帧（写到一半）不该被吃掉 */
  const partial = frame([asstMsg('这一帧还没写完', 1700000005000)]);
  fs.appendFileSync(file, partial.subarray(0, Math.floor(partial.length / 2)));
  eq('半帧不生效', S.readTranscript(SID, { limit: 10 })?.total, 4);
  fs.appendFileSync(file, partial.subarray(Math.floor(partial.length / 2)));
  eq('补齐后生效', S.readTranscript(SID, { limit: 10 })?.total, 5);

  /* 4. 注入消息过滤 + 工具轮次兜底 */
  const SID2 = 'session-test-0002';
  writeSession(SID2, [
    [
      header(SID2, 1700000100000),
      userMsg('Current runtime context: blah', 1700000101000),
      userMsg('<goal_round>\nObjective: x', 1700000101500),
      {
        type: 'assistant/message',
        time: 1700000102000,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '用户让我先看看目录结构再说。' },
              { type: 'tool-call', id: 'c1', name: 'ops_bash', arguments: '{}' },
              { type: 'tool-call', id: 'c2', name: 'ops_read_files', arguments: '{}' },
            ],
          },
        },
      },
    ],
  ]);
  const t2 = S.readTranscript(SID2, { limit: 10 });
  eq('注入消息不进正文', t2?.total, 1);
  eq('工具轮次兜底成正文', t2?.items[0]?.text, '⏺ ops_bash、ops_read_files');
  ok('标题不是「无标题」', !String(S.listSessions().find((x) => x.id === SID2)?.title || '').startsWith('(无标题)'),
    S.listSessions().find((x) => x.id === SID2)?.title);

  /* 5. 只有 header 的空会话不进列表 */
  const SID3 = 'session-test-0003';
  writeSession(SID3, [[header(SID3, 1700000200000)]]);
  ok('空会话被过滤', !S.listSessions({ limit: 20 }).some((x) => x.id === SID3));

  /* 6. 预览上限与翻页 */
  const SID4 = 'session-test-0004';
  const many = [header(SID4, 1700000300000)];
  for (let i = 0; i < 450; i += 1) many.push(userMsg(`第 ${i} 条`, 1700000300000 + i));
  writeSession(SID4, [many]);
  const t4 = S.readTranscript(SID4, { limit: 40 });
  eq('总数按真实条数算', t4?.total, 450);
  eq('首屏取末 40 条', t4?.items.at(-1)?.text, '第 449 条');
  ok('超上限标记 truncated', t4?.truncated === true);
  ok('首屏还能继续往前翻', t4?.hasMore === true);
  const t4b = S.readTranscript(SID4, { limit: 40, skip: 440 });
  ok('翻到缓存窗口外不重复', (t4b?.items || []).length === 0 || t4b.items[0].text !== t4.items[0].text, t4b?.items?.length);
  ok('翻到底 hasMore=false', t4b?.hasMore === false);

  /* 7. 存档被截断重写 → 重建而不是读到脏尾巴 */
  const SID5 = 'session-test-0005';
  const f5 = writeSession(SID5, [
    [header(SID5, 1700000400000), userMsg('旧内容一', 1700000401000), userMsg('旧内容二', 1700000402000)],
  ]);
  eq('重写前 2 条', S.readTranscript(SID5, { limit: 10 })?.total, 2);
  fs.writeFileSync(
    f5,
    frame([header(SID5, 1700000400000), userMsg('新内容', 1700000403000)])
  );
  const t5 = S.readTranscript(SID5, { limit: 10 });
  eq('重写后 1 条', t5?.total, 1);
  eq('重写后内容正确', t5?.items[0]?.text, '新内容');

  /* 8. 明文 jsonl 存档 */
  const SID6 = 'session-test-0006';
  const dir6 = sessionDir(SID6);
  fs.mkdirSync(dir6, { recursive: true });
  fs.writeFileSync(
    path.join(dir6, 'session.v4.jsonl'),
    [header(SID6, 1700000500000), userMsg('明文存档', 1700000501000)]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
  eq('明文存档可读', S.readTranscript(SID6, { limit: 5 })?.total, 1);

  /* 9. 搜索命中与长文裁剪 */
  const long = 'x'.repeat(2000);
  const SID7 = 'session-test-0007';
  writeSession(SID7, [[header(SID7, 1700000600000), userMsg(`关键词在这里 ${long}`, 1700000601000)]]);
  const hit = S.searchAll('关键词').find((h) => h.sessionId === SID7);
  ok('跨会话搜索命中', !!hit);
  ok('长文被裁到 900 字以内', (hit?.full || '').length <= 600);

  /* 10. 索引落盘 + 重建进程复用（同一进程内重新加载索引） */
  S.collectSessions();
  await new Promise((r) => setTimeout(r, 1800)); // 等索引落盘（1500ms 防抖）
  const raw = JSON.parse(fs.readFileSync(process.env.PHONE_SESSION_INDEX, 'utf8'));
  ok('索引版本正确', raw.v === 2, raw.v);
  ok('索引里存了字节游标', Object.values(raw.files).every((f) => typeof f.byteEnd === 'number' && f.byteEnd > 0));

  /* 11. 缓存统计有界 */
  const st = S.cacheStats();
  ok('缓存条目 = 会话数', st.sessions >= 5, st);
  ok('预览总量有界', st.previews <= 400 * st.sessions, st);

  /* 12. 整份导出（fullTranscript）：走全量解帧，不受预览窗口限制 */
  const full = S.fullTranscript(SID7);
  ok('导出拿得到标题', !!full && !!full.title, full && full.title);
  ok('导出条数 = items 长度', full.total === full.items.length && full.total === 1, full && full.total);
  ok('导出角色对得上', full.items[0].role === 'user', full.items[0]);
  ok('导出的是全文不是预览（>900 字）', full.items[0].text.length > 2000, full.items[0].text.length);
  const two = S.fullTranscript(SID);
  ok('会话里 我 和 DSH 都在', two.items.some((x) => x.role === 'user') && two.items.some((x) => x.role === 'assistant'), two.items.map((x) => x.role));
  const tail2 = S.fullTranscript(SID, { limit: 1 });
  ok('limit 只留最后一条', tail2.items.length === 1, tail2.items.length);
  ok('limit 会标 truncated', tail2.truncated === true, tail2.truncated);
  ok('limit 不影响 total', tail2.total === two.total, tail2.total);
  ok('limit 不改变顺序（留的是最后一条）', tail2.items[0].text === two.items[two.items.length - 1].text, tail2.items[0].text);
  ok('非法 id 直接返回 null', S.fullTranscript('../../etc/passwd') === null);
  ok('不存在的会话返回 null', S.fullTranscript('session-nope-9999') === null);

  fs.rmSync(ROOT, { recursive: true, force: true });

  if (fails.length) {
    console.log(`✗ ${fails.length} 项失败 / ${pass + fails.length} 项`);
    for (const f of fails) console.log('  -', f);
    process.exit(1);
  }
  console.log(`✓ ${pass}/${pass} 项通过`);
}

main().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(1);
});
