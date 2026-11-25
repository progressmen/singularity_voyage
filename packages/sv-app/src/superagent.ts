/**
 * Super-agent 核心编排：Router（拆解 / 汇总）+ Worker（隔离会话并发执行）。
 *
 * 本模块不依赖 dsh 运行时，只用注入的 {@linkcode SuperAgentDeps} 驱动，
 * 因此分派、并发、重试、超时与 watchdog 语义可以直接单测。
 * 真实模型调用与会话创建见 `superagent-runtime.ts`。
 */
import { randomUUID } from 'node:crypto'

/** Worker 生命周期状态。 */
export type SuperAgentWorkerStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled'

/** 整轮运行状态。 */
export type SuperAgentRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** 一个可独立执行的子任务。 */
export interface SuperAgentPlanItem {
  /** 短标题（页面展示）。 */
  title: string
  /** 自包含的执行指令（Worker 收到的完整任务）。 */
  prompt: string
}

/** Router 产出的执行计划。 */
export interface SuperAgentPlan {
  subtasks: SuperAgentPlanItem[]
}

/** Worker 返回结果。 */
export interface SuperAgentWorkerResult {
  /** Worker 的最终文本输出。 */
  output: string
  /** Worker 使用的隔离会话 id。 */
  sessionId?: string
}

/** Worker 执行上下文。 */
export interface SuperAgentWorkerContext {
  runId: string
  /** 本轮总目标（仅作 Worker 的上下文，不要求重复执行）。 */
  goal: string
  index: number
  /** 第几次尝试（从 1 开始）。 */
  attempt: number
  signal: AbortSignal
  /** 增量文本（供页面实时展示）。 */
  onText(text: string): void
  /** 隔离会话建立后回调。 */
  onSession(sessionId: string): void
}

/** 一次 Worker 的最终记录。 */
export interface SuperAgentWorkerRecord {
  index: number
  title: string
  prompt: string
  status: SuperAgentWorkerStatus
  attempts: number
  startedAt: number
  finishedAt?: number
  durationMs?: number
  output?: string
  error?: string
  sessionId?: string
}

/** 一轮运行的对外视图。 */
export interface SuperAgentRunView {
  id: string
  goal: string
  status: SuperAgentRunStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  summary?: string
  error?: string
  workers: SuperAgentWorkerRecord[]
}

/** 运行期可调参数。 */
export interface SuperAgentOptions {
  maxConcurrency: number
  maxSubtasks: number
  workerTimeoutMs: number
  retryAttempts: number
  watchdogIntervalMs: number
}

/** 可持久化的 Super-agent 配置（/sv 设置页读写，保存在 config.json）。 */
export interface SvSuperAgentConfig extends SuperAgentOptions {
  enabled: boolean
}

/** 运行历史保留上限（内存与持久化一致）。 */
export const SUPER_AGENT_HISTORY_LIMIT = 20

/** 默认参数：3 并发、最多 8 个子任务、单次 180s、重试 1 次、5s 巡检。 */
export const SUPER_AGENT_DEFAULTS: SuperAgentOptions = {
  maxConcurrency: 3,
  maxSubtasks: 8,
  workerTimeoutMs: 180_000,
  retryAttempts: 1,
  watchdogIntervalMs: 5_000,
}

/** 注入依赖：Router 拆解 / Worker 执行 / Router 汇总。 */
export interface SuperAgentDeps {
  plan(goal: string, signal: AbortSignal): Promise<SuperAgentPlan>
  runWorker(item: SuperAgentPlanItem, context: SuperAgentWorkerContext): Promise<SuperAgentWorkerResult>
  summarize(
    goal: string,
    workers: readonly SuperAgentWorkerRecord[],
    signal: AbortSignal,
  ): Promise<string>
  /** 可注入时钟与 id 生成器，便于测试。 */
  now?(): number
  createId?(): string
  /** 运行视图变化时回调（用于持久化）；高频的 worker-delta 不会触发。 */
  onChange?(runs: readonly SuperAgentRunView[]): void
}

