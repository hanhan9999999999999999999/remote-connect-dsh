/**
 * pipeline.mjs — 消息前置处理阶段链（Stage pipeline）
 *
 * 抄自 AstrBot 的洋葱模型：
 *   astrbot/core/pipeline/scheduler.py:38 `_process_stages`
 *     — 用 AsyncGenerator 的 yield 点实现「前置 → 递归下一级 → 回来后置」，
 *       `event.is_stopped()` 一置位，后面的阶段全部不跑。
 *   astrbot/core/pipeline/stage_order.py
 *     — 阶段顺序集中声明在一张表里，不散落在调用点。
 *
 * 原来 enqueue() 里六段前置解析（todo / 偏好 / 提醒 / 附件 / 编辑重发 / 语音）
 * 共用一个 try/catch：任何一处抛错（比如 parseWhen 撞到奇怪的日期串），
 * 后面所有阶段连带跳过，用户那句「明早九点叫我」就静默丢了。
 * 拆成独立阶段后：
 *   - 每段自己的 try/catch，一个挂掉不牵连其他；
 *   - 顺序集中在这一张 STAGES 表里；
 *   - 想加新前置（拦截、静音、快速回复）＝ 注册一个阶段，不碰 enqueue；
 *   - ctx.abort() 一调就短路，后面的阶段连同模型调用全部跳过。
 *
 * 零依赖，可单独 node 跑测试（见 _test_pipeline.mjs）。
 */

/** 默认阶段顺序：数字小的先跑。集中一处声明，跟 AstrBot 的 stage_order.py 同地位。 */
export const STAGES = {
  todo: 10,
  pref: 20,
  reminder: 30,
  attachments: 40,
  editFrom: 50,
  voice: 60,
  compose: 90,
};

/**
 * 一次消息处理共享的上下文。阶段之间只通过它传值，不互相 import。
 */
export function createContext(init = {}) {
  const notes = [];
  const meta = {};
  return {
    /** 用户原话（未加工） */
    text: String(init.text || ''),
    /** 已校验过的附件列表 */
    files: Array.isArray(init.files) ? init.files : [],
    /** 调用方选项：{ voice, editFrom } */
    opts: init.opts || {},
    /** 'life' | 'work' */
    mode: init.mode || 'work',
    /** 追加到最终 payload 的片段，按 push 顺序拼接 */
    notes,
    /** 阶段之间的传递槽（如 todoHandled） */
    meta,
    /** 收集到的阶段错误，不抛给调用方 */
    errors: [],
    /** 每次阶段运行的耗时记录（毫秒） */
    timings: [],
    /** 短路标记 */
    aborted: false,
    /** 短路时直接回给用户的话 */
    reply: '',

    /** 追加一段提示（等价于原来 payload += '...'） */
    note(s) {
      if (s) notes.push(String(s));
      return this;
    },
    get(k) {
      return meta[k];
    },
    set(k, v) {
      meta[k] = v;
      return this;
    },
    /** 短路：这一轮不进模型，直接把 reply 回给用户 */
    abort(reply) {
      this.aborted = true;
      if (reply) this.reply = String(reply);
      return this;
    },
    /** 最终送进 DSH 的 payload */
    compose(fallbackForFiles = '（发来文件）') {
      const head = this.text || (this.files.length ? fallbackForFiles : '');
      return [head, ...notes].filter((x) => x && String(x).length).join('\n\n');
    },
  };
}

/**
 * 阶段链。
 *
 *   const p = new Pipeline({ onError: (name, err) => ... });
 *   p.use('todo', 10, async (ctx, next) => { ...; await next(); });
 *   const ctx = await p.run(createContext({ text }));
 */
export class Pipeline {
  constructor({ onError } = {}) {
    this.stages = [];
    this.onError = typeof onError === 'function' ? onError : null;
  }

  /** 注册阶段。order 省略时用 STAGES 表里的值，再没有就排在最后。 */
  use(name, order, fn) {
    if (typeof order === 'function') {
      fn = order;
      order = STAGES[name] ?? 1000;
    }
    if (typeof fn !== 'function') throw new TypeError(`stage ${name} 需要一个函数`);
    this.stages.push({ name, order: Number(order) || 0, fn });
    this.stages.sort((a, b) => a.order - b.order);
    return this;
  }

  /**
   * 跑完整条链。
   *
   * 每个阶段独立 try/catch：抛错就记进 ctx.errors，链条继续往下走
   * （AstrBot 原版是整个 scheduler 外面包一层，一个插件炸了整条流水线一起没了；
   *  这里按阶段隔离，代价小、保命）。
   */
  async run(ctx) {
    const stages = this.stages;
    let i = 0;

    const dispatch = async () => {
      if (ctx.aborted) return;
      if (i >= stages.length) return;
      const stage = stages[i];
      i += 1;
      const t0 = process.hrtime.bigint();
      try {
        await stage.fn(ctx, dispatch);
      } catch (err) {
        ctx.errors.push({ stage: stage.name, message: String((err && err.message) || err) });
        if (this.onError) {
          try {
            this.onError(stage.name, err);
          } catch {}
        }
        // 阶段自己没往下走，就替它往下走 —— 保证一个坏阶段不会掐断整条链
        if (i < stages.length && !ctx.aborted) return dispatch();
      } finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        ctx.timings.push({ stage: stage.name, ms: Math.round(ms * 100) / 100 });
      }
    };

