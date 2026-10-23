/**
 * 个人待办与提醒存储。
 *
 * 与记忆分开存放：自动记忆抽取可能出错，不能让它直接改写日程。
 * 到期判断只依赖 `dueAt` 与 `notifiedAt`；重复任务触发后滚动到下一次，
 * 非重复任务保持 pending 直到用户完成，但不会重复提醒。
 *
 * 默认写入 `$DSH_HOME/sv/tasks.json`（0600）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 重复规则；M1 只支持一次、每天、每周。 */
export const TASK_RECURRENCES = ['none', 'daily', 'weekly'] as const
export type TaskRecurrence = (typeof TASK_RECURRENCES)[number]

/** 任务状态。 */
export type TaskStatus = 'pending' | 'done' | 'cancelled'

/** 一条待办或提醒。 */
export interface TaskEntry {
  id: string
  title: string
  notes?: string
  /** 截止/提醒时间（epoch ms）；无时间表示纯待办。 */
  dueAt?: number
  recurrence: TaskRecurrence
  status: TaskStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  /** 最近一次触发提醒的时间，用于避免同一时点重复提醒。 */
  notifiedAt?: number
  sessionId?: string
}

/** 创建任务的输入。 */
export interface TaskCreateInput {
  title: string
  notes?: string
  dueAt?: number
  recurrence?: TaskRecurrence
  sessionId?: string
}

/** 修改任务的输入；null 表示清除可选字段。 */
export interface TaskPatch {
  title?: string
  notes?: string | null
  dueAt?: number | null
  recurrence?: TaskRecurrence
  status?: TaskStatus
  snoozeMinutes?: number
}

interface TasksFile {
  version: 1
  tasks: TaskEntry[]
}

const MAX_TITLE = 120
const MAX_NOTES = 2000
const MAX_ENTRIES = 5000
const DAY_MS = 24 * 60 * 60 * 1000
const RECURRENCE_SET = new Set<string>(TASK_RECURRENCES)
const STATUS_SET = new Set<string>(['pending', 'done', 'cancelled'])

