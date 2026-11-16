// 验证 /api/tts 的合成进度 SSE：带 mid 请求时，应该一边合成一边推 tts_progress
// 用法：PHONE_TOKEN=<本机令牌> node tests/tts-progress.test.mjs
// 令牌从 phone-bridge/runtime/state.json 里取（那个文件不入库），不要把令牌写进源码。
const TOKEN = process.env.PHONE_TOKEN || '';
if (!TOKEN) {
  console.log('SKIP：没有设置 PHONE_TOKEN。先看 phone-bridge/runtime/state.json 里的 token，再 PHONE_TOKEN=... 重跑。');
  process.exit(0);
}
const BASE = 'http://127.0.0.1:' + (process.env.PHONE_BRIDGE_PORT || '8899');
const mid = 'tprog-' + Date.now();
const stamp = '进度测试' + Math.random().toString(36).slice(2, 7);

const text = [
  '主人，这是我用来测试语音进度条的一段话，' + stamp + '。',
  '第一段要稍微长一点，这样合成需要一点时间，进度条才看得出在走。',
  '第二段接着来，语音合成是按段并发的，每完成一段就会回报一次进度。',
  '第三段用来把句子数量撑到三，好让百分比是一次一次跳上去的。',
].join('');

const events = [];
const t0 = Date.now();
const ctrl = new AbortController();
(async () => {
  const res = await fetch(BASE + '/api/events?t=' + encodeURIComponent(TOKEN), { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(frame);
      const dt = /^data: (.+)$/m.exec(frame);
      if (!ev || ev[1] !== 'tts_progress' || !dt) continue;
      let d = null; try { d = JSON.parse(dt[1]); } catch (_) { continue; }
      if (d.mid !== mid) continue;
      events.push({ ...d, at: Date.now() - t0 });
    }
  }
})().catch(() => {});

const t1 = Date.now();
const r = await fetch(BASE + '/api/tts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-phone-token': TOKEN },
  body: JSON.stringify({ text, voice: 'zh-CN-XiaoxuanNeural', mid }),
});
const j = await r.json();
const ms = Date.now() - t1;
await new Promise((res) => setTimeout(res, 800));
ctrl.abort();

console.log('请求耗时 ms =', ms, '| ok =', j.ok, '| 段数 =', (j.parts || []).length, '| dur =', j.dur);
console.log('收到进度事件：');
for (const e of events) console.log(`  +${e.at}ms  done=${e.done}/${e.total}  pct=${e.pct}  phase=${e.phase}`);

const segs = events.filter((e) => e.phase === 'seg');
const grows = segs.every((e, i) => i === 0 || e.done >= segs[i - 1].done);
const last = segs[segs.length - 1];
const ok = j.ok && segs.length >= 2 && grows && last && last.done === last.total && events.some((e) => e.phase === 'done');
console.log(ok ? 'PASS：进度边合成边推，且最后一段收尾' : 'FAIL：进度事件不全');
process.exit(ok ? 0 : 1);
