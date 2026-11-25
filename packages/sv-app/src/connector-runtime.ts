/**
 * 连接器同步运行时：按 everyMinutes 扫描，串行拉取只读数据并写入事件流。
 *
 * 手动「立即同步」不受暂停开关限制；自动扫描只处理 enabled 且到期的连接器。
 * 每次同步都有超时；失败写入 lastError 与日志，不抛出到调度循环。
 */
import { svError } from './log.ts'
import type { Connector, ConnectorStore } from './connector-store.ts'
import type { FetchLike } from './connector-adapters.ts'
import { syncConnector } from './connector-adapters.ts'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_TIMEOUT_MS = 25_000

/** 同步事件（SSE 用）。 */
export interface ConnectorSyncEvent {
  type: 'connector'
  action: 'synced' | 'failed'
  connectorId: string
  name: string
  added: number
  at: number
  error?: string
}

export interface ConnectorServiceOptions {
  store: ConnectorStore
  log: (event: string, fields: Record<string, string | number | boolean>) => void
  fetchImpl?: FetchLike
  intervalMs?: number
  timeoutMs?: number
  now?: () => number
}

type ConnectorListener = (event: ConnectorSyncEvent) => void

export class ConnectorService {
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private readonly active = new Set<string>()
  private readonly listeners = new Set<ConnectorListener>()

  constructor(private readonly options: ConnectorServiceOptions) {}

  /** 启动扫描；启动时立刻检查一次。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 停止扫描；正在进行的同步不受影响。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  subscribe(listener: ConnectorListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 手动同步一次；暂停状态也允许。 */
  async runNow(id: string): Promise<{ connector: Connector; added: number; note?: string }> {
    const connector = this.options.store.getConnector(id)
    if (connector === undefined) throw new Error('连接器不存在')
    if (this.active.has(id)) throw new Error('该连接器正在同步，请稍候')
    this.active.add(id)
    const now = this.options.now?.() ?? Date.now()
    const controller = new AbortController()
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('连接器同步超时'))
    }, timeoutMs)
    timer.unref?.()

    try {
      const result = await syncConnector(connector, {
        fetch: this.options.fetchImpl ?? fetch,
        signal: controller.signal,
        now,
      })
      const added = await this.options.store.ingest(connector, result.events, now)
      await this.options.store.finishSync(id, {
        at: now,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
        added: added.length,
      })
      const updated = this.options.store.getConnector(id) ?? connector
      this.emit({
        type: 'connector',
        action: 'synced',
        connectorId: id,
        name: connector.name,
        added: added.length,
        at: now,
      })
      this.options.log('connector_synced', {
        connectorId: id,
        kind: connector.kind,
        added: added.length,
        ...(result.note === undefined ? {} : { note: result.note }),
      })
      return { connector: updated, added: added.length, ...(result.note === undefined ? {} : { note: result.note }) }
    } catch (error) {
      const message = timedOut
        ? `同步超时（${Math.round(timeoutMs / 1000)} 秒）`
        : svError(error)
      await this.options.store.finishSync(id, { at: now, error: message }).catch(() => undefined)
      this.emit({
        type: 'connector',
        action: 'failed',
        connectorId: id,
        name: connector.name,
        added: 0,
        at: now,
        error: message,
      })
      this.options.log('connector_sync_failed', {
        connectorId: id,
        kind: connector.kind,
        err: message,
      })
      throw new Error(message)
    } finally {
      clearTimeout(timer)
      this.active.delete(id)
    }
  }

  /** 按到期时间串行扫描。 */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.options.now?.() ?? Date.now()
      const due = this.options.store.listConnectors()
        .filter(connector => connector.enabled)
        .filter(connector => connector.lastSyncAt === undefined
          || connector.lastSyncAt + connector.everyMinutes * 60_000 <= now)
        .sort((a, b) => (a.lastSyncAt ?? 0) - (b.lastSyncAt ?? 0))
      for (const connector of due) {
        if (this.active.has(connector.id)) continue
        try {
          await this.runNow(connector.id)
        } catch {
          // runNow 已记录错误与事件，调度循环继续下一个
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private emit(event: ConnectorSyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个页面断开不影响同步
      }
    }
  }
}
