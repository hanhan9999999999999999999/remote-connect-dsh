// SDK 常驻 runner：dsh 进程只起一次，之后每轮走 stdio JSON-RPC。
//
// 为什么值得：spawn 路径每轮都要重新付一次冷启动（实测 2.0~2.2s），
// 而模型真正思考只要 0.6~3.7s。改成常驻后，第一轮把 initialize 摊掉，
// 后面每轮只剩「发一句 → 收事件」。
//
// 协议（@deepseek-ai/dsh-sdk-protocol）：
//   initialize           {cwd, provider, model, reasoningEffort, maxTokens?}
//   session/prompt       {sessionId, contentBlocks:[{type:'text',text}]} -> {messageId}
//   session/resume       {sessionId}
//   session/wait         {sessionId}
//   shutdown
// 服务端推：session.event / session.status / subagent.*
// 每轮的关键事实全在 session.event 里：assistant/message 带 usage，
// turn/end 表示这轮结束，tool/call、tool/result 表示工具。
//
// 注意：stdout 只准跑协议帧。有任何插件往 stdout 打印，都要在桥接侧容忍掉
// （这里解析失败的行直接跳过，并把最后几行留在 stderrTail 里方便排错）。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const nonJson = (line) => line && !line.startsWith('{');

export class SdkRunner {
  constructor({ node, bin, profile, cwd, env, log, timeoutMs }) {
    this.node = node;
    this.bin = bin;
    this.profile = profile;
    this.cwd = typeof cwd === 'function' ? cwd : () => cwd;
    this.baseEnv = env || process.env;
    this.log = typeof log === 'function' ? log : () => {};
    this.timeoutMs = Number(timeoutMs || 15 * 60_000);

    this.child = null;
    this.ready = null;          // initialize 的 promise
    this.pending = new Map();   // jsonrpc id -> {resolve, reject}
    this.seq = 1;
    this.waiters = new Set();   // 当前轮的 session.event 消费回调
    this.sessionId = null;
    this.bootMs = null;         // 最近一次 initialize 的耗时，写进 perf 用
    this.stderrTail = '';
    this.stdoutNoise = 0;
  }

  /* ------------------------------------------------------------ 进程生命周期 */

