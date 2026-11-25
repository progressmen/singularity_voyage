/**
 * 每日简报：把今日待办、昨日对话与未读收件箱整理成一条可阅读的简报。
 *
 * 生成方式：
 *  - 有可用数据时先让模型按固定结构写（只给事实，不允许编造）；
 *  - 模型失败、超时或没有配置密钥时，回落到确定性模板，保证每天都有一条；
 *  - 生成结果写入收件箱；可选额外发一封邮件（复用 mailer.py）。
 *
 * 调度与 MailNotifier 的每日摘要同一套思路：进程内每 30 秒扫描一次，
 * 到点且当天未生成过就生成；日期记在收件箱文件里，重启不会重复。
 */
import { formatTaskTime, type TaskEntry, type TasksStore } from './tasks-store.ts'
import type { SvBriefingConfig, SvMailConfig } from './config-store.ts'
import type { InboxItem, InboxKind, InboxStore } from './inbox-store.ts'
import { isMailConfigured, sendMail } from './mail-notifier.ts'
import type { SvSessionStore } from './sessions-store.ts'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DEFAULT_INTERVAL_MS = 30_000
const BRIEFING_TIMEOUT_MS = 30_000
const MAX_YESTERDAY_SESSIONS = 8
const EXCERPT_CHARS = 180
const MAX_PROMPT_TASKS = 12
const MAX_PROMPT_UNREAD = 10

/** 生成简报的模型提示词。 */
export const BRIEFING_SYSTEM = [
  '你是 Singularity Voyage 的个人助理，负责给用户写每日简报。',
  '规则：',
  '- 只使用给定的事实，不编造待办、事件、人物或结论。',
  '- 中文 Markdown，控制在 300 字以内。',
  '- 结构固定为三段：## 今日重点、## 昨日进展、## 需要关注。',
  '- 今日重点最多 3 条，优先逾期和今天到期的待办；昨日进展最多 3 条。',
  '- 没有内容时写「暂无」，不要凑字数。',
  '- 不要逐条复述全部数据，只提炼值得注意的部分。',
  '- 直接输出正文，不要代码块，不要开场白。',
].join('\n')

/** 昨日会话摘要（供 Prompt 与模板共用）。 */
export interface YesterdaySession {
  title: string
  updatedAt: number
  excerpt?: string
}

/** 未读收件箱摘要。 */
export interface BriefingUnread {
  kind: InboxKind
  title: string
}

/** 生成简报所需的输入。 */
export interface BriefingInput {
  now: number
  /** 未完成待办（按截止时间排序）。 */
  pending: TaskEntry[]
  yesterday: YesterdaySession[]
  unread: BriefingUnread[]
  unreadCount: number
}

export type BriefingGenerator = (input: BriefingInput, signal: AbortSignal) => Promise<string>

export type BriefingLogger = (event: string, fields: Record<string, string | number>) => void

/** 本地日期键（YYYY-MM-DD）。 */
export function localDayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 判断此刻是否该生成每日简报：已过当天时间，且今天还没生成过。
 * @param now - 当前时间。
 * @param time - HH:mm；空或非法表示关闭。
 * @param lastDay - 上次生成日期（YYYY-MM-DD）。
 */
export function shouldRunBriefing(now: Date, time: string, lastDay: string | undefined): boolean {
  if (!TIME_RE.test(time)) return false
  const [hours, minutes] = time.split(':').map(value => Number(value))
  const target = new Date(now)
  target.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  if (now.getTime() < target.getTime()) return false
  return lastDay !== localDayKey(now)
}

/** 简报标题：每日简报 · 11月25日。 */
export function briefingTitle(now: Date): string {
  return `每日简报 · ${now.getMonth() + 1}月${now.getDate()}日`
}

/** 简报邮件主题：带上今日待办数量。 */
export function briefingSubject(now: Date, pendingCount: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `[SV 简报] ${pad(now.getMonth() + 1)}-${pad(now.getDate())} · 待办 ${pendingCount} 项`
}

function taskLine(task: TaskEntry, now: number): string {
  const when = task.dueAt === undefined
    ? '无截止时间'
    : `${formatTaskTime(task.dueAt)}${task.dueAt <= now ? '（已逾期）' : ''}`
  return `- ${task.title}（${when}）`
}

function sameLocalDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

/** 把输入整理成模型可读的事实清单。 */
export function buildBriefingPrompt(input: BriefingInput): string {
  const now = new Date(input.now)
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now)
  const overdue = input.pending.filter(task => task.dueAt !== undefined && task.dueAt <= input.now)
  const lines = [
    `# 今日简报输入`,
    `日期：${localDayKey(now)}（${weekday}）`,
    '',
    `## 待办（未完成 ${input.pending.length} 项，其中逾期 ${overdue.length} 项）`,
  ]
  if (input.pending.length === 0) {
    lines.push('（没有未完成的待办）')
  } else {
    for (const task of input.pending.slice(0, MAX_PROMPT_TASKS)) {
      lines.push(taskLine(task, input.now))
    }
    if (input.pending.length > MAX_PROMPT_TASKS) lines.push(`（另有 ${input.pending.length - MAX_PROMPT_TASKS} 项未列出）`)
  }
  lines.push('', `## 昨日对话（${input.yesterday.length} 个会话）`)
  if (input.yesterday.length === 0) {
    lines.push('（昨天没有新对话）')
  } else {
    for (const session of input.yesterday) {
      const excerpt = session.excerpt === undefined ? '（无文字摘要）' : session.excerpt
      lines.push(`- ${session.title}：${excerpt}`)
    }
  }
  lines.push('', `## 未读收件箱（${input.unreadCount} 条）`)
  if (input.unread.length === 0) {
    lines.push('（没有未读消息）')
  } else {
    for (const item of input.unread.slice(0, MAX_PROMPT_UNREAD)) {
      lines.push(`- [${item.kind}] ${item.title}`)
    }
    if (input.unreadCount > input.unread.length) lines.push(`（另有 ${input.unreadCount - input.unread.length} 条未列出）`)
  }
  return lines.join('\n')
}

/** 确定性回落：模型不可用时仍然给出一份可读的简报。 */
export function fallbackBrief(input: BriefingInput): string {
  const now = input.now
  const overdue = input.pending.filter(task => task.dueAt !== undefined && task.dueAt <= now)
  const today = input.pending.filter(task => task.dueAt !== undefined && task.dueAt > now && sameLocalDay(task.dueAt, now))
  const rest = input.pending.filter(task => !overdue.includes(task) && !today.includes(task))

  const lines = ['## 今日重点']
  if (overdue.length > 0) {
    for (const task of overdue) lines.push(`- [逾期] ${task.title}（${formatTaskTime(task.dueAt ?? now)}）`)
  }
  if (today.length > 0) {
    for (const task of today) lines.push(`- [今天] ${task.title}（${formatTaskTime(task.dueAt ?? now)}）`)
  }
  if (overdue.length === 0 && today.length === 0) lines.push('- 今天没有到期的待办。')

  lines.push('', '## 昨日进展')
  if (input.yesterday.length === 0) {
    lines.push('- 昨天没有新对话。')
  } else {
    for (const session of input.yesterday.slice(0, 3)) {
      lines.push(`- ${session.title}：${session.excerpt ?? '（无文字摘要）'}`)
    }
  }

  lines.push('', '## 需要关注')
  if (input.unreadCount > 0) {
    lines.push(`- 收件箱有 ${input.unreadCount} 条未读：${input.unread.map(item => item.title).slice(0, 3).join('、')}`)
  }
  if (rest.length > 0) lines.push(`- 还有 ${rest.length} 项无明确截止时间的待办。`)
  if (input.unreadCount === 0 && rest.length === 0) lines.push('- 暂无。')
  return lines.join('\n')
}

