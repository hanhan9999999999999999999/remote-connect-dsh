#!/usr/bin/env node
/**
 * api-smoke.mjs —— 后端写接口的"越权/穿越"回归检查（零依赖）
 *
 * 由来：`DELETE /api/mission-file?file=../../data` 曾经能把 data 目录整个删掉
 * （工作区在 data/missions/<tid>/workspace，往上两级就是 data）。删除不可逆，
 * 所以这类断言必须自动化，不能靠"看着没坏"。
 *
 * 用法：
 *   node scripts/api-smoke.mjs                    # 默认 http://127.0.0.1:9890
 *   node scripts/api-smoke.mjs http://127.0.0.1:9891
 *
 * 它会建一个临时任务、在自己的工作区里放两个文件，验完自动删任务与目录。
 * 需要在本机跑（要直接读写 data/ 下的夹具）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:9890').replace(/\/+$/, '');

let pass = 0, fail = 0;
const logs = [];
function check(name, ok, detail) {
  (ok ? pass++ : fail++);
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  logs.push(line);
  console.log(line);
}

async function req(method, p, body) {
  // Connection: close —— 开着 keep-alive 时在 finally 里 process.exit() 会撞
  // libuv 的 UV_HANDLE_CLOSING 断言（Node 在 Windows 上的已知退出竞态）
  const opt = { method, headers: { Connection: 'close' } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opt);
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data, headers: r.headers };
}

const sentinelDir = path.join(ROOT, 'data', '_api_smoke_sentinel');
const clean = { topic: null, tid: null };

try {
  // 先确认服务活着
  const h = await req('GET', '/api/health');
  if (h.status !== 200) throw new Error(`服务没起来：${BASE}/api/health → ${h.status}`);
  console.log(`# ${BASE}  v${h.data?.version || '?'}`);
  // 监听地址要如实报出来：绑 0.0.0.0 就等于把「能读写文件」的界面交给同网段，
  // 而本项目没有内置登录 —— 这一项坏了，界面上的提醒也会跟着错。
  check('健康接口带监听地址与是否仅回环',
    typeof h.data?.bind_host === 'string' && typeof h.data?.loopback_only === 'boolean',
    `${h.data?.bind_host} / loopback=${h.data?.loopback_only}`);
{
  const h = await req('GET', '/api/health');
  check('健康接口说明要不要访问口令', h.status === 200 && typeof h.data?.token_required === 'boolean',
    JSON.stringify({ token_required: h.data?.token_required }));
}
  // 消息接口的 offset 也不能被坏输入打成 500
  {
    const mo = await req('GET', '/api/messages?topic_id=no-such-topic&limit=abc&offset=abc');
    check('消息接口的坏 limit/offset 不报 500',
      mo.status === 200 && Array.isArray(mo.data?.messages),
      JSON.stringify({ status: mo.status, n: (mo.data?.messages || []).length }));
  }
  // 目录列表：路径里带空字符/控制字符是 4xx，不是 500
  {
    const nul = await req('GET', '/api/list-dir?path=%00');
    const ctrl = await req('GET', '/api/list-dir?path=a%01b');
    const msg = String((nul.data && nul.data.error) || '') + String((ctrl.data && ctrl.data.error) || '');
    check('目录列表对非法路径报 4xx 且说人话',
      nul.status === 400 && ctrl.status === 400 && /非法字符|打不开/.test(msg),
      JSON.stringify({ nul: nul.status, ctrl: ctrl.status, msg: msg.slice(0, 80) }));
  }
  // 记忆分页：offset 要传给存储层（以前是把前 limit 条再切片，第二页永远是空）
  {
    const mf = await req('GET', '/api/memory/fragments?limit=1&offset=3');
    check('记忆列表把 offset 真的用了',
      mf.status === 200 && mf.data?.limit === 1 && mf.data?.offset === 3,
      JSON.stringify({ limit: mf.data?.limit, offset: mf.data?.offset, n: (mf.data?.fragments || []).length }));
  }
  // 版本要一处说了算：system_status 与 project-config 必须是同一个字符串
  {
    const st = await req('GET', '/api/system_status');
    const pc = await req('GET', '/api/project-config');
    check('系统状态里的版本与配置接口一致',
      st.status === 200 && typeof st.data?.version === 'string'
        && st.data.version === pc.data?.version,
      JSON.stringify({ system_status: st.data?.version, project_config: pc.data?.version }));
  }
  // 浏览器侧护栏：缺了 nosniff，接口返回的 JSON 可能被当成 HTML 执行；
  // 缺了 SAMEORIGIN，别的站点能把本界面套进 iframe 里骗点击。
  // 404 的口径：浏览器误入给 HTML 页，接口/资源仍旧 JSON（否则前端 res.json() 会炸）
  const r404 = await fetch(BASE + '/no-such-page', { headers: { Accept: 'text/html' } });
  const ct404 = r404.headers.get('content-type') || '';
  check('浏览器误入时给 HTML 404', r404.status === 404 && /text\/html/.test(ct404), ct404);
  const a404 = await req('GET', '/api/no-such-endpoint');
  {
    const noApi = await req('GET', '/api/definitely-not-here');
    check('未知接口说「没有这个接口」',
    noApi.status === 404 && String(noApi.data?.error || '').indexOf('没有这个接口') === 0,
    `${noApi.status} ${JSON.stringify(noApi.data)}`);
  }
  check('未知接口仍是 JSON 404', a404.status === 404 && !!a404.data && !!a404.data.error,
    `${a404.status} ${JSON.stringify(a404.data || {})}`);

  // 数据备份：能列、能建、下载不接受带路径的名字（建完就删，别占用户磁盘）
  const bk0 = await req('GET', '/api/maintenance/backups');
  check('备份列表可读', bk0.status === 200 && Array.isArray(bk0.data?.items));
  const backupMade = await req('POST', '/api/maintenance/backup', {});
  check('能备份一份数据', backupMade.status === 200 && (backupMade.data?.bytes || 0) > 0 && /\.zip$/.test(backupMade.data?.name || ''),
    `${Math.round((backupMade.data?.bytes || 0) / 1024)} KB · ${backupMade.data?.name || '?'}`);
  if (backupMade.data?.path && fs.existsSync(backupMade.data.path)) { try { fs.unlinkSync(backupMade.data.path); } catch {} }
  const badBk = await req('GET', '/api/maintenance/backups/download?name=../chat.db');
  check('备份下载不接受带路径的名字', badBk.status === 404);

  // 恢复会覆盖整个聊天库：没 confirm 必须拦住，名字对不上也不能蒙
  const noCf = await req('POST', '/api/maintenance/backups/restore', { name: 'backup-19700101-000000.zip' });
  check('恢复备份要 confirm', noCf.status === 400 && /confirm/.test(noCf.data?.error || ''),
    `${noCf.status} ${noCf.data?.error || ''}`);
  const noSuch = await req('POST', '/api/maintenance/backups/restore',
    { name: 'backup-19700101-000000.zip', confirm: 'restore' });
  check('恢复不存在的备份报 404', noSuch.status === 404, noSuch.status);

  check('响应带 nosniff / SAMEORIGIN 护栏',
    h.headers.get('x-content-type-options') === 'nosniff'
    && h.headers.get('x-frame-options') === 'SAMEORIGIN',
    `nosniff=${h.headers.get('x-content-type-options')} frame=${h.headers.get('x-frame-options')}`);

  const created = await req('POST', '/api/topic/new', { title: '接口自检（可删）' });
  clean.tid = created.data?.id || null;
  check('建临时任务', created.status === 200 && !!clean.tid, clean.tid || 'no id');
  if (!clean.tid) throw new Error('没拿到 topic id，后面的路径断言没法跑');

  const ws = path.join(ROOT, 'data', 'missions', clean.tid, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello', 'utf8');
  fs.mkdirSync(sentinelDir, { recursive: true });
  const sentinelFile = path.join(sentinelDir, 'keep.txt');
  fs.writeFileSync(sentinelFile, 'sentinel', 'utf8');

  // ① 穿越删除必须被挡
  const reldel = await req('DELETE', `/api/mission-file?topic_id=${clean.tid}&file=` + encodeURIComponent('../../_api_smoke_sentinel'));
  check('穿越删除被拒', reldel.status === 403, `status=${reldel.status}`);
  check('哨兵目录仍在', fs.existsSync(sentinelFile));

  // ② 穿越改名必须被挡
  const relop = await req('POST', '/api/file-op', { action: 'rename', topic_id: clean.tid, file: 'a.txt', target: '../../_api_smoke_sentinel/x.txt' });
  check('穿越改名被拒', relop.status === 403, `status=${relop.status}`);
  check('没在哨兵目录里生成文件', !fs.existsSync(path.join(sentinelDir, 'x.txt')));

  // ③ 工作区内的改名照常工作
  const okop = await req('POST', '/api/file-op', { action: 'rename', topic_id: clean.tid, file: 'a.txt', target: 'b.txt' });
  check('工作区内改名可用', okop.status === 200 && fs.existsSync(path.join(ws, 'b.txt')), `status=${okop.status}`);

  // ③b 撞名：Windows 下 os.rename 会抛 FileExistsError，以前最后变成一句 500 英文，
  // 用户看不出"名字重复"这件事。现在统一 409，只有显式 overwrite 才允许覆盖。
  fs.writeFileSync(path.join(ws, 'c.txt'), 'CCC');
  const dupop = await req('POST', '/api/file-op', { action: 'rename', topic_id: clean.tid, file: 'c.txt', target: 'b.txt' });
  check('改名撞到同名文件报 409', dupop.status === 409, `status=${dupop.status}`);
  check('撞名时源文件还在', fs.existsSync(path.join(ws, 'c.txt')));
  const owop = await req('POST', '/api/file-op', { action: 'copy', topic_id: clean.tid, file: 'c.txt', target: 'b.txt', overwrite: true });
  check('显式 overwrite 才覆盖', owop.status === 200 && fs.readFileSync(path.join(ws, 'b.txt'), 'utf8') === 'CCC',
    `status=${owop.status}`);

  // ④ 工作区内的删除照常工作
  const okdel = await req('DELETE', `/api/mission-file?topic_id=${clean.tid}&file=b.txt`);
  check('工作区内删除可用', okdel.status === 200 && !fs.existsSync(path.join(ws, 'b.txt')), `status=${okdel.status}`);

  // ⑤ 参数名写错要报错，不能"假装删掉了"
  const badKey = await req('POST', '/api/topic/delete', { id: clean.tid });
  check('缺 topic_id 的删除报 400', badKey.status === 400, `status=${badKey.status}`);
  const still = await req('GET', '/api/topics');
  check('写错键名时任务还在', (still.data?.topics || []).some((t) => t.id === clean.tid));

  // ⑥ 不存在的文件应报 404 而不是假装成功
  const gone = await req('DELETE', `/api/mission-file?topic_id=${clean.tid}&file=never-existed.txt`);
  check('删不存在的文件报 404', gone.status === 404, `status=${gone.status}`);

  // ⑦ 上传的 filename 带 ../ 只保留文件名，不能写到工作区外
  const up = await req('POST', '/api/upload', {
    topic_id: clean.tid, filename: '../../../_up_probe.txt', data: Buffer.from('x').toString('base64'),
  });
  check('上传文件名被收成基名', up.status === 200 && up.data?.filename === '_up_probe.txt', JSON.stringify(up.data));
  check('上传没落到 repo 根', !fs.existsSync(path.join(ROOT, '_up_probe.txt')));
  check('上传没落到 data/ 根', !fs.existsSync(path.join(ROOT, 'data', '_up_probe.txt')));

  // ⑧ 改名同样不能"假装改成功"
  const badRename = await req('POST', '/api/topic/rename', { id: clean.tid, title: 'x' });
  check('缺 topic_id 的改名报 400', badRename.status === 400, `status=${badRename.status}`);
  const badRename2 = await req('POST', '/api/topic/rename', { topic_id: 'nope-not-exist', title: 'x' });
  check('改名不存在的任务报 404', badRename2.status === 404, `status=${badRename2.status}`);

  // ⑨ 新建文件夹：正常可建、重名 409、越界 403
  // 动作写错 / 上传不带 topic 曾经都"静默成功"：前者回 success 却什么都没做，
  // 后者在仓库根落了个 0 字节的 file。两条都必须在 400 上被拦住。
  const badAction = await req('POST', '/api/file-op', { topic_id: clean.tid, file: 'b.txt', target: 'z.txt' });
  check('file-op 动作为空报 400', badAction.status === 400, `status=${badAction.status}`);
  const upNoTopic = await req('POST', '/api/upload', { filename: 'x.txt', data: 'aGk=' });
  check('上传缺 topic_id 报 400', upNoTopic.status === 400, `status=${upNoTopic.status}`);
  const upBadName = await req('POST', '/api/upload', { topic_id: clean.tid, filename: 'bad<name.txt', data: 'aGk=' });
  check('上传文件名非法报 400', upBadName.status === 400 && /字符/.test(String(upBadName.data?.error || '')),
    `status=${upBadName.status}`);

  const mk = await req('POST', '/api/file-op', { action: 'mkdir', topic_id: clean.tid, target: '新建资料' });
  check('新建文件夹可用', mk.status === 200 && fs.existsSync(path.join(ws, '新建资料')), `status=${mk.status}`);
  const mkDup = await req('POST', '/api/file-op', { action: 'mkdir', topic_id: clean.tid, target: '新建资料' });
  check('重名文件夹报 409', mkDup.status === 409, `status=${mkDup.status}`);
  const mkBad = await req('POST', '/api/file-op', { action: 'mkdir', topic_id: clean.tid, target: '../../_mk_probe' });
  check('越界新建被拒 403', mkBad.status === 403 && !fs.existsSync(path.join(ROOT, 'data', '_mk_probe')), `status=${mkBad.status}`);

  // ③c Windows 不接受的文件夹名：以前一路走到 os.rename，最后是 500 + [WinError 123]
  const badChar = await req('POST', '/api/file-op', { action: 'mkdir', topic_id: clean.tid, target: 'bad<name' });
  check('非法字符的名字报 400', badChar.status === 400 && /字符/.test(String(badChar.data?.error || '')),
    `status=${badChar.status} err=${JSON.stringify(badChar.data?.error)}`);
  const reserved = await req('POST', '/api/file-op', { action: 'mkdir', topic_id: clean.tid, target: 'CON' });
  check('系统保留名报 400', reserved.status === 400 && /保留/.test(String(reserved.data?.error || '')),
    `status=${reserved.status} err=${JSON.stringify(reserved.data?.error)}`);
  const errClear = await req('POST', '/api/diagnostics/errors/clear', {});
  check('错误记录能清空', errClear.status === 200 && typeof errClear.data?.cleared === 'number',
    `status=${errClear.status} body=${JSON.stringify(errClear.data)}`);

  // ⑩ 记忆接口：写入 → 召回 → 按 id 删除（不能残留自检数据）
  // 先清掉上一轮可能残留的自检碎片：store 的近重复合并会把相似文本并进旧行，
  // 一旦并进上一轮的行，这一轮的断言就会指向一个不存在的 id。
  const oldFrags = await req('GET', '/api/memory/fragments?limit=200');
  for (const f of oldFrags.data?.fragments || []) {
    if (String(f.text || '').includes('自检')) { try { await req('DELETE', `/api/memory/fragment?id=${f.id}`); } catch {} }
  }
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const addFrag = await req('POST', '/api/memory/fragment', { text: `自检记忆 ${nonce}：芝麻开门`, tags: '自检' });
// tags 传数组曾经让 sqlite 报 "type 'list' is not supported"（500）：接口要对两种写法都接受
const addFragTags = await req('POST', '/api/memory/fragment', { text: `自检记忆 ${nonce}：数组 tags`, tags: ['自检', '回归'] });
check('tags 传数组也能写入', addFragTags.status === 200 && addFragTags.data?.success === true, `HTTP ${addFragTags.status}`);
  const fragId = addFrag.data?.id;
  check('记忆碎片可写入', addFrag.status === 200 && Number.isInteger(fragId), JSON.stringify(addFrag.data));
  const rec = await req('POST', '/api/memory/recall', { context: '芝麻开门', top_k: 5 });
  const hits = rec.data?.fragments || [];
  // 用 nonce 认自己那条：库里可能还有别的记忆，排第几不由这条自检决定
  check('召回的列表包含刚写的那条', rec.status === 200 && hits.some((f) => String(f.text || '').includes(nonce)), `n=${hits.length} nonce=${nonce}`);
  check('召回响应不带 embedding', !JSON.stringify(rec.data || {}).includes('embedding'));
  const delMissing = await req('DELETE', '/api/memory/fragment?id=999999');
  check('删不存在的记忆是幂等的（不报错）', delMissing.status === 200, `status=${delMissing.status}`);
  const delBad = await req('DELETE', '/api/memory/fragment');
  check('删除记忆缺 id 报 400', delBad.status === 400, `status=${delBad.status}`);
  // 报错要能直接给人看：接口的 error 文案必须是中文，别再吐 "id required"
  check('缺参数时的报错是中文', /[\u4e00-\u9fff]/.test(String(delBad.data?.error || '')), `error=${JSON.stringify(delBad.data?.error)}`);
  const delFrag = fragId ? await req('DELETE', `/api/memory/fragment?id=${fragId}`) : { status: 0 };
  check('按 id 删记忆可用', delFrag.status === 200, `status=${delFrag.status}`);
  // 数组 tags 那条也要收走，否则它会留在库里，下次「空库」断言就被它绊住
  const tagFragId = addFragTags.data?.id;
  if (tagFragId) { try { await req('DELETE', `/api/memory/fragment?id=${tagFragId}`); } catch {} }
  const clearBad = await req('POST', '/api/memory/clear', {});
  check('清空记忆必须带 confirm', clearBad.status === 400, `status=${clearBad.status}`);

  // ⑪ 文件晶体：只读接口要能 GET（原先只写在 do_POST 里，GET 一律 404）
  const fcStats = await req('GET', '/api/file-crystals');
  check('文件晶体统计可 GET', fcStats.status === 200 && typeof fcStats.data.total_crystals === 'number',
    `status=${fcStats.status}`);
  const fcChangesBad = await req('GET', '/api/file-crystals/changes');
  check('变更检测缺 path 报 400', fcChangesBad.status === 400, `status=${fcChangesBad.status}`);
  const fcTopBad = await req('GET', '/api/file-crystals/top');
  check('读顶层缺 path 报 400', fcTopBad.status === 400, `status=${fcTopBad.status}`);
  const fcBuildGet = await req('GET', '/api/file-crystals/build');
  check('写接口用 GET 报 405', fcBuildGet.status === 405, `status=${fcBuildGet.status}`);
  const fcSources = await req('GET', '/api/file-crystals?sources=1');
  const srcs = (fcSources.data && fcSources.data.sources) || null;
  check('晶体清单可 GET（按文件汇总）',
    fcSources.status === 200 && Array.isArray(srcs) && srcs.length === fcSources.data.count,
    `status=${fcSources.status} count=${srcs ? srcs.length : 'null'}`);
  // 建一份再查：路径里的正斜杠/反斜杠必须算同一个文件（否则界面永远显示 0 片）
  const fcUp = await req('POST', '/api/upload', {
    topic_id: clean.tid, filename: 'crystal-smoke.txt',
    data: Buffer.from('# 晶体自检\n\n这一段用来验证路径归一。\n\n- 一条要点\n- 另一条要点\n').toString('base64'),
  });
  const fcFile = path.join(ws, 'crystal-smoke.txt');
  check('晶体源文件在磁盘上', fcUp.status === 200 && fs.existsSync(fcFile), `upload=${fcUp.status} ws=${ws}`);
  const fcBuild = await req('POST', '/api/file-crystals/build', { path: fcFile, topic_id: clean.tid });
  check('晶体能建（文本文件）', fcBuild.status === 200 && (fcBuild.data.total_slices || 0) > 0,
    `status=${fcBuild.status} body=${JSON.stringify(fcBuild.data).slice(0, 160)}`);
  const fcFwd = await req('GET',
    `/api/file-crystals?path=${encodeURIComponent(fcFile.replace(/\\/g, '/'))}&topic_id=${clean.tid}`);
  check('正斜杠路径也能查回晶体', fcFwd.status === 200 && (fcFwd.data.count || 0) > 0,
    `status=${fcFwd.status} count=${fcFwd.data && fcFwd.data.count}`);

  // 晶体召回：必须带 score，且不能把 embedding / 整段 content 发给浏览器
  const fcRecall = await req('POST', '/api/file-crystals/recall', { query: '路径归一', top_k: 3 });
  const fcHit = (fcRecall.data && fcRecall.data.crystals && fcRecall.data.crystals[0]) || null;
  check('晶体召回带分数', fcRecall.status === 200 && fcHit && typeof fcHit.score === 'number',
    `status=${fcRecall.status} hit=${fcHit ? JSON.stringify(Object.keys(fcHit)).slice(0, 90) : 'none'}`);
  check('晶体召回不带 embedding/content',
    !!fcHit && !('embedding' in fcHit) && !('content' in fcHit),
    fcHit ? JSON.stringify({ emb: 'embedding' in fcHit, content: 'content' in fcHit }) : 'no hit');

  // ⑫ 反思回路：run() 十二项职责各自 try/except，接口永远 200 —— 所以要断报告结构，
  // 不能只看状态码（空库跑一圈也该有 weak_assoc/entities_backfilled 这些键）
  const reflect = await req('POST', '/api/reflection/run', {});
  const rep = reflect.data || {};
  check('反思回路可手动触发', reflect.status === 200 && rep.errors && Array.isArray(rep.errors),
    `status=${reflect.status} keys=${Object.keys(rep).length}`);
  check('反思报告带各项计数', typeof rep.weak_assoc === 'number' && typeof rep.entities_backfilled === 'number',
    JSON.stringify({ weak: rep.weak_assoc, ent: rep.entities_backfilled }));
  // ⑫b 知识页：列表能读、缺 key 报 400、不存在的 key 报 404、重排接口给计数
  const kpages = await req('GET', '/api/knowledge/pages');
  check('知识页列表可读', kpages.status === 200 && Array.isArray((kpages.data || {}).pages),
    `n=${(((kpages.data || {}).pages) || []).length}`);
  const kpNoKey = await req('GET', '/api/knowledge/page');
  check('知识页缺 key 报 400', kpNoKey.status === 400, `status=${kpNoKey.status}`);
  const kpMiss = await req('GET', '/api/knowledge/page?key=__no_such_page__');
  check('知识页不存在的 key 报 404', kpMiss.status === 404, `status=${kpMiss.status}`);
  const kpCompose = await req('POST', '/api/knowledge/compose', {});
  check('知识页能重排草稿', kpCompose.status === 200 && typeof (kpCompose.data || {}).composed === 'number',
    JSON.stringify(kpCompose.data || {}));

  // ⑫c 代码存档：本机 zip 快照（列 / 存 / 回滚要 confirm / 删除）
  const vers = await req('GET', '/api/versions');
  check('代码存档列表可读', vers.status === 200 && Array.isArray((vers.data || {}).archives)
    && typeof (vers.data || {}).current_hash === 'string', `n=${(((vers.data || {}).archives) || []).length}`);
  const vsnap = await req('POST', '/api/versions/snapshot', { label: '接口自检' });
  const vname = (vsnap.data || {}).name;
  check('代码存档能新建', vsnap.status === 200 && !!vname && vsnap.data.files > 0,
    JSON.stringify({ name: vname, files: (vsnap.data || {}).files }));
  const vbad = await req('POST', '/api/versions/restore', { name: vname });
  check('代码回滚要 confirm', vbad.status === 400, `status=${vbad.status}`);
  if (vname) await req('POST', '/api/versions/delete', { name: vname });
  const vdel = await req('POST', '/api/versions/delete', { name: '__no_such_zip__' });
  check('删不存在的存档报 400', vdel.status === 400, `status=${vdel.status}`);

  const vnoname = await req('POST', '/api/versions/restore', { confirm: 'restore' });
  check('回滚不给存档名报 400', vnoname.status === 400 && /存档名/.test(String(vnoname.data && vnoname.data.error)),
    `status=${vnoname.status}`);

  // 新接口的空参数口径：文件不存在是 404，类型不对是 400，都不许"200 + error"
  const cb404 = await req('POST', '/api/file-crystals/build', { path: '__nope__.md' });
  check('建晶体时文件不存在报 404', cb404.status === 404, `status=${cb404.status}`);
  const mfBad = await req('POST', '/api/memory/fragment', { text: 12345 });
  check('记忆 text 不是字符串报 400', mfBad.status === 400, `status=${mfBad.status}`);

  // ⑬ 回收站：删掉的任务要能列出来、能原样还原（快照文件先记下，验完写回，别污染用户的回收站）
  const recPath = path.join(ROOT, 'data', 'deleted_topics_backup.jsonl');
  const recBackup = fs.existsSync(recPath) ? fs.readFileSync(recPath) : null;
  const rt = await req('POST', '/api/topic/new', { title: '回收站自检' });
  const rtid = rt.data && (rt.data.id || rt.data.topic_id);
  await req('POST', '/api/topic/delete', { topic_id: rtid });
  const rl = await req('GET', '/api/recycle/list');
  const ritem = ((rl.data && rl.data.items) || []).find((i) => i.topic_id === rtid);
  check('删掉的任务出现在回收站', !!ritem, `items=${((rl.data && rl.data.items) || []).length}`);
  let rr = { status: 0, data: {} };
  if (ritem) rr = await req('POST', '/api/recycle/restore', { dir_name: ritem.dir_name });
  check('回收站能还原', rr.status === 200 && rr.data && rr.data.success === true, `status=${rr.status}`);
  const back = await req('GET', '/api/topics');
  check('还原后任务回到列表', ((back.data && back.data.topics) || []).some((t) => t.id === rtid),
    `n=${((back.data && back.data.topics) || []).length}`);
  try { await req('POST', '/api/topic/delete', { topic_id: rtid }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data', 'missions', String(rtid)), { recursive: true, force: true }); } catch {}
  try {
    if (recBackup) fs.writeFileSync(recPath, recBackup);
    else fs.rmSync(recPath, { force: true });
  } catch {}

  // ⑭ 资产库：类型别被写坏、文本能读、删除按 id、库外登记只解除不删文件
  const note = await req('POST', '/api/assets/v3/new_note', { title: '接口自检笔记', content: '这条用于接口自检。', tags: ['自检'] });
  const notePath = note.data && note.data.path;
  // 创建接口要回句柄：只回 path 的话，想"刚建的是哪一条"还得再查一次库
  check('新建笔记会返回 id', !!(note.data && note.data.id), `id=${note.data && note.data.id}`);
  const listed = await req('GET', '/api/assets');
  const normRel = (p) => String(p || '').replace(/^[.][\\/]/, '').replace(/\\/g, '/');
  const noteId = (note.data && note.data.id) || '';
  const assetRec = ((listed.data && listed.data.assets) || []).find((a) => a.id === noteId)
    || ((listed.data && listed.data.assets) || []).find((a) => normRel(a.path) === normRel(notePath));
  check('资产里的笔记不是「目录」', !!assetRec && assetRec.type !== 'dir', `type=${assetRec && assetRec.type}`);
  const rd = await req('GET', '/api/assets/v3/read?path=' + encodeURIComponent(notePath || ''));
  check('资产文本能读出来', rd.status === 200 && String((rd.data || {}).content || '').includes('接口自检'),
    `status=${rd.status}`);
  if (assetRec && assetRec.id) {
    const del = await req('POST', '/api/assets/v3/delete', { id: assetRec.id });
    const after = await req('GET', '/api/assets');
    const gone = !(((after.data && after.data.assets) || []).some((a) => a.id === assetRec.id));
    check('资产能按 id 删除', del.status === 200 && gone, `status=${del.status} gone=${gone}`);
    check('库内资产删除后文件也没了', !fs.existsSync(notePath || ''), String(notePath));
  } else {
    check('资产能按 id 删除', false, 'note id missing');
    check('库内资产删除后文件也没了', false, 'note path missing');
  }

  // 库外登记：删除只能解除登记，绝不能删用户的文件
  const extPath = path.join(ROOT, 'README.md');
  const reg = await req('POST', '/api/assets/add', { path: extPath, name: 'README.md', type: 'file', tags: ['自检'] });
  const extId = reg.data && reg.data.asset && reg.data.asset.id;
  const unreg = extId ? await req('POST', '/api/assets/v3/delete', { id: extId }) : { status: 0, data: {} };
  // 登记一个目录之后，它里面的子文件也要能站内读（资产库「浏览」里双击预览就靠这条授权）
  const dirReg = await req('POST', '/api/assets/add', { path: ROOT, tags: ['自检'] });
  const dirId = dirReg.data && dirReg.data.asset && dirReg.data.asset.id;
  const childRead = await req('GET', '/api/assets/v3/read?path=' + encodeURIComponent(path.join(ROOT, 'scripts', 'api-smoke.mjs')));
  check('登记目录里的子文件能读',
    childRead.status === 200 && String((childRead.data || {}).content || '').includes('api-smoke'),
    `status=${childRead.status}`);
  if (dirId) await req('POST', '/api/assets/v3/delete', { id: dirId });

  // 僵尸登记：库里的文件被手动删掉之后，这条登记还必须删得掉（以前回 400 "not a file"）
  const zombie = await req('POST', '/api/assets/v3/new_note', { title: '僵尸登记自检', content: 'x', tags: ['自检'] });
  const zPath = (zombie.data && zombie.data.path) || '';
  const zId = (zombie.data && zombie.data.id) || '';
  if (zPath && zId) {
    // new_note 可能回相对库根的路径（.\notes\x.md），要按资产库根拼绝对路径再删
    const absZ = path.isAbsolute(zPath) ? zPath : path.join(ROOT, 'data', 'assets', String(zPath).replace(/^[.][\\/]/, ''));
    try { fs.unlinkSync(absZ); } catch (_) { try { fs.unlinkSync(zPath); } catch (_) {} }
    const zDel = await req('POST', '/api/assets/v3/delete', { id: zId });
    check('文件已被删的登记也能删掉', zDel.status === 200 && !!((zDel.data || {}).cleared_stale),
      `status=${zDel.status} body=${JSON.stringify(zDel.data).slice(0, 80)}`);
  } else {
    check('文件已被删的登记也能删掉', false, 'zombie note missing');
  }

  check('库外登记解除后文件还在', fs.existsSync(extPath) && unreg.status === 200,
    `status=${unreg.status} exists=${fs.existsSync(extPath)}`);

  // 缩略图：时间流不该把几 MB 的原图整张塞进列表（?w= 走服务端缩放）
  // 用仓库里真实存在的一张 512×512 PNG，缩放后宽度必须变小、体积也不能更大
  const pngPath = path.join(ROOT, 'android', 'icon-512.png');
  const addPng = await req('POST', '/api/assets/add', { path: pngPath, note: '缩略图自检' });
  const pngRec = (addPng.data && (addPng.data.asset || addPng.data)) || {};
  const thumbUrl = `http://127.0.0.1:9890/api/assets/preview?w=160&path=${encodeURIComponent(pngPath)}`;
  let thumbInfo = null;
  try {
    const tr = await fetch(thumbUrl);
    const buf = Buffer.from(await tr.arrayBuffer());
    thumbInfo = { status: tr.status, type: tr.headers.get('content-type'), bytes: buf.length,
      w: buf.length > 24 ? buf.readUInt32BE(16) : 0, orig: fs.statSync(pngPath).size };
  } catch (e) { thumbInfo = { err: String(e) }; }
  check('资产缩略图会按宽度缩放',
    !!thumbInfo && thumbInfo.status === 200 && thumbInfo.w > 0 && thumbInfo.w <= 200,
    JSON.stringify(thumbInfo).slice(0, 120));
  if (pngRec.id) await req('POST', '/api/assets/v3/delete', { id: pngRec.id });

  // 链接资产：调用方给了标题就用它（没给才去抓网页 <title>，再退域名）
  const lk = await req('POST', '/api/assets/v3/new_link', { url: 'https://example.com/notes', title: '手写标题自检' });
  const lkName = (lk.data && lk.data.name) || '';
  check('链接资产采用调用方给的标题', lk.status === 200 && lkName === '手写标题自检',
    `status=${lk.status} name=${lkName}`);
  if (lk.data && lk.data.id) await req('POST', '/api/assets/v3/delete', { id: lk.data.id });

  // 语音运行时没装是「这台机器没有这个能力」，不该报成 500
  const ttsStart = await req('GET', '/api/tts/start');
  check('缺语音运行时时 TTS 启动返回 503 而不是 500',
    ttsStart.status === 503 || ttsStart.status === 200,
    `status=${ttsStart.status} err=${String((ttsStart.data && ttsStart.data.error) || '').slice(0, 40)}`);

  // 更新日志：项目只有 CHANGELOG.md，接口要能把它解析成结构化版本块，
  // 否则「更新日志」页永远「暂无记录」
  const clog = await req('GET', '/api/changelog');
  const rels = (clog.data && clog.data.releases) || [];
  const rel0 = rels[0] || {};
  check('更新日志能从 CHANGELOG.md 解析出版本块',
    clog.status === 200 && rels.length > 0 && /^v\d/.test(rel0.version || '')
      && Array.isArray(rel0.sections) && rel0.sections.length > 0,
    `status=${clog.status} n=${rels.length} ver=${rel0.version || ''}`);

  // 路由兜底也要说人话：POST 到只读接口 / 空参数切模型
let noPost = null;
try {
  noPost = await req('POST', '/api/health', {});
} catch { noPost = null; }
const noPostMsg = String(noPost?.data?.error || '');
check('POST 到只读接口会说「没有这个接口」',
  !!noPost && noPost.status === 404 && noPostMsg.indexOf('没有这个接口') === 0,
  JSON.stringify({ status: noPost?.status, msg: noPostMsg }));

let tm = null;
try {
  tm = await req('POST', '/api/task-model', {});
} catch { tm = null; }
const tmMsg = String(tm?.data?.error || '');
check('切模型缺参数会说明要什么',
  !!tm && tm.status === 400 && (tmMsg.indexOf('切模型需要') >= 0 || tmMsg.indexOf('没在列表里') >= 0),
  JSON.stringify({ status: tm?.status, msg: tmMsg.slice(0, 60) }));

let cr = null;
try {
  cr = await req('GET', '/api/file-crystals/build');
} catch { cr = null; }
check('方法用错会说是「只接受 POST」',
  !!cr && cr.status === 405 && String(cr?.data?.error || '').indexOf('只接受 POST') >= 0,
  JSON.stringify({ status: cr?.status, msg: String(cr?.data?.error || '').slice(0, 40) }));

// 空参数不能在资产库里造空笔记
const emptyNote = await req('POST', '/api/assets/v3/new_note', {});
check('空参数不会造出空笔记',
  emptyNote.status === 400 && /至少给一个/.test(String((emptyNote.data || {}).error || '')),
  JSON.stringify(emptyNote));

// 资产库目录：空 / 「.」/ 相对路径都要被拒，不能把库搬进程序根目录
const libBefore = await req('GET', '/api/assets');
const libEmpty = await req('POST', '/api/assets/settings', {});
const libDot = await req('POST', '/api/assets/settings', { lib_dir: '.' });
const libRel = await req('POST', '/api/assets/settings', { lib_dir: 'notes' });
const libAfter = await req('GET', '/api/assets');
const libErrText = String((libEmpty.data || {}).error || '') + String((libDot.data || {}).error || '') + String((libRel.data || {}).error || '');
check('资产库目录不接受空串 / 相对路径',
  libEmpty.status === 400 && libDot.status === 400 && libRel.status === 400
    && /绝对路径|为空/.test(libErrText)
    && (libAfter.data || {}).lib_dir === (libBefore.data || {}).lib_dir,
  JSON.stringify({ e: libEmpty.status, d: libDot.status, r: libRel.status,
    before: (libBefore.data || {}).lib_dir, after: (libAfter.data || {}).lib_dir }));

// 坏 JSON / 空对象：必须有响应，不能直接断开
const rawBad = await fetch(BASE + '/api/settings/banner', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'BadJSON{' });
const badBody = await rawBad.text();
const bannerEmpty = await req('POST', '/api/settings/banner', {});
const fbBad = await req('POST', '/api/message-feedback', { kind: 'nope' });
check('坏 JSON 与空对象都给得出话',
  rawBad.status === 400 && /"error"/.test(badBody)
    && bannerEmpty.status === 200 && typeof bannerEmpty.data?.hide_banner === 'boolean'
    && fbBad.status === 400 && /反馈类型/.test(String(fbBad.data?.error || '')),
  JSON.stringify({ status: rawBad.status, banner: bannerEmpty.status, fb: fbBad.status }));

// 画布：空参数/假 tid 不许在 data/missions 里造工作区
const badTid = 'no-such-topic-' + Date.now();
const cv = await req('POST', '/api/canvas/save', { tid: badTid });
const cv2 = await req('POST', '/api/canvas/window/add', { tid: badTid, window: { type: 'file' } });
check('画布不认假 tid（不白造工作区）',
  cv.status === 404 && /没有这个任务/.test(String(cv.data?.error || '')) &&
  cv2.status === 404 && /没有这个任务/.test(String(cv2.data?.error || '')),
  JSON.stringify({ save: cv.status, add: cv2.status }));

// 查询串里的坏数字不该 500：limit=abc 回落到默认值
const badLimit = await req('GET', '/api/messages?limit=abc&offset=-5');
const badCanvas = await req('GET', '/api/canvas?tid=' + encodeURIComponent('../../etc'));
check('坏查询参数不报 500、假 tid 不白造',
  badLimit.status === 200 && badCanvas.status === 404 && /没有这个任务/.test(badCanvas.data.error || ''),
  JSON.stringify({ limit: badLimit.status, canvas: badCanvas.status, err: badCanvas.data.error }));

// 并发备份：同一秒发起 4 个，名字必须互不相同（以前四个线程抢同一个文件名互相覆盖）
{
  const mk = async () => (await (await fetch(BASE + '/api/maintenance/backup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json());
  const made = await Promise.all([mk(), mk(), mk(), mk()]);
  const names = made.map((x) => x.name).filter(Boolean);
  check('同一秒并发备份不会互相覆盖',
    names.length === 4 && new Set(names).size === 4,
    JSON.stringify(names));
  for (const n of names) {
    try {
      await fetch(BASE + '/api/maintenance/backups/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n }),
      });
    } catch { /* 清理失败不影响断言 */ }
  }
}