  async _spawnAndInit() {
    const env = { ...this.baseEnv };
    for (const k of Object.keys(env)) if (k.startsWith('DSH_') && k !== 'DSH_HOME') delete env[k];
    env.PHONE_BRIDGE_CHILD = '1';
    env.DSH_STDOUT_IS_PROTOCOL = '1';   // 让本地插件把日志走 stderr，别污染协议
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');

    const t0 = Date.now();
    const child = spawn(this.node, [this.bin, '--profile', this.profile], {
      cwd: this.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    this.stderrTail = '';
    this.stdoutNoise = 0;

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (nonJson(line)) { this.stdoutNoise++; continue; }
        let msg;
        try { msg = JSON.parse(line); } catch { this.stdoutNoise++; continue; }
        this._onMessage(msg);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderrTail += d;
      if (this.stderrTail.length > 8000) this.stderrTail = this.stderrTail.slice(-8000);
    });
    child.on('close', (code) => {
      const err = new Error(`dsh 常驻进程退出（code=${code}）`);
      for (const [, w] of this.pending) w.reject(err);
      this.pending.clear();
      for (const fn of this.waiters) { try { fn({ type: 'exit', code }); } catch {} }
      this.waiters.clear();
      this.child = null;
      this.ready = null;
    });

    const res = await this._rpc('initialize', {
      cwd: this.cwd(),
      provider: this.provider,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    });
    this.bootMs = Date.now() - t0;
    return res;
  }

  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const w = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || 'jsonrpc error'));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method === 'session.event') {
      for (const fn of this.waiters) { try { fn(msg.params.event); } catch {} }
      return;
    }
    if (msg.method === 'session.status') {
      for (const fn of this.waiters) { try { fn({ __status: true, ...msg.params }); } catch {} }
    }
  }

  _rpc(method, params) {
    if (!this.child) throw new Error('runner 未启动');
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, this.timeoutMs);
    });
  }

  /** 确保进程活着并完成 initialize；model/provider 变化时重启。 */
  async ensure({ provider, model, reasoningEffort }) {
    const route = `${provider}/${model}/${reasoningEffort ?? ''}`;
    if (this.child && this.ready && this.route === route) {
      try { await this.ready; return; } catch { /* 掉线了就走下面重启 */ }
    }
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.route = route;
    this.ready = this._spawnAndInit();
    await this.ready;
  }

  /** 有旧会话就先试着接上（历史在磁盘上，接不上就当新会话）。 */
  async adoptSession(sessionId) {
    if (!sessionId) return null;
    if (this.sessionId === sessionId) return sessionId;
    try {
      await this._rpc('session/resume', { sessionId });
      this.sessionId = sessionId;
      return sessionId;
    } catch (e) {
      this.log('sdk', `接不上旧会话 ${sessionId}：${e.message}，改用新会话`);
      return null;
    }
  }

  get alive() { return !!this.child && !!this.ready; }

  abort() {
    try { this.child?.kill(); } catch {}
    this.child = null;
    this.ready = null;
  }

  async shutdown() {
    try { if (this.child) await this._rpc('shutdown', {}); } catch {}
    this.abort();
  }

  /* ---------------------------------------------------------------- 一轮对话 */

  /**
   * 跑一轮。把 SDK 事件翻译成和 spawn 路径一样的形状，交给 onEvent。
   * 返回 { code, sessionId, usage }。
   */
  async runTurn({ text, sessionId, onEvent, onSession }) {
    const emit = (ev) => { try { onEvent && onEvent(ev); } catch {} };

    // 进程不在（第一次 / 崩了）就重起；已有旧会话则续上
    if (!this.alive) {
      await this.ensure({ provider: this.provider, model: this.model, reasoningEffort: this.reasoningEffort });
    }
    // 每轮都显式 resume 一次：常驻进程跑完一轮后会话会停在「已结束」状态，
    // 不重新挂回会话，第二个 session/prompt 就永远等不到事件（实测卡住）。
    if (sessionId) {
      try {
        await this._rpc('session/resume', { sessionId });
        this.sessionId = sessionId;
      } catch (e) {
        this.log('sdk', `resume ${sessionId} 失败：${e.message}`);
      }
    }

    let sid = this.sessionId;
    if (!sid) {
      sid = sessionId && /^session-[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : `session-${crypto.randomUUID()}`;
      this.sessionId = sid;
    }
    emit({ type: 'session', sessionId: sid });

    let usage = null;
    let code = 0;
    let errText = '';
    const done = new Promise((resolve) => {
      const finish = (c, err) => { code = c; errText = err || ''; this.waiters.delete(listener); resolve(); };
      const listener = (ev) => {
        if (ev.__status) { emit({ type: 'status', phase: ev.state === 'running' ? 'turn_start' : 'turn_idle' }); return; }
        switch (ev.type) {
          case 'step/start':
            emit({ type: 'status', phase: 'step_start', turn: ev.data?.turn, step: ev.data?.step });
            break;
          case 'assistant/attempt':
            if (ev.data?.message?.content) forwardContent(ev.data.message.content);
            break;
          case 'assistant/message': {
            if (ev.data?.usage) usage = ev.data.usage;
            forwardContent(ev.data?.message?.content);
            break;
          }
          case 'tool/call': {
            const d = ev.data || {};
            const name = d.name || d.tool || d.call?.name || 'tool';
            const input = d.input || d.args || d.call?.input || {};
            emit({ type: 'tool_call', callId: d.callId || d.id, tool: name, input });
            break;
          }
          case 'tool/result': {
            const d = ev.data || {};
            const raw = typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? '');
            emit({ type: 'tool_result', callId: d.callId || d.id, status: d.status || (d.error ? 'failed' : 'completed'), result: raw.slice(0, 800) });
            break;
          }
          case 'turn/end': {
            const reason = ev.data?.reason || ev.data?.stopReason;
            const bad = reason && (reason.kind === 'error' || reason.kind === 'failed');
            emit({ type: 'status', phase: 'turn_end', usage, reason: bad ? reason : undefined });
            if (bad) finish(1, reason?.error?.message || 'turn error');
            else finish(0, '');
            break;
          }
          case 'exit':
            finish(-1, `dsh 常驻进程退出（code=${ev.code}）`);
            break;
          default:
            break;
        }
      };
      const forwardContent = (content) => {
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type === 'text' && c.text) emit({ type: 'text', text: c.text });
          else if (c.type === 'reasoning' && c.text) emit({ type: 'thinking', text: c.text });
        }
      };
      this.waiters.add(listener);
      setTimeout(() => finish(1, '本轮超时'), this.timeoutMs);
    });

    try {
      // 画面直接作为图片块过去：模型不用先读文件就能看见这一眼。
      const blocks = [{ type: 'text', text }];
      if (Array.isArray(images)) {
        for (const im of images.slice(0, 2)) {
          if (!im || !im.data) continue;
          blocks.push({ type: 'image', data: String(im.data), mimeType: String(im.mimeType || 'image/jpeg') });
        }
      }
      await this._rpc('session/prompt', {
        sessionId: sid,
        contentBlocks: blocks,
      });
    } catch (e) {
      this.waiters.clear();
      this.abort();
      return { code: -1, sessionId: sid, usage, error: e.message };
    }

    await done;
    if (code !== 0 && this.stderrTail) errText = errText || this.stderrTail.trim().split('\n').slice(-6).join('\n');
    return { code, sessionId: sid, usage, error: errText };
  }
}