    await dispatch();
    while (!ctx.aborted && i < stages.length) {
      // 有阶段没调 next() 就返回了（但也没 abort）：视作「到此为止」，不硬跑后面的
      break;
    }
    return ctx;
  }
}

/**
 * 默认阶段集合 —— 把 enqueue() 里原来那六段搬过来，语义逐条对齐。
 *
 * 依赖全部注入（不做模块级 import），这样测试时可以塞假实现，
 * 也避免 server.mjs 与 pipeline.mjs 循环引用。
 *
 * deps: {
 *   todos, prefs, reminders,        // 三个业务模块
 *   WORKDIR, path, humanSize,       // 附件拼路径用
 *   log, broadcast, catchErr,       // server.mjs 的日志/推送
 * }
 */
export function defaultStages(deps) {
  const { todos, prefs, reminders, path, WORKDIR, humanSize } = deps;
  const log = deps.log || (() => {});
  const broadcast = deps.broadcast || (() => {});
  const catchErr = deps.catchErr || (() => {});

  return [
    [
      'todo',
      STAGES.todo,
      (ctx, next) => {
        // 顺序很重要：todo 必须先求值，reminder 才知道要不要让位。
        // 拆开之后这个依赖走 ctx.meta，不再靠函数内变量顺序（原来的 TDZ 就是那么来的）。
        const todo = todos.tryFromText(ctx.text, reminders.parseWhen);
        ctx.set('todoHandled', !!todo);
        if (todo && todo.item) {
          broadcast('todo-new', todo.item);
          log('todo', todo.item.text.slice(0, 40) + (todo.at ? `（提醒 ${new Date(todo.at).toLocaleString('zh-CN')}）` : ''));
        }
        return next();
      },
    ],

    [
      'pref',
      STAGES.pref,
      (ctx, next) => {
        const pref = prefs.tryFromText(ctx.text);
        if (pref) {
          broadcast('pref-new', { text: pref });
          log('pref', pref.slice(0, 40));
        }
        return next();
      },
    ],

    [
      'reminder',
      STAGES.reminder,
      (ctx, next) => {
        // 待办优先：一句「记一下：明天问快递，下午三点」只产出一个东西，别既待办又提醒
        if (ctx.get('todoHandled')) return next();
        const rem = reminders.tryFromText(ctx.text, { mode: ctx.mode });
        if (rem) {
          ctx.note(`（提醒已经替你设好了：${rem.label} · ${rem.text}。回话时顺口确认一句就好，别展开解释。）`);
          broadcast('reminder-new', rem);
          log('reminder', `new ${rem.id} ${rem.label} ${rem.text}`);
        }
        return next();
      },
    ],

    [
      'attachments',
      STAGES.attachments,
      (ctx, next) => {
        if (ctx.files.length) {
          const lines = ctx.files.map(
            (f) => `- ${path.join(WORKDIR, f.path)}（${f.name}，${humanSize(f.size)}${f.mime ? `，${f.mime}` : ''}）`,
          );
          ctx.note(`[附件] 手机发来 ${ctx.files.length} 个文件，已经存到本机：\n${lines.join('\n')}`);
          // 图片要真的被「看见」：明确点名路径，别让模型以为附件只是文字
          const imgs = ctx.files.filter((f) => /^image\//.test(f.mime || ''));
          if (imgs.length) {
            ctx.note(
              `[看图] 上面有 ${imgs.length} 张是图片，用 read_image 打开这些绝对路径就能真正看见画面：\n` +
              imgs.map((f) => `- ${path.join(WORKDIR, f.path)}`).join('\n'),
            );
          }
        }
        return next();
      },
    ],

    [
      'editFrom',
      STAGES.editFrom,
      (ctx, next) => {
        if (ctx.opts && ctx.opts.editFrom) {
          // 编辑后重发：让电脑知道这是改过的，原话附在末尾（不改用户当前这句）
          ctx.note('（主人把上面这句编辑后重发，原来的说法是：' + String(ctx.opts.editFrom).slice(0, 300) + '）');
        }
        return next();
      },
    ],

    [
      'voice',
      STAGES.voice,
      (ctx, next) => {
        if (ctx.opts && ctx.opts.voice) {
          ctx.note('（上一句是手机语音转的文字，可能有同音错字；按意思理解就行，不要纠正措辞，也不要提"语音识别"这件事。）');
        }
        return next();
      },
    ],
  ];
}

/** 一条消息从进来到能送进 DSH，走这一趟 */
export async function processMessage(deps, input) {
  const ctx = createContext(input);
  const pipeline = new Pipeline({
    onError: (stage, err) => (deps.catchErr || (() => {}))('stage:' + stage, err),
  });
  for (const [name, order, fn] of defaultStages(deps)) pipeline.use(name, order, fn);
  await pipeline.run(ctx);
  // 阶段耗时里出现明显拖慢的（>20ms），记一笔，方便以后查是谁慢
  const slow = ctx.timings.filter((t) => t.ms > 20);
  if (slow.length && deps.log) {
    deps.log('stage-slow', slow.map((t) => `${t.stage} ${t.ms}ms`).join(' · '));
  }
  return ctx;
}
