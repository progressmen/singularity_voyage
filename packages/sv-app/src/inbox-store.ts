/**
 * 个人收件箱：每日简报、到期提醒与后台任务结果的统一落点。
 *
 * 收件箱是「已经发生、等待用户查看」的消息流，不是待办本身：标记已读只
 * 影响未读红点，不会改变任务状态。每日简报的「今天是否已生成」也记在
 * 同一份文件里，避免重启后重复生成。
 *
 * 默认写入 `$DSH_HOME/sv/inbox.json`（0600）；写入串行化并原子替换。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 收件箱条目类型。 */
export const INBOX_KINDS = ['briefing', 'reminder', 'agent', 'system', 'automation'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

/** 类型的中文标签（供页面与 Prompt 展示）。 */
export const INBOX_KIND_LABELS: Record<InboxKind, string> = {
  briefing: '简报',
  reminder: '提醒',
  agent: '助手',
  automation: '自动化',
  system: '系统',
}

/** 一条收件箱消息。 */
export interface InboxItem {
  id: string
  kind: InboxKind
  title: string
  /** Markdown 正文。 */
  body: string
  createdAt: number
  /** 首次读取时间；缺省表示未读。 */
  readAt?: number
  /** 关联会话，页面可直接跳转。 */
  sessionId?: string
  /** 关联待办。 */
  taskId?: string
  /** 静默投递（静默时段产生）：页面不弹提示，仅进列表。 */
  silent?: boolean
}

/** 新增条目的输入。 */
export interface InboxInput {
  kind: InboxKind
  title: string
  body: string
  sessionId?: string
  taskId?: string
  silent?: boolean
}

/** 列表过滤条件。 */
export interface InboxListOptions {
  unreadOnly?: boolean
  kind?: InboxKind
  limit?: number
}

/** 收件箱变更事件（SSE 与页面角标用）。 */
export interface InboxEvent {
  action: 'add' | 'read' | 'remove' | 'read-all'
  unread: number
  item?: InboxItem
}

type InboxListener = (event: InboxEvent) => void

/** 条目数上限：超出时优先丢弃最旧的已读条目。 */
const MAX_ITEMS = 500
const MAX_TITLE = 120
const MAX_BODY = 5000

const KIND_SET = new Set<string>(INBOX_KINDS)

interface InboxFile {
  version: 1
  /** 最近一次生成每日简报的本地日期（YYYY-MM-DD）。 */
  lastBriefDay?: string
  items: InboxItem[]
}

function isKind(value: unknown): value is InboxKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 对外视图：read 由 readAt 派生，页面无需自己判断。 */
export function inboxView(entry: InboxItem): {
  id: string
  kind: InboxKind
  title: string
  body: string
  createdAt: number
  read: boolean
  readAt?: number
  sessionId?: string
  taskId?: string
  silent?: boolean
} {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    createdAt: entry.createdAt,
    read: entry.readAt !== undefined,
    ...(entry.readAt === undefined ? {} : { readAt: entry.readAt }),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    ...(entry.silent === true ? { silent: true } : {}),
  }
}

