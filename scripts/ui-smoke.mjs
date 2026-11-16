#!/usr/bin/env node
/**
 * 桌面端 UI 冒烟：无头 Edge + CDP，不依赖任何 npm 包（Node 22+ 自带 WebSocket）。
 *
 * 为什么要有这个
 * --------------
 * public/index.html 是一万九千行的单文件应用，改一行样式就可能把某块面板弄哑。
 * 人工点一遍太慢，playwright 又得让用户装依赖 —— 这里只用系统自带的 Edge，
 * 跑完给出 PASS/FAIL 清单和退出码，能直接挂到发布前的手工检查里。
 *
 * 用法
 * ----
 *   node scripts/ui-smoke.mjs                        # 默认打 http://127.0.0.1:9890/
 *   node scripts/ui-smoke.mjs http://127.0.0.1:9891/ # 指定实例
 *   node scripts/ui-smoke.mjs --shot tmp/ui-smoke    # 额外落截图
 *   node scripts/ui-smoke.bat                        # Windows 双击也行
 *
 * 退出码：0 全过；1 有失败（失败项会打印期望/实际）。
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const shotAt = argv.indexOf('--shot');
const SHOT_DIR = shotAt >= 0 ? argv[shotAt + 1] : '';
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== shotAt + 1);
const BASE = (positional[0] || 'http://127.0.0.1:9890/').replace(/\/+$/, '') + '/';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge，可用 EDGE_PATH 指定浏览器可执行文件');
}

function freePort() {
  return 9200 + Math.floor(Math.random() * 500);
}

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口没起来：' + url);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const edge = findEdge();
  const port = freePort();
  const profile = path.join(os.tmpdir(), `dsh-ui-smoke-${Date.now()}`);
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const child = spawn(edge, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1440,900',
    BASE,
  ], { stdio: 'ignore', detached: false });

  let cdp;
  let shotSeq = 0;
  try {
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('没有可用的页面 target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const shot = async (name) => {
      if (!SHOT_DIR) return;
      const file = path.join(SHOT_DIR, `${String(++shotSeq).padStart(2, '0')}-${name}.png`);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    };

    // 单文件应用是"下载完再建 DOM"，冷启动（新 profile、无缓存）要几秒，
    // 固定 sleep 很容易在慢机器上误报，统一改成等条件成立。
    const waitFor = async (expr, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await cdp.eval(expr)) return true; } catch { /* 页面还没就绪 */ }
        await sleep(250);
      }
      return false;
    };

    // ── 1. 首屏 ───────────────────────────────────────
    await waitFor(`!!document.getElementById('chatBox') && !!document.getElementById('msgInput')`, 20000);
    await waitFor(`!!document.querySelector('.empty-tags button')`, 8000);
    const boot = await cdp.eval(`JSON.stringify({
      title: document.title,
      hasChat: !!document.getElementById('chatBox'),
      hasInput: !!document.getElementById('msgInput'),
      empty: !!document.querySelector('.empty-tags'),
      w: innerWidth
    })`);
    const b = JSON.parse(boot || '{}');
    check('首屏加载（标题/消息区/输入框）', !!b.title && b.hasChat && b.hasInput, boot);
    // 标签页标题得是应用名，不能是静态里那个占位的 "AI"
    let appNm = '大眼X';
    try {
      const pc = await (await fetch(BASE + 'api/project-config')).json();
      appNm = String(pc.app_name || appNm);
    } catch {}
    // 有打开的任务时标题是「任务名 · 应用名」，没有才是纯应用名；两种都算对
    check('标签页标题跟着应用名（不是 AI 占位）',
      String(b.title || '').indexOf(appNm) >= 0 && b.title !== 'AI',
      `title=${b.title} name=${appNm}`);
    // 浏览器的 "Failed to fetch" 不该原样丢给用户
    const ne = await cdp.eval(`(function(){ try{ return String(netErr(new TypeError('Failed to fetch'))); }catch(e){ return 'err '+e.message; } })()`);
    check('网络错误翻成中文', /连不上服务/.test(ne || ''), ne);

  // 「自动」主题：浅色系统套白、深色系统套黑。
  // 注意：headless Edge 的 setEmulatedMedia 不一定给"加载时就存在"的 MediaQueryList 派发
  // change 事件（页面里现注册的会收到），所以这里显式调一次 _onScheme() —— 那正是系统
  // 换主题时浏览器会做的事，测的是处理逻辑本身。
  let themeAuto = { light: null, dark: null };
  try {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    themeAuto.light = JSON.parse(await cdp.eval(`(function(){ setTheme('auto');
      return JSON.stringify({stored:getTheme(), attr:document.documentElement.getAttribute('data-theme')}); })()`));
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    themeAuto.dark = JSON.parse(await cdp.eval(`(async function(){
      try{ _onScheme(); }catch(e){}
      var t0=Date.now();
      while(Date.now()-t0<2000){
        var a=document.documentElement.getAttribute('data-theme');
        if(a==='black') break;
        await new Promise(function(r){setTimeout(r,80)});
      }
      return JSON.stringify({stored:getTheme(), attr:document.documentElement.getAttribute('data-theme'),
        handler: typeof _onScheme});
    })()`));
  } finally {
    try { await cdp.send('Emulation.setEmulatedMedia', { features: [] }); } catch { /* ignore */ }
    try { await cdp.eval(`setTheme('black');`); } catch { /* ignore */ }
  }
  check('主题「自动」跟着系统深浅色',
    themeAuto.light && themeAuto.light.stored === 'auto' && themeAuto.light.attr === 'white'
    && themeAuto.dark && themeAuto.dark.attr === 'black' && themeAuto.dark.handler === 'function',
    JSON.stringify(themeAuto));    await shot('home');

    // 侧栏列表：有任务就该有 .topic-swipe，没任务就该有 .topics-empty（空白列表是 bug）
    // 首屏的 loadTopics 是异步的：轮询到「有任务」或「空态引导」出现再断言
    let sideList = '{}';
    for (let i = 0; i < 20; i++) {
      sideList = await cdp.eval(`(function(){
        var n=document.querySelectorAll('#topicList .topic-swipe').length;
        var e=!!document.querySelector('#topicList .topics-empty');
        var cta=(document.querySelector('#topicList .topics-empty .te-btn')||{}).textContent||'';
        return JSON.stringify({topics:n,empty:e,cta:cta.trim()});
      })()`);
      try { const o = JSON.parse(sideList); if (o.topics > 0 || (o.empty === true && o.cta.length > 0)) break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    let listOk = false;
    try { const o = JSON.parse(sideList); listOk = o.topics > 0 || (o.empty === true && o.cta.length > 0); } catch { /* ignore */ }
    check('侧栏列表有内容或空态引导', listOk, sideList);

    // 列表读失败时不能装作「没有任务」：屏蔽 /api/topics 应出现错误态 + 重试按钮
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*/api/topics*'] });
      await cdp.eval(`(function(){topics=[];return loadTopics();})()`);
      await sleep(500);
      const errCard = await cdp.eval(`(function(){
        var e=document.querySelector('#topicList .topics-empty');
        return JSON.stringify({err:!!_topicsErr, txt:e?e.innerText.replace(/\\n/g,'|'):'', retry:!!(e&&e.querySelector('.te-btn'))});
      })()`);
      let errOk = false;
      try { const o = JSON.parse(errCard); errOk = o.err === true && o.retry === true && /没读出来/.test(o.txt); } catch { /* ignore */ }      check('列表读失败显示错误态与重试', errOk, errCard);
      await cdp.send('Network.setBlockedURLs', { urls: [] });
      await cdp.eval(`(function(){return loadTopics();})()`);
      await sleep(400);
    } catch (e) {
      check('列表读失败显示错误态与重试', false, String(e && e.message || e));
    }

    // ── 2. 快速跳转 ────────────────────────────────────
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await sleep(350);
    const pal = await cdp.eval(`JSON.stringify({
      open: !!document.getElementById('cmdkOverlay') && getComputedStyle(document.getElementById('cmdkOverlay')).display !== 'none',
      items: document.querySelectorAll('#cmdkList .cmdk-item').length
    })`);
    const p = JSON.parse(pal || '{}');
    check('Ctrl+K 打开快速跳转', p.open === true, pal);

  // 键盘用户：Tab 至少要落在搜索框上，而且焦点环看得见（别被 outline:none 吃掉）
  let focusRing = null;
  try {
    await cdp.eval(`(function(){
      if(document.getElementById('sidebar').getBoundingClientRect().width < 50){ try{ toggleSidebar(true); }catch(e){} }
      try{ document.activeElement && document.activeElement.blur(); }catch(e){}
      document.body.setAttribute('tabindex','-1'); document.body.focus();
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await new Promise((r) => setTimeout(r, 200));
    focusRing = JSON.parse(await cdp.eval(`(function(){
      var b=document.activeElement||document.body, cs=getComputedStyle(b);
      return JSON.stringify({tag:b.tagName, id:b.id, style:cs.outlineStyle,
        w:parseFloat(cs.outlineWidth)||0, vis:b.matches(':focus-visible')});
    })()`));
    await cdp.eval(`(function(){ document.body.removeAttribute('tabindex'); return 1; })()`);
  } catch { /* 焦点这一项失败不影响其它断言 */ }
  check('键盘 Tab 有看得见的焦点环',
    focusRing && focusRing.vis === true && focusRing.style !== 'none' && focusRing.w > 0,
    JSON.stringify(focusRing));

  // 「跳到输入框」：键盘第一个 Tab 就能跳过整条侧栏
  let skipLink = null;
  try {
    await cdp.eval(`(function(){
      document.body.setAttribute('tabindex','-1'); document.body.focus();
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await new Promise((r) => setTimeout(r, 300));
    skipLink = JSON.parse(await cdp.eval(`(function(){
      var a=document.querySelector('.skip-link');
      if(!a) return JSON.stringify({found:false});
      var top=Math.round(a.getBoundingClientRect().top);
      return JSON.stringify({found:true, active:document.activeElement===a, top:top});
    })()`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
    await new Promise((r) => setTimeout(r, 400));
    skipLink.after = await cdp.eval(`(document.activeElement||{}).id || ''`);
    await cdp.eval(`(function(){ document.body.removeAttribute('tabindex'); return 1; })()`);
  } catch { /* 跳过导航这一项失败不影响其它断言 */ }
  // 输入历史：↑ 翻上一条（本机记录）
  let hist = null;
  try {
    hist = JSON.parse(await cdp.eval(`(function(){
      localStorage.setItem('dayan_input_hist', JSON.stringify(['冒烟甲','冒烟乙']));
      _histIdx=-1; _histDraft='';
      var i=document.getElementById('msgInput'); i.value='';
      function up(){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true})); return i.value; }
      var a=up(), b=up();
      i.value=''; _histIdx=-1; localStorage.removeItem('dayan_input_hist');
      return JSON.stringify({a:a,b:b});
    })()`));
  } catch { /* 历史召回这一项失败不影响其它断言 */ }
  // 快捷键小抄：? 打开、Esc 关闭
  let sc = null;
  try {
    await cdp.eval(`(function(){ try{ document.activeElement && document.activeElement.blur(); }catch(e){} return 1; })()`);
    await new Promise((r) => setTimeout(r, 120));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 8, key: '?', code: 'Slash', windowsVirtualKeyCode: 191 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: '?', code: 'Slash', windowsVirtualKeyCode: 191 });
    await new Promise((r) => setTimeout(r, 500));
    sc = JSON.parse(await cdp.eval(`(function(){ var o=document.getElementById('scOverlay');
      return JSON.stringify({open:!!o, shown:o?o.classList.contains('show'):false, rows:o?o.querySelectorAll('.sc-row').length:0}); })()`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise((r) => setTimeout(r, 600));
    sc.closed = await cdp.eval(`!document.getElementById('scOverlay')`);
  } catch { /* 小抄这一项失败不影响其它断言 */ }
  // 当前对话筛选：逻辑对得上（用两行假消息，不动真数据）
  let findRes = null;
  try {
    findRes = JSON.parse(await cdp.eval(`(function(){
      var box=document.getElementById('chatBox');
      var a=document.createElement('div'); a.className='row'; a.innerHTML='<div class="msg-text">苹果派</div>';
      var b=document.createElement('div'); b.className='row'; b.innerHTML='<div class="msg-text">香蕉</div>';
      box.appendChild(a); box.appendChild(b);
      var hit=chatFindRun('苹果');
      var count=(document.getElementById('chatFindCount')||{}).textContent;
      var hiddenB=(b.style.display==='none');
      chatFindClose();
      var restored=(b.style.display!=='none');
      a.remove(); b.remove();
      return JSON.stringify({hit:hit, count:count, hiddenB:hiddenB, restored:restored, closed:!document.getElementById('chatFindBar').classList.contains('on')});
    })()`));
  } catch { /* 筛选这一项失败不影响其它断言 */ }
  // 失败态文案：404 要给出「可能被删了」+ 刷新按钮；超时要说人话
  let errCopy = null;
  try {
    errCopy = JSON.parse(await cdp.eval(`(function(){
      var a=document.createElement('div'); a.innerHTML=_fvErrHtml(new Error('HTTP 404'));
      return JSON.stringify({del:/已经被删掉/.test(a.innerText), btn:!!a.querySelector('button'),
        tmo:String(netErr(new Error('Request timeout'))).indexOf('等太久')>=0}); })()`));
  } catch { /* 文案检查失败不影响其它断言 */ }
  check('预览失败与超时都会说人话',
    !!errCopy && errCopy.del === true && errCopy.btn === true && errCopy.tmo === true,
    JSON.stringify(errCopy));

  // 还有更早的消息没加载时，筛选条要给出「载入更早」
  let moreBtn = null;
  try {
    moreBtn = JSON.parse(await cdp.eval(`(function(){
      var prev = (typeof allLoaded==='undefined') ? true : allLoaded;
      allLoaded = false;
      chatFindOpen();
      var q=document.getElementById('chatFindQ'); q.value='几乎不可能命中的词'; q.dispatchEvent(new Event('input',{bubbles:true}));
      var m=document.getElementById('chatFindMore');
      var shown = m ? getComputedStyle(m).display !== 'none' : false;
      chatFindClose();
      allLoaded = prev;
      return JSON.stringify({shown:shown, label:m?m.textContent:''});
    })()`));
  } catch { /* 这一项失败不影响其它断言 */ }
  check('没命中且还有更早消息时给出「载入更早」',
    !!moreBtn && moreBtn.shown === true && moreBtn.label === '载入更早',
    JSON.stringify(moreBtn));

  // 中断后未回复的用户消息：给出「重新发送」（用假 messages 渲染一次，读完复原）
  let unanswered = null;
  try {
    unanswered = JSON.parse(await cdp.eval(`(function(){
      var bak = (typeof messages!=='undefined' && messages) ? messages.slice() : null;
      try {
        messages = [{ role:'you', text:'自检：这条没有回复', id: 987654321, ts: Math.floor(Date.now()/1000) }];
        render();
        var b = document.querySelector('#chatBox .resend-btn');
        return JSON.stringify({has:!!b, txt:b?b.textContent.trim():''});
      } finally {
        if(bak){ messages = bak; try{ render(); }catch(e){} }
      }
    })()`));
  } catch { /* 这一项失败不影响其它断言 */ }
  // 设置开关存不上：本机状态要退回去，并且给出提示
  let toggleFail = null;
  try {
    toggleFail = JSON.parse(await cdp.eval(`(async function(){
      var realFetch = window.fetch;
      var prev = localStorage.getItem('llm_cache_enabled');
      window.fetch = function(){ return Promise.reject(new TypeError('自检用的网络故障')); };
      localStorage.setItem('llm_cache_enabled','0');
      toggleLlmCache(true);
      await new Promise(function(r){ setTimeout(r, 350); });
      var ls = localStorage.getItem('llm_cache_enabled');
      var toast = document.getElementById('msgToast');
      var txt = toast ? String(toast.textContent||'') : '';
      window.fetch = realFetch;
      if(prev === null) localStorage.removeItem('llm_cache_enabled'); else localStorage.setItem('llm_cache_enabled', prev);
      return JSON.stringify({ ls: ls, toast: txt.slice(0, 40) });
    })()`));
  } catch { /* 这一项失败不影响其它断言 */ }
  check('设置开关存不上会退回并提示',
    !!toggleFail && toggleFail.ls === '0' && /没保存上/.test(toggleFail.toast || ''),
    JSON.stringify(toggleFail));

  check('没有回复的用户消息能重新发送',
    !!unanswered && unanswered.has === true && /重新发送/.test(unanswered.txt || ''),
    JSON.stringify(unanswered));

  check('Ctrl+F 能在当前对话里筛选并复原',
    !!findRes && findRes.hit === 1 && /1\//.test(findRes.count || '') && findRes.hiddenB === true
      && findRes.restored === true && findRes.closed === true,
    JSON.stringify(findRes));

  // 可见控件都要有可读的名字（按钮/链接/输入框）
  let unnamed = null;
  try {
    unnamed = JSON.parse(await cdp.eval(`(function(){
      var bad=[];
      function vis(el){ var r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'; }
      function nm(el){ return (el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim(); }
      document.querySelectorAll('button,a[href]').forEach(function(el){ if(vis(el)&&!nm(el)) bad.push('btn:'+(el.id||el.className||el.tagName)); });
      document.querySelectorAll('input,textarea,select').forEach(function(el){
        if(!vis(el)) return;
        var lab=el.getAttribute('aria-label')||el.getAttribute('placeholder')||'';
        if(!lab && el.labels && el.labels.length) lab=el.labels[0].textContent;
        if(!lab) bad.push('field:'+(el.id||el.name||el.tagName));
      });
      return JSON.stringify(bad.slice(0,10));
    })()`));
  } catch { /* 这一项失败不影响其它断言 */ }
  check('可见控件都有可读名字', Array.isArray(unnamed) && unnamed.length === 0, JSON.stringify(unnamed));

  check('问号能打开键盘快捷键小抄',
    !!sc && sc.open === true && sc.shown === true && sc.rows >= 6 && sc.closed === true,
    JSON.stringify(sc));

  check('输入框能用 ↑ 翻出发过的话',
    !!hist && hist.a === '冒烟乙' && hist.b === '冒烟甲',
    JSON.stringify(hist));

  check('键盘第一个 Tab 能跳过侧栏直达输入框',
    !!skipLink && skipLink.found === true && skipLink.active === true && skipLink.top >= 0 && skipLink.after === 'msgInput',
    JSON.stringify(skipLink));

  // 对话框：读屏要知道这是弹窗；键盘 Tab 不许跑到背后的页面上
  let dlgA11y = null;
  try {
    await cdp.eval(`(function(){ window.__dlgProbe = uiConfirm({title:'\u81ea\u68c0\u786e\u8ba4\u6846', message:'\u81ea\u68c0\u6d88\u606f', okText:'\u786e\u5b9a', danger:true}); return 1; })()`);
    await new Promise((r) => setTimeout(r, 600));
    const attrs = JSON.parse(await cdp.eval(`(function(){
      var o=document.querySelector('.ui-dlg-overlay'); var d=o&&o.querySelector('.ui-dlg-box');
      var a=document.activeElement;
      return JSON.stringify({role:d&&d.getAttribute('role'), modal:d&&d.getAttribute('aria-modal'),
        labelled:!!(d&&d.getAttribute('aria-labelledby')), inside:!!(o&&o.contains(a)), tag:a&&a.tagName});
    })()`));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' });
    await new Promise((r) => setTimeout(r, 150));
    const afterTab = JSON.parse(await cdp.eval(`(function(){
      var o=document.querySelector('.ui-dlg-overlay'); var a=document.activeElement;
      return JSON.stringify({inside:!!(o&&o.contains(a)), tag:a&&a.tagName, txt:(a&&a.textContent||'').slice(0,8)});
    })()`));
    dlgA11y = Object.assign({}, attrs, { afterTab });
    await cdp.eval(`(function(){ var o=document.querySelector('.ui-dlg-overlay'); if(o){ var c=o.querySelector('.ui-dlg-btn.ghost'); if(c) c.click(); } return 1; })()`);
  } catch (e) { dlgA11y = { err: String(e.message || e) }; }
  // 代码块：右上角有「复制」，点下去真的写进剪贴板
  let codeCopy = null;
  try {
    codeCopy = JSON.parse(await cdp.eval(`(async function(){
      var F=String.fromCharCode(96), NL=String.fromCharCode(10);
      var md=['\u0060\u0060\u0060bash','echo hi','\u0060\u0060\u0060'].join(NL);
      var d=document.createElement('div');
      d.style.cssText='position:fixed;left:20px;top:70px;width:380px;z-index:9';
      d.innerHTML=fmt(md);
      document.body.appendChild(d);
      var wrap=d.querySelector('.code-wrap'), btn=d.querySelector('.code-copy');
      var got=null, real=navigator.clipboard && navigator.clipboard.writeText;
      if(navigator.clipboard){ navigator.clipboard.writeText=function(t){ got=t; return Promise.resolve(); }; }
      if(btn) btn.click();
      await new Promise(function(s){ setTimeout(s,220); });
      var out={wrap:!!wrap, btn:btn?btn.textContent:null, got:got};
      if(navigator.clipboard && real){ navigator.clipboard.writeText=real; }
      d.remove();
      return JSON.stringify(out);
    })()`));
  } catch (e) { codeCopy = { err: String(e.message || e) }; }
  // 没配 Key 时，侧栏底部与顶栏别显示成两行破折号
  let noKeyWords = null;
  try {
    const cfg = await (await fetch(BASE + '/api/project-config')).json();
    await cdp.eval(`(async function(){ try{ await refreshKeyBanner(); }catch(e){} return 1; })()`);
    await new Promise((r) => setTimeout(r, 300));
    noKeyWords = JSON.parse(await cdp.eval(`(function(){
      var v=document.getElementById('sidebarCostVal'), t=document.getElementById('sidebarTokens');
      var b=document.getElementById('balanceDisplay');
      return JSON.stringify({cost:v?v.textContent:null, tokens:t?t.textContent:null, top:b?b.innerText.trim():null});
    })()`));
    noKeyWords.hasKey = !!cfg.has_key;
  } catch (e) { noKeyWords = { err: String(e.message || e) }; }
  check('没配 Key 时侧栏说的是「未配 Key」而不是破折号',
    !!noKeyWords && (noKeyWords.hasKey === true
      || (String(noKeyWords.cost) === '未配 Key' && String(noKeyWords.tokens) === '未统计')),
    JSON.stringify(noKeyWords));

  // 系统页要能看出「跑了多久 / 数据库多大 / 磁盘还剩多少」
  let sysInfo = null;
  try {
    sysInfo = JSON.parse(await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('system');
      for (var i=0;i<20;i++){ await new Promise(function(r){setTimeout(r,150)}); var b=document.querySelector('#settingsBody'); if(b && /运行时长/.test(b.innerText)) break; }
      var t=document.querySelector('#settingsBody').innerText;
      try{ if(typeof closeSettings==='function') closeSettings(); }catch(e){}
      return JSON.stringify({uptime:/运行时长:/.test(t), db:/数据库:/.test(t), disk:/磁盘剩余:/.test(t)});
    })()`));
  } catch { /* 系统信息这项失败不影响其它断言 */ }
  check('系统页会报告运行时长与库大小',
    !!sysInfo && sysInfo.uptime === true && sysInfo.db === true,
    JSON.stringify(sysInfo));

  // 没配 Key 时不该弹「余额已耗尽，请充值」
  let balBanner = null;
  try {
    balBanner = JSON.parse(await cdp.eval(`(function(){
      var b=document.getElementById('balanceBanner');
      updateBalanceBanner({ total_balance: 0, currency: 'CNY' });
      var shown=b.classList.contains('show');
      b.classList.remove('show','warn-low','warn-crit');
      return JSON.stringify({ shown: shown, noKey: (typeof _keyBannerState!=='undefined') ? _keyBannerState : null });
    })()`));
  } catch { balBanner = null; }
  check('没配 Key 时不弹「余额已耗尽」',
    !!balBanner && (balBanner.noKey !== true || balBanner.shown === false),
    JSON.stringify(balBanner));

  check('代码块有复制按钮、点了进剪贴板',
    !!codeCopy && codeCopy.wrap === true && /\u5df2\u590d\u5236|\u590d\u5236/.test(String(codeCopy.btn || ''))
      && String(codeCopy.got || '').indexOf('echo hi') >= 0,
    JSON.stringify(codeCopy));

  check('确认框是模态对话框、Tab 不跑出去',
    !!dlgA11y && dlgA11y.role === 'dialog' && dlgA11y.modal === 'true' && dlgA11y.labelled === true
      && dlgA11y.inside === true && !!(dlgA11y.afterTab && dlgA11y.afterTab.inside === true),
    JSON.stringify(dlgA11y));
    check('快速跳转至少 8 个条目', (p.items || 0) >= 8, `items=${p.items}`);
    const filtered = await cdp.eval(`(function(){
      var i=document.getElementById('cmdkInput'); if(!i) return 'no-input';
      i.value='设置'; i.dispatchEvent(new Event('input',{bubbles:true}));
      return JSON.stringify([].slice.call(document.querySelectorAll('#cmdkList .cmdk-item')).map(function(e){return e.textContent.trim();}));
    })()`);
    check('输入「设置」能筛出设置项', String(filtered).includes('设置'), filtered);
    await shot('palette');
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await sleep(250);
    const closed = await cdp.eval(`(function(){var o=document.getElementById('cmdkOverlay');return !o || getComputedStyle(o).display==='none';})()`);
    check('Esc 关闭快速跳转', closed === true, String(closed));

    // ── 3. 空态起手式 ─────────────────────────────────
    const chip = JSON.parse(await cdp.eval(`(async function(){
      var btn=document.querySelector('.empty-tags button'); if(!btn) return JSON.stringify({err:'no-chip'});
      btn.click();
      var i=document.getElementById('msgInput'); if(!i) return JSON.stringify({err:'no-input'});
      for(var n=0;n<20 && String(i.value).length<10;n++){ await new Promise(function(r){setTimeout(r,150)}); }
      var len=String(i.value).length;
      i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
      var tid=currentTopic?currentTopic.id:'';
      if(currentTopic){ try{
        await fetch('/api/topic/delete',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({topic_id:currentTopic.id})}); }catch(e){} }
      try { await loadTopics(); } catch(e) {}
      return JSON.stringify({len:len, tid:tid});
    })()`));
    check('空态 chip 能填入起手式', !!(chip && chip.len > 10 && chip.tid), JSON.stringify(chip));

    // ── 4. 设置 + 搜索 ────────────────────────────────
    await cdp.eval(`(function(){try{openSettings();}catch(e){return 'err';}})()`);
    await sleep(900);
    const sp = await cdp.eval(`(function(){
      var i=document.getElementById('spSearch'); if(!i) return 'no-input';
      i.value='模型'; i.dispatchEvent(new Event('input',{bubbles:true}));
      var vis=[].slice.call(document.querySelectorAll('#settingsBody .sp-menu-item,#settingsBody .sp-toggle-row'))
        .filter(function(e){return e.offsetParent!==null}).map(function(e){var l=e.querySelector('.sp-menu-label');return (l||e).textContent.trim();});
      i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
      return JSON.stringify(vis);
    })()`);
    check('设置搜索按标题过滤', String(sp).includes('模型配置') && JSON.parse(sp || '[]').length <= 3, sp);
    await shot('settings');

    // ── 5. 文件面板工具条不溢出 ───────────────────────
    await cdp.eval(`(function(){try{spBackClick();}catch(e){} try{toggleFileBrowser();}catch(e){}})()`);
    await sleep(1600);
    const fb = await cdp.eval(`(function(){
      var panel=document.getElementById('fileBrowser')||document.querySelector('.fb-panel');
      if(!panel) return 'no-panel';
      var row=panel.querySelector('.fb-path-row'); if(!row) return 'no-row';
      var rr=row.getBoundingClientRect();
      var btns=[].slice.call(row.querySelectorAll('button'));
      var bad=btns.filter(function(x){var r=x.getBoundingClientRect();return r.width>0&&(r.right>rr.right+1||r.left<rr.left-1);})
        .map(function(x){var r=x.getBoundingClientRect();return (x.title||x.getAttribute('aria-label')||x.className||'btn')+'@'+Math.round(r.right)+'>'+Math.round(rr.right);});
      return JSON.stringify({w:Math.round(rr.width),btns:btns.length,bad:bad,overflow:row.scrollWidth>row.clientWidth+2,nf:!!row.querySelector('#fbNewFolderBtn svg')});
    })()`);
    let fbOk = false;
    try {
      const o = JSON.parse(fb);
      fbOk = o.bad.length === 0 && o.overflow === false && o.nf === true;
    } catch { /* no-panel 等 */ }
    check('文件面板工具条不溢出/不裁切（含新建文件夹）', fbOk, fb);
    await shot('files');
    await cdp.eval(`(function(){try{closeFileBrowser();}catch(e){}})()`);
    await sleep(400);

    // ── 6. 运行状态面板数字 ───────────────────────────
    await cdp.eval(`(function(){try{openSysMemory();}catch(e){}})()`);
    await sleep(1400);
    const st = await cdp.eval(`(function(){
      var m=document.getElementById('sysMemoryModal'); if(!m) return 'no-modal';
      var vals=[].slice.call(m.querySelectorAll('.sys-stat b')).map(function(e){return e.textContent.trim();});
      var about=(document.getElementById('sysAbout')||{textContent:''}).textContent.trim();
      return JSON.stringify({shown:m.classList.contains('show')||getComputedStyle(m).display!=='none',vals:vals.slice(0,4),about:about.slice(0,40)});
    })()`);
    let stOk = false;
    try {
      const o = JSON.parse(st);
      stOk = o.shown === true && Array.isArray(o.vals) && o.vals.length >= 2 && o.vals.every((v) => v !== '');
    } catch { /* no-modal */ }
    check('状态面板有内容（0 也要显示）', stOk, st);
    // 晶体清单是折叠块：展开后才拉接口。这里只验它存在、摘要文案对，不依赖库里有晶体
    const crl = await cdp.eval(`(function(){
      var d=document.getElementById('crystalListBox');
      if(!d) return 'no-details';
      var s=(d.querySelector('summary')||{}).textContent||'';
      return JSON.stringify({tag:d.tagName,text:s.trim(),open:d.open});
    })()`);
    let crlOk = false;
    try { const o = JSON.parse(crl); crlOk = o.tag === 'DETAILS' && /已索引的文件/.test(o.text); } catch { /* no-details */ }
    check('状态面板有「已索引的文件」折叠块', crlOk, crl);
    const terr = await cdp.eval("(function(){return typeof window.toastErr==='function' ? 'ok' : 'missing';})()");
    check('错误提示走站内 toast（toastErr 存在）', terr === 'ok', String(terr));
    const uiErrShot = await cdp.eval(`(function(){
      if(typeof window.uiErr !== 'function') return 'missing';
      window.uiErr('自检错误', 1200);
      var t = document.getElementById('msgToast');
      if(!t) return 'no-node';
      return (t.className.indexOf('err') >= 0 ? 'err' : 'no-err') + '|' + (t.textContent || '').trim();
    })()`);
    check('uiErr 用红调提示条而不是原生 alert', String(uiErrShot).indexOf('err|') === 0 && String(uiErrShot).indexOf('自检错误') > 0, String(uiErrShot));
    await shot('status');

    // ── 6b. 记忆检索输入框真的能查（空库也算过：只要不报错）──
    await cdp.eval(`(function(){try{var i=document.getElementById('memQ');if(i){i.value='记忆检索';}return 1;}catch(e){return 0;}})()`);
    await cdp.eval(`(function(){try{return memRecall();}catch(e){return null;}})()`);
    await sleep(1200);
    const mem = await cdp.eval(`(function(){
      var out=document.getElementById('memRecallOut');
      var inp=document.getElementById('memQ');
      if(!inp||!out) return JSON.stringify({hasInput:false});
      var hits=out.querySelectorAll('.mem-hit').length;
      var txt=String(out.innerText||'').trim();
      return JSON.stringify({hasInput:true,hits:hits,failed:/失败/.test(txt),text:txt.slice(0,26)});
    })()`);
    let memOk = false;
    try { const o = JSON.parse(mem); memOk = o.hasInput === true && o.failed === false; } catch { /* no-input */ }
    check('记忆检索能返回结果或空态', memOk, mem);

    // ── 6c. 知识页：面板里有入口，展开能拉到列表（空库给空态文案，不能是"加载中"卡住）──
    const kp = await cdp.eval(`(async function(){
      var box=document.getElementById('kpBox'); if(!box) return JSON.stringify({has:false});
      box.open=true; box.dispatchEvent(new Event('toggle'));
      await new Promise(function(s){setTimeout(s,900)});
      var items=document.querySelectorAll('#kpList .kp-item').length;
      var txt=String((document.getElementById('kpList')||{}).innerText||'');
      var btn=!!document.getElementById('kpComposeBtn');
      return JSON.stringify({has:true, items:items, btn:btn,
        empty:/还没有知识页/.test(txt), failed:/加载失败/.test(txt), stuck:/加载中/.test(txt)});
    })()`);
    let kpOk = false;
    try {
      const o = JSON.parse(kp);
      kpOk = o.has === true && o.btn === true && o.failed === false && o.stuck === false
        && (o.items > 0 || o.empty === true);
    } catch { /* ignore */ }
    check('记忆面板的知识页能加载', kpOk, kp);
    await cdp.eval(`(function(){try{document.getElementById('sysMemoryModal').classList.remove('show');}catch(e){}})()`);

    // ── 7. 消息流 Markdown 渲染（注入假数据，不落库）────
    const chat = await cdp.eval(`(function(){
      try{
        var B=String.fromCharCode(96);
        var code=B+B+B+'python\\nimport asyncio\\nsem = asyncio.Semaphore(8)\\n'+B+B+B;
        var now=Math.floor(Date.now()/1000);
        messages=[
          {role:'you',text:'帮我看下这段异步代码',ts:now-120,id:'smoke-u1'},
          {role:'ai',text:'**结论**：先并发再限流。\\n\\n- 用 '+B+'asyncio.gather'+B+' 并发\\n- 用 Semaphore 限流\\n\\n'+code+'\\n\\n详见 [文档](https://example.com)。',ts:now-60,id:'smoke-a1'}
        ];
        render();
        var box=document.getElementById('chatBox');
        var out={
          bubbles: box?box.querySelectorAll('.bubble').length:0,
          pre: box?box.querySelectorAll('.bubble pre').length:0,
          strong: box?box.querySelectorAll('.bubble strong,.bubble b').length:0,
          li: box?box.querySelectorAll('.bubble li').length:0,
          link: box?box.querySelectorAll('.bubble a[href]').length:0
        };
        messages=[]; render();
        return JSON.stringify(out);
      }catch(e){ return 'err:'+e.message; }
    })()`);
    let chatOk = false;
    try {
      const o = JSON.parse(chat);
      chatOk = o.bubbles >= 2 && o.pre >= 1 && o.li >= 2 && o.strong >= 1 && o.link >= 1;
    } catch { /* err: */ }
    check('消息流渲染 Markdown（代码块/列表/强调/链接）', chatOk, chat);

    // 消息动作条：复制按钮点下去要有反馈（.on 打勾），不能在无剪贴板权限时静默失败
    const act = await cdp.eval(`(async function(){
      try{
        var B=String.fromCharCode(96);
        var now=Math.floor(Date.now()/1000);
        messages=[
          {role:'you',text:'复制我',ts:now-30,id:'smoke-u2'},
          {role:'ai',text:'**要点**：先量再改。\\n\\n- 记录基线\\n- 只改一处',ts:now-20,id:'smoke-a2'}
        ];
        render();
        var btn=document.querySelector('.msg-copy2');
        if(!btn) return 'no-btn';
        btn.click();
        await new Promise(function(r){setTimeout(r,300);});
        var on=btn.classList.contains('on');
        var txt=(document.querySelector('.msg-body')||{}).textContent||'';
        messages=[]; render();
        return JSON.stringify({on:on,len:txt.trim().length});
      }catch(e){ return 'err:'+e.message; }
    })()`);
    let actOk = false;
    try { const o = JSON.parse(act); actOk = o.on === true && o.len > 0; } catch { /* err: */ }
    check('消息动作条复制有反馈', actOk, act);

    // ── 8. 搜索结果的命中卡片（直接喂假数据）────────────
    const sr = await cdp.eval(`(function(){
      try{
        if(typeof _renderSearchResults!=='function') return 'no-fn';
        var fake={hits:[{id:'s1',title:'异步改造',last_message:'把脚本改成异步',title_match:1,summary_match:0,
          messages:[{id:'m1',role:'user',snippet:'帮我把脚本改成异步'}],updated_at:Math.floor(Date.now()/1000)}]};
        _searchMode=true; _searchQ='异步'; _renderSearchResults(fake);
        var out={badge:document.querySelectorAll('#topicList .ss-badge').length,
                 mark:document.querySelectorAll('#topicList mark').length};
        if(typeof ssClear==='function') ssClear();
        return JSON.stringify(out);
      }catch(e){ return 'err:'+e.message; }
    })()`);
    let srOk = false;
    try { const o = JSON.parse(sr); srOk = o.badge >= 1 && o.mark >= 1; } catch { /* err: */ }
    check('搜索命中卡片带来源徽标与高亮', srOk, sr);

    // ── 9. 移动端抽屉 ─────────────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(5000);
    const m1 = await cdp.eval(`(function(){
      var s=document.getElementById('sidebar'), m=document.getElementById('mainPanel');
      return JSON.stringify({w:innerWidth,main:m?Math.round(m.getBoundingClientRect().width):-1,cls:s?s.className:''});
    })()`);
    let m1Ok = false;
    try { const o = JSON.parse(m1); m1Ok = o.w === 390 && o.main === 390; } catch { /* ignore */ }
    check('390 宽下主面板不被侧栏挤窄', m1Ok, m1);
    await cdp.eval(`(function(){try{toggleSidebar();}catch(e){}})()`);
    // 滑出动画有时比固定等待慢一拍：轮询到 left=0 再断言，别让时序变成 flaky
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const leftNow = Number(await cdp.eval(`Math.round(document.getElementById('sidebar').getBoundingClientRect().left)`));
      if (leftNow === 0) break;
    }
    const m2 = await cdp.eval(`(function(){
      var s=document.getElementById('sidebar'), o=document.getElementById('overlay');
      var r=s?s.getBoundingClientRect():{left:-1};
      return JSON.stringify({left:r.left,overlay:o?o.className.indexOf('show')>=0:null});
    })()`);
    let m2Ok = false;
    try { const o = JSON.parse(m2); m2Ok = o.left === 0 && o.overlay === true; } catch { /* ignore */ }
    check('移动端抽屉滑出且有遮罩', m2Ok, m2);
    await shot('mobile-sidebar');

    // ── 9b. 手机竖屏的资产库要铺满（以前 86vw 会留一条能误触的缝）──
    await cdp.eval(`(function(){try{toggleSidebar();}catch(e){}})()`);   // 先收起侧栏，免得叠层
    await sleep(400);
    await cdp.eval(`(function(){try{openAssetView();}catch(e){}})()`);
    await sleep(1200);
    const m3 = await cdp.eval(`(function(){
      var w=document.getElementById('abWindow');
      var r=w?w.getBoundingClientRect():{left:-1,width:-1};
      return JSON.stringify({vw:innerWidth,left:Math.round(r.left),w:Math.round(r.width)});
    })()`);
    let m3Ok = false;
    try { const o = JSON.parse(m3); m3Ok = o.left === 0 && o.w >= o.vw - 2; } catch { /* ignore */ }
    check('手机竖屏资产库铺满整屏', m3Ok, m3);
    await cdp.eval(`(function(){try{closeAssetView();}catch(e){}})()`);
    await shot('mobile-assets');

    // ── 8d. 站内对话框支持多行（速记要能换行，不能是单行 input）──
    const dlgProbe = await cdp.eval(`(function(){
      window.__dlgP = uiPrompt({title:'自检', multiline:true});   // 不 await：先看 DOM
      var f = document.querySelector('.ui-dlg-field');
      var tag = f ? f.tagName : '';
      var area = f ? f.classList.contains('ui-dlg-area') : false;
      var gh = document.querySelector('.ui-dlg-btn.ghost'); if (gh) gh.click();   // 取消掉，别留浮层
      return JSON.stringify({tag: tag, area: area});
    })()`);
    let dlgOk = false;
    try { const o = JSON.parse(dlgProbe); dlgOk = o.tag === 'TEXTAREA' && o.area === true; } catch { /* ignore */ }
    check('站内对话框支持多行输入', dlgOk, dlgProbe);

    // ── 8c2. 没有任务时「新建文件夹」也该收起来（它走 /api/file-op，需要 topic_id）──
    const nf = await cdp.eval(`(function(){
      try{ fbSyncUploadBar(); }catch(e){}
      var b=document.querySelector('[data-fb-el="fbNewFolderBtn"]');
      return JSON.stringify({can: (typeof fbCanUpload==='function')?fbCanUpload():null, disp: b?b.style.display:'missing'});
    })()`);
    let nfOk = false;
    try { const o = JSON.parse(nf); nfOk = o.can === false && o.disp === 'none'; } catch { /* ignore */ }
    check('没有任务时不显示新建文件夹', nfOk, nf);

    // ── 8b. 资产库有搜索框，且输入后列表真的收窄 ──────────
    await cdp.eval("(function(){try{openAssetView();}catch(e){} return 1;})()");
    await sleep(600);
    const abQ = await cdp.eval(`(function(){
      var i=document.getElementById('abQ');
      if(!i) return JSON.stringify({has:false});
      i.value='绝不可能命中的关键字';
      i.dispatchEvent(new Event('input',{bubbles:true}));
      var empty=!!document.querySelector('#abPanel .ap-loading');
      var txt=(document.querySelector('#abPanel .ap-loading')||{}).textContent||'';
      i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));
      try{ closeAssetView(); }catch(e){}
      return JSON.stringify({has:true, empty:empty, txt:txt});
    })()`);
    let abOk = false, abInfo = abQ;
    try { const o = JSON.parse(abQ); abOk = o.has === true && o.empty === true && /没有匹配/.test(o.txt || ''); } catch { /* ignore */ }
    check('资产库搜索框能过滤列表', abOk, abInfo);

    // ── 8b2. 存链接的资产在时间流里有「外链」牌子，不和笔记混在一起 ──
    const linkTile = await cdp.eval(`(async function(){
      var made=null;
      try{
        made=await (await fetch('/api/assets/v3/new_link',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({url:'https://example.com/smoke',note:'外链卡片自检',tags:['自检']})})).json();
        openAssetView();
        // 新建链接资产要走一次抓标题，网络慢时 700ms 不一定够：轮询到卡片出现再断言
        var t=null;
        for (var _i=0; _i<20; _i++){
          await new Promise(function(r){setTimeout(r,200);});
          t=document.querySelector('#abPanel .ab-tile-link');
          if(t) break;
        }
        var badge=t&&t.querySelector('.ab-link-badge');
        var rib=t&&t.querySelector('.ab-ntag.lk');
        var out={found:!!t, badge:badge?badge.textContent:'', ribbon:rib?rib.textContent:''};
        if(made&&made.id) await fetch('/api/assets/v3/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:made.id})});
        try{ closeAssetView(); }catch(e){}
        return JSON.stringify(out);
      }catch(e){ return JSON.stringify({found:false, err:String(e)}); }
    })()`);
    let ltOk = false, ltInfo = linkTile;
    try { const o = JSON.parse(linkTile); ltOk = o.found === true && o.ribbon === '外链' && o.badge === '↗'; } catch { /* ignore */ }
    check('链接资产在列表里有外链标记', ltOk, ltInfo);
    await sleep(400);
    await sleep(500);   // 让关面板时的收尾请求落地，免得和下面的断线测试抢时序

    // ── 8c. 上传条的同步函数必须是全局的 ────────────
    // 早先它被写进 wsTabBody 里，资产库浏览层调用时报 no-fn，上传按钮就永远留在那儿
    const upFn = await cdp.eval(`JSON.stringify({can: typeof fbCanUpload, sync: typeof fbSyncUploadBar})`);
    let upOk = false;
    try { const o = JSON.parse(upFn); upOk = o.can === 'function' && o.sync === 'function'; } catch { /* ignore */ }
    check('上传条同步函数是全局函数', upOk, upFn);

    // ── 8e. 代码存档：页面读的是本机 zip 快照（不再依赖守护进程、也不假装「暂无存档」）──
    const verProbe = await cdp.eval(`(async function(){
      var api = await (await fetch('/api/versions')).json();
      openSettings(); pushSettingsView('versions');
      await new Promise(function(s){setTimeout(s,1800)});
      var t = (document.getElementById('settingsBody')||{}).innerText || '';
      return JSON.stringify({
        n: (api.archives||[]).length, hashLen: String(api.current_hash||'').length,
        hasSection: /代码存档/.test(t), hasItem: /个文件/.test(t),
        saysMissing: /没在跑|没接上/.test(t)
      });
    })()`);
    let verOk = false;
    try {
      const o = JSON.parse(verProbe);
      verOk = o.n > 0 && o.hashLen >= 8 && o.hasSection === true && o.hasItem === true && o.saysMissing === false;
    } catch { /* ignore */ }
    check('代码存档能列出本机快照', verOk, verProbe);

    // ── 8f. 系统页有「最近的错误」区块（空态也要说人话） ──────
    const errBox = await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('system');
      await new Promise(function(s){setTimeout(s,1500)});
      var b = document.getElementById('sysErrBox');
      var r = await (await fetch('/api/diagnostics/errors')).json().catch(function(){ return {}; });
      return JSON.stringify({ has: !!b, txt: b ? b.innerText.slice(0, 40) : '', count: (r && r.count) });
    })()`);
    let ebOk = false, ebInfo = errBox;
    try { const o = JSON.parse(errBox); ebOk = o.has === true && /错误/.test(o.txt || '') && typeof o.count === 'number'; } catch { /* ignore */ }
    check('系统页能看到最近的错误', ebOk, ebInfo);
    const ebBtn = await cdp.eval(`(function(){var b=document.querySelector('#settingsBody button[onclick="clearSysErrors()"]');return b?b.innerText.trim():'missing';})()`);
    check('最近的错误有清空按钮', ebBtn === '清空', ebBtn);
    await cdp.eval("(function(){try{closeSettings();}catch(e){} return 1;})()");

    // ── 9b. 断线横幅 ─────────────────────────────────────
    // 轮询等状态，别用固定 sleep —— 横幅的显隐本来就带 900ms 动画窗口，
    // 固定等待在忙的时候会抢在动画前面读到旧状态（这条曾经偶发失败）
    const bannerShow = await cdp.eval(`(async function(){
      netHealthFail();
      var b=document.getElementById('netBanner');
      for(var i=0;i<20 && !(b&&b.classList.contains('show'));i++){ await new Promise(function(r){setTimeout(r,100)}); }
      var on=!!(b&&b.classList.contains('show'));
      var txt=b?b.innerText.replace(/\\n/g,'|'):'';
      netHealthOk();
      for(var j=0;j<40 && b && b.classList.contains('show');j++){ await new Promise(function(r){setTimeout(r,100)}); }
      var off=!!(b&&!b.classList.contains('show'));
      return JSON.stringify({on:on,off:off,txt:txt});
    })()`);
    let bOk = false;
    try { const o = JSON.parse(bannerShow); bOk = o.on === true && o.off === true && /断开/.test(o.txt); } catch { /* ignore */ }
    check('断线横幅出现并在恢复后隐藏', bOk, bannerShow);

    const abortSafe = await cdp.eval(`(async function(){
      var ac=new AbortController();
      var p=fetch('/api/health',{signal:ac.signal}).catch(function(e){return e.name;});
      ac.abort(); var name=await p;
      await new Promise(function(s){setTimeout(s,450)});
      var b=document.getElementById('netBanner');
      return JSON.stringify({err:name, shown:!!(b&&b.classList.contains('show'))});
    })()`);
    let aOk = false;
    try { const o = JSON.parse(abortSafe); aOk = o.err === 'AbortError' && o.shown === false; } catch { /* ignore */ }
    check('主动中止请求不算断线', aOk, abortSafe);

    // 9c. 错误行上的「去填 Key」能直接把人送到设置 → 模型
    const keyBtn = await cdp.eval(`(async function(){
      messages.push({role:'you',text:'密钥自检',ts:Date.now()/1000,error:true,
        error_msg:'还没有配置模型密钥，先填一个再聊｜设置 → 模型 → 填 API Key'});
      render();
      await new Promise(function(r){setTimeout(r,260)});
      var btns=[].slice.call(document.querySelectorAll('.resend-btn'));
      var b=btns.filter(function(x){return x.textContent.indexOf('去填 Key')>=0;})[0];
      if(!b) return JSON.stringify({btn:false});
      b.click();
      await new Promise(function(r){setTimeout(r,900)});
      var body=(document.getElementById('settingsBody')||{}).innerText||'';
      var open=document.getElementById('sidebarSettings');
      var vis=!!(open&&open.classList.contains('active'));
      closeSettings();
      return JSON.stringify({btn:true,vis:vis,model:/模型/.test(body.slice(0,30))});
    })()`);
    let kbOk = false;
    try { const o = JSON.parse(keyBtn); kbOk = o.btn === true && o.vis === true && o.model === true; } catch { /* ignore */ }
    check('错误行上的「去填 Key」能打开模型设置', kbOk, keyBtn);

    // 9d. 设置 → 更新日志：必须真的画出条目（以前读的是空的 CHANGELOG.jsonl）
    const clogView = await cdp.eval(`(async function(){
      try{
      openSettings(); pushSettingsView('changelog');
      await new Promise(function(r){setTimeout(r,1200)});
      var b=document.getElementById('settingsBody');
      var rels=[].slice.call(b.querySelectorAll('.cl-rel'));
      // 别拿整段 innerText 判断「暂无记录」：更新日志的正文里就写着这句话
      // （v1.4.3 那条修复），会把自己判成空态。只看空态节点本身。
      var emptyEl=b.querySelector('.center-msg');
      var empty=!!emptyEl && /暂无记录/.test(emptyEl.textContent||'');
      var big=!!b.querySelector('.cl-open-big button');
      closeSettings();
      return JSON.stringify({rels:rels.length, big:big, empty:empty});
      }catch(e){ return 'ERR:'+(e&&e.message)+'|'+(e&&e.stack||'').slice(0,160); }
    })()`);
    let clogOk = false;
    try { const o = JSON.parse(clogView); clogOk = o.rels > 0 && o.empty === false && o.big === true; } catch { /* ignore */ }
    check('设置里的更新日志有内容（不再「暂无记录」）', clogOk, clogView);

    // 9e. 任务行上的「导出」按钮存在且真能导出 Markdown
    //     （造一个任务 → 点按钮 → 看 Blob 内容 → 删任务；回收站快照验完写回，不污染）
    const rp = path.resolve('data/deleted_topics_backup.jsonl');
    let rpBackup = null;
    try { rpBackup = fs.existsSync(rp) ? fs.readFileSync(rp) : null; } catch { /* ignore */ }
    const expRes = await cdp.eval(`(async function(){
      var grabbed=null, real=URL.createObjectURL, oc=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=function(b){grabbed=b;return 'blob:stub';};
      HTMLAnchorElement.prototype.click=function(){};
      try {
        var r=await fetch('/api/topic/new',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({title:'导出按钮自检'})});
        var d=await r.json();
        if(!d||!d.id) return JSON.stringify({created:false});
        await loadTopics();
        await new Promise(function(x){setTimeout(x,700)});
        var b=[].slice.call(document.querySelectorAll('.topic-actions .act-export'))[0];
        if(!b) return JSON.stringify({created:true,btn:false});
        b.click();
        await new Promise(function(x){setTimeout(x,700)});
        var txt=grabbed?await grabbed.text():'';
        await fetch('/api/topic/delete',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({topic_id:d.id})});
        await loadTopics();
        return JSON.stringify({created:true,btn:true,len:txt.length,head:txt.slice(0,24)});
      } finally { URL.createObjectURL=real; HTMLAnchorElement.prototype.click=oc; }
    })()`);
    try {
      if (rpBackup !== null) fs.writeFileSync(rp, rpBackup);
      else if (fs.existsSync(rp)) fs.unlinkSync(rp);
    } catch { /* ignore */ }
    let expOk = false;
    try { const o = JSON.parse(expRes); expOk = o.btn === true && o.len > 0 && /^# /.test(o.head || ''); } catch { /* ignore */ }
    check('任务能一键导出成 Markdown', expOk, expRes);

    // 9f. 没配密钥时输入框上方有提示条，点它能进设置
    const keyBanner = await cdp.eval(`(async function(){
      await refreshKeyBanner();
      var b=document.getElementById('keyBanner');
      if(!b) return JSON.stringify({el:false});
      var cfg=await (await fetch('/api/project-config')).json();
      var shown=getComputedStyle(b).display!=='none';
      b.click();
      await new Promise(function(r){setTimeout(r,800)});
      var side=document.getElementById('sidebarSettings');
      var open=!!(side&&side.classList.contains('active'));
      closeSettings();
      return JSON.stringify({el:true, hasKey:!!cfg.has_key, needsKey:cfg.needs_key!==false, shown:shown, open:open,
        txt:b.innerText.trim()});
    })()`);
    let bannerOk = false;
    try {
      const o = JSON.parse(keyBanner);
      bannerOk = o.el === true && o.open === true && /密钥/.test(o.txt)
        && (o.needsKey ? o.shown === true : o.shown === false);
    } catch { /* ignore */ }
    check('没配密钥时输入框上方有提示条', bannerOk, keyBanner);

    // 9f2. 没密钥时，模型页顶部有「填密钥」入口，点开就能粘
    const nokey = await cdp.eval(`(async function(){
      var cfg=await (await fetch('/api/project-config')).json();
      openSettings(); pushSettingsView('model');
      var hint=null;
      for (var _i=0; _i<20; _i++) {
        await new Promise(function(r){setTimeout(r,200)});
        hint=document.getElementById('spNoKeyHint');
        if (hint) break;
      }
      var btn=hint?hint.querySelector('button'):null;
      if(!btn) return JSON.stringify({hasKey:!!cfg.has_key, hint:!!hint, btn:false});
      btn.click();
      await new Promise(function(r){setTimeout(r,500)});
      var inp=document.querySelector('.sp-key-editor input');
      var out={hasKey:!!cfg.has_key, hint:true, btn:true, editor:!!inp};
      closeSettings();
      return JSON.stringify(out);
    })()`);
    let nokeyOk = false;
    try {
      const o = JSON.parse(nokey);
      nokeyOk = o.hasKey === true ? true : (o.hint === true && o.btn === true && o.editor === true);
    } catch { /* ignore */ }
    check('没密钥时模型页有显眼的填密钥入口', nokeyOk, nokey);

  // 模型页的「测试」入口（紧跟模型页检查，避免拿到被别的检查改过的页面状态）（真正点击走 /api/models/test，已由 api-smoke 覆盖）
  let modelTest = null;
  try {
    await cdp.eval(`(function(){ openSettings(); pushSettingsView('model'); return 1; })()`);
    for (let i = 0; i < 60; i++) {   // 冷缓存时 /api/models 会探活本地服务，可能 7 秒才出按钮
      if (await cdp.eval(`!!document.getElementById('spTestBtn')`)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    modelTest = JSON.parse(await cdp.eval(`(function(){
      var b=document.getElementById('spTestBtn');
      return JSON.stringify({found:!!b, txt:b?String(b.textContent||''):'', title:b?String(b.title||''):''});
    })()`));
  } catch (e) { modelTest = { err: String((e && e.message) || e) }; }
  check('模型页有「测试」按钮',
    !!modelTest && modelTest.found === true && String(modelTest.txt).indexOf('测试') >= 0,
    JSON.stringify(modelTest));

  // 建议页：没密钥时给「去填 Key」，而不是让人点一个只会失败的按钮
  let sugHint = null;
  try {
    sugHint = JSON.parse(await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('suggestions');
      await new Promise(function(s){setTimeout(s,900)});
      var cfg=await (await fetch('/api/project-config')).json();
      var n=document.querySelector('.sug-nokey');
      var b=document.getElementById('sugGenBtn');
      return JSON.stringify({needsKey:cfg.needs_key===true, hint:!!n,
        hintTxt:n?String(n.innerText).replace(/\s+/g,' '):'', hasBtn:!!b});
    })()`));
  } catch (e) { sugHint = { err: String((e && e.message) || e) }; }
  const fr = JSON.parse(await cdp.eval(`(async function(){
    var cfg=await (await fetch('/api/project-config')).json();
    try { currentTopic=null; messages=[]; msgOffset=0; allLoaded=true; render(); } catch(e) {}
    await refreshKeyBanner();
    await new Promise(function(r){setTimeout(r,350)});
    var c=document.getElementById('firstRunCard');
    var before=c?getComputedStyle(c).display:'missing';
    var rows=c?c.querySelectorAll('.fr-row').length:0;
    if(c){ var b=c.querySelector('.fr-off'); if(b) b.click(); }
    var after=c?getComputedStyle(c).display:'missing';
    var off=localStorage.getItem('first_run_off');
    localStorage.removeItem('first_run_off');
    if(c) c.style.display = (before==='block')?'block':'none';
    try { await loadTopics(); } catch(e) {}
    return JSON.stringify({needsKey:cfg.needs_key===true, before:before, after:after, rows:rows, off:off});
  })()`));
  const chipTopic = JSON.parse(await cdp.eval(`(async function(){
    currentTopic=null; messages=[]; render();
    await new Promise(function(r){setTimeout(r,350)});
    var b=document.querySelector('.empty-tags button');
    if(!b) return JSON.stringify({chip:false});
    b.click();
    await new Promise(function(r){setTimeout(r,1500)});
    var inp=document.getElementById('msgInput');
    var out={chip:true, tid:currentTopic?currentTopic.id:'', val:inp?String(inp.value).slice(0,20):'',
      focus:document.activeElement===inp};
    if(currentTopic){ try{
      await fetch('/api/topic/delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({topic_id:currentTopic.id})}); }catch(e){} }
    try { await loadTopics(); } catch(e) {}
    return JSON.stringify(out);
  })()`));
  check('没任务时点起手 chip 会先建任务再填字',
    chipTopic.chip === true && !!chipTopic.tid && String(chipTopic.val).length > 4,
    JSON.stringify(chipTopic));

  check('没配 Key 时首屏有「三步就能开始」，点「知道了」会收起',
    fr.needsKey ? (fr.before === 'block' && fr.rows === 3 && fr.after === 'none' && fr.off === '1')
                : true,
    JSON.stringify(fr));

  check('AI 建议页在没密钥时给出「去填 Key」',
    !!sugHint && sugHint.hasBtn === true
    && (sugHint.needsKey ? (sugHint.hint === true && /去填 Key/.test(String(sugHint.hintTxt))) : true),
    JSON.stringify(sugHint));


    // 9g. 快速跳转里能直接去资产库 / 模型 / 时间机器 / 回收站
    const cmdkActs = await cdp.eval(`(async function(){
      openCommandPalette();
      await new Promise(function(r){setTimeout(r,500)});
      var labels=[].slice.call(document.querySelectorAll('.cmdk-label')).map(function(x){return x.textContent;});
      var row=[].slice.call(document.querySelectorAll('.cmdk-item'))
        .filter(function(x){return /资产库/.test(x.textContent);})[0];
      if(row) row.click();
      await new Promise(function(r){setTimeout(r,700)});
      var ab=document.getElementById('abWindow');
      var ov=document.getElementById('cmdkOverlay');
      if(typeof closeAssetView==='function') closeAssetView();
      return JSON.stringify({labels:labels.join('|'),
        closed:!(ov&&ov.classList.contains('show')),
        ab:!!(ab&&ab.offsetWidth>0)});
    })()`);
    let cmdkOk = false;
    try {
      const o = JSON.parse(cmdkActs);
      // 资产面板是否真打开另有专门一项；这里只验「四条入口在、点了会关面板」
      cmdkOk = /资产库/.test(o.labels) && /模型与密钥/.test(o.labels)
        && /时间机器/.test(o.labels) && /回收站/.test(o.labels)
        && /数据备份/.test(o.labels) && /主题：自动/.test(o.labels)
        && o.closed === true;
    } catch { /* ignore */ }
    check('快速跳转里有资产库/模型/时间机器/回收站/数据备份', cmdkOk, cmdkActs);

    // 9h. 侧栏搜索：输入关键词能命中任务，点进去切到它（造一个任务，验完删掉并还原回收站快照）
    let rpBackup2 = null;
    try { rpBackup2 = fs.existsSync(rp) ? fs.readFileSync(rp) : null; } catch { /* ignore */ }
    const srch = await cdp.eval(`(async function(){
      var tag='搜索按钮自检';
      var r=await fetch('/api/topic/new',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({title:tag})});
      var d=await r.json();
      if(!d||!d.id) return JSON.stringify({created:false});
      await loadTopics();
      var i=document.getElementById('searchInput');
      if(!i) return JSON.stringify({created:true,input:false});
      i.value=tag; i.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(function(x){setTimeout(x,1400)});
      var rows=[].slice.call(document.querySelectorAll('#topicList .topic-item'));
      var hit=rows.filter(function(x){return x.textContent.indexOf(tag)>=0;})[0];
      var text=hit?hit.textContent:'';
      if(hit) hit.click();
      await new Promise(function(x){setTimeout(x,1200)});
      var cur=(typeof currentTopic!=='undefined'&&currentTopic)?currentTopic.id:'';
      await fetch('/api/topic/delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({topic_id:d.id})});
      ssClear();
      await loadTopics();
      return JSON.stringify({created:true,rows:rows.length,hit:!!hit,
        matched:/命中/.test(document.body.innerText)?true:true,
        switched:cur===d.id,txt:text.slice(0,60)});
    })()`);
    try {
      if (rpBackup2 !== null) fs.writeFileSync(rp, rpBackup2);
      else if (fs.existsSync(rp)) fs.unlinkSync(rp);
    } catch { /* ignore */ }
    let srchOk = false;
    try {
      const o = JSON.parse(srch);
      srchOk = o.created === true && o.hit === true && o.switched === true && /搜索按钮自检/.test(o.txt || '');
    } catch { /* ignore */ }
    check('侧栏搜索能命中任务并切过去', srchOk, srch);

    // 9j. 没人 catch 的 Promise 拒绝要弹红条（中止类不弹）
    const gerr = JSON.parse(await cdp.eval(`(async function(){
      // 用合成事件触发监听器：真的 unhandledrejection 会被冒烟自己的异常钩子记一笔
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',
        {promise: Promise.resolve(), reason: new Error('自检用的假崩溃')}));
      await new Promise(function(r){setTimeout(r,500)});
      var t=document.getElementById('msgToast');
      var first=t? t.textContent : '';
      t.className=''; t.textContent='';
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',
        {promise: Promise.resolve(), reason: Object.assign(new Error('The operation was aborted'), {name:'AbortError'})}));
      await new Promise(function(r){setTimeout(r,400)});
      var second=t? t.textContent : '';
      t.className=''; t.textContent='';
      return JSON.stringify({hit:/后台出错了/.test(first), aborted:second===''});
    })()`));
    check('未捕获的 Promise 拒绝会弹提示条（中止类不弹）', gerr.hit === true && gerr.aborted === true, gerr);

    // 9k. Esc 分层关：先关资产预览，再关资产库（不能一次把两层都收掉）
    const esc = JSON.parse(await cdp.eval(`(async function(){
      openAssetView();
      await new Promise(function(r){setTimeout(r,500)});
      var v=document.getElementById('abFileView');
      if(v) v.style.display='';
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await new Promise(function(r){setTimeout(r,200)});
      var w=document.getElementById('abWindow');
      var step1={view:v.style.display, win:w.offsetWidth};
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await new Promise(function(r){setTimeout(r,200)});
      var step2={win:w.offsetWidth};
      return JSON.stringify({step1:step1, step2:step2});
    })()`));
    check('Esc 先关资产预览再关资产库',
      esc.step1 && esc.step1.view === 'none' && esc.step1.win > 100 && esc.step2.win === 0, esc);

    // 9i. 系统页有「数据备份」：能读到列表（空态也要说话），按钮在
    const bk = JSON.parse(await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('system');
      var box=null, btn=null, t='';
      for (var _i=0; _i<25; _i++) {
        await new Promise(function(r){setTimeout(r,200)});
        box=document.getElementById('sysBackupBox'); btn=document.getElementById('sysBackupBtn');
        t=box?box.innerText:'';
        if (box && btn && !/读取中/.test(t)) break;
      }
      return JSON.stringify({box:!!box, btn:!!btn, text:t.slice(0,40),
        stuck:/读取中/.test(t), err:/读取失败/.test(t)});
    })()`));
    const bkOk = bk.box === true && bk.btn === true && bk.stuck === false && bk.err === false;
    check('系统页有数据备份入口', bkOk, bk);

  // 备份区要有「从文件导入…」，孤儿工作区的说明不能跑到备份区下面
  let bkImport = null;
  try {
    bkImport = JSON.parse(await cdp.eval(`(async function(){
      for (var _i=0; _i<20; _i++) {
        if (document.getElementById('bkFileInput')) break;
        await new Promise(function(r){setTimeout(r,150)});
      }
      var b=document.getElementById('sysBackupBox');
      var sec=b?b.closest('.sp-section'):null;
      var secs=document.querySelectorAll('#settingsBody .sp-section');
      var own=null;
      for(var i=0;i<secs.length;i++){ var h=secs[i].querySelector('h4'); if(h&&h.textContent.indexOf('孤儿工作区')>=0){ own=secs[i]; break; } }
      return JSON.stringify({hasInput:!!document.getElementById('bkFileInput'),
        btns:Array.prototype.map.call(sec?sec.querySelectorAll('button'):[],function(x){return x.textContent}),
        wsHint: own?String(own.innerText).indexOf('missions_trash')>=0:false,
        bkHint: sec?String(sec.innerText).indexOf('missions_trash')>=0:false});
    })()`));
  } catch { /* 断言会报 */ }
  check('备份区能选文件导入，说明没有串到别的块',
    !!bkImport && bkImport.hasInput === true
    && (bkImport.btns || []).some((t) => t.indexOf('从文件导入') >= 0)
    && bkImport.wsHint === true && bkImport.bkHint === false,
    JSON.stringify(bkImport));

    // 9i2. 备份行上的「恢复」：弹的是危险确认（取消掉，不真恢复）
    const bkr = JSON.parse(await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('system');
      await new Promise(function(r){setTimeout(r,1500)});
      var b=document.querySelector('#sysBackupBox .sp-bk-row button');
      if(!b) return JSON.stringify({btn:null});
      b.click(); await new Promise(function(r){setTimeout(r,450)});
      var ov=document.querySelector('.ui-dlg-overlay');
      var out={btn:b.textContent, dlg:!!ov, danger: ov?!!ov.querySelector('.ui-dlg-btn.danger'):false,
        txt: ov?String(ov.innerText).slice(0,80):''};
      if(ov){ var c=ov.querySelector('.ui-dlg-btn:not(.primary):not(.danger)'); if(c) c.click(); }
      return JSON.stringify(out);
    })()`));
    check('备份行有恢复按钮且要二次确认',
      bkr.btn === '恢复' && bkr.dlg === true && bkr.danger === true, bkr);

    const bkd = JSON.parse(await cdp.eval(`(function(){
      var rows=document.querySelectorAll('#sysBackupBox .sp-bk-row');
      var dels=document.querySelectorAll('#sysBackupBox .sp-bk-del');
      return JSON.stringify({rows:rows.length, dels:dels.length,
        title: dels.length?dels[0].getAttribute('title'):''});
    })()`));
    const spSearch = JSON.parse(await cdp.eval(`(async function(){
      openSettings();
      await new Promise(function(r){setTimeout(r,500)});
      function hits(q){
        var i=document.getElementById('spSearch');
        i.value=q; i.dispatchEvent(new Event('input',{bubbles:true}));
        var rows=document.querySelectorAll('#settingsBody .sp-menu-item');
        var out=[];
        for(var k=0;k<rows.length;k++){ if(rows[k].style.display!=='none') out.push(rows[k].textContent.replace(/\s+/g,' ').trim()); }
        return out;
      }
      var a=hits('密钥'), b=hits('扫码'), c=hits('zzzqqq');
      var none=document.getElementById('spSearchNone');
      var noneShown = none ? getComputedStyle(none).display!=='none' : false;
      var labels=[]; document.querySelectorAll('#settingsBody .sp-menu-label').forEach(function(x){labels.push(x.textContent.trim())});
      var i2=document.getElementById('spSearch'); i2.value=''; i2.dispatchEvent(new Event('input',{bubbles:true}));
      return JSON.stringify({key:a, scan:b, miss:c, noneShown: noneShown,
        hasMobile: labels.indexOf('移动端配对')>=0, hasBackup: labels.indexOf('数据备份')>=0});
    })()`));
    check('设置搜索能按同义词找到项',
      !!spSearch && spSearch.key.some(function(x){return /模型配置/.test(x)}) && spSearch.scan.some(function(x){return /移动端配对/.test(x)})
      && spSearch.miss.length === 0 && spSearch.noneShown === true && spSearch.hasMobile === true && spSearch.hasBackup === true,
      JSON.stringify(spSearch).slice(0, 220));

    const rc = JSON.parse(await cdp.eval(`(async function(){
      openSettings(); pushSettingsView('recycle');
      var b=document.getElementById('settingsBody');
      var out={rows:0,dels:0,empty:false};
      for (var _i=0; _i<20; _i++) {
        await new Promise(function(r){setTimeout(r,200)});
        out={rows:b.querySelectorAll('.rc-item').length,
             dels:b.querySelectorAll('.rc-del').length,
             empty:/回收站为空/.test(b.innerText||'')};
        if (out.rows > 0 || out.empty) break;
      }
      return JSON.stringify(out);
    })()`));
    check('回收站每条都有删除按钮',
      !!rc && (rc.empty === true ? rc.rows === 0 : (rc.rows > 0 && rc.dels === rc.rows)),
      JSON.stringify(rc));

    check('每行备份都有一个删除按钮',
      bkd.rows > 0 && bkd.dels === bkd.rows && /删/.test(bkd.title), bkd);


    // ── 10. 控制台错误 ─────────────────────────────────
    const errs = cdp.errors.filter((e) => e && !/favicon|ERR_ABORTED|net::ERR/i.test(e));
    check('无未捕获的 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* 已经退了 */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge 可能还占着 */ }
    // 自检建过又删掉的任务会留下空工作区：只清「一个文件都没有」的目录，不碰用户的东西
    try {
      const base = path.resolve('data/missions');
      if (fs.existsSync(base)) {
        for (const d of fs.readdirSync(base)) {
          const p = path.join(base, d);
          try {
            if (fs.statSync(p).isDirectory() && fs.readdirSync(p, { recursive: true }).every((x) => !fs.statSync(path.join(p, x)).isFile())) {
              fs.rmSync(p, { recursive: true, force: true });
            }
          } catch { /* 单个目录失败就跳过 */ }
        }
      }
    } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? '，失败：' + failed.map((f) => f.name).join('；') : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ui-smoke 出错：' + (e?.stack || e));
  process.exit(1);
});
