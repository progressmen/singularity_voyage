/**
 * 邮件通知：待办到期提醒 + 每日待办摘要。
 *
 * 发信不另写一套 SMTP：待办提醒调用 `mcp/sv-mail-mcp/mailer.py` 的 CLI，
 * 与模型可调用的 MCP 工具（`mcp__sv-mail__send_email`）共用同一份配置与实现。
 *
 * 触发路径：
 *  - 到期提醒：订阅 ReminderService 的提醒事件（页面弹窗照常，额外发一封邮件）；
 *  - 每日摘要：进程内每 30 秒扫描一次，到点且当天未发过就汇总未完成待办。
 *
 * 摘要发送记录写在 `$DSH_HOME/sv/mail-state.json`（只含日期），避免重启后重复发信。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir, type SvMailConfig } from './config-store.ts'
import { svError } from './log.ts'
import { formatTaskTime, type TaskEntry, type TasksStore } from './tasks-store.ts'

/** 单次发信（含 Python 启动）的超时。 */
const SEND_TIMEOUT_MS = 30_000
/** 每日摘要的扫描间隔。 */
const DEFAULT_INTERVAL_MS = 30_000
const DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const RECURRENCE_LABEL: Record<string, string> = { none: '不重复', daily: '每天', weekly: '每周' }

/** 发给 mailer.py 的载荷。 */
export interface MailPayload {
  subject: string
  body: string
  /** 留空表示用配置里的默认收件人。 */
  to?: string
}

export type MailLogger = (event: string, fields: Record<string, string | number>) => void

/** mailer.py 路径：默认仓库 mcp/sv-mail-mcp/（可用 SV_MAIL_SCRIPT 覆盖）。 */
export function mailScriptPath(): string {
  const override = process.env.SV_MAIL_SCRIPT?.trim()
  if (override !== undefined && override.length > 0) return override
  // lib/ 与 src/ 到仓库根都是三层
  return join(import.meta.dirname, '..', '..', '..', 'mcp', 'sv-mail-mcp', 'mailer.py')
}

function pythonBin(): string {
  return process.env.SV_MAIL_PYTHON?.trim() || 'python3'
}

function localDayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 从 CLI 的 stdout JSON 里取错误信息。 */
function parseError(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') {
      return (parsed as { error: string }).error
    }
  } catch {
    // 非 JSON 输出（例如 Python traceback）交给 stderr 兜底
  }
  return undefined
}

/**
 * 调用 mailer.py 发信；失败抛错（由调用方决定记日志还是展示）。
 * @param payload - 主题、正文与可选收件人。
 * @param options - `dryRun` 只校验配置，不连接 SMTP。
 */
export async function sendMail(payload: MailPayload, options: { dryRun?: boolean } = {}): Promise<void> {
  const args = [mailScriptPath(), 'send']
  if (options.dryRun === true) args.push('--dry-run')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pythonBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`发信超时（${SEND_TIMEOUT_MS}ms）`))
    }, SEND_TIMEOUT_MS)
    timer.unref?.()
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (code === 0) {
        finish()
        return
      }
      const detail = parseError(stdout) ?? (stderr.trim().length > 0 ? stderr.trim() : `退出码 ${code}`)
      finish(new Error(`发信失败：${detail}`))
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * 判断此刻是否该发每日摘要：已过当天摘要时间，且今天还没发过。
 * @param now - 当前时间。
 * @param digestAt - HH:mm；空或非法表示关闭。
 * @param lastDay - 上次发送日期（YYYY-MM-DD）。
 */
export function shouldSendDigest(now: Date, digestAt: string, lastDay: string | undefined): boolean {
  if (!DIGEST_TIME_RE.test(digestAt)) return false
  const [hours, minutes] = digestAt.split(':').map(value => Number(value))
  const target = new Date(now)
  target.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  if (now.getTime() < target.getTime()) return false
  return lastDay !== localDayKey(now)
}

/**
 * 判断邮件配置是否可用（发件人/收件人留空时回落到账号）。
 * 不完整的配置不尝试发信，也不占用当天的摘要名额。
 */
export function isMailConfigured(config: SvMailConfig): boolean {
  return config.host.length > 0
    && config.user.length > 0
    && config.password.length > 0
    && (config.to.length > 0 || config.user.length > 0)
}

/** 到期提醒邮件正文。 */
export function reminderBody(task: TaskEntry, now = Date.now()): string {
  const lines = ['待办提醒', '', `标题：${task.title}`]
  if (task.dueAt !== undefined) {
    lines.push(`时间：${formatTaskTime(task.dueAt)}${task.dueAt <= now ? '（已逾期）' : ''}`)
  }
  if (task.recurrence !== 'none') lines.push(`重复：${RECURRENCE_LABEL[task.recurrence] ?? task.recurrence}`)
  if (task.notes !== undefined && task.notes.length > 0) lines.push('', '备注：', task.notes)
  lines.push('', '—— 由 Singularity Voyage 自动发送')
  return lines.join('\n')
}

