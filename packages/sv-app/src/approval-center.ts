/**
 * 审批中心：把宿主 `approval/request` 瀑布接到 /sv 页面。
 *
 * 宿主在工具需要用户确认时调用 approval 服务；SV 注册一个前置 answerer：
 *  - 生成审计记录并推送到 `/sv/api/events`；
 *  - 页面上的审批卡片通过 `POST /sv/api/approvals/:id/answer` 返回结果；
 *  - 没有页面在线时立即 fail-closed（`unavailable`），避免后台任务无限等待；
 *  - 超时、请求取消、页面全部关闭都会结束为 `cancelled`。
 *
 * 放行只对当前这次调用生效（`allowed-once`），不会形成持久白名单。
 */
import type { ApprovalEvent, ApprovalOutcome, ApprovalRecord, ApprovalStore } from './approval-store.ts'

/** 宿主 approval/request 的结构化子集（避免直接依赖 dsh-user-approval 包）。 */
export interface HostApprovalRequest {
  agent: { id: unknown }
  toolName: string
  callId?: unknown
  reason?: string
  signal?: AbortSignal
}

type ApprovalListener = (event: ApprovalEvent) => void

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/** 默认等待时间：与 Linger 的 10 分钟一致。 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

export interface ApprovalCenterOptions {
  timeoutMs?: number
  log?: (event: string, fields: Record<string, string | number | boolean>) => void
}

export class ApprovalCenter {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly listeners = new Set<ApprovalListener>()
  private viewers = 0

  constructor(
    private readonly store: ApprovalStore,
    private readonly options: ApprovalCenterOptions = {},
  ) {}

  /** 页面打开 `/sv/api/events` 时登记一个观察者；返回注销函数。 */
  attachViewer(): () => void {
    this.viewers += 1
    let detached = false
    return () => {
      if (detached) return
      detached = true
      this.viewers = Math.max(0, this.viewers - 1)
      if (this.viewers === 0) void this.cancelAll('viewer-left')
    }
  }

  hasViewer(): boolean {
    return this.viewers > 0
  }

  pendingCount(): number {
    return this.store.pendingCount()
  }

  list(status: 'all' | 'pending' | 'decided' = 'all', limit = 100): ApprovalRecord[] {
    return this.store.list(status, limit)
  }

  get(id: string): ApprovalRecord | undefined {
    return this.store.get(id)
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 用户从页面回答一条审批。 */
  async answer(id: string, outcome: 'allowed-once' | 'rejected'): Promise<ApprovalRecord> {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') throw new Error('审批结果必须是 allowed-once 或 rejected')
    const record = await this.settle(id, outcome, 'user')
    if (record === undefined) throw new Error('审批不存在或已处理')
    return record
  }

  /** 清空审计历史。 */
  async clear(): Promise<void> {
    await this.store.clear()
  }

  /** 从磁盘重新加载审计（恢复备份后调用）。 */
  async load(): Promise<void> {
    await this.store.load()
  }

  /** 把遗留的待处理记录标为取消（恢复备份后调用）。 */
  async failPending(): Promise<number> {
    return await this.store.failPending()
  }

  /**
   * 宿主 answerer：等待用户回答，或在没有页面/超时/取消时 fail-closed。
   */
  async request(req: HostApprovalRequest): Promise<ApprovalOutcome> {
    const sessionId = req.agent?.id === undefined ? undefined : String(req.agent.id)
    const record = await this.store.add({
      toolName: req.toolName,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
    })

    // 先登记 pending，再广播 asked：页面在收到事件后立刻点击也不会落空。
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        void this.settle(record.id, 'cancelled', 'timeout')
      }, timeoutMs)
      const pending: PendingApproval = { resolve, timer }
      this.pending.set(record.id, pending)

      if (req.signal !== undefined) {
        if (req.signal.aborted) {
          void this.settle(record.id, 'cancelled', 'aborted')
          return
        }
        const onAbort = (): void => {
          void this.settle(record.id, 'cancelled', 'aborted')
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
        pending.signal = req.signal
        pending.onAbort = onAbort
      }
    })
    this.emit({ type: 'approval', action: 'asked', item: record, pending: this.store.pendingCount() })
    this.log('approval_asked', {
      approvalId: record.id,
      tool: record.toolName,
      ...(sessionId === undefined ? {} : { sessionId }),
    })

    if (req.signal?.aborted === true) {
      await this.settle(record.id, 'cancelled', 'aborted')
      return 'cancelled'
    }

    // 没有页面在线：立即拒绝，避免后台任务等到超时。
    if (this.viewers === 0) {
      await this.settle(record.id, 'unavailable', 'no-answerer')
      this.log('approval_unavailable', { approvalId: record.id, tool: record.toolName })
      return 'unavailable'
    }

    return await decision
  }

  /** 结束一条待处理审批：落审计、通知页面、唤醒等待方。 */
  private async settle(
    id: string,
    outcome: ApprovalOutcome,
    decidedBy: 'user' | 'timeout' | 'aborted' | 'viewer-left' | 'no-answerer',
  ): Promise<ApprovalRecord | undefined> {
    const pending = this.pending.get(id)
    if (pending === undefined) return undefined
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    const record = await this.store.decide(id, outcome, decidedBy)
    pending.resolve(outcome)
    if (record !== undefined) {
      this.emit({ type: 'approval', action: 'decided', item: record, pending: this.store.pendingCount() })
      this.log('approval_decided', { approvalId: id, outcome, decidedBy })
    }
    return record
  }

  private async cancelAll(decidedBy: 'viewer-left'): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      await this.settle(id, 'cancelled', decidedBy)
    }
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个页面断开不影响其他观察者与宿主审批
      }
    }
  }

  private log(event: string, fields: Record<string, string | number | boolean>): void {
    this.options.log?.(event, fields)
  }
}
