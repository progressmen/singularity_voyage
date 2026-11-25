/**
 * 审批审计：记录每一次需要用户确认的工具操作及最终结果。
 *
 * 审批是「一次性授权」：批准只对当前这次调用生效，不会写入持久白名单。
 * 记录写入 `$DSH_HOME/sv/approvals.json`（0600、原子替换），最多保留 500 条，
 * 供审批中心查看历史；不包含工具参数正文，只保留工具名、原因与会话 id。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 审批的最终结果。`allowed-once` 是唯一的放行结果。 */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

/** 审批由谁结束。 */
export type ApprovalDecidedBy = 'user' | 'timeout' | 'aborted' | 'viewer-left' | 'restart' | 'no-answerer'

/** 一条审批记录。 */
export interface ApprovalRecord {
  id: string
  /** 发起审批的会话；未知时省略。 */
  sessionId?: string
  toolName: string
  callId?: string
  /** 发起方给出的原因（模型解释为什么需要审批）。 */
  reason?: string
  requestedAt: number
  decidedAt?: number
  outcome?: ApprovalOutcome
  decidedBy?: ApprovalDecidedBy
}

/** 审批事件（SSE 与页面角标用）。 */
export interface ApprovalEvent {
  type: 'approval'
  action: 'asked' | 'decided'
  item: ApprovalRecord
  /** 当前仍待处理的数量。 */
  pending: number
}

const MAX_RECORDS = 500

interface ApprovalFile {
  version: 1
  records: ApprovalRecord[]
}

const OUTCOME_SET = new Set<string>(APPROVAL_OUTCOMES)

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value)
}

function sanitize(value: unknown): ApprovalRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<ApprovalRecord>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.toolName !== 'string' || record.toolName.length === 0) return undefined
  const requestedAt = typeof record.requestedAt === 'number' && Number.isFinite(record.requestedAt)
    ? record.requestedAt
    : Date.now()
  const outcome = isOutcome(record.outcome) ? record.outcome : undefined
  return {
    id: record.id,
    toolName: clip(record.toolName, 120),
    requestedAt,
    ...(typeof record.sessionId === 'string' && record.sessionId.length > 0 ? { sessionId: record.sessionId } : {}),
    ...(typeof record.callId === 'string' && record.callId.length > 0 ? { callId: record.callId } : {}),
    ...(typeof record.reason === 'string' && record.reason.length > 0 ? { reason: clip(record.reason, 1000) } : {}),
    ...(outcome === undefined ? {} : { outcome }),
    ...(typeof record.decidedAt === 'number' && Number.isFinite(record.decidedAt) ? { decidedAt: record.decidedAt } : {}),
    ...(typeof record.decidedBy === 'string' ? { decidedBy: record.decidedBy as ApprovalDecidedBy } : {}),
  }
}

export class ApprovalStore {
  private records: ApprovalRecord[] = []
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'approvals.json')
  }

  /** 读取持久化审计；缺失或损坏时从空开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ApprovalFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return
      this.records = parsed.records
        .map(sanitize)
        .filter((record): record is ApprovalRecord => record !== undefined)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, MAX_RECORDS)
    } catch {
      // 损坏文件按空审计处理
    }
  }

  /** 列表：默认全部，可按待处理/已处理过滤。 */
  list(status: 'all' | 'pending' | 'decided' = 'all', limit = 100): ApprovalRecord[] {
    const filtered = status === 'pending'
      ? this.records.filter(record => record.outcome === undefined)
      : status === 'decided'
        ? this.records.filter(record => record.outcome !== undefined)
        : this.records
    return filtered.slice(0, Math.min(MAX_RECORDS, Math.max(1, Math.trunc(limit))))
  }

  get(id: string): ApprovalRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  pendingCount(): number {
    return this.records.reduce((count, record) => count + (record.outcome === undefined ? 1 : 0), 0)
  }

  /** 新增一条待处理审批并落盘。 */
  async add(input: {
    toolName: string
    sessionId?: string
    callId?: string
    reason?: string
  }): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: randomUUID(),
      toolName: clip(input.toolName.trim() || 'unknown', 120),
      requestedAt: Date.now(),
      ...(input.sessionId === undefined || input.sessionId.length === 0 ? {} : { sessionId: input.sessionId }),
      ...(input.callId === undefined || input.callId.length === 0 ? {} : { callId: input.callId }),
      ...(input.reason === undefined || input.reason.length === 0 ? {} : { reason: clip(input.reason, 1000) }),
    }
    this.records.unshift(record)
    if (this.records.length > MAX_RECORDS) this.records.splice(MAX_RECORDS)
    await this.persist()
    return record
  }

  /** 结束一条审批；未知 id 或已结束时返回 undefined。 */
  async decide(id: string, outcome: ApprovalOutcome, decidedBy: ApprovalDecidedBy): Promise<ApprovalRecord | undefined> {
    const record = this.records.find(item => item.id === id)
    if (record === undefined || record.outcome !== undefined) return undefined
    record.outcome = outcome
    record.decidedAt = Date.now()
    record.decidedBy = decidedBy
    await this.persist()
    return record
  }

  /** 进程重启后，把上次遗留的待处理记录标为取消（没有进程能再回答它们）。 */
  async failPending(): Promise<number> {
    let count = 0
    const now = Date.now()
    for (const record of this.records) {
      if (record.outcome !== undefined) continue
      record.outcome = 'cancelled'
      record.decidedAt = now
      record.decidedBy = 'restart'
      count += 1
    }
    if (count > 0) await this.persist()
    return count
  }

  /** 清空审计历史（只影响展示，不影响正在等待的审批）。 */
  async clear(): Promise<void> {
    this.records = []
    await this.persist()
  }

  private persist(): Promise<void> {
    const next = this.tail.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: ApprovalFile = { version: 1, records: this.records }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}
