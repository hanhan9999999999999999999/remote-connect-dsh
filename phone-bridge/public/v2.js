/* ============================================================
   v2 —— 微信级聊天逻辑（插在主 IIFE 内部，共享闭包）
   - md() 轻量 Markdown 渲染（代码块/表格/列表/引用/行内）
   - 消息分组 + 时间分隔 + 气泡尾巴
   - 智能滚动 + 新消息浮标 + 打字指示器
   - 长按菜单（复制/引用/重发）+ 图片全屏预览
   - 页面隐藏时系统通知 + 未读标题
   - 快捷短语 + 震动反馈
   ============================================================ */

/* ---------------- Markdown ---------------- */
const MD_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function mdEsc(s) { return String(s).replace(/[&<>"]/g, (c) => MD_ESC[c]); }

function mdInline(s) {
  // 行内已经整体转义过；这里处理行内代码 -> 粗体 -> 斜体 -> 删除 -> 链接
  const codes = [];
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => {
    codes.push(i);
    return '\u0001C' + (codes.length - 1) + '\u0001';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  s = s.replace(/\u0001C(\d+)\u0001/g, (_, i) => '<code>' + mdEsc(window.__mdInlineCodes[i]) + '</code>');
  return s;
}

/** 把 markdown 文本转成 HTML 片段（安全：先整体转义，再放行白名单标签） */
function md(src) {
  if (!src) return '';
  let s = String(src).replace(/\r\n/g, '\n');

  // 1) 抽出围栏代码块
  const blocks = [];
  s = s.replace(/```([\w+.#-]*)[ \t]*\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: (lang || '').trim(), code: code.replace(/\n+$/, '') });
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  // 2) 抽出行内代码原文（不参与转义与行内替换）
  const inl = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    inl.push(c);
    return '\u0000I' + (inl.length - 1) + '\u0000';
  });

  s = mdEsc(s);

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  const flushList = () => {};

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // 空行
    if (!line.trim()) { i += 1; continue; }

    // 代码块占位
    const cb = line.match(/^\u0000B(\d+)\u0000$/);
    if (cb) {
      const b = blocks[Number(cb[1])];
      const lang = b.lang ? mdEsc(b.lang) : 'code';
      out.push(
        '<div class="codeblock"><div class="cbhead"><span class="lang">' + lang +
        '</span><button type="button" data-cp="' + out.length + '">复制</button></div><pre><code>' +
        mdEsc(b.code) + '</code></pre></div>'
      );
      window.__mdCodeStore = window.__mdCodeStore || [];
      window.__mdCodeStore.push(b.code);
      i += 1;
      continue;
    }

    // 表格：| a | b |  +  |---|---|
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const head = line.split('|').map((x) => x.trim()).filter((x, idx, arr) => !(idx === 0 && x === '') && !(idx === arr.length - 1 && x === ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(lines[i].split('|').map((x) => x.trim()).filter((x, idx, arr) => !(idx === 0 && x === '') && !(idx === arr.length - 1 && x === '')));
        i += 1;
      }
      let t = '<div class="tb"><table><thead><tr>' + head.map((h) => '<th>' + mdInline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>';
      t += '</tbody></table></div>';
      out.push(t);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>');
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    // 引用（连续多行合并）
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + mdInline(buf.join('<br>')) + '</blockquote>');
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push('<ul>' + items.map((x) => '<li>' + mdInline(x) + '</li>').join('') + '</ul>');
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      out.push('<ol>' + items.map((x) => '<li>' + mdInline(x) + '</li>').join('') + '</ol>');
      continue;
    }

    // 普通段落（连续非空行，行内换行 -> <br>）
    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\u0000B\d+\u0000$/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
  }

  // 行内代码还原表
  window.__mdInlineCodes = inl;
  let html = out.join('');

  // 代码块复制按钮需要的源码索引在拼接后无法对应，改为直接携带 data-code
  html = html.replace(/<button type="button" data-cp="\d+">复制<\/button>/g, '<button type="button" class="cpbtn">复制</button>');
  return html;
}

/** 绑定代码块复制（事件委托，渲染后调用一次即可） */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.classList || !t.classList.contains('cpbtn')) return;
  const box = t.closest('.codeblock');
  const code = box ? box.querySelector('pre code') : null;
  if (!code) return;
  copyText(code.textContent || '').then((ok) => {
    t.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { t.textContent = '复制'; }, 1500);
  });
});

/* ---------------- 时间分隔 ---------------- */
function dayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (sameDay(d, now)) return hm;
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(d, y)) return '昨天 ' + hm;
  const md2 = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '年') + md2;
}

/** 重算分组类 + 插入时间分隔（幂等：先清掉旧的） */
function reflowGroups() {
  const main = $('main');
  [...main.querySelectorAll('.daysep')].forEach((x) => x.remove());
  const rows = [...main.children].filter((x) => x.classList && x.classList.contains('row'));
  let prev = null;
  rows.forEach((row, idx) => {
    const m = msgs[idx];
    // 清分组类
    row.classList.remove('grp-first', 'grp-mid', 'grp-last');
    const b = row.querySelector('.bubble');
    if (b) b.classList.remove('last');

    const sameAsPrev = m && prev && m.role === prev.role && (m.at || 0) - (prev.at || 0) < 60000;
    const next = msgs[idx + 1];
    const sameAsNext = m && next && m.role === next.role && (next.at || 0) - (m.at || 0) < 60000;

    row.classList.add(!sameAsPrev ? 'grp-first' : 'grp-mid');
    if (!sameAsNext) { row.classList.add('grp-last'); if (b) b.classList.add('last'); }

    // 时间分隔：首条、跨天、或间隔 > 10 分钟
    const needSep = m && (!prev || (m.at || 0) - (prev.at || 0) > 600000 || !sameDayTs(prev.at, m.at));
    if (needSep) {
      const sep = document.createElement('div');
      sep.className = 'daysep';
      const s = document.createElement('span');
      s.textContent = dayLabel(m.at) || '现在';
      sep.appendChild(s);
      main.insertBefore(sep, row);
    }
    prev = m || prev;
  });
}
function sameDayTs(a, b) {
  if (!a || !b) return false;
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/* ---------------- 气泡渲染 ---------------- */
function bubbleEl(m) {
  const row = document.createElement('div');
  row.className = 'row ' + (m.role === 'user' ? 'me' : 'ai');
  row.dataset.id = m.id || '';

  const b = document.createElement('div');
  b.className = 'bubble' + (m.streaming ? ' streaming' : '') + (m.role === 'user' ? '' : ' md');
  b._msgId = m.id || '';
  if (m.role === 'user') b.textContent = m.text || '';
  else b.innerHTML = md(m.text || '');
  row.appendChild(b);

  // 附件
  if (m.files && m.files.length) {
    const box = document.createElement('div');
    box.className = 'files';
    for (const f of m.files) {
      const url = base + '/api/file?t=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(f.path);
      if (/^image\//.test(f.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(f.path)) {
        const img = document.createElement('img');
        img.src = url;
        img.loading = 'lazy';
        img.onclick = () => openLightbox(url);
        box.appendChild(img);
      } else {
        const a = document.createElement('a');
        a.className = 'f';
        a.href = url;
        a.target = '_blank';
        a.textContent = '📄 ' + (f.name || f.path) + (f.size ? ' · ' + fmtSize(f.size) : '');
        box.appendChild(a);
      }
    }
    row.appendChild(box);
  }

  // 历史消息的工具芯片（新消息进思考时间线）
  if (m.tools && m.tools.length && !(m.steps && m.steps.length)) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const t of m.tools) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t.name + (t.summary ? ' · ' + t.summary : '');
      chips.appendChild(c);
    }
    row.appendChild(chips);
  }

  const steps = m.steps && m.steps.length ? m.steps : (m.thinking || []).map((t) => ({ kind: 'think', text: t }));
  if (steps.length) {
    const d = stepsEl(steps, !!m.streaming);
    if (m.streaming) d.open = true;
    row.appendChild(d);
  }

  if (m.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = m.error;
    row.appendChild(e);
  }

  // 用户消息发送状态
  if (m.role === 'user' && (m.failed || m.sending)) {
    const st = document.createElement('div');
    st.className = 'mstate' + (m.failed ? ' fail' : '');
    if (m.failed) {
      st.textContent = '发送失败 ';
      const btn = document.createElement('button');
      btn.textContent = '重发';
      btn.onclick = () => resend(m);
      st.appendChild(btn);
    } else {
      st.textContent = '发送中…';
    }
    row.appendChild(st);
  }

  attachLongPress(row, b, m);
  return { row, b };
}

/* 流式文本重绘（节流，避免每帧重解析 markdown） */
function setBubbleText(m, el) {
  const paint = () => {
    if (m.role === 'user') el.textContent = m.text || '';
    else el.innerHTML = md(m.text || '');
  };
  const rec = m.__paint || (m.__paint = { last: 0, timer: null });
  const now = Date.now();
  if (now - rec.last > 140) { rec.last = now; paint(); }
  else if (!rec.timer) {
    rec.timer = setTimeout(() => { rec.timer = null; rec.last = Date.now(); paint(); }, 140);
  }
}

/* ---------------- 智能滚动 ---------------- */
let nearBottom = true;
function isNearBottom() {
  const m = $('main');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 90;
}
function scrollBottom(force) {
  const m = $('main');
  if (force || nearBottom) m.scrollTop = m.scrollHeight;
  if (nearBottom) hideJump();
}
function showJump(n) {
  const j = $('jump');
  if (!j) return;
  j.querySelector('span').textContent = n > 0 ? n + ' 条新消息' : '回到最新';
  j.classList.add('show');
}
function hideJump() { const j = $('jump'); if (j) j.classList.remove('show'); }

$('main').addEventListener('scroll', () => {
  nearBottom = isNearBottom();
  if (nearBottom) hideJump();
}, { passive: true });

/* ---------------- 重渲染 ---------------- */
function renderAll() {
  const main = $('main');
  main.innerHTML = '';
  streaming = null;
  for (const m of msgs) {
    const { row, b } = bubbleEl(m);
    main.appendChild(row);
    if (m.streaming) streaming = { el: b, msg: m, row };
  }
  reflowGroups();
  nearBottom = true;
  scrollBottom(true);
}

/* ---------------- 打字指示器 ---------------- */
let typingRow = null;
function showTyping() {
  if (typingRow) return;
  const row = document.createElement('div');
  row.className = 'row ai grp-first grp-last';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  row.appendChild(b);
  $('main').appendChild(row);
  typingRow = row;
  scrollBottom();
}
function hideTyping() {
  if (typingRow) { typingRow.remove(); typingRow = null; }
}

/* ---------------- 长按菜单 ---------------- */
let lpTimer = null;
let lpStart = null;
function attachLongPress(row, bubble, m) {
  bubble.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      openCtx(t.clientX, t.clientY, m);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 480);
  }, { passive: true });
  bubble.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (lpStart && (Math.abs(t.clientX - lpStart.x) > 12 || Math.abs(t.clientY - lpStart.y) > 12)) {
      clearTimeout(lpTimer); lpTimer = null;
    }
  }, { passive: true });
  bubble.addEventListener('touchend', () => { clearTimeout(lpTimer); lpTimer = null; }, { passive: true });
  bubble.addEventListener('touchcancel', () => { clearTimeout(lpTimer); lpTimer = null; }, { passive: true });
  // 桌面上右键也能用
  bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, m); });
}

function openCtx(x, y, m) {
  let el = $('ctxmenu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ctxmenu';
    el.className = 'ctxmenu';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { el.classList.remove('show'); fn(); };
    el.appendChild(b);
  };
  add('复制', async () => { const ok = await copyText(m.text || ''); toast(ok ? '已复制' : '复制失败'); });
  add('引用', () => {
    const q = '> ' + String(m.text || '').split('\n').slice(0, 6).join('\n> ') + '\n\n';
    $('input').value = q + $('input').value;
    autosize();
    $('input').focus();
  });
  if (m.role === 'user') {
    add('重发', () => {
      $('input').value = m.text || '';
      autosize();
      $('input').focus();
    });
  }
  el.classList.add('show');
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(x - w / 2, innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y - h - 10, innerHeight - h - 8)) + 'px';
  const close = (ev) => {
    if (!el.contains(ev.target)) { el.classList.remove('show'); document.removeEventListener('touchstart', close); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => {
    document.addEventListener('touchstart', close, { passive: true });
    document.addEventListener('mousedown', close);
  }, 60);
}

/* ---------------- 图片预览 ---------------- */
function openLightbox(url) {
  let lb = $('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = '<img alt="preview"><div class="lb-actions"><button data-a="save">保存</button><button data-a="close">关闭</button></div>';
    document.body.appendChild(lb);
    lb.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'close' || e.target === lb) lb.classList.remove('show');
      if (a === 'save') {
        const link = document.createElement('a');
        link.href = lb.dataset.url;
        link.download = '';
        link.target = '_blank';
        link.click();
      }
    });
  }
  lb.dataset.url = url;
  lb.querySelector('img').src = url;
  lb.classList.add('show');
}

/* ---------------- 通知 ---------------- */
function notifyReply(m) {
  if (!document.hidden) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification('DSH 回复了你', {
      body: String(m.text || '').replace(/\s+/g, ' ').slice(0, 120) || '（这条没有文字内容）',
      tag: 'dsh-' + (m.id || Date.now()),
      silent: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
  document.title = '● ' + (document.title.replace(/^● /, ''));
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = document.title.replace(/^● /, '');
});

/* ---------------- 发送状态 ---------------- */
function resend(m) {
  const i = msgs.indexOf(m);
  if (i >= 0) msgs.splice(i, 1);
  $('input').value = m.text || '';
  autosize();
  renderAll();
  send();
}

/* ---------------- 快捷短语 ---------------- */
const QUICK = ['继续', '说得再详细点', '直接给完整代码', '为什么这样', '重新来一次', '用表格对比'];
(function initQuick() {
  const box = $('quick');
  if (!box) return;
  QUICK.forEach((q) => {
    const b = document.createElement('button');
    b.textContent = q;
    b.onclick = () => {
      if (busy) { toast('正在回答中'); return; }
      $('input').value = q;
      autosize();
      send();
      if (navigator.vibrate) navigator.vibrate(8);
    };
    box.appendChild(b);
  });
})();

/* ---------------- 输入区增强 ---------------- */
(function enhanceInput() {
  const t = $('input');
  const btn = $('btn-send');
  const sync = () => {
    const has = t.value.trim().length > 0 || pending.some((f) => f.path);
    btn.classList.toggle('active', !!has);
  };
  t.addEventListener('input', sync);
  sync();
  window.__syncSendState = sync;

  // 键盘弹起时把视图顶回底部（Android WebView 的经典问题）
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fix = () => {
      document.body.style.height = vv.height + 'px';
      if (nearBottom) setTimeout(() => scrollBottom(true), 60);
    };
    vv.addEventListener('resize', fix);
    vv.addEventListener('scroll', fix);
    fix();
  }
  // 点空白处收起键盘（但别打断滚动）
  $('main').addEventListener('touchend', (e) => {
    if (e.target === $('main')) t.blur();
  }, { passive: true });
})();

/* ---------------- 通知开关（设置面板按钮） ---------------- */
(function initNotifyBtn() {
  const openBtn = $('btn-notify');
  if (!openBtn) return;
  const paint = () => {
    if (!('Notification' in window)) { openBtn.textContent = '系统通知：本机不支持'; openBtn.disabled = true; return; }
    const p = Notification.permission;
    openBtn.textContent = p === 'granted' ? '系统通知：已开启（点此关闭提示）' : p === 'denied' ? '系统通知：被浏览器拒绝' : '开启系统通知（切到后台也能收到）';
  };
  openBtn.onclick = async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { toast('已经是开启状态'); return; }
    const r = await Notification.requestPermission();
    paint();
    toast(r === 'granted' ? '已开启系统通知' : '没拿到通知权限');
  };
  paint();
})();
