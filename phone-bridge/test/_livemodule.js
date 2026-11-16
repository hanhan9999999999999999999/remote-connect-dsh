  (function liveEyes() {
    const bar = $('livebar');
    if (!bar) return;
    const box = $('lb-box');
    const vid = $('lb-video');
    const img = $('lb-img');
    const emptyEl = $('lb-empty');
    const statusEl = $('lb-status');
    const cadSel = $('lb-cad');
    const stopBtn = $('lb-stop');
    const askBtn = $('lb-ask');
    const dot = $('lb-dot');
    const NC = window.DSHCam || null;
    const nativeOk = () => !!(NC && NC.available && NC.available());

    const CAD_KEY = 'dsh.liveCad';
    let CAD = Math.max(4000, Number(localStorage.getItem(CAD_KEY) || 0) || 20000);
    let running = false;
    let timer = null;
    let pollT = null;
    let k = 0;
    let stream = null;
    let nativePreview = false;
    let failWhy = '';

    const say = (t) => { if (statusEl) statusEl.textContent = t || ''; };
    const cadText = () => { if (cadSel) cadSel.value = String(CAD); };

    /* 原生侧的话术接到状态行上 */
    window.__liveInfo = (msg) => { if (msg) say('相机：' + msg); };
    window.__livePreview = (ok, msg) => {
      if (ok) {
        nativePreview = true;
        if (emptyEl) emptyEl.classList.add('off');
      } else {
        nativePreview = false;
        say('取景器没开成：' + (msg || '未知原因'));
      }
    };

    const prevFail = window.__camFail;
    window.__camFail = (msg) => {
      failWhy = String(msg || '取帧失败');
      if (running) say('相机没给画面：' + failWhy);
      if (prevFail) return prevFail(msg);
    };

    /* 原生只给单帧时，把这帧画到 <img> 上，至少屏幕上是活的 */
    const prevFrame = window.__camFrame;
    window.__camFrame = async (b64, w, h, src) => {
      if ((running || pollT) && b64) {
        try {
          img.src = 'data:image/jpeg;base64,' + b64;
          img.classList.add('on');
          if (emptyEl) emptyEl.classList.add('off');
        } catch (_) {}
      }
      if (prevFrame) return prevFrame(b64, w, h, src);
    };

    /* 一帧：浏览器视频流优先（画布取像最稳），原生只做兜底 */
    async function grab() {
      if (stream && vid.videoWidth) {
        const w = 1280;
        const h = Math.max(1, Math.round((w * vid.videoHeight) / vid.videoWidth));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        try { c.getContext('2d').drawImage(vid, 0, 0, w, h); } catch (_) { return null; }
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
        return blob ? { blob: blob, w: w, h: h } : null;
      }
      if (nativeOk() && typeof window.__camGrabOnce === 'function') {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          window.__pushDone = null;
          const f = await window.__camGrabOnce();
          if (f && f.blob) return { blob: f.blob, w: f.w || 0, h: f.h || 0 };
          if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
        }
      }
      return null;
    }

    /* 顺手推进服务端缓冲：这样 AI 想用 phone_see 补看一眼时也有货 */
    async function pushBuffer(f) {
      try {
        const r = await fetch(
          base + '/api/camera/push?t=' + encodeURIComponent(token) + '&mime=image/jpeg&w=' + (f.w || 0) + '&h=' + (f.h || 0) + '&facing=environment',
          { method: 'POST', body: f.blob }
        );
        window.__lastPushStatus = r.status || 0;
        return r.ok;
      } catch (_) {
        window.__lastPushStatus = -1;
        return false;
      }
    }

    /* 这一眼拍到的照片，作为「我」发的附件进会话 */
    async function uploadFrame(f) {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      try {
        const r = await fetch(base + '/api/upload?t=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent('cam-' + stamp + '.jpg'), 'content-type': 'application/octet-stream' },
          body: f.blob,
        });
        const j = await r.json();
        return j && j.ok ? j : null;
      } catch (_) { return null; }
    }

    async function tellServer(on) {
      try {
        await fetch(base + '/api/camera/live?t=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ on: !!on, fps: 0, gapMs: CAD, facing: 'environment' }),
        });
      } catch (_) {}
    }

    async function beat(manual) {
      if (!running && !manual) return 0;
      k += 1;
      failWhy = '';
      const f = await grab();
      if (!f) {
        const why = failWhy || window.__lastGrabWhy
          || (!nativeOk() && !stream ? '这个页面拿不到手机相机' : '相机这一帧没回来');
        say('这一眼没拍到：' + why);
        return 0;
      }
      try {
        img.src = URL.createObjectURL(f.blob);
        img.classList.add('on');
        if (emptyEl) emptyEl.classList.add('off');
      } catch (_) {}
      await pushBuffer(f);
      const up = await uploadFrame(f);
      const body = { k: k };
      if (up && up.path) { body.path = up.path; body.size = up.size; body.mime = 'image/jpeg'; }
      try {
        const r = await fetch(base + '/api/live/comment?t=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 429) {
          const wait = Math.max(1000, Math.ceil(j.waitMs || CAD));
          say('刚看过一眼，' + Math.ceil(wait / 1000) + ' 秒后再看');
          return wait + 400;
        }
        if (r.status === 409) { say('这一眼跳过：手机这边没有画面'); return 0; }
        if (!r.ok) { say('没叫动他：' + (j.error || r.status)); return 0; }
        if (j && j.skipped === 'busy') { say('他还在看上一眼，等这轮说完'); return 0; }
        say('第 ' + (j.k || k) + ' 眼看过了 · ' + new Date().toLocaleTimeString().slice(0, 5));
        return 0;
      } catch (e) {
        say('这一眼出错：' + (e && e.message ? e.message : e));
        return 0;
      }
    }

    /* 自己排下一眼：限流后该等多久只有服务端知道，让它说了算 */
    function schedule(ms) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!running) return;
      timer = setTimeout(async () => {
        timer = null;
        let wait = 0;
        try { wait = await beat(false); } catch (_) { wait = 0; }
        if (running) schedule(wait && wait > 0 ? wait : CAD + 500);
      }, Math.max(0, ms));
    }

    async function startPreview() {
      if (emptyEl) {
        emptyEl.classList.remove('off');
        emptyEl.textContent = '正在开摄像头…';
      }
      /* 1) 浏览器视频流：APK 已经给了相机权限，这条路最稳，画布取帧也最准 */
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          vid.srcObject = stream;
          vid.classList.add('on');
          await vid.play();
          if (emptyEl) emptyEl.classList.add('off');
          say('画面在会话上方 · 他每隔一会儿看一眼');
          return;
        } catch (e) {
          if (emptyEl) emptyEl.textContent = '浏览器不给摄像头，改用原生取景…';
        }
      }
      /* 2) 原生取景器 */
      if (nativeOk()) {
        setTimeout(() => {
          try {
            const r = box.getBoundingClientRect();
            NC.startPreview(r.left, r.top, r.width, r.height);
          } catch (_) {}
        }, 260);
        await new Promise((res) => setTimeout(res, 1000));
        if (nativePreview) return;
        /* 3) 取景器都开不成，就一秒一张顶着 */
        pollT = setInterval(() => { try { NC.grab(); } catch (_) {} }, 1200);
        say('取景器没开成，先用一秒一张顶着');
        return;
      }
      if (emptyEl) emptyEl.textContent = '这台设备给不了画面：装带相机的 DSH-Phone.apk，或用 https 打开';
      say('拿不到摄像头');
    }

    async function start() {
      if (running) return;
      running = true;
      k = 0;
      document.body.classList.add('live-mode');
      window.__liveRunning = true;
      if (dot) dot.classList.add('on');
      cadText();
      try { sheet('cam', false); } catch (_) {}
      await startPreview();
      await tellServer(true);
      schedule(0);
    }

    function stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (pollT) { clearInterval(pollT); pollT = null; }
      document.body.classList.remove('live-mode');
      window.__liveRunning = false;
      if (dot) dot.classList.remove('on');
      tellServer(false);
      if (nativePreview && NC) { try { NC.stopPreview(); } catch (_) {} }
      nativePreview = false;
      if (stream) {
        try { stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); } catch (_) {}
        stream = null;
      }
      try { vid.pause(); } catch (_) {}
      try { vid.srcObject = null; } catch (_) {}
      vid.classList.remove('on');
      img.classList.remove('on');
      try { img.removeAttribute('src'); } catch (_) {}
      if (emptyEl) {
        emptyEl.classList.remove('off');
        emptyEl.textContent = '正在开摄像头…';
      }
      say('他每隔一会儿会看你一眼');
    }

    if (stopBtn) stopBtn.onclick = () => stop();
    if (askBtn) askBtn.onclick = () => { if (!running) start(); else beat(true); };
    if (cadSel) {
      cadSel.onchange = () => {
        CAD = Math.max(4000, Number(cadSel.value) || 20000);
        try { localStorage.setItem(CAD_KEY, String(CAD)); } catch (_) {}
        if (running) {
          tellServer(true);
          schedule(CAD);
          say('改成每 ' + Math.round(CAD / 1000) + ' 秒看一眼');
        }
      };
    }

    /* 「直播」：直接开始，不再先弹一个面板再点开始 */
    const camLive = $('cam-live');
    if (camLive) {
      camLive.onclick = (e) => {
        try { e.stopPropagation(); } catch (_) {}
        try { document.getElementById('cam-close').click(); } catch (_) {}
        setTimeout(() => start(), 200);
      };
    }

    /* 原生取景器是按坐标贴上去的：屏幕转了就重新贴一次 */
    const relayout = () => {
      if (!running || !nativePreview || !NC) return;
      try {
        const r = box.getBoundingClientRect();
        NC.startPreview(r.left, r.top, r.width, r.height);
      } catch (_) {}
    };
    window.addEventListener('resize', relayout);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) setTimeout(relayout, 200);
    });

    cadText();
    window.__liveStart = start;
    window.__liveStop = stop;
    window.__liveInfo = window.__liveInfo || say;
  })();