export class InboxStore {
  private items: InboxItem[] = []
  private briefDay: string | undefined
  private readonly dir: string
  private readonly listeners = new Set<InboxListener>()
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'inbox.json')
  }

  /** 读取持久化文件；缺失或损坏时从空收件箱开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<InboxFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) return
      this.items = []
      for (const item of parsed.items) {
        const normalized = this.sanitize(item)
        if (normalized !== undefined) this.items.push(normalized)
      }
      this.items.sort((a, b) => b.createdAt - a.createdAt)
      if (typeof parsed.lastBriefDay === 'string' && parsed.lastBriefDay.length > 0) {
        this.briefDay = parsed.lastBriefDay
      }
    } catch {
      // 损坏文件按空收件箱处理
    }
  }

  /** 订阅变更；返回取消订阅函数。 */
  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 按时间倒序列出条目。 */
  list(options: InboxListOptions = {}): InboxItem[] {
    let result = this.items
    if (options.unreadOnly === true) result = result.filter(item => item.readAt === undefined)
    if (options.kind !== undefined) result = result.filter(item => item.kind === options.kind)
    const limit = options.limit === undefined ? 100 : Math.min(500, Math.max(1, Math.trunc(options.limit)))
    return result.slice(0, limit)
  }

  get(id: string): InboxItem | undefined {
    return this.items.find(item => item.id === id)
  }

  unreadCount(): number {
    return this.items.reduce((count, item) => count + (item.readAt === undefined ? 1 : 0), 0)
  }

  /** 新增一条消息；标题为空时拒绝写入。 */
  async add(input: InboxInput): Promise<InboxItem> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error('收件箱标题不能为空')
    if (!isKind(input.kind)) throw new Error('收件箱类型非法')
    const item: InboxItem = {
      id: randomUUID(),
      kind: input.kind,
      title: clip(title, MAX_TITLE),
      body: clip(input.body.trim(), MAX_BODY),
      createdAt: Date.now(),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.silent === true ? { silent: true } : {}),
    }
    this.items.unshift(item)
    this.prune()
    await this.persist()
    this.notify({ action: 'add', item, unread: this.unreadCount() })
    return item
  }

  /**
   * 标记已读/未读。
   * @returns 更新后的条目；未知 id 返回 undefined。
   */
  async markRead(id: string, read = true): Promise<InboxItem | undefined> {
    const item = this.get(id)
    if (item === undefined) return undefined
    if (read) {
      if (item.readAt === undefined) item.readAt = Date.now()
    } else {
      delete item.readAt
    }
    await this.persist()
    this.notify({ action: 'read', item, unread: this.unreadCount() })
    return item
  }

  /** 全部标记已读；返回本次更新的条数。 */
  async markAllRead(): Promise<number> {
    const now = Date.now()
    let changed = 0
    for (const item of this.items) {
      if (item.readAt !== undefined) continue
      item.readAt = now
      changed += 1
    }
    if (changed > 0) {
      await this.persist()
      this.notify({ action: 'read-all', unread: 0 })
    }
    return changed
  }

  /** 清空收件箱与简报生成日期（隐私清空与恢复用）。 */
  async clear(): Promise<void> {
    this.items = []
    this.briefDay = undefined
    await this.persist()
    this.notify({ action: 'read-all', unread: 0 })
  }

  /** 删除条目；未知 id 返回 false。 */
  async remove(id: string): Promise<boolean> {
    const index = this.items.findIndex(item => item.id === id)
    if (index < 0) return false
    const [item] = this.items.splice(index, 1)
    await this.persist()
    this.notify({
      action: 'remove',
      ...(item === undefined ? {} : { item }),
      unread: this.unreadCount(),
    })
    return true
  }

  /** 最近一次生成简报的本地日期（YYYY-MM-DD）。 */
  lastBriefDay(): string | undefined {
    return this.briefDay
  }

  /** 记录每日简报已生成，防止进程重启后重复生成。 */
  async markBriefDay(day: string): Promise<void> {
    this.briefDay = day
    await this.persist()
  }

  private notify(event: InboxEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅者（通常是断开的 SSE 连接）故障不影响其他订阅者
      }
    }
  }

  private sanitize(value: unknown): InboxItem | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Partial<InboxItem>
    if (typeof record.id !== 'string' || record.id.length === 0) return undefined
    if (!isKind(record.kind)) return undefined
    if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now()
    return {
      id: record.id,
      kind: record.kind,
      title: clip(record.title.trim(), MAX_TITLE),
      body: typeof record.body === 'string' ? clip(record.body, MAX_BODY) : '',
      createdAt,
      ...(typeof record.readAt === 'number' && Number.isFinite(record.readAt) ? { readAt: record.readAt } : {}),
      ...(typeof record.sessionId === 'string' && record.sessionId.length > 0 ? { sessionId: record.sessionId } : {}),
      ...(typeof record.taskId === 'string' && record.taskId.length > 0 ? { taskId: record.taskId } : {}),
      ...(record.silent === true ? { silent: true } : {}),
    }
  }

  private prune(): void {
    while (this.items.length > MAX_ITEMS) {
      // 优先丢弃最旧的已读条目；全部未读时才丢最旧的一条。
      let index = -1
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i]!.readAt !== undefined) {
          index = i
          break
        }
      }
      this.items.splice(index >= 0 ? index : this.items.length - 1, 1)
    }
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: InboxFile = {
        version: 1,
        ...(this.briefDay === undefined ? {} : { lastBriefDay: this.briefDay }),
        items: this.items,
      }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }
}