function isRecurrence(value: unknown): value is TaskRecurrence {
  return typeof value === 'string' && RECURRENCE_SET.has(value)
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 时间展示：MM/DD HH:mm。 */
export function formatTaskTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 下一次重复时间（严格晚于当前时刻）。 */
function nextOccurrence(dueAt: number, recurrence: TaskRecurrence, now: number): number {
  if (recurrence === 'none') return dueAt
  const step = recurrence === 'daily' ? DAY_MS : 7 * DAY_MS
  let next = dueAt + step
  while (next <= now) next += step
  return next
}

/** 对外视图（API / 工具返回）。 */
export function taskView(entry: TaskEntry): {
  id: string
  title: string
  notes?: string
  dueAt?: number
  recurrence: TaskRecurrence
  status: TaskStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  notifiedAt?: number
  sessionId?: string
} {
  return {
    id: entry.id,
    title: entry.title,
    ...(entry.notes === undefined ? {} : { notes: entry.notes }),
    ...(entry.dueAt === undefined ? {} : { dueAt: entry.dueAt }),
    recurrence: entry.recurrence,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(entry.notifiedAt === undefined ? {} : { notifiedAt: entry.notifiedAt }),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
  }
}

export class TasksStore {
  private entries = new Map<string, TaskEntry>()
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'tasks.json')
  }

  /** 读取持久化文件；缺失或损坏时从空任务开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TasksFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return
      this.entries = new Map()
      for (const task of parsed.tasks) {
        const normalized = this.sanitize(task)
        if (normalized !== undefined) this.entries.set(normalized.id, normalized)
      }
    } catch {
      // 损坏文件按空处理
    }
  }

  /** 任务列表：未完成在前（按截止时间），已完成在后（按完成时间）。 */
  list(includeDone = true): TaskEntry[] {
    const all = [...this.entries.values()]
    const pending = all
      .filter(task => task.status === 'pending')
      .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
        || b.updatedAt - a.updatedAt)
    if (!includeDone) return pending
    const finished = all
      .filter(task => task.status !== 'pending')
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    return [...pending, ...finished]
  }

  get(id: string): TaskEntry | undefined {
    return this.entries.get(id)
  }

  /** 创建任务。 */
  async create(input: TaskCreateInput): Promise<TaskEntry> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error('任务标题不能为空')
    if (title.length > MAX_TITLE) throw new Error(`任务标题不能超过 ${MAX_TITLE} 个字符`)
    if (input.dueAt !== undefined && !Number.isFinite(input.dueAt)) throw new Error('dueAt 非法')
    const recurrence = input.recurrence ?? 'none'
    if (!isRecurrence(recurrence)) throw new Error('重复规则非法')
    const now = Date.now()
    const entry: TaskEntry = {
      id: randomUUID(),
      title,
      ...(input.notes === undefined || input.notes.trim().length === 0 ? {} : { notes: clip(input.notes.trim(), MAX_NOTES) }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      recurrence,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    }
    this.entries.set(entry.id, entry)
    this.prune()
    await this.persist()
    return entry
  }

  /** 修改任务；未知 id 返回 undefined。 */
  async update(id: string, patch: TaskPatch): Promise<TaskEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title.length === 0) throw new Error('任务标题不能为空')
      if (title.length > MAX_TITLE) throw new Error(`任务标题不能超过 ${MAX_TITLE} 个字符`)
      entry.title = title
    }
    if (patch.notes !== undefined) {
      if (patch.notes === null || patch.notes.trim().length === 0) delete entry.notes
      else entry.notes = clip(patch.notes.trim(), MAX_NOTES)
    }
    if (patch.recurrence !== undefined) {
      if (!isRecurrence(patch.recurrence)) throw new Error('重复规则非法')
      entry.recurrence = patch.recurrence
    }
    if (patch.dueAt !== undefined) {
      if (patch.dueAt === null) {
        delete entry.dueAt
        delete entry.notifiedAt
      } else {
        if (!Number.isFinite(patch.dueAt)) throw new Error('dueAt 非法')
        entry.dueAt = patch.dueAt
        delete entry.notifiedAt
      }
    }
    if (patch.snoozeMinutes !== undefined) {
      if (!Number.isFinite(patch.snoozeMinutes) || patch.snoozeMinutes <= 0) throw new Error('snoozeMinutes 必须是正数')
      entry.dueAt = Date.now() + patch.snoozeMinutes * 60_000
      entry.status = 'pending'
      delete entry.completedAt
      delete entry.notifiedAt
    }
    if (patch.status !== undefined) {
      if (!isStatus(patch.status)) throw new Error('任务状态非法')
      entry.status = patch.status
      if (patch.status === 'done') entry.completedAt = Date.now()
      else delete entry.completedAt
      if (patch.status !== 'pending') delete entry.notifiedAt
    }
    entry.updatedAt = Date.now()
    await this.persist()
    return entry
  }

  /** 标记完成。 */
  async complete(id: string): Promise<TaskEntry | undefined> {
    return this.update(id, { status: 'done' })
  }

  /** 删除任务；未知 id 返回 false。 */
  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id)
    if (existed) await this.persist()
    return existed
  }

  /** 当前到期且尚未提醒的任务。 */
  due(now = Date.now()): TaskEntry[] {
    return [...this.entries.values()].filter(task => task.status === 'pending'
      && task.dueAt !== undefined
      && task.dueAt <= now
      && (task.notifiedAt === undefined || task.notifiedAt < task.dueAt))
  }

  /**
   * 记录一次提醒：非重复任务只标记 notifiedAt；重复任务滚动到下一次。
   * @returns 更新后的任务；未知 id 返回 undefined。
   */
  async markNotified(id: string, now = Date.now()): Promise<TaskEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    entry.notifiedAt = now
    entry.updatedAt = now
    if (entry.recurrence !== 'none' && entry.dueAt !== undefined) {
      entry.dueAt = nextOccurrence(entry.dueAt, entry.recurrence, now)
    }
    await this.persist()
    return entry
  }

  /** 生成注入 System Prompt 的待办段落；没有未完成任务时也包含当前时间。 */
  promptBlock(limit = 8): string {
    const now = Date.now()
    const pending = this.list(false).slice(0, limit)
    const lines = [
      '## 待办与提醒',
      `当前时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
    ]
    for (const task of pending) {
      if (task.dueAt === undefined) {
        lines.push(`- [ ] ${clip(task.title, 80)}（无截止时间）`)
      } else {
        const overdue = task.dueAt <= now ? '，已逾期' : ''
        lines.push(`- [ ] ${clip(task.title, 80)}（${formatTaskTime(task.dueAt)}${overdue}）`)
      }
    }
    return lines.join('\n')
  }

  private sanitize(value: unknown): TaskEntry | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Partial<TaskEntry>
    if (typeof record.id !== 'string' || record.id.length === 0) return undefined
    if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined
    if (!isStatus(record.status)) return undefined
    const recurrence = isRecurrence(record.recurrence) ? record.recurrence : 'none'
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
    return {
      id: record.id,
      title: clip(record.title.trim(), MAX_TITLE),
      ...(typeof record.notes === 'string' && record.notes.length > 0 ? { notes: clip(record.notes, MAX_NOTES) } : {}),
      ...(typeof record.dueAt === 'number' && Number.isFinite(record.dueAt) ? { dueAt: record.dueAt } : {}),
      recurrence,
      status: record.status,
      createdAt,
      updatedAt,
      ...(typeof record.completedAt === 'number' && Number.isFinite(record.completedAt) ? { completedAt: record.completedAt } : {}),
      ...(typeof record.notifiedAt === 'number' && Number.isFinite(record.notifiedAt) ? { notifiedAt: record.notifiedAt } : {}),
      ...(typeof record.sessionId === 'string' && record.sessionId.length > 0 ? { sessionId: record.sessionId } : {}),
    }
  }

  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return
    const finished = this.list(true).filter(task => task.status !== 'pending').slice(0, this.entries.size - MAX_ENTRIES)
    for (const task of finished) this.entries.delete(task.id)
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: TasksFile = { version: 1, tasks: this.list(true) }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }
}
