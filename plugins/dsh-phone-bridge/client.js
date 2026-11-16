/**
 * @local/dsh-phone-bridge — client half.
 * 在输入框 dock 区放一个「远程服务」按钮，点开面板可开启/关闭手机远程服务。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-phone-bridge',
  factory(require) {
    const React = require('react');
    // 2026-11-13 诊断：探测宿主是否允许拿 react-dom（决定 portal 实现路线）
    const __RD = (() => { try { return require('react-dom'); } catch (e) { return null; } })();
    const __RDC = (() => { try { return require('react-dom/client'); } catch (e) { return null; } })();
    const __PORTAL = !!((__RD && __RD.createPortal) || (__RDC && __RDC.createRoot));
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/dsh-phone-api';

    async function call(path, method, payload) {
      const r = await fetch(API + path, {
        method: method || 'GET',
        headers: method ? { 'content-type': 'application/json' } : undefined,
        body: method ? JSON.stringify(payload || {}) : undefined,
      });
      let body = null;
      try {
        body = await r.json();
      } catch (e) {
        body = { ok: false, error: 'bad json' };
      }
      return body || {};
    }

    function Dot(props) {
      const color = props.running ? '#3fb950' : props.paused ? '#d29922' : '#8b949e';
      return h('span', {
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: 4,
          background: color,
          boxShadow: props.running ? '0 0 6px ' + color : 'none',
          marginRight: 6,
          flex: '0 0 auto',
        },
      });
    }

    function row(label, value) {
      return h(
        'div',
        { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '18px', color: '#9aa4b2' } },
        h('span', { style: { flex: '0 0 76px', color: '#6e7681' } }, label),
        h('span', { style: { flex: '1 1 auto', wordBreak: 'break-all', color: '#c9d1d9' } }, value || '—'),
      );
    }

    const PANEL_POS_KEY = 'dsh.phone.panel.pos';

    /** 把面板限制在视口里；窗口变小/手机横竖屏切换时也不会拖到屏幕外。 */
    function clampPanel(x, y, w, h) {
      const pad = 8;
      const maxX = Math.max(pad, window.innerWidth - w - pad);
      const maxY = Math.max(pad, window.innerHeight - h - pad);
      return { left: Math.min(Math.max(pad, x), maxX), top: Math.min(Math.max(pad, y), maxY) };
    }

    function RemotePanel(props) {
      const embedded = !!props.embedded;
      const st = props.status;
      const running = !!(st && st.running);
      const conflict = (st && st.conflict) || null;
      const panelRef = useRef(null);
      const dragRef = useRef(null);
      const lastPos = useRef(null);
      // 2026-11-13：style 坐标与视口坐标的固定偏移（见文件末尾说明）
      const calib = useRef({ dx: 0, dy: 0 });
      const [pos, setPos] = useState(null);
      const [dragging, setDragging] = useState(false);
      // 校准完成前先不画，避免把 (0,0) 那一帧闪给用户看
      const [ready, setReady] = useState(false);

      // 2026-11-13：不再恢复上次拖动位置。旧记录（例如上一版布局里存的右下角）
      // 只要落在视口内就会被 clampPanel 放行，面板于是每次都开在远离按钮的地方。
      // 现在固定以左下角为锚点打开；拖动只在本次会话内有效（写入侧保持不变）。
      useEffect(() => {
        try {
          localStorage.removeItem(PANEL_POS_KEY);
        } catch {
          /* ignore */
        }
      }, []);

      // 打开时先归零测出祖先偏移，再用它把面板摆到视口左下角。
      // 没有 transform 祖先时 r.left/r.top 就是 0，calib 保持 {0,0}。
      React.useLayoutEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        setPos({ left: 0, top: 0 });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          setReady(true);
        };
        const raf = window.requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          calib.current = { dx: r.left, dy: r.top };
          const targetLeft = 24;
          const targetTop = Math.max(8, window.innerHeight - 108 - r.height);
          setPos({ left: targetLeft - r.left, top: targetTop - r.top });
          finish();
        });
        // 兜底：万一 rAF 没跑（后台标签页等），也不能让面板一直不显示
        const timer = window.setTimeout(finish, 400);
        return () => {
          window.cancelAnimationFrame(raf);
          window.clearTimeout(timer);
        };
      }, []);

      useEffect(() => {
        const onResize = () => {
          const el = panelRef.current;
          const base = pos || lastPos.current;
          if (!el || !base) return;
          const r = el.getBoundingClientRect();
          const q = clampPanel(base.left, base.top, r.width, r.height);
          lastPos.current = q;
          setPos({ left: q.left - calib.current.dx, top: q.top - calib.current.dy });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [pos]);

      const onDragStart = (e) => {
        if (e.target.closest('button')) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        const el = panelRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
        lastPos.current = { left: r.left, top: r.top };
        setPos({ left: r.left - calib.current.dx, top: r.top - calib.current.dy });
        setDragging(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };
      const onDragMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        e.preventDefault();
        const q = clampPanel(e.clientX - d.dx, e.clientY - d.dy, d.w, d.h);
        lastPos.current = q;
        setPos({ left: q.left - calib.current.dx, top: q.top - calib.current.dy });
      };
      const onDragEnd = (e) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (lastPos.current) {
          try {
            localStorage.setItem(PANEL_POS_KEY, JSON.stringify(lastPos.current));
          } catch {
            /* ignore */
          }
        }
      };
      const onResetPos = (e) => {
        if (e.target.closest('button')) return;
        try {
          localStorage.removeItem(PANEL_POS_KEY);
        } catch {
          /* ignore */
        }
        lastPos.current = null;
        setPos(null);
      };
      // 端口被占：把「谁占的」和「换到哪个端口」直接摆出来，别只报一句启动失败
      const conflictBlock = conflict
        ? h(
            'div',
            {
              style: {
                marginTop: 8,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(248,81,73,.10)',
                border: '1px solid rgba(248,81,73,.38)',
                fontSize: 11,
                lineHeight: '16px',
                color: '#ffa198',
              },
            },
            h('div', { style: { fontWeight: 600, marginBottom: 3 } }, '端口 ' + conflict.port + ' 被 ' + conflict.name + ' 占了'),
            h(
              'div',
              { style: { color: '#8b949e', wordBreak: 'break-all' } },
              'PID ' + conflict.pid + (conflict.cmdline ? ' · ' + String(conflict.cmdline).slice(0, 90) : ''),
            ),
            conflict.suggestPort
              ? h(
                  'button',
                  {
                    onClick: () => props.onSwitchPort(conflict.suggestPort),
                    disabled: !!props.busy,
                    style: {
                      marginTop: 6,
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid #f85149',
                      background: props.busy ? '#21262d' : 'rgba(248,81,73,.18)',
                      color: props.busy ? '#6e7681' : '#ffa198',
                      fontSize: 11,
                      cursor: props.busy ? 'default' : 'pointer',
                    },
                  },
                  props.busy === 'port' ? '切换中…' : '换到 ' + conflict.suggestPort + ' 启动',
                )
              : null,
          )
        : null;
      return h(
        'div',
        {
          ref: panelRef,
          style: {
            ...(embedded
              ? { position: 'static', width: '100%', maxWidth: 560 }
              : {
                  position: 'fixed',
                  ...(pos ? { left: pos.left, top: pos.top } : { left: 24, bottom: 108 }),
                  visibility: ready ? 'visible' : 'hidden',
                }),
            boxSizing: 'border-box',
            width: embedded ? '100%' : 336,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 140px)',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '14px 16px',
            borderRadius: 12,
            background: '#161b22',
            border: '1px solid #30363d',
            boxShadow: '0 12px 40px rgba(0,0,0,.5)',
            zIndex: 2147483000,
            fontFamily: 'inherit',
            color: '#c9d1d9',
            cursor: dragging ? 'grabbing' : 'default',
          },
        },
        h(
          'div',
          {
            onPointerDown: onDragStart,
            onPointerMove: onDragMove,
            onPointerUp: onDragEnd,
            onPointerCancel: onDragEnd,
            onDoubleClick: onResetPos,
            title: '按住拖动，双击回到左下角',
            style: {
              display: 'flex',
              alignItems: 'center',
              marginBottom: 10,
              cursor: dragging ? 'grabbing' : 'grab',
              touchAction: 'none',
              userSelect: 'none',
            },
          },
          embedded ? null : h('span', { style: { color: '#6e7681', fontSize: 13, marginRight: 5, letterSpacing: '-1px' } }, '⠿'),
          h(Dot, { running, paused: st && st.paused }),
          h('span', { style: { fontWeight: 600, fontSize: 13, flex: '1 1 auto' } }, '手机远程服务'),
          h(
            'span',
            {
              title: 'portal 探测结果（诊断用，稳定后移除）',
              style: { fontSize: 10, padding: '1px 6px', borderRadius: 6, border: '1px solid ' + (__PORTAL ? '#238636' : '#8b5cf6'), color: __PORTAL ? '#3fb950' : '#a78bfa', marginRight: 6, whiteSpace: 'nowrap' },
            },
            __PORTAL ? 'portal ok' : 'no portal',
          ),
          embedded ? null : h(
            'button',
            {
              onClick: props.onClose,
              title: '收起',
              style: {
                border: 0,
                background: 'transparent',
                color: '#8b949e',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: '16px',
                padding: 4,
              },
            },
            '×',
          ),
        ),
        row('状态', running ? '运行中' + (st.pid ? ' · PID ' + st.pid : '') : st && st.paused ? '已手动关闭' : '未运行'),
        row('端口', st && st.port ? String(st.port) : '—'),
        conflictBlock,
        row('模式', st && st.mode),
        running ? row('公网', st.publicUrl) : null,
        running ? row('局域网', st.recommended) : null,
        running
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: '22px', color: '#9aa4b2', alignItems: 'center' } },
              h('span', { style: { flex: '0 0 76px', color: '#6e7681' } }, '配对码'),
              h('input', {
                value: props.codeDraft == null ? '' : props.codeDraft,
                onChange: (e) => props.onCodeChange(e.target.value.replace(/[^\d]/g, '').slice(0, 8)),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') props.onSaveCode();
                },
                inputMode: 'numeric',
                placeholder: '4-8 位数字',
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  padding: '2px 6px',
                  borderRadius: 6,
                  border: '1px solid #30363d',
                  background: '#0d1117',
                  color: '#c9d1d9',
                  fontSize: 12,
                },
              }),
              h(
                'button',
                {
                  onClick: props.onSaveCode,
                  disabled: props.savingCode,
                  style: {
                    padding: '2px 9px',
                    borderRadius: 6,
                    border: '1px solid #1f6feb',
                    background: props.savingCode ? '#21262d' : '#1f6feb',
                    color: props.savingCode ? '#6e7681' : '#fff',
                    fontSize: 11,
                    cursor: props.savingCode ? 'default' : 'pointer',
                  },
                },
                props.savingCode ? '保存中' : '保存',
              ),
            )
          : null,
        running ? row('会话', st.sessionId) : null,
        st && st.error ? row('错误', st.error) : null,
        running
          ? h(
              'button',
              {
                onClick: props.onCopy,
                style: {
                  marginTop: 8,
                  padding: '5px 10px',
                  borderRadius: 7,
                  border: '1px solid #30363d',
                  background: 'transparent',
                  color: '#8b949e',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
              props.copied ? '已复制 ✓' : '复制手机地址',
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 12 } },
          h(
            'button',
            {
              onClick: props.onStart,
              disabled: props.busy || running,
              style: {
                flex: '1 1 0',
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid #238636',
                background: running ? '#21262d' : '#238636',
                color: running ? '#6e7681' : '#fff',
                fontSize: 12,
                cursor: running ? 'default' : 'pointer',
              },
            },
            props.busy === 'start' ? '启动中…' : '开启远程服务',
          ),
          h(
            'button',
            {
              onClick: props.onStop,
              disabled: props.busy || !running,
              style: {
                flex: '1 1 0',
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid #30363d',
                background: '#21262d',
                color: running ? '#f85149' : '#6e7681',
                fontSize: 12,
                cursor: running ? 'pointer' : 'default',
              },
            },
            props.busy === 'stop' ? '关闭中…' : '关闭远程服务',
          ),
          h(
            'button',
            {
              onClick: props.onRestart,
              disabled: props.busy || !running,
              title: '等价于先关闭再开启，用来让桥接重新加载 server.mjs',
              style: {
                flex: '0 0 auto',
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid #30363d',
                background: '#21262d',
                color: running ? '#58a6ff' : '#6e7681',
                fontSize: 12,
                cursor: running ? 'pointer' : 'default',
              },
            },
            props.busy === 'restart' ? '重启中…' : '重启',
          ),
        ),
        h(
          'div',
          { style: { marginTop: 9, fontSize: 11, lineHeight: '16px', color: '#6e7681' } },
          '关闭后守护脚本不会自动拉起；下次点「开启」即可恢复。',
        ),
      );
    }

    function PhoneBridgeDock() {
      const [open, setOpen] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState('');
      const [copied, setCopied] = useState(false);
      const [err, setErr] = useState('');
      const [notice, setNotice] = useState('');
      const [codeDraft, setCodeDraft] = useState('');
      const [savingCode, setSavingCode] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const s = await call('/status');
          setStatus(s);
          setErr(s && s.ok === false ? String(s.error || '读取失败') : '');
        } catch (e) {
          setErr(String((e && e.message) || e));
        }
      }, []);

      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
      }, [refresh]);

      const act = useCallback(
        async (kind) => {
          setBusy(kind);
          setNotice('');
          try {
            // restart = 先关再开：/stop 写 paused.flag，/start 清掉它并直连 spawn，等价于重载 server.mjs
            let s;
            if (kind === 'restart') {
              await call('/stop', 'POST');
              s = await call('/start', 'POST', { autoPort: true });
            } else {
              s = await call(kind === 'start' ? '/start' : '/stop', 'POST', kind === 'start' ? { autoPort: true } : undefined);
            }
            setStatus(s);
            // 端口被占后自动搬家成功：这不是错误，是要提醒主人手机端换地址
            if (s && s.portChanged) {
              setNotice(`端口 ${s.fromPort} 被别的程序占着，已经改用 ${s.port} 起来了 —— 手机端要换成新地址（配对码不变）。`);
            }
            if (s && s.ok === false) setErr(String(s.error || '操作失败'));
            else if (s && s.started === false && !s.starting) setErr(String(s.error || '启动失败'));
            else if (s && (s.timedOut || s.stopped === false)) setErr(String(s.error || '操作未完成'));
            else setErr('');
          } catch (e) {
            setErr(String((e && e.message) || e));
          } finally {
            setBusy('');
          }
        },
        [],
      );

      // 换端口：停掉旧的、写到 port.json、在新端口起来。端口被别人占着时这一下就能救回来
      const switchTo = useCallback(async (port) => {
        if (!port) return;
        setBusy('port');
        setNotice('');
        try {
          const s = await call('/port', 'POST', { port });
          setStatus(s);
          if (s && s.switched) {
            setErr('');
            setNotice(`已经改用端口 ${port} 起来了 —— 手机端要换成新地址（配对码不变）。`);
          } else {
            setErr(String((s && s.error) || '换端口失败'));
          }
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      }, []);

      const copy = useCallback(async () => {
        const url = (status && (status.publicUrl || status.recommended)) || '';
        if (!url) return;
        const code = (status && status.pairCode) || '';
        const text = code ? `手机打开 ${url} ，配对码 ${code}` : `手机打开 ${url}`;
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (e) {
          setErr('复制失败：' + String((e && e.message) || e));
        }
      }, [status]);

      const running = !!(status && status.running);
      const label = running ? '远程服务 · 开' : status && status.paused ? '远程服务 · 关' : '远程服务';

      // 配对码编辑：草稿跟 status 同步（第一次拿到 / 别人改过时都要跟上）
      useEffect(() => {
        if (status && status.pairCode) setCodeDraft(String(status.pairCode));
      }, [status && status.pairCode]);

      const saveCode = useCallback(async () => {
        const code = (codeDraft || '').trim();
        if (!/^\d{4,8}$/.test(code)) {
          setErr('配对码只能是 4-8 位数字');
          return;
        }
        setSavingCode(true);
        try {
          const s = await call('/paircode', 'POST', { code });
          if (s && s.ok) {
            setStatus(s);
            setErr('');
          } else {
            setErr(String((s && s.error) || '改配对码失败'));
          }
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setSavingCode(false);
        }
      }, [codeDraft]);

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              setOpen((v) => !v);
              refresh();
            },
            title: running ? '手机远程服务运行中' : '手机远程服务未运行',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              height: 28,
              padding: '0 10px',
              marginRight: 6,
              borderRadius: 14,
              border: '1px solid ' + (running ? '#238636' : '#30363d'),
              background: running ? 'rgba(35,134,54,.14)' : 'transparent',
              color: running ? '#3fb950' : '#8b949e',
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          h(Dot, { running, paused: status && status.paused }),
          label,
        ),
        open
          ? h(RemotePanel, {
              status,
              busy,
              copied,
              codeDraft,
              savingCode,
              onCodeChange: setCodeDraft,
              onSaveCode: saveCode,
              onCopy: copy,
              onClose: () => setOpen(false),
              onStart: () => act('start'),
              onStop: () => act('stop'),
              onRestart: () => act('restart'),
              onSwitchPort: switchTo,
            })
          : null,
        open && (err || notice)
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  left: 24,
                  bottom: 78,
                  maxWidth: 336,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  zIndex: 9999,
                },
              },
              notice
                ? h(
                    'div',
                    {
                      style: {
                        padding: '7px 10px',
                        borderRadius: 8,
                        background: 'rgba(35,134,54,.14)',
                        border: '1px solid rgba(35,134,54,.45)',
                        color: '#7ee787',
                        fontSize: 11,
                        lineHeight: '16px',
                      },
                    },
                    notice,
                  )
                : null,
              err
                ? h(
                    'div',
                    {
                      style: {
                        padding: '6px 10px',
                        borderRadius: 8,
                        background: 'rgba(248,81,73,.12)',
                        border: '1px solid rgba(248,81,73,.4)',
                        color: '#f85149',
                        fontSize: 11,
                        lineHeight: '16px',
                      },
                    },
                    err,
                  )
                : null,
            )
          : null,
      );
    }

    // 设置页分栏：把同一个面板以普通布局渲染（无浮层、无拖动）
    function PhoneBridgeSection() {
      return h(PhoneBridgeDock, { embedded: true });
    }

    return {
      inject: ['slots'],
      apply() {
        // 面板已并入「设置 → 设备互联 → 手机通道」，对话区不再注册浮层按钮。
      },
    };
  },
});
