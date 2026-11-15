/**
 * dsh-see-world —— 浏览器侧。
 *
 * 三块界面：
 *   1. settings.section  侧栏「看世界」设置页：选设备、分辨率、帧率、拼图帧数…
 *   2. conversation.composer.dock  输入框上方一个小按钮，一键打开看世界
 *   3. shell.overlay     浮层面板：当前摄像头的实时画面、状态、抓一张给会话
 *
 * 约定（见 Harness 插件指南）：
 *   - 产物 id 必须等于包名，否则 ModuleLoader 只会在控制台报 loaded without registering。
 *   - 不 require 任何 Harness 客户端包（那会让整个 slot 崩掉、白屏），只 require('react')。
 *   - 样式/定时器/监听器都放在 apply 的 ctx.effect 里并返回清理函数。
 *   - 后端拿不到的东西（默认值、校验）一律问后端，不在前端重写一份。
 */
window.__ModuleLoader__.load({
  id: 'dsh-see-world',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/api/see-world';
    const NS = 'see-world';

    // ── 文案 ─────────────────────────────────────────────
    // 用本地小字典而不是 Client locale 服务：少一层依赖，装错也只会退化成英文。
    const EN = typeof navigator !== 'undefined' && !/^zh/i.test(navigator.language || '');
    const TEXT = {
      nav: ['看世界', 'See World'],
      title: ['看世界 · 摄像头', 'See World · Camera'],
      subtitle: ['让当前会话通过摄像头看一眼。', 'Let this conversation look through the camera.'],
      device: ['摄像头设备', 'Camera device'],
      picking: ['正在找设备…', 'Looking for devices…'],
      noDevice: ['没有找到摄像头设备', 'No camera found'],
      resolution: ['分辨率', 'Resolution'],
      fps: ['输入帧率', 'Frame rate'],
      frames: ['拼图帧数', 'Frames per sheet'],
      quality: ['画质', 'Quality'],
      previewSize: ['预览宽度', 'Preview width'],
      monitor: ['预攒画面', 'Pre-buffer frames'],
      monitorHint: ['画面有变化时在后台攒一张拼版（watch / peek 才有图可拿）；开了「自动回报」就自动生效',
        'Buffer a sheet in the background when things change (what watch / peek draw on); auto-enabled by auto-reply'],
      sendOnOpen: ['打开即抓一张', 'Send one shot on open'],
      sendOnOpenHint: ['点开面板后自动把第一张画面发进会话', 'Send the first frame to the conversation automatically'],
      save: ['保存', 'Save'],
      saving: ['保存中…', 'Saving…'],
      saved: ['已保存', 'Saved'],
      reset: ['恢复默认', 'Reset'],
      open: ['打开看世界', 'Open See World'],
      close: ['关闭', 'Close'],
      start: ['开始', 'Start'],
      stop: ['停止', 'Stop'],
      send: ['抓一张发到会话', 'Send a shot'],
      sending: ['发送中…', 'Sending…'],
      sent: ['已发到会话', 'Sent'],
      empty: ['还没有画面', 'No picture yet'],
      emptyHint: ['点右下角「开始」打开摄像头', 'Press Start (bottom right) to open the camera'],
      running: ['运行中', 'Live'],
      idle: ['未运行', 'Idle'],
      loading: ['读取中…', 'Loading…'],
      ffmpeg: ['ffmpeg', 'ffmpeg'],
      configPath: ['配置文件', 'Config file'],
      warnings: ['提示', 'Notes'],
      brightness: ['亮度', 'Brightness'],
      movement: ['变动', 'Movement'],
      privacy: ['摄像头画面只在本机处理，不会上传到别处。', 'Camera frames stay on this machine.'],
      hFps: ['越高越流畅，但更耗 CPU。', 'Higher is smoother but costs more CPU.'],
      hFrames: ['一次看几张画面拼在同一张图上。', 'How many frames go into one sheet.'],
      hPreview: ['面板里的小图宽度，不影响发给模型的图。', 'Preview width only — it does not change what the model sees.'],
      dragHint: ['按住这里可以拖动面板', 'Hold here to move the panel'],
      resizeHint: ['拖动改变宽度', 'Drag to resize'],
      replyTo: ['回报到', 'Reply to'],
      replyNone: ['（还没绑定会话）', '(no conversation yet)'],
      replyNoSession: ['还没有会话可绑定：先在会话里调一次 see_world', 'No conversation yet — call see_world once first'],
      replyBound: ['已改绑到指定会话', 'Bound to that conversation'],
      replyAuto: ['自动回报', 'Auto reply'],
      replyAutoHint: ['画面有变化时自动往会话里投一条消息', 'Post a message to the conversation when the view changes'],
      replyEvery: ['间隔', 'Every'],
      replyCount: ['已回报', 'Replied'],
      rebind: ['改绑到当前会话', 'Bind to this conversation'],
      diag: ['复制诊断信息', 'Copy diagnostics'],
      diagHint: ['把当前设置、运行状态和设备列表复制成一段 JSON，排错时贴给对方看',
        'Copy settings, status and device list as JSON for troubleshooting'],
      diagDone: ['诊断信息已复制到剪贴板', 'Diagnostics copied to the clipboard'],
      diagFail: ['剪贴板不可用（非 https / 无权限）；可以先截图，或看设置页底部的路径', 
        'Clipboard unavailable — take a screenshot, or read the paths at the bottom'],
      rebindHint: ['你现在正看着另一个会话，点这里让画面变化回报到它',
        'You are looking at another conversation; send the replies there'],
      replyEveryHint: ['两次自动回报之间至少隔多久（3~600 秒）', 'Minimum gap between auto replies (3–600 s)'],
      replyAttach: ['回报时带图', 'Attach a frame'],
      replyAttachHint: ['关掉就只发文字，省 token', 'Off means text only — cheaper'],
      replyBudget: ['回报次数上限', 'Reply budget'],
      replyBudgetHint: ['这一段最多自动回报几次', 'How many auto replies before it stops'],
      on: ['开', 'on'],
      off: ['关', 'off'],
      closeKeep: ['收起面板，自动回报继续', 'Hide the panel; auto replies keep running'],
      closeStops: ['收起面板并放开摄像头', 'Hide the panel and release the camera'],
    };
    const t = (key) => {
      const pair = TEXT[key];
      if (!pair) return key;
      return EN ? pair[1] : pair[0];
    };

    // ── 跟宿主说话 ───────────────────────────────────────
    async function getJson(path) {
      const res = await fetch(`${API}${path}`, { cache: 'no-store', credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        const msg = body?.warnings?.[0] ?? body?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return body;
    }

    async function postJson(path, payload) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await res.json().catch(() => null);
      // 宿主的分工是：HTTP 200 表示"这条路走到了"，body.ok 表示"这件事成了"。
      // 打不开摄像头、设备被占用这类失败都走 200 + ok:false，只看 res.ok 会把它当成成功。
      if (!res.ok || body?.ok === false) {
        const msg = body?.warnings?.[0] ?? body?.error?.message ?? `HTTP ${res.status}`;
        const err = new Error(msg);
        err.body = body;
        err.hint = body?.hint ?? '';
        throw err;
      }
      return body;
    }

    // ── 面板开关（按钮和浮层共享） ─────────────────────────
    const ui = {
      open: false,
      listeners: new Set(),
      set(next) {
        if (this.open === next) return;
        this.open = next;
        this.listeners.forEach((fn) => fn());
      },
      toggle() { this.set(!this.open); },
    };

    function usePanelOpen() {
      const [open, setOpen] = useState(ui.open);
      useEffect(() => {
        const fn = () => setOpen(ui.open);
        ui.listeners.add(fn);
        fn();
        return () => ui.listeners.delete(fn);
      }, []);
      return open;
    }

    // ── 实时画面 ─────────────────────────────────────────
    /**
     * 轮询 /frame 拿 PNG。用 objectURL 而不是 base64：大图走 base64 会卡住渲染线程。
     * 上一张的 URL 在下一张到手时立刻收回，不然会一直吃着内存。
     */
    function useLiveFrame({ width = 640, active = true, intervalMs = 800 }) {
      const [src, setSrc] = useState(null);
      const [info, setInfo] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(false);

      useEffect(() => {
        if (!active) return undefined;
        let stopped = false;
        let timer = null;
        let url = null;

        const tick = async () => {
          if (stopped) return;
          try {
            const res = await fetch(`${API}/frame?w=${width}`, { cache: 'no-store', credentials: 'same-origin' });
            const type = res.headers.get('content-type') || '';
            if (type.includes('application/json')) {
              const body = await res.json().catch(() => null);
              if (!stopped) {
                setInfo(body ? { ...body, empty: true } : null);
                setLoading(false);
              }
            } else if (res.ok) {
              const blob = await res.blob();
              if (stopped) { return; }
              const next = URL.createObjectURL(blob);
              if (url) URL.revokeObjectURL(url);
              url = next;
              setSrc(next);
              setError(null);
              setLoading(false);
              const at = Number(res.headers.get('x-see-world-at')) || Date.now();
              const gain = Number(res.headers.get('x-see-world-gain')) || 1;
              setInfo({ at, gain });
            } else {
              if (!stopped) setError(`HTTP ${res.status}`);
            }
          } catch (e) {
            if (!stopped) setError(String(e?.message ?? e));
          }
          if (!stopped) timer = setTimeout(tick, intervalMs);
        };

        setLoading(true);
        tick();
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (url) URL.revokeObjectURL(url);
        };
      }, [width, active, intervalMs]);

      return { src, info, error, loading };
    }

    // ── 状态轮询 ─────────────────────────────────────────
    function useStatus(active = true, intervalMs = 2000) {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      useEffect(() => {
        if (!active) return undefined;
        let stopped = false;
        let timer = null;
        const tick = async () => {
          try {
            const body = await getJson('/status');
            if (!stopped) { setStatus(body); setError(null); }
          } catch (e) {
            if (!stopped) setError(String(e?.message ?? e));
          }
          if (!stopped) timer = setTimeout(tick, intervalMs);
        };
        tick();
        return () => { stopped = true; if (timer) clearTimeout(timer); };
      }, [active, intervalMs]);
      return { status, error };
    }

    function clockOf(ms) {
      if (!Number.isFinite(ms)) return '--:--:--';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function chip(label, value, tone) {
      return h('span', { className: `dsw-chip${tone ? ` is-${tone}` : ''}` },
        h('span', { className: 'dsw-chip-key' }, label),
        h('span', { className: 'dsw-chip-val' }, value));
    }

    // ── 小部件 ───────────────────────────────────────────
    function Field({ label, hint, children }) {
      return h('label', { className: 'dsw-field' },
        h('span', { className: 'dsw-field-label' }, label),
        children,
        hint ? h('span', { className: 'dsw-field-hint' }, hint) : null);
    }

    function Banner({ kind = 'info', children }) {
      if (!children) return null;
      return h('div', { className: `dsw-banner is-${kind}` }, children);
    }

    // ── 设置页 ───────────────────────────────────────────
    /**
     * 诊断单：把设置、运行状态、设备列表拼成一段能直接贴给别人的 JSON。
     * 做成纯函数是为了能测——它不该在测试里靠 hooks 跑起来才被验证。
     */
    function buildDiag(state, at) {
      const src = state ?? {};
      return JSON.stringify({
        plugin: 'dsh-see-world',
        at: at ?? new Date().toISOString(),
        config: src.config ?? null,
        status: src.meta?.status ?? null,
        devices: (src.devices ?? []).map((d) => ({ name: d?.name ?? null, kind: d?.kind ?? null })),
      }, null, 2);
    }

    /**
     * 实时画面。<img src=/stream> 是最省事的路（multipart/x-mixed-replace 交给浏览器解码），
     * 但 Chromium 对这条流很挑剔：开头多一个 CRLF、少一个 content-type，它就安静地什么都不显示
     * ——面板看起来就是一块黑。所以这里改成自己读流：fetch + ReadableStream，从字节里切出
     * 一张张 JPEG、createImageBitmap 解出来画到 canvas 上，不依赖浏览器对 multipart 的容忍度。
     * 环境里没有流式 fetch / createImageBitmap 时才退回 <img>。
     */
    function indexOfPair(buf, a, b, from = 0) {
      for (let i = from; i + 1 < buf.length; i += 1) {
        if (buf[i] === a && buf[i + 1] === b) return i;
      }
      return -1;
    }

    function LiveView({ url, filter, label = '', onDead }) {
      const canvasRef = useRef(null);
      const [mode, setMode] = useState('auto');
      // 流断了只通知外面（外面延迟 900ms 换一个 nonce 重连），不在这里自己重开——
      // 否则 effect 依赖一变就立刻重跑，服务端一收流就成了热循环
      const die = () => { if (typeof onDead === 'function') onDead(); };
      useEffect(() => {
        if (!url) return undefined;
        const canvas = canvasRef.current;
        const ctx2d = canvas?.getContext?.('2d');
        if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function' || !ctx2d) {
          setMode('img');
          return undefined;
        }
        let stopped = false;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        (async () => {
          try {
            const res = await fetch(url, { signal: ctrl?.signal, cache: 'no-store' });
            if (!res?.ok || !res.body?.getReader) { setMode('img'); return; }
            const reader = res.body.getReader();
            let buf = new Uint8Array(0);
            for (;;) {
              const { value, done } = await reader.read();
              if (stopped || done) break;
              if (value?.length) {
                const merged = new Uint8Array(buf.length + value.length);
                merged.set(buf);
                merged.set(value, buf.length);
                buf = merged;
              }
              // 一次 read 里可能躺着好几帧，切完为止
              for (;;) {
                const start = indexOfPair(buf, 0xff, 0xd8);
                if (start < 0) { if (buf.length > (1 << 20)) buf = new Uint8Array(0); break; }
                const end = indexOfPair(buf, 0xff, 0xd9, start + 2);
                if (end < 0) { if (start > 0) buf = buf.slice(start); break; }
                const jpeg = buf.slice(start, end + 2);
                buf = buf.slice(end + 2);
                const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
                if (stopped) { bmp?.close?.(); break; }
                if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
                  canvas.width = bmp.width;
                  canvas.height = bmp.height;
                }
                ctx2d.drawImage(bmp, 0, 0);
                bmp?.close?.();
              }
            }
            if (!stopped) die();
          } catch (e) {
            if (!stopped && String(e?.name) !== 'AbortError') die();
          }
        })();
        return () => { stopped = true; try { ctrl?.abort(); } catch { /* 忽略 */ } };
      }, [url]);

      if (mode === 'img') {
        return h('img', {
          className: 'dsw-img',
          src: url,
          alt: label,
          style: filter ? { filter } : undefined,
          onError: die,
        });
      }
      return h('canvas', {
        className: 'dsw-canvas',
        ref: canvasRef,
        'aria-label': label,
        style: filter ? { filter } : undefined,
      });
    }

    function SettingsPage() {
      const [state, setState] = useState({ loading: true, error: null, config: null, devices: [], meta: null });
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);
      const [dirty, setDirty] = useState(false);

      const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
          const cfg = await getJson('/config');
          let devices = [];
          try {
            const d = await getJson('/devices');
            devices = d.devices ?? [];
          } catch { /* 没设备也要能把设置页打开 */ }
          let live = null;
          try { live = await getJson('/status'); } catch { /* 状态拿不到不影响改设置 */ }
          setState({ loading: false, error: null, config: cfg.config, devices, meta: { ...cfg, status: live } });
        } catch (e) {
          setState((s) => ({ ...s, loading: false, error: String(e?.message ?? e) }));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      /** 排错时最有用的两个字："复制"。给一张能直接贴给别人的诊断单。 */
      const copyDiag = async () => {
        const text = buildDiag(state);
        try {
          await navigator.clipboard.writeText(text);
          setNotice({ kind: 'ok', lines: [t('diagDone')] });
        } catch {
          setNotice({ kind: 'warn', lines: [t('diagFail')] });
        }
      };

      const patch = (key, value) => {
        setDirty(true);
        setNotice(null);
        setState((s) => ({ ...s, config: { ...s.config, [key]: value } }));
      };

      const save = async () => {
        const c = state.config;
        if (!c) return;
        setSaving(true);
        setNotice(null);
        try {
          const body = await postJson('/config', {
            patch: {
              device: c.device ?? null,
              width: Number(c.width),
              height: Number(c.height),
              fps: Number(c.fps),
              frames: Number(c.frames),
              quality: Number(c.quality),
              previewWidth: Number(c.previewWidth),
              monitor: Boolean(c.monitor),
              sendOnOpen: Boolean(c.sendOnOpen),
              autoReply: Boolean(c.autoReply),
              replyIntervalSec: Number(c.replyIntervalSec),
              replyAttach: Boolean(c.replyAttach),
              replyBudget: Number(c.replyBudget),
            },
          });
          setState((s) => ({ ...s, config: body.config, meta: { ...s.meta, warnings: body.warnings ?? [] } }));
          setDirty(false);
          setNotice({ kind: (body.warnings ?? []).length ? 'warn' : 'ok', lines: (body.warnings ?? []).length ? body.warnings : [t('saved')] });
        } catch (e) {
          setNotice({ kind: 'error', lines: [String(e?.message ?? e)] });
        } finally {
          setSaving(false);
        }
      };

      const c = state.config;
      const resolutions = state.meta?.resolutions ?? [[1280, 720]];

      return h('div', { className: 'dsw-page' },
        h('header', { className: 'dsw-head' },
          h('h2', { className: 'dsw-h2' }, t('title')),
          h('p', { className: 'dsw-sub' }, t('subtitle')),
          h('p', { className: 'dsw-fine' }, t('privacy')),
          state.meta?.status ? h('p', { className: 'dsw-fine' },
            `${t('replyTo')}：${state.meta.status.reply?.sessionId ?? t('replyNone')}`
            + ` · ${t('replyAuto')} ${state.meta.status.reply?.auto ? t('on') : t('off')}`
            + ` · ${t('replyEvery')} ${state.meta.status.reply?.intervalSec ?? c?.replyIntervalSec ?? '-'}s`
            + ` · ${state.meta.status.running ? '● ' + t('running') : '○ ' + t('idle')}`) : null,
        ),

        state.loading && !c ? h(Banner, { kind: 'info' }, t('loading')) : null,
        state.error ? h(Banner, { kind: 'error' }, state.error) : null,

        c ? h('div', { className: 'dsw-grid' },
          h(Field, { label: t('device') },
            h('select', {
              className: 'dsw-input',
              value: c.device ?? '',
              onChange: (e) => patch('device', e.target.value || null),
            },
            h('option', { value: '' }, state.devices.length ? '自动（第一个摄像头）' : t('noDevice')),
            state.devices.map((d) => h('option', { key: d.name, value: d.name }, `${d.name}${d.kind === 'video?' ? '（虚拟）' : ''}`)),
            )),

          h(Field, { label: t('resolution') },
            h('select', {
              className: 'dsw-input',
              value: `${c.width}x${c.height}`,
              onChange: (e) => {
                const [w, hh] = e.target.value.split('x').map(Number);
                patch('width', w);
                patch('height', hh);
              },
            },
            resolutions.map(([w, hh]) => h('option', { key: `${w}x${hh}`, value: `${w}x${hh}` }, `${w} × ${hh}`)),
            )),

          h(Field, { label: t('fps'), hint: t('hFps') },
            h('input', {
              className: 'dsw-input', type: 'number', min: 1, max: 30, step: 1,
              value: c.fps,
              onChange: (e) => patch('fps', e.target.value),
            })),

          h(Field, { label: t('frames'), hint: t('hFrames') },
            h('input', {
              className: 'dsw-input', type: 'number', min: 1, max: 9, step: 1,
              value: c.frames,
              onChange: (e) => patch('frames', e.target.value),
            })),

          h(Field, { label: t('quality') },
            h('select', {
              className: 'dsw-input',
              value: String(c.quality ?? 1),
              onChange: (e) => patch('quality', Number(e.target.value)),
            },
            h('option', { value: '0' }, '省 token（小图）'),
            h('option', { value: '1' }, '标准'),
            h('option', { value: '2' }, '清晰'),
            h('option', { value: '3' }, '最清晰（大图）'),
            )),

          h(Field, { label: t('previewSize'), hint: t('hPreview') },
            h('input', {
              className: 'dsw-input', type: 'number', min: 240, max: 1280, step: 40,
              value: c.previewWidth,
              onChange: (e) => patch('previewWidth', e.target.value),
            })),

          h(Field, { label: t('monitor'), hint: t('monitorHint') },
            h('input', {
              className: 'dsw-check', type: 'checkbox',
              checked: Boolean(c.monitor),
              onChange: (e) => patch('monitor', e.target.checked),
            })),

          h(Field, { label: t('sendOnOpen'), hint: t('sendOnOpenHint') },
            h('input', {
              className: 'dsw-check', type: 'checkbox',
              checked: Boolean(c.sendOnOpen),
              onChange: (e) => patch('sendOnOpen', e.target.checked),
            })),

          h(Field, { label: t('replyAuto'), hint: t('replyAutoHint') },
            h('input', {
              className: 'dsw-check', type: 'checkbox',
              checked: Boolean(c.autoReply),
              onChange: (e) => patch('autoReply', e.target.checked),
            })),

          h(Field, { label: t('replyEvery'), hint: t('replyEveryHint') },
            h('input', {
              className: 'dsw-input', type: 'number', min: 3, max: 600, step: 1,
              value: c.replyIntervalSec,
              onChange: (e) => patch('replyIntervalSec', e.target.value),
            })),

          h(Field, { label: t('replyAttach'), hint: t('replyAttachHint') },
            h('input', {
              className: 'dsw-check', type: 'checkbox',
              checked: Boolean(c.replyAttach),
              onChange: (e) => patch('replyAttach', e.target.checked),
            })),

          h(Field, { label: t('replyBudget'), hint: t('replyBudgetHint') },
            h('input', {
              className: 'dsw-input', type: 'number', min: 1, max: 200, step: 1,
              value: c.replyBudget,
              onChange: (e) => patch('replyBudget', e.target.value),
            })),
        ) : null,

        notice ? h(Banner, { kind: notice.kind === 'ok' ? 'ok' : notice.kind === 'warn' ? 'warn' : 'error' },
          notice.lines.map((line, i) => h('div', { key: i }, line))) : null,

        (state.meta?.warnings ?? []).length && !notice
          ? h(Banner, { kind: 'warn' }, state.meta.warnings.map((w, i) => h('div', { key: i }, w)))
          : null,

        c ? h('div', { className: 'dsw-actions' },
          h('button', {
            className: 'dsw-btn is-primary',
            onClick: save,
            disabled: saving || !dirty,
          }, saving ? t('saving') : t('save')),
          h('button', {
            className: 'dsw-btn',
            onClick: () => { ui.set(true); },
          }, t('open')),
          h('button', { className: 'dsw-btn is-ghost', onClick: load }, '重新读取'),
          h('button', { className: 'dsw-btn is-ghost', onClick: copyDiag, title: t('diagHint') }, t('diag')),
        ) : null,

        h('div', { className: 'dsw-meta' },
          state.meta?.ffmpeg?.path
            ? h('div', { className: 'dsw-meta-row' },
              h('span', { className: 'dsw-meta-key' }, t('ffmpeg')),
              h('code', { className: 'dsw-code' }, state.meta.ffmpeg.path),
              h('span', { className: 'dsw-meta-tag' }, state.meta.ffmpeg.source || ''))
            : null,
          state.meta?.path
            ? h('div', { className: 'dsw-meta-row' },
              h('span', { className: 'dsw-meta-key' }, t('configPath')),
              h('code', { className: 'dsw-code' }, state.meta.path))
            : null,
        ),
      );
    }

    // ── 输入框上的小按钮 ─────────────────────────────────
    function ComposerButton() {
      const open = usePanelOpen();
      return h('button', {
        type: 'button',
        className: `dsw-pill${open ? ' is-on' : ''}`,
        title: t('open'),
        'aria-pressed': open,
        onClick: () => {
          // 你在哪个会话点的这个按钮，就让那个会话负责说话
          const sid = currentSessionId();
          if (sid) postJson('/control', { action: 'bind', sessionId: sid }).catch(() => {});
          ui.toggle();
        },
      },
      h('span', { className: 'dsw-pill-dot', 'aria-hidden': 'true' }),
      h('span', { className: 'dsw-pill-text' }, t('nav')),
      );
    }

    // ── 面板的位置：能拖、能改宽、记住上次的样子 ──────────
    const BOX_KEY = 'dsh-see-world.panel';
    function readBox() {
      try {
        const raw = window.localStorage?.getItem(BOX_KEY);
        const b = raw ? JSON.parse(raw) : null;
        if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w)) {
          return { x: b.x, y: b.y, w: Math.max(320, Math.min(1400, b.w)) };
        }
      } catch { /* 隐私模式没有 localStorage：那就每次回到默认位置 */ }
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const w = Math.min(760, Math.max(420, Math.round(vw * 0.46)));
      return { x: Math.max(12, vw - w - 28), y: Math.max(56, Math.round(vh * 0.12)), w };
    }

    // ── 现在是哪个会话在看？──────────────────────────────
    // conversation.composer.dock 传进来的 props 是空对象，拿不到 sessionId；
    // 但 shell 自己把"当前会话"persist 在 localStorage 的 dsh.sessions.current 里
    // （dsh-client-ui-workspace 的 UiWorkspaceService.selection）。读它 = 知道你正看着哪个会话。
    const CURRENT_SESSION_KEY = 'dsh.sessions.current';
    function currentSessionId() {
      try {
        const raw = window.localStorage?.getItem(CURRENT_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const id = parsed?.sessionId ?? parsed?.state?.sessionId;
        return typeof id === 'string' && id.trim() ? id.trim() : null;
      } catch {
        return null; // 隐私模式 / key 被清过：退回宿主侧的"最近活动会话"
      }
    }

    /**
     * 拖动的落点：夹在视口里，手指移到屏幕外也不会把面板带出去。
     * 抽成纯函数是为了能被测试直接算——拖动本身在假宿主里不好跑。
     */
    function clampBox(from, dx, dy, vw, vh) {
      const width = (vw || 1280);
      const height = (vh || 800);
      return {
        ...from,
        x: Math.min(Math.max(6, from.x + dx), Math.max(6, width - from.w - 6)),
        y: Math.min(Math.max(6, from.y + dy), Math.max(6, height - 64)),
      };
    }

    /** 改宽的落点：不小于 360，也不越过右边界。 */
    function clampWidth(from, dx, vw) {
      const width = (vw || 1280);
      return {
        ...from,
        w: Math.min(Math.max(360, from.w + dx), Math.max(360, width - from.x - 8)),
      };
    }

    function usePanelBox() {
      const [box, setBox] = useState(readBox);
      // 拖动是高频 setState，用 ref 记最新值，松手时才落盘
      const latest = useRef(box);
      latest.current = box;
      const commit = () => {
        try { window.localStorage?.setItem(BOX_KEY, JSON.stringify(latest.current)); } catch { /* ignore */ }
      };
      const drag = (e) => {
        if (e.button != null && e.button !== 0) return;
        // 别把按钮上的点击吃掉：只有点在标题/空白处才拖
        if (e.target?.closest?.('button,select,input,a')) return;
        e.preventDefault();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const from = { ...latest.current };
        const move = (ev) => {
          setBox(clampBox(from, ev.clientX - x0, ev.clientY - y0, window.innerWidth, window.innerHeight));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          commit();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      const resize = (e) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX;
        const from = { ...latest.current };
        const move = (ev) => {
          setBox(clampWidth(from, ev.clientX - x0, window.innerWidth));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          commit();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      return { box, drag, resize };
    }

    // ── 浮层面板 ─────────────────────────────────────────
    function Panel() {
      const open = usePanelOpen();
      const [config, setConfig] = useState(null);
      const [busy, setBusy] = useState(null);
      const [flash, setFlash] = useState(null);
      const [booted, setBooted] = useState(false);
      const [nonce, setNonce] = useState(0);
      const { box, drag, resize } = usePanelBox();
      const { status } = useStatus(open, 1000);
      const running = Boolean(status?.running);
      const reply = status?.reply ?? null;
      const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
      const replyOn = Boolean(reply?.auto ?? config?.autoReply);
      const boundId = reply?.sessionId ?? null;
      const replyBusy = busy === 'reply';
      // 会话下拉：最近活动的几个 + 当前绑定的那个（万一它已经不在列表里）
      const sessionOptions = (() => {
        const list = sessions.slice(0, 12)
          .filter((s) => s && s.id)
          .map((s) => ({ id: s.id, label: s.title || String(s.id).slice(0, 8) }));
        if (boundId && !list.some((s) => s.id === boundId)) {
          list.unshift({ id: boundId, label: String(boundId).slice(0, 8) });
        }
        return list;
      })();
      const saveCfg = async (patch) => {
        const out = await postJson('/config', { patch });
        if (out?.config) setConfig(out.config);
        return out;
      };
      const previewWidth = Math.max(240, Math.min(1280, Number(config?.previewWidth ?? 640)));
      // 跑起来的时候走长连接：一条 TCP，服务端按帧写，浏览器就地换画面。
      // 没跑的时候才轮询 /frame —— 那时轮询是为了拿"为什么没画面"这句话。
      const { src: stillSrc, info, error, loading } = useLiveFrame({
        width: previewWidth,
        active: open && !running,
        intervalMs: 700,
      });
      // 实时流是 ffmpeg 在采集进程里现成的 MJPEG，帧率就是它那边的预览帧率（默认 30）
      const fps = Math.min(30, Math.max(4, Math.round(Number(status?.preview?.fps ?? status?.capture?.fps) || 30)));
      const liveSrc = running
        ? `${API}/stream?w=${previewWidth}&fps=${fps}&n=${nonce}`
        : null;
      const src = liveSrc || stillSrc;
      // 原生 JPEG 没经过亮度归一，靠 CSS 补回来（gain 来自分析那一路的曝光统计）
      const gain = Number(status?.gain);
      const imgFilter = Number.isFinite(gain) && gain > 0 && Math.abs(gain - 1) > 0.04
        ? `brightness(${Math.max(0.4, Math.min(2.6, gain)).toFixed(2)})`
        : undefined;

      // 打开面板先读配置，并按 sendOnOpen 决定要不要自动抓一张
      useEffect(() => {
        if (!open) return undefined;
        let stopped = false;
        (async () => {
          // 打开面板的这一刻，把"正在看的会话"绑成回报目标
          const sid = currentSessionId();
          if (sid) {
            try { await postJson('/control', { action: 'bind', sessionId: sid }); } catch { /* 没 eye 也没关系，start 时还会绑一次 */ }
          }
          try {
            const body = await getJson('/config');
            if (stopped) return;
            setConfig(body.config);
            if (!booted && body.config?.sendOnOpen) {
              setBooted(true);
              try {
                await postJson('/control', { action: 'start', sessionId: sid ?? undefined });
                const sent = await postJson('/send', { seconds: 1.6, sessionId: sid ?? undefined });
                if (!stopped) setFlash({ kind: 'ok', text: `${t('sent')}（${sent?.images ?? 0} 张）` });
              } catch (e) {
                if (!stopped) setFlash({ kind: 'warn', text: String(e?.message ?? e) });
              }
            } else {
              setBooted(true);
            }
          } catch (e) {
            if (!stopped) setFlash({ kind: 'error', text: String(e?.message ?? e) });
          }
        })();
        return () => { stopped = true; };
      }, [open, booted]);

      // Esc 关面板
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') closePanel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open, replyOn]);

      /**
       * 关面板 = 收起界面。摄像头要不要跟着放开，看自动回报开没开：
       * 开着就继续盯着（它是"值班的眼睛"），关着就没理由继续占着设备。
       */
      const closePanel = () => {
        ui.set(false);
        if (!replyOn) postJson('/control', { action: 'stop' }).catch(() => {});
      };

      const run = async (label, fn) => {
        setBusy(label);
        setFlash(null);
        try {
          const out = await fn();
          setFlash({ kind: 'ok', text: typeof out === 'string' ? out : 'ok' });
        } catch (e) {
          setFlash({ kind: 'error', text: [String(e?.message ?? e), e?.hint].filter(Boolean).join('\n') });
        } finally {
          setBusy(null);
        }
      };

      // 提示条只是"刚才那一下怎么了"，不该常驻在面板里冒充状态
      useEffect(() => {
        if (!flash) return undefined;
        const timer = setTimeout(() => setFlash(null), 5200);
        return () => clearTimeout(timer);
      }, [flash]);

      if (!open) return null;

      const meanV = status?.exposure?.meanV;

      return h('div', { className: 'dsw-overlay', role: 'dialog', 'aria-label': t('title') },
        h('div', {
          className: 'dsw-panel',
          style: { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px` },
        },
          h('header', { className: 'dsw-panel-head', onPointerDown: drag, title: t('dragHint') },
            h('span', { className: 'dsw-grip', 'aria-hidden': 'true' }, '⋮⋮'),
            h('div', { className: 'dsw-panel-title' },
              h('span', { className: `dsw-live-dot${running ? ' is-on' : ''}` }),
              h('span', { className: 'dsw-panel-name' }, status?.device || config?.device || t('nav')),
              h('span', { className: 'dsw-panel-state' }, running ? t('running') : t('idle')),
            ),
            h('button', {
              type: 'button',
              className: 'dsw-x',
              'aria-label': t('close'),
              title: replyOn ? t('closeKeep') : t('closeStops'),
              onClick: closePanel,
            }, '×'),
          ),

          h('div', { className: 'dsw-shot' },
            src
              ? h(LiveView, {
                url: src,
                filter: imgFilter,
                label: t('nav'),
                // 流断了（换设备、ffmpeg 重开）就换个 nonce 重新连一次
                onDead: () => { if (running) setTimeout(() => setNonce((n) => n + 1), 900); },
              })
              : h('div', { className: 'dsw-empty' },
                h('span', { className: 'dsw-empty-line' },
                  loading ? t('loading') : (info?.warnings?.[0] || error || t('empty'))),
                (info?.hint ? h('span', { className: 'dsw-empty-hint' }, info.hint) : null),
                !running && !loading && !info?.hint
                  ? h('span', { className: 'dsw-empty-hint' }, t('emptyHint'))
                  : null),
            h('div', { className: 'dsw-shot-tag' }, clockOf(info?.at ?? status?.at)),
          ),

          h('div', { className: 'dsw-chips' },
            chip(t('brightness'), Number.isFinite(meanV) ? `${Math.round(meanV)}/255` : '—'),
            chip(t('movement'), Number.isFinite(status?.score) ? status.score.toFixed(1) : '—'),
            chip('FPS', status?.fps ? String(Math.round(status.fps)) : (config ? String(config.fps) : '—')),
            chip('帧', status?.frames ? String(status.frames) : '0'),
            info?.gain ? chip('Gain', `×${Number(info.gain).toFixed(2)}`) : null,
          ),

          flash ? h(Banner, { kind: flash.kind === 'ok' ? 'ok' : flash.kind === 'warn' ? 'warn' : 'error' }, flash.text) : null,

          // 回报这一排：哪个会话负责、要不要自动、多久一次
          h('div', { className: 'dsw-reply' },
            h('span', { className: 'dsw-reply-key' }, t('replyTo')),
            sessionOptions.length
              ? h('select', {
                className: 'dsw-select',
                value: boundId ?? '',
                disabled: replyBusy,
                onChange: (e) => run('reply', async () => {
                  const sid = e.target.value;
                  if (!sid) return t('replyNone');
                  const out = await postJson('/control', { action: 'bind', sessionId: sid });
                  return out?.ok === false ? (out?.warnings?.[0] ?? t('idle')) : t('replyBound');
                }),
              },
              !boundId ? h('option', { value: '' }, t('replyNone')) : null,
              sessionOptions.map((s) => h('option', { key: s.id, value: s.id }, s.label)))
              : h('span', { className: 'dsw-reply-note' }, t('replyNoSession')),

            h('button', {
              type: 'button',
              className: `dsw-switch${replyOn ? ' is-on' : ''}`,
              'aria-pressed': replyOn,
              disabled: replyBusy,
              title: t('replyAutoHint'),
              onClick: () => run('reply', async () => {
                const out = await saveCfg({ autoReply: !replyOn });
                return `${t('replyAuto')}：${!replyOn ? t('on') : t('off')}${out?.warnings?.[0] ? ` · ${out.warnings[0]}` : ''}`;
              }),
            }, h('span', { className: 'dsw-switch-dot', 'aria-hidden': 'true' }),
            h('span', null, t('replyAuto'))),

            h('label', { className: 'dsw-reply-int' },
              h('span', null, t('replyEvery')),
              h('input', {
                type: 'number',
                min: 3,
                max: 600,
                step: 1,
                className: 'dsw-input is-num',
                value: String(reply?.intervalSec ?? config?.replyIntervalSec ?? 25),
                disabled: replyBusy,
                onChange: (e) => run('reply', async () => {
                  const sec = Number(e.target.value);
                  if (!Number.isFinite(sec)) return t('idle');
                  const out = await saveCfg({ replyIntervalSec: Math.round(sec) });
                  const got = out?.config?.replyIntervalSec ?? sec;
                  return `${t('replyEvery')} ${got}s${out?.warnings?.[0] ? ` · ${out.warnings[0]}` : ''}`;
                }),
              }),
              h('span', null, 's'),
            ),

            h('span', { className: 'dsw-reply-note' },
              `${t('replyCount')} ${reply?.wakes ?? 0}/${reply?.budget ?? config?.replyBudget ?? 20}`
              + (reply?.replyInSec != null ? ` · ${reply.replyInSec}s` : '')),
          ),

          // 你在别的会话里看着这个面板：给一个显式的"改绑"，而不是偷偷抢过去
          (() => {
            const cur = currentSessionId();
            if (!cur || cur === boundId) return null;
            return h('div', { className: 'dsw-reply' },
              h('button', {
                type: 'button',
                className: 'dsw-btn is-mini',
                disabled: replyBusy,
                title: t('rebindHint'),
                onClick: () => run('bind', async () => {
                  const out = await postJson('/control', { action: 'bind', sessionId: cur });
                  return out?.ok ? `${t('replyBound')} ${String(cur).slice(0, 8)}` : t('idle');
                }),
              }, t('rebind')),
              h('span', { className: 'dsw-reply-note' }, String(cur).slice(0, 8)),
            );
          })(),

          h('footer', { className: 'dsw-panel-foot' },
            running
              ? h('button', {
                className: 'dsw-btn', disabled: busy === 'stop',
                onClick: () => run('stop', async () => {
                  await postJson('/control', { action: 'stop' });
                  return t('idle');
                }),
              }, busy === 'stop' ? '…' : t('stop'))
              : h('button', {
                className: 'dsw-btn is-primary', disabled: busy === 'start',
                onClick: () => run('start', async () => {
                  const out = await postJson('/control', { action: 'start', sessionId: currentSessionId() ?? undefined });
                  // 不写死文案：后端说没起来就是没起来
                  return out?.running ? t('running') : (out?.warnings?.[0] ?? t('idle'));
                }),
              }, busy === 'start' ? '…' : t('start')),

            h('button', {
              className: 'dsw-btn is-primary', disabled: busy === 'send',
              onClick: () => run('send', async () => {
                const out = await postJson('/send', { seconds: 1.6, sessionId: currentSessionId() ?? undefined });
                return `${t('sent')}（${out?.images ?? 0} 张）`;
              }),
            }, busy === 'send' ? t('sending') : t('send')),
          ),
          h('span', { className: 'dsw-resize', onPointerDown: resize, title: t('resizeHint'), 'aria-hidden': 'true' }),
        ),
      );
    }

    // ── 样式 ─────────────────────────────────────────────
    const CSS = `
.dsw-page{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;max-width:720px}
.dsw-head{display:flex;flex-direction:column;gap:4px}
.dsw-h2{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-text-1,#e8e8ee)}
.dsw-sub{margin:0;font-size:12.5px;color:var(--dsw-alias-text-2,#a5a7b4)}
.dsw-fine{margin:0;font-size:11.5px;color:var(--dsw-alias-text-3,#7c7f8c)}
.dsw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
@media (max-width:620px){.dsw-grid{grid-template-columns:1fr}}
.dsw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsw-field-label{font-size:12.5px;color:var(--dsw-alias-text-1,#e8e8ee)}
.dsw-field-hint{font-size:11px;color:var(--dsw-alias-text-3,#7c7f8c);line-height:1.45}
.dsw-input{height:30px;padding:0 8px;border-radius:7px;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16));
  background:var(--dsw-alias-fill-2,rgba(255,255,255,.06));
  color:var(--dsw-alias-text-1,#e8e8ee);outline:none}
.dsw-input:focus{border-color:var(--dsw-alias-accent,#6f8cff)}
.dsw-check{width:15px;height:15px;accent-color:var(--dsw-alias-accent,#6f8cff)}
.dsw-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsw-btn{height:30px;padding:0 13px;border-radius:8px;font-size:12.5px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16));
  background:var(--dsw-alias-fill-2,rgba(255,255,255,.06));
  color:var(--dsw-alias-text-1,#e8e8ee);transition:background .12s,border-color .12s}
.dsw-btn:hover:not(:disabled){background:var(--dsw-alias-fill-3,rgba(255,255,255,.11))}
.dsw-btn:disabled{opacity:.5;cursor:default}
.dsw-btn.is-primary{background:var(--dsw-alias-accent,#6f8cff);border-color:transparent;color:#fff}
.dsw-btn.is-ghost{background:transparent}
.dsw-btn.is-mini{height:24px;padding:0 9px;font-size:11.5px;border-radius:6px}
.dsw-banner{font-size:12px;line-height:1.55;padding:8px 10px;border-radius:8px;
  border:1px solid transparent;white-space:pre-wrap}
.dsw-banner.is-info{color:#9fb4ff;background:rgba(111,140,255,.1);border-color:rgba(111,140,255,.3)}
.dsw-banner.is-ok{color:#7ce0a6;background:rgba(80,200,140,.1);border-color:rgba(80,200,140,.3)}
.dsw-banner.is-warn{color:#f0c86a;background:rgba(240,200,106,.1);border-color:rgba(240,200,106,.3)}
.dsw-banner.is-error{color:#ff8e8e;background:rgba(255,110,110,.1);border-color:rgba(255,110,110,.3)}
.dsw-meta{display:flex;flex-direction:column;gap:5px;margin-top:4px}
.dsw-meta-row{display:flex;gap:8px;align-items:baseline;font-size:11.5px;min-width:0}
.dsw-meta-key{flex:none;color:var(--dsw-alias-text-3,#7c7f8c)}
.dsw-meta-tag{flex:none;font-size:10.5px;padding:1px 6px;border-radius:5px;
  background:var(--dsw-alias-fill-3,rgba(255,255,255,.11));color:var(--dsw-alias-text-3,#7c7f8c)}
.dsw-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
  color:var(--dsw-alias-text-2,#a5a7b4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsw-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;
  border-radius:999px;cursor:pointer;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16));
  background:var(--dsw-alias-fill-2,rgba(255,255,255,.06));
  color:var(--dsw-alias-text-2,#a5a7b4)}
.dsw-pill:hover{background:var(--dsw-alias-fill-3,rgba(255,255,255,.11));color:var(--dsw-alias-text-1,#e8e8ee)}
.dsw-pill.is-on{border-color:rgba(111,140,255,.55);color:#c6d3ff;background:rgba(111,140,255,.14)}
.dsw-pill-dot{width:7px;height:7px;border-radius:50%;background:#6f8cff;box-shadow:0 0 0 3px rgba(111,140,255,.16)}
.dsw-pill.is-on .dsw-pill-dot{animation:dsw-blink 1.6s ease-in-out infinite}
@keyframes dsw-blink{0%,100%{opacity:1}50%{opacity:.35}}

/* 浮层不吃整个屏幕的点击：它只是一块能拖的窗口，底下 DSH 照常能点 */
.dsw-overlay{position:fixed;inset:0;z-index:60;pointer-events:none}
.dsw-panel{position:absolute;pointer-events:auto;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);overflow:auto;
  display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;border-radius:14px;
  background:var(--dsw-alias-page-2,#1b1d24);
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16));
  box-shadow:0 24px 70px rgba(0,0,0,.5)}
.dsw-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  cursor:grab;user-select:none;touch-action:none;margin:-4px -4px 0;padding:4px;border-radius:8px}
.dsw-panel-head:active{cursor:grabbing}
.dsw-panel-head:hover{background:var(--dsw-alias-fill-2,rgba(255,255,255,.06))}
.dsw-grip{font-size:11px;letter-spacing:-2px;color:var(--dsw-alias-text-3,#7c7f8c);flex:none}
.dsw-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;
  touch-action:none;opacity:.5;
  background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-text-3,#7c7f8c) 46%,var(--dsw-alias-text-3,#7c7f8c) 56%,transparent 56%,
    transparent 70%,var(--dsw-alias-text-3,#7c7f8c) 70%,var(--dsw-alias-text-3,#7c7f8c) 80%,transparent 80%)}
.dsw-resize:hover{opacity:.95}
.dsw-reply{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;
  color:var(--dsw-alias-text-3,#7c7f8c);padding:6px 8px;border-radius:9px;
  background:var(--dsw-alias-fill-2,rgba(255,255,255,.05))}
.dsw-reply-key{flex:none;color:var(--dsw-alias-text-2,#a5a7b4)}
.dsw-reply-note{margin-left:auto;flex:none;font-size:11.5px;font-variant-numeric:tabular-nums}
.dsw-reply-int{display:inline-flex;align-items:center;gap:4px;flex:none}
.dsw-select{height:26px;max-width:190px;padding:0 8px;border-radius:7px;font-size:12px;
  color:var(--dsw-alias-text-1,#e8e8ee);background:var(--dsw-alias-page-1,#14161c);
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16));cursor:pointer}
.dsw-input.is-num{width:56px;height:26px;padding:0 6px;border-radius:7px;font-size:12px;text-align:right;
  color:var(--dsw-alias-text-1,#e8e8ee);background:var(--dsw-alias-page-1,#14161c);
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16))}
.dsw-switch{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  font-size:12px;cursor:pointer;flex:none;
  color:var(--dsw-alias-text-2,#a5a7b4);background:transparent;
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.16))}
.dsw-switch-dot{width:7px;height:7px;border-radius:50%;background:#666;flex:none}
.dsw-switch.is-on{color:#8fe3b4;border-color:rgba(75,209,139,.5);background:rgba(75,209,139,.12)}
.dsw-switch.is-on .dsw-switch-dot{background:#4bd18b;box-shadow:0 0 0 3px rgba(75,209,139,.16)}
.dsw-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsw-panel-title{display:flex;align-items:center;gap:8px;min-width:0}
.dsw-live-dot{width:8px;height:8px;border-radius:50%;background:#666;flex:none}
.dsw-live-dot.is-on{background:#4bd18b;box-shadow:0 0 0 3px rgba(75,209,139,.18);animation:dsw-blink 1.6s ease-in-out infinite}
.dsw-panel-name{font-size:13px;font-weight:600;color:var(--dsw-alias-text-1,#e8e8ee);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-panel-state{font-size:11.5px;color:var(--dsw-alias-text-3,#7c7f8c);flex:none}
.dsw-x{width:26px;height:26px;border-radius:7px;border:none;cursor:pointer;font-size:17px;line-height:1;
  background:transparent;color:var(--dsw-alias-text-3,#7c7f8c)}
.dsw-x:hover{background:var(--dsw-alias-fill-3,rgba(255,255,255,.11));color:var(--dsw-alias-text-1,#e8e8ee)}
.dsw-shot{position:relative;border-radius:10px;overflow:hidden;background:#0b0d12;
  aspect-ratio:16/9;max-height:min(56vh,520px);display:flex;align-items:center;justify-content:center}
.dsw-img{width:100%;height:100%;object-fit:contain;display:block}
.dsw-canvas{max-width:100%;max-height:100%;width:auto;height:auto;display:block;background:#000}
.dsw-empty{display:flex;flex-direction:column;gap:5px;align-items:center;color:var(--dsw-alias-text-3,#7c7f8c);
  font-size:12.5px;padding:24px;text-align:center;max-width:min(420px,88%)}
.dsw-empty-line{color:var(--dsw-alias-text-2,#a5a7b4);line-height:1.5}
.dsw-empty-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-text-3,#7c7f8c);word-break:break-word}
.dsw-shot-tag{position:absolute;left:8px;bottom:8px;font-family:ui-monospace,Consolas,monospace;
  font-size:11px;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff}
.dsw-chips{display:flex;gap:6px;flex-wrap:wrap}
.dsw-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:3px 8px;border-radius:7px;
  background:var(--dsw-alias-fill-2,rgba(255,255,255,.06));
  border:1px solid var(--dsw-alias-border-2,rgba(255,255,255,.12))}
.dsw-chip-key{color:var(--dsw-alias-text-3,#7c7f8c)}
.dsw-chip-val{color:var(--dsw-alias-text-1,#e8e8ee);font-variant-numeric:tabular-nums}
.dsw-panel-foot{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
`;

    // ── 装配 ─────────────────────────────────────────────
    function apply(ctx) {
      if (ctx?.effect) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-see-world';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-see-world: styles');
      }

      const slots = ctx?.slots;
      if (!slots?.inject) return;

      // 侧栏设置页
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: NS,
        order: 44,
        label: () => t('nav'),
      }, SettingsPage));

      // 输入框上方的小按钮
      slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: NS,
        order: 6,
      }, ComposerButton));

      // 实时画面浮层
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: `${NS}-panel`,
        order: 40,
      }, Panel));
    }

    return { name: 'dsh-see-world', inject: ['slots'], apply, __test: { clampBox, clampWidth, currentSessionId, readBox, buildDiag } };
  },
});
