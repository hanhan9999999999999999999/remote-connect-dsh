/**
 * dsh-remote-connect · tasks
 *
 * 同步任务表。设置页轮询的就是这里。
 *
 * 任务只活在内存里：进程重启后清空，历史结果看 `syncs/` 目录。
 * 表有上限（默认 40 条），超了按 `startedAt` 淘汰最老的一条，
 * 免得长期运行以后这张表无限长大。
 */
import { rid } from './util.mjs'

export const MAX_TASKS = 40

/** 建一条新任务（还没开始跑，`phase: 'queued'`）。 */
export function newTask({ kind = 'sync', direction = 'push', peerId } = {}) {
  return {
    id: `t_${rid(6)}`,
    kind,
    direction,
    peerId,
    phase: 'queued',
    done: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    detail: '',
    // 进度查询失败了几次：同步照样能成功，但界面上该说得出「进度可能不准」。
    progressFailures: 0,
  }
}

/** 对外视图：只给前端需要的字段，不把内部引用漏出去。 */
export function taskView(t) {
  return {
    id: t.id,
    kind: t.kind,
    direction: t.direction,
    peerId: t.peerId,
    phase: t.phase,
    done: t.done,
    total: t.total,
    bytes: t.bytes,
    totalBytes: t.totalBytes,
    detail: t.detail,
    progressFailures: t.progressFailures ?? 0,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    error: t.error,
    result: t.result,
  }
}

export class TaskTable {
  constructor(max = MAX_TASKS) {
    this.max = max
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  /** 收下一条任务，必要时淘汰最老的一条；返回那条任务本身（后面还要往里写进度）。 */
  add(task) {
    this.map.set(task.id, task)
    this.#trim()
    return task
  }

  get(id) {
    return this.map.get(id) ?? null
  }

  /** 给前端看的视图；找不到返回 null。 */
  view(id) {
    const t = this.get(id)
    return t ? taskView(t) : null
  }

  /** 最近 n 条（按插入顺序，最新在后）。返回的是视图拷贝——改它不会影响任务。 */
  recent(n = 10) {
    return [...this.map.values()].slice(-n).map(taskView)
  }

  /** 任务对象本身（内部用）。视图是拷贝，要改状态必须拿到原对象。 */
  listRefs() {
    return [...this.map.values()]
  }

  /**
   * 淘汰：只淘汰**已经结束**的任务，按开始时间从早到晚。
   *
   * 表有上限是为了「长期运行不无限长大」，不是为了让正在跑的那条从面板上消失——
   * 一旦把在跑的丢了，`/task/status` 查不到它、取消也点不到，用户只能等它自己结束
   * （或者重启）。所以全都在跑的时候宁可暂时超上限，也不丢。
   */
  #trim() {
    while (this.map.size > this.max) {
      let oldest = null
      for (const t of this.map.values()) {
        if (!t.finishedAt) continue
        if (!oldest || t.startedAt < oldest.startedAt) oldest = t
      }
      if (!oldest) return
      this.map.delete(oldest.id)
    }
  }
}