/** 推送给页面的事件。 */
export type SuperAgentEvent =
  | { type: 'run-start'; runId: string; goal: string; at: number }
  | { type: 'plan'; runId: string; subtasks: { index: number; title: string }[]; degraded?: boolean }
  | { type: 'retry-start'; runId: string; index: number; title: string }
  | { type: 'worker-start'; runId: string; index: number; title: string; attempt: number }
  | { type: 'worker-session'; runId: string; index: number; sessionId: string }
  | { type: 'worker-delta'; runId: string; index: number; text: string }
  | { type: 'worker-retry'; runId: string; index: number; attempt: number; error: string }
  | {
    type: 'worker-end'
    runId: string
    index: number
    title: string
    status: SuperAgentWorkerStatus
    attempts: number
    durationMs: number
    output?: string
    error?: string
    sessionId?: string
  }
  | { type: 'summary'; runId: string; text: string }
  | { type: 'run-end'; runId: string; status: SuperAgentRunStatus; durationMs: number; workers: SuperAgentWorkerRecord[] }
  | { type: 'error'; runId: string; message: string }
  | { type: 'done' }

/** 需要持久化的关键事件（跳过高频 delta / start / session，减少写盘）。 */
const PERSIST_EVENTS: ReadonlySet<SuperAgentEvent['type']> = new Set([
  'plan',
  'worker-end',
  'summary',
  'run-end',
  'retry-start',
])

/** /sv 路由需要的只读 + 运行接口。 */
export interface SuperAgentSurface {
  readonly enabled: boolean
  readonly limits: SuperAgentOptions
  /** 页面保存后即时应用开关与限额（对下一轮运行生效）。 */
  applyConfig(config: SvSuperAgentConfig): void
  runs(): SuperAgentRunView[]
  run(goal: string, subtasks: readonly string[] | undefined, signal: AbortSignal): AsyncGenerator<SuperAgentEvent>
  /** 手动重试某个已结束运行里的失败 Worker。 */
  retry(runId: string, index: number, signal: AbortSignal): AsyncGenerator<SuperAgentEvent>
  stop(runId: string): boolean
  /** 清空已结束的运行历史（活动运行保留）。 */
  clearHistory(): void
  /** 从持久化快照恢复历史（数据恢复用）。 */
  restoreHistory(runs: readonly SuperAgentRunView[]): void
}

/**
 * 不可重试的上游错误：认证失败或账户余额不足。
 *
 * Runner 遇到它会立即失败并跳过重试 / 单任务降级，避免把「余额不足」
 * 误报成「Router 拆解失败」后继续消耗 Worker 调用。
 */
export class SuperAgentFatalError extends Error {
  readonly code: string | undefined
  readonly status: number | undefined

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'SuperAgentFatalError'
    this.code = options.code
    this.status = options.status
  }
}

/**
 * 判断上游失败是否不可重试（认证 / 余额）。
 * @param failure - 失败里的稳定 code 与 HTTP status。
 * @returns 命中时 true。
 */
export function isFatalProviderFailure(failure: { code?: string; status?: number }): boolean {
  return failure.status === 401
    || failure.status === 402
    || failure.status === 403
    || failure.code === 'AUTH'
    || failure.code === 'INVALID_CREDENTIAL'
}

/** Worker 超时（用于区分普通失败与超时）。 */
class SuperAgentTimeoutError extends Error {
  constructor() {
    super('Worker 执行超时')
  }
}

/** 单次尝试被取消。 */
class SuperAgentAbortedError extends Error {
  constructor() {
    super('Worker 执行已取消')
  }
}

/** 正整数校正；非法值回落到默认值。 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 非负整数校正（重试次数允许 0）。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 从环境变量读取非负整数配置（0 由各字段的校验决定是否合法）。 */
function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 读取布尔环境变量：1/true/yes/on 为真。 */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return undefined
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return undefined
}

/**
 * 解析 Super-agent 开关与限额：patch 配置 > 环境变量 > 默认值。
 * 默认关闭；关闭时宿主不注册任何 Super-agent 路由。
 * @param config - patch 行注入的可选配置。
 * @returns 归一化后的运行参数。
 */
