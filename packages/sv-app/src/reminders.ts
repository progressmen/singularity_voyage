/**
 * 待办提醒扫描器与页面通知总线。
 *
 * 进程内每 30 秒扫描一次到期任务；命中后写入 notifiedAt（重复任务滚动到
 * 下一次），并把提醒事件推给所有订阅者（`/sv/api/events` 的 SSE 连接）。
 *
 * 不依赖 `ctx.schedule`：M1 只需要「页面内准时提醒」，不需要把消息重新
 * 投递回会话触发模型；后者等到 M3 的主动简报再引入。
 */
import { svError } from './log.ts'
import { taskView, type TasksStore } from './tasks-store.ts'

/** 推送给页面的提醒事件。 */
export interface SvReminderEvent {
  type: 'reminder'
  task: ReturnType<typeof taskView>
  at: number
}

type Listener = (event: SvReminderEvent) => void

/** 日志回调：只传事件名与字段，由调用方决定级别与格式。 */
export type ReminderLogger = (event: string, fields: Record<string, string | number>) => void

/** 扫描间隔（毫秒）。 */
const DEFAULT_INTERVAL_MS = 30_000

export class ReminderService {
  private timer: NodeJS.Timeout | undefined
  private readonly subscribers = new Set<Listener>()
  private scanning = false

  constructor(
    private readonly tasks: TasksStore,
    private readonly log: ReminderLogger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  /** 启动扫描；重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.scan()
    this.timer = setInterval(() => void this.scan(), this.intervalMs)
    this.timer.unref?.()
  }

  /** 停止扫描（插件卸载时调用）。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 订阅提醒事件；返回取消订阅函数。 */
  subscribe(listener: Listener): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /** 扫描一次到期任务并广播。 */
  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const now = Date.now()
      for (const task of this.tasks.due(now)) {
        try {
          const updated = await this.tasks.markNotified(task.id, now)
          if (updated === undefined) continue
          const event: SvReminderEvent = { type: 'reminder', task: taskView(updated), at: now }
          for (const listener of this.subscribers) {
            try {
              listener(event)
            } catch {
              // 单个订阅者（通常是断开的 SSE 连接）故障不影响其他订阅者
            }
          }
        } catch (error) {
          this.log('reminder_send_failed', { taskId: task.id, err: svError(error) })
        }
      }
    } finally {
      this.scanning = false
    }
  }
}