/** 每日摘要里归为「已逾期」的任务。 */
function overdueOf(pending: TaskEntry[], now: number): TaskEntry[] {
  return pending.filter(task => task.dueAt !== undefined && task.dueAt <= now)
}

/** 每日摘要邮件主题：带上逾期数量，一眼能看出是否有超时项。 */
export function digestSubject(pending: TaskEntry[], now = Date.now()): string {
  const day = localDayKey(new Date(now)).slice(5)
  const overdue = overdueOf(pending, now).length
  return `[SV 日报] ${day} 待办 ${pending.length} 项${overdue > 0 ? `（逾期 ${overdue}）` : ''}`
}

/**
 * 每日摘要邮件正文。
 *
 * 超时提醒不单独发信：逾期任务在摘要里单列一段，其余待办跟在后面。
 */
export function digestBody(pending: TaskEntry[], now = Date.now()): string {
  const overdue = overdueOf(pending, now)
  const rest = pending.filter(task => !overdue.includes(task))
  const lines = [`今日待办（${pending.length} 项）`, '']
  if (pending.length === 0) {
    lines.push('今天没有未完成的待办。')
  } else {
    if (overdue.length > 0) {
      lines.push(`已逾期（${overdue.length} 项）`)
      for (const task of overdue) {
        lines.push(`- [ ] ${task.title}（${formatTaskTime(task.dueAt ?? now)} · 已逾期）`)
      }
      if (rest.length > 0) lines.push('')
    }
    if (rest.length > 0) {
      lines.push(overdue.length > 0 ? '其余待办' : '待办')
      for (const task of rest) {
        const when = task.dueAt === undefined ? '无截止时间' : formatTaskTime(task.dueAt)
        lines.push(`- [ ] ${task.title}（${when}）`)
      }
    }
  }
  lines.push('', '—— 由 Singularity Voyage 自动发送')
  return lines.join('\n')
}

/** 每日摘要历史上一次发送日期。 */
interface MailState {
  lastDigestDay?: string
}

export interface MailNotifierOptions {
  /** 每次发送时读取最新配置，页面保存后立即生效。 */
  config: () => SvMailConfig
  tasks: TasksStore
  log: MailLogger
  intervalMs?: number
}

export class MailNotifier {
  private timer: NodeJS.Timeout | undefined
  private lastDigestDay: string | undefined
  private stateLoaded = false
  private checking = false

  constructor(private readonly options: MailNotifierOptions) {}

  private get stateFile(): string {
    return join(svDataDir(), 'mail-state.json')
  }

  /** 启动每日摘要扫描；重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.loadState().then(() => this.tick())
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 停止扫描（插件卸载时调用）。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 到期提醒：页面弹窗之外再发一封邮件。 */
  async notifyReminder(task: TaskEntry): Promise<void> {
    const config = this.options.config()
    if (!config.enabled || !config.notifyOnReminder || !isMailConfigured(config)) return
    try {
      await sendMail({ subject: `[SV 提醒] ${task.title}`, body: reminderBody(task) })
      this.options.log('reminder_mail_sent', { taskId: task.id })
    } catch (error) {
      this.options.log('reminder_mail_failed', { taskId: task.id, err: svError(error) })
    }
  }

  /** 设置页「发送测试邮件」：不看开关，只验证 SMTP 配置是否可用。 */
  async sendTest(): Promise<void> {
    await sendMail({
      subject: '[SV] 测试邮件',
      body: `这是一封来自 Singularity Voyage 的测试邮件。\n\n如果你收到了它，说明邮件提醒已经配置成功。\n发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    })
  }

  private async tick(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      const config = this.options.config()
      if (!config.enabled || config.digestAt.length === 0 || !isMailConfigured(config)) return
      const now = new Date()
      if (!shouldSendDigest(now, config.digestAt, this.lastDigestDay)) return
      if (!this.stateLoaded) await this.loadState()
      if (!shouldSendDigest(now, config.digestAt, this.lastDigestDay)) return
      // 当天只尝试一次：SMTP 故障时记日志，不在 30 秒循环里反复发信
      this.lastDigestDay = localDayKey(now)
      const pending = this.options.tasks.list(false)
      try {
        await sendMail({
          subject: digestSubject(pending, now.getTime()),
          body: digestBody(pending, now.getTime()),
        })
        this.options.log('digest_mail_sent', { count: pending.length })
      } catch (error) {
        this.options.log('digest_mail_failed', { count: pending.length, err: svError(error) })
      }
      await this.persistState()
    } finally {
      this.checking = false
    }
  }

  private async loadState(): Promise<void> {
    this.stateLoaded = true
    try {
      const raw = await readFile(this.stateFile, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as MailState).lastDigestDay
        if (typeof value === 'string' && value.length > 0) this.lastDigestDay = value
      }
    } catch {
      // 缺失或损坏按「今天还没发」处理
    }
  }

  private async persistState(): Promise<void> {
    const dir = svDataDir()
    await mkdir(dir, { recursive: true })
    const state: MailState = this.lastDigestDay === undefined ? {} : { lastDigestDay: this.lastDigestDay }
    const temp = `${this.stateFile}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.stateFile)
  }
}