export function resolveSuperAgentConfig(config: {
  superAgent?: boolean
  superAgentMaxConcurrency?: number
  superAgentMaxSubtasks?: number
  superAgentWorkerTimeoutMs?: number
  superAgentRetryAttempts?: number
  superAgentWatchdogIntervalMs?: number
}): SuperAgentOptions & { enabled: boolean } {
  const enabled = config.superAgent ?? envBool('SV_SUPERAGENT_ENABLED') ?? false
  const maxConcurrency = clamp(
    positiveInt(config.superAgentMaxConcurrency ?? envInt('SV_SUPERAGENT_MAX_CONCURRENCY'), SUPER_AGENT_DEFAULTS.maxConcurrency),
    1,
    8,
  )
  const maxSubtasks = clamp(
    positiveInt(config.superAgentMaxSubtasks ?? envInt('SV_SUPERAGENT_MAX_SUBTASKS'), SUPER_AGENT_DEFAULTS.maxSubtasks),
    1,
    12,
  )
  const workerTimeoutMs = clamp(
    positiveInt(config.superAgentWorkerTimeoutMs ?? envInt('SV_SUPERAGENT_WORKER_TIMEOUT_MS'), SUPER_AGENT_DEFAULTS.workerTimeoutMs),
    1_000,
    3_600_000,
  )
  const retryAttempts = clamp(
    nonNegativeInt(config.superAgentRetryAttempts ?? envInt('SV_SUPERAGENT_RETRY_ATTEMPTS'), SUPER_AGENT_DEFAULTS.retryAttempts),
    0,
    5,
  )
  const watchdogIntervalMs = clamp(
    positiveInt(config.superAgentWatchdogIntervalMs ?? envInt('SV_SUPERAGENT_WATCHDOG_INTERVAL_MS'), SUPER_AGENT_DEFAULTS.watchdogIntervalMs),
    100,
    60_000,
  )
  return { enabled, maxConcurrency, maxSubtasks, workerTimeoutMs, retryAttempts, watchdogIntervalMs }
}

/** 由标题 / 指令生成短标题。 */
function titleOf(text: string, fallback = '子任务'): string {
  const firstLine = text.split('\n').find(line => line.trim().length > 0)?.trim() ?? ''
  const title = firstLine.length > 0 ? firstLine : fallback
  return title.length <= 40 ? title : `${title.slice(0, 40)}…`
}

/** 把用户显式给出的子任务行转成计划。 */
export function buildPlanFromSubtasks(subtasks: readonly string[], maxSubtasks: number): SuperAgentPlan {
  const items = subtasks
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .slice(0, maxSubtasks)
    .map(text => ({ title: titleOf(text), prompt: text }))
  return { subtasks: items }
}

/** 单任务兜底计划：拆解失败时至少把原目标交给一个 Worker。 */
export function fallbackPlan(goal: string): SuperAgentPlan {
  const text = goal.trim()
  return { subtasks: [{ title: titleOf(text, '目标'), prompt: text }] }
}