/** 邮件正文：去掉 Markdown 标题符号，保留可读结构。 */
export function briefPlainText(body: string): string {
  return body
    .replace(/^##\s+/gm, '')
    .replace(/^- /gm, '· ')
    .trim()
}

export interface BriefingServiceOptions {
  /** 每次生成时读取最新配置，页面保存后立即生效。 */
  config: () => SvBriefingConfig
  mail: () => SvMailConfig
  tasks: TasksStore
  sessions: SvSessionStore
  inbox: InboxStore
  /** 模型生成；未提供或抛错时使用模板。 */
  generate?: BriefingGenerator
  log: BriefingLogger
  intervalMs?: number
}

export class BriefingService {
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(private readonly options: BriefingServiceOptions) {}

  /** 启动扫描；重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 停止扫描（插件卸载时调用）。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 立即生成一份简报（设置页按钮用）；忽略开关与当天去重。 */
  async runNow(): Promise<InboxItem> {
    if (this.running) throw new Error('简报正在生成，请稍候')
    this.running = true
    try {
      return await this.generate('manual')
    } finally {
      this.running = false
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return
    const config = this.options.config()
    if (!config.enabled || !TIME_RE.test(config.time)) return
    if (!shouldRunBriefing(new Date(), config.time, this.options.inbox.lastBriefDay())) return
    this.running = true
    try {
      const item = await this.generate('schedule')
      this.options.log('brief_created', { itemId: item.id, source: 'schedule' })
    } catch (error) {
      this.options.log('brief_failed', {
        source: 'schedule',
        err: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.running = false
    }
  }

  private async generate(source: 'schedule' | 'manual'): Promise<InboxItem> {
    const now = new Date()
    const input = await this.collect(now)
    let body = ''
    if (this.options.generate !== undefined && this.hasMaterial(input)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), BRIEFING_TIMEOUT_MS)
      timer.unref?.()
      try {
        body = (await this.options.generate(input, controller.signal)).trim()
      } catch (error) {
        this.options.log('brief_llm_failed', {
          source,
          err: error instanceof Error ? error.message : String(error),
        })
      } finally {
        clearTimeout(timer)
      }
    }
    if (body.length === 0) body = fallbackBrief(input)

    const item = await this.options.inbox.add({
      kind: 'briefing',
      title: briefingTitle(now),
      body,
    })
    await this.options.inbox.markBriefDay(localDayKey(now))
    this.options.log('brief_stored', { itemId: item.id, source, pending: input.pending.length })
    await this.mail(item, now, input.pending.length)
    return item
  }

  /** 没有待办、昨日对话与未读时不必调用模型，直接用模板。 */
  private hasMaterial(input: BriefingInput): boolean {
    return input.pending.length > 0 || input.yesterday.length > 0 || input.unreadCount > 0
  }

  private async mail(item: InboxItem, now: Date, pendingCount: number): Promise<void> {
    const config = this.options.config()
    if (!config.email) return
    const mail = this.options.mail()
    if (!mail.enabled || !isMailConfigured(mail)) return
    try {
      await sendMail({ subject: briefingSubject(now, pendingCount), body: briefPlainText(item.body) })
      this.options.log('brief_mail_sent', { itemId: item.id })
    } catch (error) {
      this.options.log('brief_mail_failed', {
        itemId: item.id,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 汇总今日待办、昨日会话与未读收件箱。 */
  private async collect(now: Date): Promise<BriefingInput> {
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const startOfYesterday = new Date(startOfToday)
    startOfYesterday.setDate(startOfYesterday.getDate() - 1)

    const sessions = this.options.sessions.list()
      .filter(entry => entry.updatedAt >= startOfYesterday.getTime() && entry.updatedAt < startOfToday.getTime())
      .slice(0, MAX_YESTERDAY_SESSIONS)
    const yesterday: YesterdaySession[] = []
    for (const entry of sessions) {
      let excerpt: string | undefined
      try {
        const messages = await this.options.sessions.messages(entry.id)
        const last = [...messages].reverse().find(message => message.role === 'assistant' && message.text.trim().length > 0)
        if (last !== undefined) {
          const text = last.text.replace(/\s+/g, ' ').trim()
          excerpt = text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}…`
        }
      } catch {
        // 单个会话读取失败不影响简报
      }
      yesterday.push({
        title: entry.title,
        updatedAt: entry.updatedAt,
        ...(excerpt === undefined ? {} : { excerpt }),
      })
    }

    // 简报本身不计入「未读收件箱」：否则昨天的简报会被今天的简报当成新消息。
    const unread = this.options.inbox.list({ unreadOnly: true, limit: 500 })
      .filter(item => item.kind !== 'briefing')
    return {
      now: now.getTime(),
      pending: this.options.tasks.list(false),
      yesterday,
      unread: unread.slice(0, MAX_PROMPT_UNREAD).map(item => ({ kind: item.kind, title: item.title })),
      unreadCount: unread.length,
    }
  }
}
