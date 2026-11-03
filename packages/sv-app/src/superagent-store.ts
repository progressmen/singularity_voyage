/**
 * Super-agent 运行历史持久化：`$DSH_HOME/sv/superagent-runs.json`（0600）。
 *
 * 只保存运行视图（目标、Worker 状态、输出摘要、耗时），不保存模型密钥，
 * 也不复制完整会话日志。文件损坏时按空历史启动，不影响主链路。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { svDataDir } from './config-store.ts'
import {
  SUPER_AGENT_HISTORY_LIMIT,
  type SuperAgentRunStatus,
  type SuperAgentRunView,
  type SuperAgentWorkerRecord,
  type SuperAgentWorkerStatus,
} from './superagent.ts'

/** 单条 Worker 输出的持久化上限，避免文件无限膨胀。 */
const MAX_OUTPUT = 20_000
/** 汇总与目标的持久化上限。 */
const MAX_SUMMARY = 20_000
const MAX_GOAL = 10_000
/** 子任务指令与错误信息的持久化上限。 */
const MAX_PROMPT = 4_000
const MAX_ERROR = 2_000
/** 防御性上限：单轮最多保留的 Worker 记录。 */
const MAX_WORKERS = 32

const RUN_STATUSES = new Set<SuperAgentRunStatus>(['running', 'succeeded', 'partial', 'failed', 'cancelled'])
const WORKER_STATUSES = new Set<SuperAgentWorkerStatus>(['pending', 'running', 'succeeded', 'failed', 'timeout', 'cancelled'])

/** 截断文本；非字符串返回 undefined。 */
function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** 有限数字；其他值返回 undefined。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 非负整数；其他值返回 undefined。 */
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 归一化一条 Worker 记录。 */
function normalizeWorker(raw: unknown, index: number): SuperAgentWorkerRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const worker: SuperAgentWorkerRecord = {
    index,
    title: clipText(record.title, 200) ?? `Worker ${index + 1}`,
    prompt: clipText(record.prompt, MAX_PROMPT) ?? '',
    status: typeof record.status === 'string' && WORKER_STATUSES.has(record.status as SuperAgentWorkerStatus)
      ? record.status as SuperAgentWorkerStatus
      : 'failed',
    attempts: nonNegativeInt(record.attempts) ?? 0,
    startedAt: finiteNumber(record.startedAt) ?? 0,
  }
  const output = clipText(record.output, MAX_OUTPUT)
  if (output !== undefined) worker.output = output
  const error = clipText(record.error, MAX_ERROR)
  if (error !== undefined) worker.error = error
  const sessionId = clipText(record.sessionId, 128)
  if (sessionId !== undefined) worker.sessionId = sessionId
  const finishedAt = finiteNumber(record.finishedAt)
  if (finishedAt !== undefined) worker.finishedAt = finishedAt
  const durationMs = finiteNumber(record.durationMs)
  if (durationMs !== undefined) worker.durationMs = durationMs
  return worker
}

/** 归一化一条运行记录；缺少 id 或 goal 时丢弃。 */
function normalizeRun(raw: unknown): SuperAgentRunView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const id = clipText(record.id, 128)
  const goal = clipText(record.goal, MAX_GOAL)
  if (id === undefined || id.length === 0 || goal === undefined || goal.length === 0) return undefined

  const run: SuperAgentRunView = {
    id,
    goal,
    status: typeof record.status === 'string' && RUN_STATUSES.has(record.status as SuperAgentRunStatus)
      ? record.status as SuperAgentRunStatus
      : 'failed',
    startedAt: finiteNumber(record.startedAt) ?? 0,
    workers: Array.isArray(record.workers)
      ? record.workers
        .slice(0, MAX_WORKERS)
        .map((worker, index) => normalizeWorker(worker, index))
        .filter((worker): worker is SuperAgentWorkerRecord => worker !== undefined)
      : [],
  }
  const summary = clipText(record.summary, MAX_SUMMARY)
  if (summary !== undefined) run.summary = summary
  const error = clipText(record.error, MAX_ERROR)
  if (error !== undefined) run.error = error
  const finishedAt = finiteNumber(record.finishedAt)
  if (finishedAt !== undefined) run.finishedAt = finishedAt
  const durationMs = finiteNumber(record.durationMs)
  if (durationMs !== undefined) run.durationMs = durationMs
  return run
}

/** Super-agent 运行历史存储。 */
export class SuperAgentRunStore {
  private runs: SuperAgentRunView[] = []
  /** 串行写盘队列，避免并发 rename 交错。 */
  private chain: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(file: string = join(svDataDir(), 'superagent-runs.json')) {
    this.file = file
  }

  /** 当前已加载 / 最近保存的运行（新的在前）。 */
  list(): SuperAgentRunView[] {
    return this.runs
  }

  /** 读取磁盘历史；文件缺失或损坏时按空历史处理。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.runs = []
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.runs = []
      return
    }
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { runs?: unknown }).runs)
        ? (parsed as { runs: unknown[] }).runs
        : []

    const seen = new Set<string>()
    const runs: SuperAgentRunView[] = []
    for (const item of list) {
      const run = normalizeRun(item)
      if (run === undefined || seen.has(run.id)) continue
      seen.add(run.id)
      runs.push(run)
    }
    runs.sort((a, b) => b.startedAt - a.startedAt)
    this.runs = runs.slice(0, SUPER_AGENT_HISTORY_LIMIT)
  }

  /**
   * 保存运行历史（深拷贝快照后异步落盘）。
   * @param runs - 当前运行列表；会自动截断到历史上限。
   */
  save(runs: readonly SuperAgentRunView[]): Promise<void> {
    const snapshot = structuredClone(
      [...runs]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, SUPER_AGENT_HISTORY_LIMIT),
    )
    this.runs = snapshot
    const payload = `${JSON.stringify({ version: 1, runs: snapshot }, null, 2)}\n`
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, payload, { mode: 0o600 })
      await rename(temp, this.file)
    }
    // 前一次写失败也要继续后续写入，否则历史会永久停止更新。
    this.chain = this.chain.then(write, write)
    return this.chain
  }
}