/** 从模型输出里截取 JSON（允许包裹 Markdown 代码块）。 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const source = fenced?.[1] ?? text
  const objectStart = source.indexOf('{')
  const objectEnd = source.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(source.slice(objectStart, objectEnd + 1))
    } catch {
      // 继续尝试数组形态
    }
  }
  const arrayStart = source.indexOf('[')
  const arrayEnd = source.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(source.slice(arrayStart, arrayEnd + 1))
    } catch {
      // 放弃解析
    }
  }
  return undefined
}

/** 把数组元素归一化为子任务。 */
function toPlanItem(raw: unknown): SuperAgentPlanItem | undefined {
  if (typeof raw === 'string') {
    const prompt = raw.trim()
    return prompt.length === 0 ? undefined : { title: titleOf(prompt), prompt }
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const prompt = [record.prompt, record.task, record.description, record.instructions]
    .find(value => typeof value === 'string' && value.trim().length > 0)
  if (typeof prompt !== 'string') return undefined
  const title = typeof record.title === 'string' && record.title.trim().length > 0
    ? record.title.trim()
    : titleOf(prompt)
  return { title: title.length <= 40 ? title : `${title.slice(0, 40)}…`, prompt: prompt.trim() }
}

/**
 * 解析 Router 的拆解结果。无法解析或为空时返回 false，由调用方决定兜底策略。
 * @param text - 模型输出原文。
 * @param maxSubtasks - 子任务数量上限。
 * @returns 解析出的计划；失败时 undefined。
 */
export function parseSuperAgentPlan(text: string, maxSubtasks: number): SuperAgentPlan | undefined {
  const parsed = extractJson(text)
  const rawItems = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? [
        (parsed as Record<string, unknown>).subtasks,
        (parsed as Record<string, unknown>).tasks,
        (parsed as Record<string, unknown>).plan,
      ].find(Array.isArray)
      : undefined
  if (rawItems === undefined) return undefined
  const items = rawItems
    .map(toPlanItem)
    .filter((item): item is SuperAgentPlanItem => item !== undefined)
    .slice(0, maxSubtasks)
  return items.length === 0 ? undefined : { subtasks: items }
}

/**
 * 从**被截断**或夹杂解释的模型输出里尽力打捞完整的子任务对象。
 *
 * 典型场景：Router 输出到一半触发 max_tokens，外层 `{"subtasks":[...]}` 没有闭合，
 * 但前面若干 `{"title":...,"prompt":...}` 是完整 JSON。这里逐个扫描平衡的
 * 对象并解析，只接受带 prompt/task/description 的条目。
 * @param text - 模型输出原文。
 * @param maxSubtasks - 子任务数量上限。
 * @returns 打捞出的计划；没有完整条目时 undefined。
 */
export function parseSuperAgentPlanSalvage(text: string, maxSubtasks: number): SuperAgentPlan | undefined {
  const items: SuperAgentPlanItem[] = []
  const seen = new Set<string>()
  const stack: number[] = []
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push(index)
      continue
    }
    if (char !== '}' || stack.length === 0) continue
    const start = stack.pop()!
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(start, index + 1))
    } catch {
      continue
    }
    const item = toPlanItem(parsed)
    if (item === undefined) continue
    const key = `${item.title}\u0000${item.prompt}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    if (items.length >= maxSubtasks) break
  }

  return items.length === 0 ? undefined : { subtasks: items }
}

/** 无模型可用时的纯文本汇总。 */
export function fallbackSummary(goal: string, workers: readonly SuperAgentWorkerRecord[]): string {
  const lines = workers.map(worker => {
    if (worker.status === 'succeeded') {
      return `- ${worker.title}：${worker.output?.trim().length ? worker.output.trim() : '（无输出）'}`
    }
    return `- ${worker.title}：未完成（${worker.error ?? worker.status}）`
  })
  return [`目标：${goal}`, '', ...lines].join('\n')
}

/** 事件队列：把并发 Worker 的事件汇入异步生成器。 */
class EventQueue {
  private readonly queue: SuperAgentEvent[] = []
  private wake: (() => void) | undefined
  private closed = false

  push(event: SuperAgentEvent): void {
    if (this.closed) return
    this.queue.push(event)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  close(): void {
    this.closed = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *drain(): AsyncGenerator<SuperAgentEvent> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!
      }
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.wake = resolve
      })
    }
  }
}

/** 用外部 signal 中断一个 Promise。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SuperAgentAbortedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SuperAgentAbortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 一次运行的活动记录。 */
interface ActiveRun {
  view: SuperAgentRunView
  controller: AbortController
}

/** 正在执行的一次 Worker 尝试。 */
interface ActiveAttempt {
  startedAt: number
  timedOut: boolean
  abort: () => void
}

/** Router / Worker 编排器。 */
export class SuperAgentRunner {
  private readonly active = new Map<string, ActiveRun>()
  private readonly history: SuperAgentRunView[] = []
  /** 手动重试中的 Worker：`${runId}:${index}` → 中止器。 */
  private readonly manualRetries = new Map<string, AbortController>()

  constructor(
    private readonly deps: SuperAgentDeps,
    readonly options: SuperAgentOptions,
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.deps.createId?.() ?? randomUUID()
  }

  /** 当前运行中与最近结束的运行（新的在前）。 */
  list(): SuperAgentRunView[] {
    return [...this.active.values()].map(entry => entry.view).concat(this.history)
  }

  /**
   * 恢复上次进程持久化的运行历史。
   *
   * 进程重启时不可能还有活动运行，因此 `running` 一律降级为失败，
   * 并把其中未完成的 Worker 标记为取消，避免页面显示永远转圈。
   * @param runs - 已持久化的运行视图。
   */
  restore(runs: readonly SuperAgentRunView[]): void {
    this.history.length = 0
    const seen = new Set<string>()
    for (const run of runs) {
      if (seen.has(run.id)) continue
      seen.add(run.id)
      if (run.status === 'running') {
        const finishedAt = this.now()
        run.status = 'failed'
        run.error = run.error ?? '服务重启，运行已中断'
        run.finishedAt = finishedAt
        run.durationMs = Math.max(0, finishedAt - run.startedAt)
        for (const worker of run.workers) {
          if (worker.status === 'running' || worker.status === 'pending') {
            worker.status = 'cancelled'
            worker.error = worker.error ?? '服务重启，执行已中断'
          }
        }
      }
      this.history.push(run)
    }
    this.history.sort((a, b) => b.startedAt - a.startedAt)
    if (this.history.length > SUPER_AGENT_HISTORY_LIMIT) {
      this.history.splice(SUPER_AGENT_HISTORY_LIMIT)
    }
  }

  /** 清空已结束的运行历史；活动运行保留，并触发一次持久化回调。 */
  clearHistory(): void {
    this.history.length = 0
    try {
      this.deps.onChange?.(this.list())
    } catch {
      // 持久化失败不影响清空
    }
  }

  /** 查找运行视图（活动或历史）。 */
  private findRun(runId: string): SuperAgentRunView | undefined {
    for (const entry of this.active.values()) {
      if (entry.view.id === runId) return entry.view
    }
    return this.history.find(view => view.id === runId)
  }

  /** 中止一轮运行或该运行下的手动重试；未知 runId 返回 false。 */
  stop(runId: string): boolean {
    let stopped = false
    const entry = this.active.get(runId)
    if (entry !== undefined) {
      entry.controller.abort(new Error('用户停止'))
      stopped = true
    }
    for (const [key, controller] of this.manualRetries) {
      if (key.startsWith(`${runId}:`)) {
        controller.abort(new Error('用户停止'))
        stopped = true
      }
    }
    return stopped
  }

  /**
   * 手动重试某个已结束运行里的失败 Worker。
   *
   * 只允许 `failed` / `timeout` / `cancelled` 的 Worker；重试会复用原运行，
   * 追加尝试次数、重新汇总，并把状态更新回同一张运行卡片。
   * @param runId - 运行 id。
   * @param index - Worker 下标。
   * @param externalSignal - 页面断开或用户停止时中止。
   */
  async *retry(runId: string, index: number, externalSignal?: AbortSignal): AsyncGenerator<SuperAgentEvent> {
    const view = this.findRun(runId)
    if (view === undefined) throw new Error('运行不存在或已被清理')
    if (view.status === 'running') throw new Error('该运行仍在进行中，请等待结束后再重试')
    const worker = view.workers[index]
    if (worker === undefined) throw new Error('Worker 不存在')
    if (worker.status !== 'failed' && worker.status !== 'timeout' && worker.status !== 'cancelled') {
      throw new Error('该 Worker 当前不需要重试')
    }
    if (worker.prompt.trim().length === 0) throw new Error('该 Worker 缺少执行指令，无法重试')

    const key = `${runId}:${index}`
    if (this.manualRetries.has(key)) throw new Error('该 Worker 正在重试')

    const controller = new AbortController()
    const signal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal])
    this.manualRetries.set(key, controller)

    const queue = new EventQueue()
    const emit = (event: SuperAgentEvent): void => {
      this.apply(view, event)
      queue.push(event)
    }
    void this.executeRetry(runId, view, index, signal, emit)
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        emit({ type: 'error', runId, message })
        emit({ type: 'done' })
      })
      .finally(() => {
        this.manualRetries.delete(key)
        queue.close()
      })

    try {
      yield* queue.drain()
    } finally {
      controller.abort(new Error('事件流已关闭'))
    }
  }

  /** 执行一次手动重试，并在结束后重新汇总。 */
  private async executeRetry(
    runId: string,
    view: SuperAgentRunView,
    index: number,
    signal: AbortSignal,
    emit: (event: SuperAgentEvent) => void,
  ): Promise<void> {
    const worker = view.workers[index]!
    const item: SuperAgentPlanItem = { title: worker.title, prompt: worker.prompt }
    const attemptOffset = worker.attempts

    // 清掉上次失败的残留状态，但保留总尝试次数作为本轮偏移。
    worker.status = 'pending'
    delete worker.output
    delete worker.error
    delete worker.sessionId
    delete worker.durationMs
    delete worker.finishedAt
    worker.startedAt = 0
    view.status = 'running'
    delete view.error
    emit({ type: 'retry-start', runId, index, title: worker.title })

    const running = new Map<number, ActiveAttempt>()
    const stopWatchdog = this.startWatchdog(running)
    try {
      await this.runWorker(runId, view.goal, index, item, worker, signal, emit, running, attemptOffset)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', runId, message })
      if (!signal.aborted) {
        worker.status = 'failed'
        worker.error = message
      }
    } finally {
      stopWatchdog()
    }

    const succeeded = view.workers.filter(candidate => candidate.status === 'succeeded')
    if (!signal.aborted) {
      let summary: string
      if (succeeded.length > 0) {
        try {
          summary = await abortable(this.deps.summarize(view.goal, view.workers, signal), signal)
          if (summary.trim().length === 0) summary = fallbackSummary(view.goal, view.workers)
        } catch {
          summary = fallbackSummary(view.goal, view.workers)
        }
      } else {
        summary = fallbackSummary(view.goal, view.workers)
      }
      emit({ type: 'summary', runId, text: summary })
    }

    const status: SuperAgentRunStatus = succeeded.length === view.workers.length
      ? 'succeeded'
      : succeeded.length > 0 ? 'partial' : 'failed'
    view.status = status
    emit({ type: 'run-end', runId, status, durationMs: view.durationMs ?? 0, workers: view.workers })
    emit({ type: 'done' })
  }

  /**
   * 执行一轮 Super-agent：拆解 → 并发 Worker（含重试 / 超时）→ 汇总。
   * @param goal - 用户目标。
   * @param input - 可选显式子任务（每行一个）；给出时跳过模型拆解。
   * @param externalSignal - 页面断开或用户停止时中止。
   */
  async *run(
    goal: string,
    input: { subtasks?: readonly string[] } = {},
    externalSignal?: AbortSignal,
  ): AsyncGenerator<SuperAgentEvent> {
    const runId = this.createId()
    const startedAt = this.now()
    const controller = new AbortController()
    const signal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, externalSignal])
    const view: SuperAgentRunView = {
      id: runId,
      goal,
      status: 'running',
      startedAt,
      workers: [],
    }
    this.active.set(runId, { view, controller })

    const queue = new EventQueue()
    const emit = (event: SuperAgentEvent): void => {
      this.apply(view, event)
      queue.push(event)
    }

    void this.execute(runId, goal, input, signal, emit, view)
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        emit({ type: 'error', runId, message })
        this.finish(runId, view, 'failed', emit)
      })
      .finally(() => queue.close())

    try {
      yield* queue.drain()
    } finally {
      controller.abort(new Error('事件流已关闭'))
    }
  }

  /** 把事件回写到运行视图。 */
  private apply(view: SuperAgentRunView, event: SuperAgentEvent): void {
    switch (event.type) {
      case 'plan':
        view.workers = event.subtasks.map(item => ({
          index: item.index,
          title: item.title,
          prompt: '',
          status: 'pending',
          attempts: 0,
          startedAt: 0,
        }))
        break
      case 'worker-start': {
        const worker = view.workers[event.index]
        if (worker !== undefined) {
          worker.status = 'running'
          worker.attempts = event.attempt
          if (worker.startedAt === 0) worker.startedAt = this.now()
        }
        break
      }
      case 'worker-session': {
        const worker = view.workers[event.index]
        if (worker !== undefined) worker.sessionId = event.sessionId
        break
      }
      case 'worker-delta': {
        const worker = view.workers[event.index]
        if (worker !== undefined) worker.output = `${worker.output ?? ''}${event.text}`
        break
      }
      case 'worker-retry': {
        const worker = view.workers[event.index]
        if (worker !== undefined) worker.error = event.error
        break
      }
      case 'worker-end': {
        const worker = view.workers[event.index]
        if (worker !== undefined) {
          worker.status = event.status
          worker.attempts = event.attempts
          worker.durationMs = event.durationMs
          worker.finishedAt = this.now()
          if (event.output !== undefined) worker.output = event.output
          if (event.error !== undefined) worker.error = event.error
          if (event.sessionId !== undefined) worker.sessionId = event.sessionId
        }
        break
      }
      case 'summary':
        view.summary = event.text
        break
      case 'run-end':
        view.status = event.status
        view.durationMs = event.durationMs
        view.workers = event.workers
        break
      case 'error':
        view.error = view.error === undefined ? event.message : `${view.error}\n${event.message}`
        break
      default:
        break
    }
    // 只落关键节点：计划、Worker 结束、汇总、运行结束与手动重试开始。
    if (PERSIST_EVENTS.has(event.type)) {
      try {
        this.deps.onChange?.(this.list())
      } catch {
        // 持久化失败不能反过来影响运行
      }
    }
  }

  /** 结束一轮：补全时间字段并移入历史。 */
  private finish(
    runId: string,
    view: SuperAgentRunView,
    status: SuperAgentRunStatus,
    emit: (event: SuperAgentEvent) => void,
  ): void {
    const finishedAt = this.now()
    const durationMs = finishedAt - view.startedAt
    view.status = status
    view.finishedAt = finishedAt
    view.durationMs = durationMs
    emit({ type: 'run-end', runId, status, durationMs, workers: view.workers })
    emit({ type: 'done' })
    this.active.delete(runId)
    this.history.unshift(view)
    if (this.history.length > SUPER_AGENT_HISTORY_LIMIT) {
      this.history.splice(SUPER_AGENT_HISTORY_LIMIT)
    }
  }

  /** 主流程。 */
  private async execute(
    runId: string,
    goal: string,
    input: { subtasks?: readonly string[] },
    signal: AbortSignal,
    emit: (event: SuperAgentEvent) => void,
    view: SuperAgentRunView,
  ): Promise<void> {
    emit({ type: 'run-start', runId, goal, at: this.now() })

    let plan: SuperAgentPlan
    let degraded = false
    const explicit = input.subtasks?.map(text => text.trim()).filter(text => text.length > 0) ?? []
    if (explicit.length > 0) {
      plan = buildPlanFromSubtasks(explicit, this.options.maxSubtasks)
    } else {
      try {
        plan = await this.deps.plan(goal, signal)
        if (plan.subtasks.length > this.options.maxSubtasks) {
          plan = { subtasks: plan.subtasks.slice(0, this.options.maxSubtasks) }
        }
      } catch (error) {
        if (signal.aborted) {
          this.finish(runId, view, 'cancelled', emit)
          return
        }
        // 认证 / 余额问题重试和降级都没有意义：直接失败并给出可操作提示。
        if (error instanceof SuperAgentFatalError) {
          emit({ type: 'error', runId, message: error.message })
          this.finish(runId, view, 'failed', emit)
          return
        }
        degraded = true
        emit({
          type: 'error',
          runId,
          message: `Router 拆解失败，已退化为单任务：${error instanceof Error ? error.message : String(error)}`,
        })
        plan = fallbackPlan(goal)
      }
    }

    if (plan.subtasks.length === 0) plan = fallbackPlan(goal)
    emit({
      type: 'plan',
      runId,
      subtasks: plan.subtasks.map((item, index) => ({ index, title: item.title })),
      ...degraded ? { degraded: true } : {},
    })
    // plan 事件只带标题；把执行指令补进记录，便于历史回看。
    view.workers = view.workers.map((worker, index) => ({
      ...worker,
      prompt: plan.subtasks[index]?.prompt ?? '',
    }))

    if (signal.aborted) {
      for (const worker of view.workers) worker.status = 'cancelled'
      this.finish(runId, view, 'cancelled', emit)
      return
    }

    await this.dispatch(runId, plan, view, signal, emit)

    if (signal.aborted) {
      this.finish(runId, view, 'cancelled', emit)
      return
    }

    const succeeded = view.workers.filter(worker => worker.status === 'succeeded')
    let summary: string
    if (succeeded.length > 0) {
      try {
        summary = await abortable(this.deps.summarize(goal, view.workers, signal), signal)
        if (summary.trim().length === 0) summary = fallbackSummary(goal, view.workers)
      } catch {
        summary = fallbackSummary(goal, view.workers)
      }
    } else {
      summary = fallbackSummary(goal, view.workers)
    }
    emit({ type: 'summary', runId, text: summary })

    const status: SuperAgentRunStatus = succeeded.length === view.workers.length
      ? 'succeeded'
      : succeeded.length > 0 ? 'partial' : 'failed'
    this.finish(runId, view, status, emit)
  }

  /** 启动 watchdog；返回停止函数。 */
  private startWatchdog(running: Map<number, ActiveAttempt>): () => void {
    const timer = setInterval(() => {
      const at = this.now()
      for (const state of running.values()) {
        if (at - state.startedAt > this.options.workerTimeoutMs) {
          state.timedOut = true
          state.abort()
        }
      }
    }, this.options.watchdogIntervalMs)
    return () => clearInterval(timer)
  }

  /** 并发执行全部子任务；重试在槽位内完成，watchdog 负责兜底中止。 */
  private async dispatch(
    runId: string,
    plan: SuperAgentPlan,
    view: SuperAgentRunView,
    signal: AbortSignal,
    emit: (event: SuperAgentEvent) => void,
  ): Promise<void> {
    let cursor = 0
    /** 正在执行的尝试：index → 本次尝试的起始时间、超时标记与中止器。 */
    const running = new Map<number, ActiveAttempt>()
    const stopWatchdog = this.startWatchdog(running)

    const drain = async (): Promise<void> => {
      while (true) {
        const index = cursor++
        const item = plan.subtasks[index]
        const worker = view.workers[index]
        if (item === undefined || worker === undefined) return
        await this.runWorker(runId, view.goal, index, item, worker, signal, emit, running)
      }
    }

    try {
      const slots = Math.max(1, Math.min(this.options.maxConcurrency, plan.subtasks.length))
      await Promise.all(Array.from({ length: slots }, () => drain()))
    } finally {
      stopWatchdog()
    }
  }

  /** 执行单个子任务（含重试与超时）。 */
  private async runWorker(
    runId: string,
    goal: string,
    index: number,
    item: SuperAgentPlanItem,
    worker: SuperAgentWorkerRecord,
    signal: AbortSignal,
    emit: (event: SuperAgentEvent) => void,
    running: Map<number, ActiveAttempt>,
    attemptOffset = 0,
  ): Promise<void> {
    const maxAttempts = 1 + this.options.retryAttempts
    const startedAt = this.now()
    let lastError = ''

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const totalAttempt = attemptOffset + attempt
      if (signal.aborted) {
        this.endWorker(runId, index, worker, 'cancelled', startedAt, emit, '运行已取消')
        return
      }
      emit({ type: 'worker-start', runId, index, title: item.title, attempt: totalAttempt })
      const attemptController = new AbortController()
      const attemptSignal = AbortSignal.any([signal, attemptController.signal])
      const state = { startedAt: this.now(), timedOut: false, abort: () => attemptController.abort() }
      running.set(index, state)
      try {
        const result = await this.runAttempt(item, {
          runId,
          goal,
          index,
          attempt: totalAttempt,
          signal: attemptSignal,
          onText: text => emit({ type: 'worker-delta', runId, index, text }),
          onSession: sessionId => emit({ type: 'worker-session', runId, index, sessionId }),
        }, attemptSignal, attemptController, () => {
          state.timedOut = true
        })
        running.delete(index)
        this.endWorker(runId, index, worker, 'succeeded', startedAt, emit, undefined, result.output, result.sessionId)
        return
      } catch (error) {
        running.delete(index)
        lastError = error instanceof Error ? error.message : String(error)
        if (signal.aborted) {
          this.endWorker(runId, index, worker, 'cancelled', startedAt, emit, lastError)
          return
        }
        const fatal = error instanceof SuperAgentFatalError
        const timedOut = state.timedOut || error instanceof SuperAgentTimeoutError
        // 超时可能先触发 abort 监听（表现为“已取消”），统一改写成明确的超时提示。
        if (timedOut && !fatal) {
          const timeoutLabel = this.options.workerTimeoutMs >= 1_000
            ? `${Math.round(this.options.workerTimeoutMs / 1_000)}s`
            : `${this.options.workerTimeoutMs}ms`
          lastError = `Worker 执行超时（${timeoutLabel}）`
        }
        // 认证 / 余额类错误不会因为重试而恢复，直接结束该 Worker。
        if (!fatal && attempt < maxAttempts) {
          emit({ type: 'worker-retry', runId, index, attempt: totalAttempt, error: lastError })
          continue
        }
        this.endWorker(runId, index, worker, timedOut ? 'timeout' : 'failed', startedAt, emit, lastError)
        return
      }
    }
    this.endWorker(runId, index, worker, 'failed', startedAt, emit, lastError)
  }

  /** 单次尝试：超时定时器 + 取消监听，二者都保证 Promise 一定结算。 */
  private runAttempt(
    item: SuperAgentPlanItem,
    context: SuperAgentWorkerContext,
    signal: AbortSignal,
    timeoutController: AbortController,
    markTimedOut: () => void,
  ): Promise<SuperAgentWorkerResult> {
    return new Promise<SuperAgentWorkerResult>((resolve, reject) => {
      let settled = false
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        action()
      }
      const timer = setTimeout(() => {
        markTimedOut()
        // 先结算为超时，再中止请求；否则 abort 监听会先把它记成“已取消”。
        settle(() => reject(new SuperAgentTimeoutError()))
        timeoutController.abort()
      }, this.options.workerTimeoutMs)
      const onAbort = (): void => {
        settle(() => reject(new SuperAgentAbortedError()))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.deps.runWorker(item, context).then(
        value => settle(() => resolve(value)),
        error => settle(() => reject(error)),
      )
    })
  }

  /** 写入 Worker 最终状态并广播。 */
  private endWorker(
    runId: string,
    index: number,
    worker: SuperAgentWorkerRecord,
    status: SuperAgentWorkerStatus,
    startedAt: number,
    emit: (event: SuperAgentEvent) => void,
    error?: string,
    output?: string,
    sessionId?: string,
  ): void {
    const durationMs = this.now() - startedAt
    emit({
      type: 'worker-end',
      runId,
      index,
      title: worker.title,
      status,
      attempts: worker.attempts,
      durationMs,
      ...output === undefined ? {} : { output },
      ...error === undefined ? {} : { error },
      ...sessionId === undefined ? {} : { sessionId },
    })
  }
}