// 发消息给已删除的任务：404 说清楚，不是 500
{
  const gone = await req('POST', '/api/chat', { topic_id: 'no-such-topic-' + Date.now(), message: 'hi' });
  check('发给已删除的任务回 404 而不是 500',
    gone.status === 404 && /删/.test(String(gone.data && gone.data.error || '')),
    JSON.stringify({ status: gone.status, error: gone.data && gone.data.error }));
}

// 诊断包：能下载、是 zip（版本/环境/日志都在里面，不含聊天内容）
let diag = null;
try {
  const rr = await fetch(BASE + '/api/diagnostics/bundle');
  const ab = Buffer.from(await rr.arrayBuffer());
  diag = { status: rr.status, bytes: ab.length, sig: ab.slice(0, 2).toString(), ctype: rr.headers.get('content-type') || '' };
} catch { diag = null; }
check('诊断包能下载且是 zip',
  !!diag && diag.status === 200 && diag.bytes > 200 && diag.sig === 'PK' && /zip/.test(diag.ctype),
  JSON.stringify(diag));

// 诊断：线程栈能取到（取消聊天后拿它确认没人攥着 sqlite）
  const th = await req('GET', '/api/diagnostics/threads');
  const thList = (th.data && th.data.threads) || [];
  check('线程诊断接口能取到栈',
    th.status === 200 && thList.length > 0 && Array.isArray(thList[0].stack) && thList[0].stack.length > 0,
    `status=${th.status} n=${thList.length}`);

  // 没配密钥时：立刻 400 + 一句能照做的 hint（别让人对着英文 401 发呆）
  const cfg = await req('GET', '/api/project-config');
  const hasKey = !!(cfg.data && cfg.data.has_key);
  if (!hasKey) {
    const chatNoKey = await req('POST', '/api/chat', { message: '自检：无密钥', topic_id: clean.tid || '' });
    const cerr = String((chatNoKey.data && chatNoKey.data.error) || '');
    check('没配密钥时聊天立刻回 400 并说清怎么做',
      chatNoKey.status === 400 && /密钥/.test(cerr) && !!(chatNoKey.data && chatNoKey.data.hint),
      `status=${chatNoKey.status} err=${cerr.slice(0, 40)}`);
  } else {
    check('没配密钥时聊天立刻回 400 并说清怎么做', true, 'skip: 本机已配置密钥');
  }

  const ents = await req('GET', '/api/memory/entities');
  check('实体列表不带 embedding', !JSON.stringify(ents.data || {}).includes('embedding'),
    `status=${ents.status}`);
} catch (e) {
  check('自检跑完', false, e.message);
} finally {
  // 配置：前端要按 has_key 决定挂不挂「还没配密钥」提示条，别让它去猜
{
  const cfg = await req('GET', '/api/project-config');
  check('配置接口带上 has_key', cfg.status === 200 && typeof cfg.data?.has_key === 'boolean',
    JSON.stringify(cfg.data));
  const needKey = ['deepseek', 'zhipu', 'openai', 'moonshot', 'qwen', 'siliconflow', 'custom']
    .includes(String(cfg.data?.provider || ''));
  check('配置接口的 needs_key 与 provider + has_key 对得上（本地模型不该被催填 Key）',
    typeof cfg.data?.needs_key === 'boolean' && cfg.data.needs_key === (needKey && cfg.data.has_key !== true),
    JSON.stringify({ provider: cfg.data?.provider, has_key: cfg.data?.has_key, needs_key: cfg.data?.needs_key }));
}

// 孤儿工作区：能报数；没有 confirm 不许动手
{
  const ws = await req('GET', '/api/maintenance/workspaces');
  const okShape = ws.status === 200 && typeof ws.data?.count === 'number' && Array.isArray(ws.data?.orphans);
  check('孤儿工作区接口能报数', okShape, JSON.stringify(ws.data).slice(0, 120));
  const bad = await req('POST', '/api/maintenance/workspaces/cleanup', {});
  check('清理孤儿工作区要 confirm', bad.status === 400, JSON.stringify(bad.data));
}

// 搜索：标题命中要能搜回来（消息正文走同一套 LIKE，这里只验标题这条主干）
{
  const tag = '搜索自检' + Date.now().toString(36).slice(-5);
  const st = await req('POST', '/api/topic/new', { title: tag });
  const sid = st.data && (st.data.id || st.data.topic_id);
  const sr = await req('GET', '/api/search?q=' + encodeURIComponent(tag));
  const hit = (sr.data?.hits || []).find((h) => h.id === sid);
  check('搜索能按标题命中', sr.status === 200 && !!hit && hit.title_match === true,
    JSON.stringify(sr.data).slice(0, 140));
  const none = await req('GET', '/api/search?q=' + encodeURIComponent('zzz没这个词' + tag));
  check('搜索没有结果时给空数组', none.status === 200 && (none.data?.count || 0) === 0,
    JSON.stringify(none.data).slice(0, 80));
  if (sid) {
    await req('POST', '/api/topic/delete', { topic_id: sid });
    // 自己删的任务别留在用户回收站里
    try {
      const rp = path.join(ROOT, 'data', 'deleted_topics_backup.jsonl');
      if (fs.existsSync(rp)) {
        const keep = fs.readFileSync(rp, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => {
          try { const o = JSON.parse(l); return !(o.topic && String(o.topic.id) === String(sid)); } catch { return false; }
        });
        fs.writeFileSync(rp, keep.length ? keep.join('\n') + '\n' : '');
      }
    } catch {}
    try { fs.rmSync(path.join(ROOT, 'data', 'missions', sid), { recursive: true, force: true }); } catch {}
  }
}

// 删任务要连带清掉它的记忆碎片：否则记忆面板会数到、recall 会搜到死链
{
  const tag = '记忆清理自检' + Date.now().toString(36).slice(-5);
  const nt = await req('POST', '/api/topic/new', { title: tag });
  const nid = nt.data && (nt.data.id || nt.data.topic_id);
  const phrase = '删除任务残留自检唯一句' + tag;
  const add = await req('POST', '/api/memory/fragment', { text: phrase, topic_id: nid, layer: 'core' });
  const before = await req('POST', '/api/memory/recall', { query: phrase, top_k: 5 });
  const beforeHit = (before.data?.fragments || []).some((h) => String(h.text || '').includes(tag));
  if (nid) { await req('POST', '/api/topic/delete', { topic_id: nid }); }
  const after = await req('POST', '/api/memory/recall', { query: phrase, top_k: 5 });
  const afterHit = (after.data?.fragments || []).some((h) => String(h.text || '').includes(tag));
  check('删任务会连带清掉它的记忆碎片', add.status === 200 && beforeHit && !afterHit,
    JSON.stringify({ add: add.status, beforeHit, afterHit }).slice(0, 140));
  // 自己删的任务别留在回收站里
  try {
    const rp = path.join(ROOT, 'data', 'deleted_topics_backup.jsonl');
    if (fs.existsSync(rp)) {
      const keep = fs.readFileSync(rp, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => {
        try { const o = JSON.parse(l); return !(o.topic && String(o.topic.id) === String(nid)); } catch { return false; }
      });
      fs.writeFileSync(rp, keep.length ? keep.join('\n') + '\n' : '');
    }
  } catch {}
  try { fs.rmSync(path.join(ROOT, 'data', 'missions', String(nid || '')), { recursive: true, force: true }); } catch {}
}

// 坏参数：参数错是 4xx，不是 500；报错要是中文
{
  const cv = await req('POST', '/api/canvas/tab/active', {});
  check('画布切标签页缺参数报 4xx 且是中文', [400, 404].includes(cv.status) && /[\u4e00-\u9fff]/.test(String(cv.data?.error || '')),
    JSON.stringify(cv.data).slice(0, 120));
  const au = await req('POST', '/api/assets/update', {});
  check('更新不存在的资产给中文 404', au.status === 404 && /[\u4e00-\u9fff]/.test(String(au.data?.error || '')),
    JSON.stringify(au.data).slice(0, 120));
}

// 删任务顺手收掉空工作区；里面有文件就一个都不动
{
  const mk = async (withFile) => {
    const r = await req('POST', '/api/topic/new', { title: '空工作区自检' });
    const tid = r.data && (r.data.id || r.data.topic_id);
    const dir = path.join(ROOT, 'data', 'missions', String(tid), 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    if (withFile) fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const del = await req('POST', '/api/topic/delete', { topic_id: tid });
    const kept = fs.existsSync(dir);
    if (withFile) { try { fs.rmSync(path.join(ROOT, 'data', 'missions', String(tid)), { recursive: true, force: true }); } catch {} }
    return { tid, del: del.data, kept, dirGone: !fs.existsSync(path.join(ROOT, 'data', 'missions', String(tid))) };
  };
  const empty = await mk(false);
  const full = await mk(true);
  check('删任务会收掉空工作区、有文件则保留',
    empty.del?.empty_workspace_removed === true && empty.dirGone === true
    && full.del?.empty_workspace_removed === false && full.kept === true,
    JSON.stringify({ empty, full }).slice(0, 200));
  // 回收站里别留这两条自检
  try {
    const rp = path.join(ROOT, 'data', 'deleted_topics_backup.jsonl');
    if (fs.existsSync(rp)) {
      const mine = new Set([String(empty.tid || ''), String(full.tid || '')]);
      const keep = fs.readFileSync(rp, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => {
        try { const o = JSON.parse(l); return !(o.topic && mine.has(String(o.topic.id))); } catch { return false; }
      });
      fs.writeFileSync(rp, keep.length ? keep.join('\n') + '\n' : '');
    }
  } catch {}
}

// 清理：先删任务，再删残留目录与哨兵
  if (clean.tid) { try { await req('POST', '/api/topic/delete', { topic_id: clean.tid }); } catch {} }
  // 回收站也会记下这次删的任务：只摘掉我们自己那几条（按 topic.id 认），别动用户原有的
  try {
    const rp = path.join(ROOT, 'data', 'deleted_topics_backup.jsonl');
    if (fs.existsSync(rp)) {
      const mine = new Set([String(clean.tid || '')].filter(Boolean));
      const keep = fs.readFileSync(rp, 'utf8').split('\n').filter((l) => l.trim()).filter((l) => {
        try { const o = JSON.parse(l); return !(o.topic && mine.has(String(o.topic.id))); } catch { return false; }
      });
      fs.writeFileSync(rp, keep.length ? keep.join('\n') + '\n' : '');
    }
  } catch {}
  for (const p of [sentinelDir, clean.tid ? path.join(ROOT, 'data', 'missions', clean.tid) : null]) {
    if (!p) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  // 备份导入：垃圾字节要 400，真 zip 能进来
  let impBad = null, impGood = null;
  try {
    let r = await fetch(BASE + '/api/maintenance/backups/import', {
      method: 'POST', headers: { Connection: 'close' }, body: Buffer.from('definitely not a zip'),
    });
    impBad = { status: r.status, data: await r.json().catch(() => null) };
    // 先造一份，再把它自己导回来（等同校验 zip 合法 + 落盘）
    const mk2 = await req('POST', '/api/maintenance/backup', {});
    const nm = mk2.data?.name || '';
    if (nm) {
      const bin = await fetch(BASE + '/api/maintenance/backups/download?name=' + encodeURIComponent(nm));
      const buf = Buffer.from(await bin.arrayBuffer());
      r = await fetch(BASE + '/api/maintenance/backups/import', {
        method: 'POST', headers: { Connection: 'close' }, body: buf,
      });
      impGood = { status: r.status, data: await r.json().catch(() => null) };
      if (impGood?.data?.name) await req('POST', '/api/maintenance/backups/delete', { name: impGood.data.name });
      try { fs.unlinkSync(path.join(ROOT, 'data', 'backups', nm)); } catch {}
    }
  } catch (e) { impBad = impBad || { error: String(e) }; }
  check('备份导入会拒绝不是 zip 的字节',
    impBad && impBad.status === 400 && /zip/.test(String(impBad.data?.error || '')),
    JSON.stringify(impBad).slice(0, 160));
  check('备份能导出再导入',
    impGood && impGood.status === 200 && impGood.data?.ok === true && /^backup-/.test(String(impGood.data?.name || '')),
    JSON.stringify(impGood).slice(0, 160));

  const bkList = await req('GET', '/api/maintenance/backups');
  const bkItems = (bkList.data && bkList.data.items) || [];
  check('备份列表会标明来源（自动/导入/恢复前/手动）',
    bkList.status === 200 && bkItems.length > 0
    && bkItems.every((it) => ['manual', 'auto', 'import', 'pre'].includes(String(it.kind)))
    && bkItems.some((it) => it.kind === 'manual'),
    JSON.stringify(bkItems.map((it) => [it.name.slice(-12), it.kind])).slice(0, 200));

  const delMissing = await req('POST', '/api/maintenance/backups/delete', { name: 'no-such-backup.zip' });
  check('删不存在的备份报 404', delMissing.status === 404, JSON.stringify(delMissing.data || {}).slice(0, 120));

  const tmpBk = await req('POST', '/api/maintenance/backup', {});
  const tmpName = String(tmpBk.data?.name || '');
  const delOk = await req('POST', '/api/maintenance/backups/delete', { name: tmpName });
  const afterDel = await req('GET', '/api/maintenance/backups');
  check('备份能删掉（只删文件，不动数据）',
    tmpBk.status === 200 && delOk.status === 200 && delOk.data?.ok === true
    && !((afterDel.data?.items || []).some((it) => it.name === tmpName)),
    JSON.stringify({ made: tmpName, del: delOk.data }).slice(0, 160));

  // 回收站：单挑一条永久删除（造任务 → 删进回收站 → 删快照 → 再删 404）
  {
    const t = await req('POST', '/api/topic/new', { title: '回收站单删自检' });
    const tid = t.data?.id || t.data?.topic_id;
    await req('POST', '/api/topic/delete', { topic_id: tid });
    const rl = await req('GET', '/api/recycle/list');
    const hit = ((rl.data && rl.data.items) || []).find((x) => String(x.title || '').indexOf('回收站单删自检') >= 0);
    const one = hit ? await req('POST', '/api/recycle/delete', { dir_name: hit.dir_name }) : { status: 0 };
    const again = hit ? await req('POST', '/api/recycle/delete', { dir_name: hit.dir_name }) : { status: 0 };
    const rl2 = await req('GET', '/api/recycle/list');
    const gone = hit && !((rl2.data && rl2.data.items) || []).some((x) => x.dir_name === hit.dir_name);
    check('回收站能单挑一条永久删除',
      !!hit && one.status === 200 && again.status === 404 && gone === true,
      JSON.stringify({ hit: !!hit, one: one.status, again: again.status, gone: !!gone }).slice(0, 160));
  }

  const sug = await req('POST', '/api/settings/suggestions', { generate: true });
  const sugNeedsKey = sug.data?.needs_key === true;
  check('AI 建议：没密钥时给中文原因而不是硬调模型',
    sug.status === 200 && typeof sug.data?.gen_msg === 'string'
    && (!sugNeedsKey || /密钥/.test(String(sug.data.gen_msg))),
    JSON.stringify({ needs_key: sugNeedsKey, msg: sug.data?.gen_msg }).slice(0, 160));

  const mt = await req('POST', '/api/models/test', {});
  check('模型页的「测试」接口不花 token 也能给结论',
    mt.status === 200 && typeof mt.data?.ok === 'boolean'
    && (mt.data.ok === true || /[\u4e00-\u9fff]/.test(String(mt.data.error || ''))),
    JSON.stringify(mt.data || {}).slice(0, 160));

  console.log(`\n${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
}
