/**
 * 自动化执行器：调度扫描 + 三类任务执行 + 收件箱/邮件触达。
 *
 * 所有副作用集中在这里：
 *  - web / keyword 走注入的 `fetchPage`（生产环境复用 `ctx.web.fetch`）；
 *  - prompt 走注入的 `runPrompt`（生产环境用隔离 Agent，带完整工具面）；
 *  - 结果与失败都写入收件箱；可选发邮件；
 *  - 每次运行都落一条历史，供页面与工具查询。
 *
 * 同一自动化不会被并发执行；整轮扫描串行执行，避免同时起多个模型调用。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  type Automation,
  type AutomationRun,
  type AutomationStore,
} from './automation-store.ts'
import type { SvAutomationConfig, SvMailConfig } from './config-store.ts'
import type { InboxStore } from './inbox-store.ts'
import type { FetchedPage } from './knowledge-source.ts'
import { isMailConfigured, sendMail } from './mail-notifier.ts'
import { svError } from './log.ts'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
const MAX_BODY = 5000

export type AutomationPromptRunner = (automation: Automation, signal: AbortSignal) => Promise<string>

export type AutomationFetchPage = (url: string, signal: AbortSignal) => Promise<FetchedPage>

export type AutomationLogger = (event: string, fields: Record<string, string | number | boolean>) => void

export interface AutomationRuntimeOptions {
  store: AutomationStore
  inbox: InboxStore
  /** 每次运行读取最新邮件配置。 */
  mail: () => SvMailConfig
  /** 每次扫描读取最新全局设置（暂停 / 静默 / 重试）；缺省时按默认值。 */
  config?: () => SvAutomationConfig
  fetchPage: AutomationFetchPage
  runPrompt: AutomationPromptRunner
  log: AutomationLogger
  intervalMs?: number
  fetchTimeoutMs?: number
  promptTimeoutMs?: number
}

export interface AutomationExecution {
  automation: Automation
  run: AutomationRun
}

/** 一次尝试的结果（execute 负责落库与通知）。 */
interface AttemptResult {
  status: AutomationRun['status']
  summary: string
  error?: string
  body: string
  notifyTitle: string
  notify: boolean
  hash?: string | null
  match?: string | null
  text?: string | null
}

/** RSS / Atom 里的一条内容。 */
export interface FeedItem {
  title: string
  link: string
  id: string
  summary?: string
}

/** RSS 条目的指纹分隔符（不写入正文）。 */
const FEED_SEPARATOR = '\u0001'

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10))
      } catch {
        return ''
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

/** 从 RSS / Atom XML 中解析条目（正则实现，不引入 XML 依赖）。 */
export function parseFeedItems(xml: string, max = 30): FeedItem[] {
  const items: FeedItem[] = []
  for (const match of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const raw = match[0]
    const pick = (tag: string): string => {
      const found = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(raw)
      if (found === null) return ''
      return decodeXml(found[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    const title = pick('title')
    const link = pick('link') || /<link[^>]*href="([^"]+)"/i.exec(raw)?.[1]?.trim() || ''
    const guid = pick('guid') || pick('id') || link
    if (title.length === 0 && link.length === 0) continue
    const summary = pick('description') || pick('summary') || pick('content')
    items.push({
      title: title.length > 0 ? title : link,
      link,
      id: guid.length > 0 ? guid : title,
      ...summary.length === 0 ? {} : { summary },
    })
    if (items.length >= max) break
  }
  return items
}

/** 简单行级差异：返回新增/移除的前几条（去重、忽略空白行）。 */
export function diffLines(previous: string, next: string): { added: string[]; removed: string[] } {
  const prevLines = previous.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const nextLines = next.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const prevSet = new Set(prevLines)
  const nextSet = new Set(nextLines)
  return {
    added: nextLines.filter(line => !prevSet.has(line)).slice(0, 3),
    removed: prevLines.filter(line => !nextSet.has(line)).slice(0, 3),
  }
}

function minutesOf(value: string): number | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** 当前是否处于静默时段（支持跨午夜）。 */
export function inQuietHours(config: SvAutomationConfig, date = new Date()): boolean {
  const start = minutesOf(config.quietStart)
  const end = minutesOf(config.quietEnd)
  if (start === undefined || end === undefined || start === end) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return start < end ? now >= start && now < end : now >= start || now < end
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function plainText(text: string): string {
  return text
    .replace(/^##\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^- /gm, '· ')
    .trim()
}

/** 关键词附近的片段，用于邮件/收件箱正文。 */
export function keywordSnippet(text: string, keyword: string, max = 180): string {
  const index = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (index < 0) return ''
  const from = Math.max(0, index - 60)
  const slice = text.slice(from, from + max).trim()
  return `${from > 0 ? '…' : ''}${slice}${from + max < text.length ? '…' : ''}`
}

export class AutomationService {
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private readonly active = new Set<string>()

  constructor(private readonly options: AutomationRuntimeOptions) {}

  /** 启动扫描；启动时立刻检查一次，补跑一次因进程停止而错过的任务。 */
  start(): void {
    if (this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 停止扫描（插件卸载时调用）；正在执行的任务不受影响。 */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 手动运行一次；暂停状态也允许。 */
  async runNow(id: string): Promise<AutomationExecution> {
    const entry = this.options.store.get(id)
    if (entry === undefined) throw new Error('自动化不存在')
    if (this.active.has(id)) throw new Error('该自动化正在运行，请稍候')
    return this.execute(entry)
  }

  /** 按 nextRunAt 扫描到期任务；串行执行。 */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // 全局暂停时只跳过自动扫描，手动「运行」仍可用。
      if (this.options.config?.().paused === true) return
      const now = Date.now()
      const due = this.options.store.list()
        .filter(entry => entry.enabled && entry.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
      for (const entry of due) {
        if (this.active.has(entry.id)) continue
        try {
          await this.execute(entry)
        } catch (error) {
          this.options.log('automation_run_failed', {
            automationId: entry.id,
            err: svError(error),
          })
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async execute(entry: Automation): Promise<AutomationExecution> {
    if (this.active.has(entry.id)) throw new Error('该自动化正在运行')
    this.active.add(entry.id)
    const startedAt = Date.now()
    const config = this.options.config?.()
    const quiet = config !== undefined && inQuietHours(config)
    const retries = Math.min(5, Math.max(0, config?.retryAttempts ?? 0))
    const timeoutMs = entry.kind === 'prompt'
      ? this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
      : this.options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS

    let result: AttemptResult | undefined
    let timedOut = false
    try {
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController()
        timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('执行超时'))
        }, timeoutMs)
        timer.unref?.()
        try {
          result = await this.perform(entry, controller.signal)
        } catch (failure) {
          result = {
            status: 'failed',
            summary: '运行失败',
            error: timedOut ? `执行超时（${Math.round(timeoutMs / 1000)} 秒）` : svError(failure),
            notify: true,
            notifyTitle: `自动化失败：${entry.title}`,
            body: [
              `任务：${entry.title}`,
              ...entry.kind === 'prompt' ? [`任务描述：${entry.prompt ?? ''}`] : [],
              ...entry.url === undefined ? [] : [`监控网页：${entry.url}`],
              '',
              `错误：${timedOut ? `执行超时（${Math.round(timeoutMs / 1000)} 秒）` : svError(failure)}`,
            ].join('\n'),
          }
        } finally {
          clearTimeout(timer)
        }
        // 超时说明上游已不可用，不再重试；其余失败按配置重试。
        if (result.status !== 'failed' || timedOut || attempt >= retries) break
        this.options.log('automation_retry', { automationId: entry.id, attempt: attempt + 1 })
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
      }
    } finally {
      this.active.delete(entry.id)
    }

    if (result === undefined) throw new Error('自动化没有产生结果')
    const { status, summary, error, body, notify, notifyTitle } = result
    const finishedAt = Date.now()
    const updated = await this.options.store.finishRun(entry.id, {
      at: finishedAt,
      summary: `${summary}${error === undefined ? '' : `：${error}`}`,
      ...result.hash === undefined ? {} : { hash: result.hash },
      ...result.match === undefined ? {} : { match: result.match },
      ...result.text === undefined ? {} : { text: result.text },
    })
    if (updated === undefined) {
      throw new Error('自动化已被删除，运行结果未保存')
    }
    const run = await this.options.store.recordRun({
      automationId: entry.id,
      title: entry.title,
      startedAt,
      finishedAt,
      status,
      summary: clip(summary, 500),
      ...(error === undefined ? {} : { error: clip(error, 500) }),
    })

    if (notify) {
      try {
        await this.options.inbox.add({
          kind: 'automation',
          title: notifyTitle,
          body: clip(body, MAX_BODY),
          ...quiet ? { silent: true } : {},
        })
      } catch (inboxError) {
        this.options.log('automation_inbox_failed', {
          automationId: entry.id,
          err: svError(inboxError),
        })
      }
      // 静默时段只进收件箱，不发邮件。
      if (!quiet) await this.mail(entry, notifyTitle, clip(body, MAX_BODY))
    }

    this.options.log('automation_run', {
      automationId: entry.id,
      kind: entry.kind,
      status,
      notify,
      quiet,
      durationMs: finishedAt - startedAt,
    })
    return { automation: updated, run }
  }

  /** 执行一次自动化任务的核心逻辑（不含重试与落库）。 */
  private async perform(entry: Automation, signal: AbortSignal): Promise<AttemptResult> {
    if (entry.kind === 'web') {
      const page = await this.options.fetchPage(entry.url ?? '', signal)
      const nextHash = sha256(page.text)
      if (entry.lastHash === undefined) {
        return {
          status: 'ok',
          summary: `已建立基线（${page.text.length} 字符）`,
          notify: false,
          notifyTitle: '',
          body: '',
          hash: nextHash,
          text: page.text,
        }
      }
      if (entry.lastHash === nextHash) {
        return {
          status: 'unchanged',
          summary: '内容未变化',
          notify: false,
          notifyTitle: '',
          body: '',
          hash: nextHash,
          text: page.text,
        }
      }
      const diff = diffLines(entry.lastText ?? '', page.text)
      const lines = [`监控网页：${page.url}`]
      if (diff.added.length > 0) lines.push(`新增内容：\n${diff.added.map(line => `+ ${clip(line, 160)}`).join('\n')}`)
      if (diff.removed.length > 0) lines.push(`移除内容：\n${diff.removed.map(line => `- ${clip(line, 160)}`).join('\n')}`)
      if (diff.added.length === 0 && diff.removed.length === 0) {
        lines.push(clip(page.text.replace(/\s+/g, ' ').trim(), 600))
      }
      return {
        status: 'changed',
        summary: `内容发生变化（新增 ${diff.added.length} / 移除 ${diff.removed.length} 段）`,
        notify: true,
        notifyTitle: `网页变化：${entry.title}`,
        body: lines.join('\n\n'),
        hash: nextHash,
        text: page.text,
      }
    }
    if (entry.kind === 'keyword') {
      const page = await this.options.fetchPage(entry.url ?? '', signal)
      const lower = page.text.toLowerCase()
      const matched = (entry.keywords ?? []).filter(keyword => lower.includes(keyword.toLowerCase()))
      if (matched.length === 0) {
        return { status: 'unchanged', summary: '未命中关键词', notify: false, notifyTitle: '', body: '', match: null }
      }
      const fingerprint = matched.join('|')
      if (entry.lastMatch === fingerprint) {
        return {
          status: 'unchanged',
          summary: `仍命中：${matched.join('、')}（内容未变化）`,
          notify: false,
          notifyTitle: '',
          body: '',
          match: fingerprint,
        }
      }
      const snippets = matched.slice(0, 3)
        .map(keyword => `「${keyword}」\n${keywordSnippet(page.text, keyword) || '（内容过长，请打开原网页查看）'}`)
        .join('\n\n')
      return {
        status: 'matched',
        summary: `命中：${matched.join('、')}`,
        notify: true,
        notifyTitle: `关键词命中：${entry.title}`,
        body: `监控网页：${page.url}\n\n命中关键词：${matched.join('、')}\n\n${snippets}`,
        match: fingerprint,
      }
    }
    if (entry.kind === 'rss') {
      const page = await this.options.fetchPage(entry.url ?? '', signal)
      const items = parseFeedItems(page.text)
      if (items.length === 0) throw new Error('没有解析到 RSS / Atom 条目')
      const fingerprint = items.map(item => item.id).join(FEED_SEPARATOR)
      if (entry.lastMatch === undefined) {
        return {
          status: 'ok',
          summary: `已建立基线（${items.length} 条）`,
          notify: false,
          notifyTitle: '',
          body: '',
          match: fingerprint,
        }
      }
      if (entry.lastMatch === fingerprint) {
        return {
          status: 'unchanged',
          summary: `没有新条目（共 ${items.length} 条）`,
          notify: false,
          notifyTitle: '',
          body: '',
          match: fingerprint,
        }
      }
      const previous = new Set(entry.lastMatch.split(FEED_SEPARATOR))
      const fresh = items.filter(item => !previous.has(item.id))
      const listed = (fresh.length > 0 ? fresh : items).slice(0, 8)
      return {
        status: 'matched',
        summary: `发现 ${fresh.length} 条新内容`,
        notify: true,
        notifyTitle: `RSS 更新：${entry.title}`,
        body: [
          `订阅地址：${page.url}`,
          ...listed.map(item => `- ${item.title}${item.link.length > 0 ? `\n  ${item.link}` : ''}`),
        ].join('\n'),
        match: fingerprint,
      }
    }
    const output = (await this.options.runPrompt(entry, signal)).trim()
    if (output.length === 0) throw new Error('任务没有产生文本输出')
    return {
      status: 'ok',
      summary: `已生成结果（${output.length} 字符）`,
      notify: true,
      notifyTitle: `自动化：${entry.title}`,
      body: output,
    }
  }

  /** 命中/完成时可选发邮件；配置不完整时静默跳过。 */
  private async mail(entry: Automation, title: string, body: string): Promise<void> {
    if (!entry.email) return
    const mail = this.options.mail()
    if (!mail.enabled || !isMailConfigured(mail)) return
    try {
      await sendMail({ subject: `[SV 自动化] ${title}`, body: plainText(body) })
      this.options.log('automation_mail_sent', { automationId: entry.id })
    } catch (error) {
      this.options.log('automation_mail_failed', { automationId: entry.id, err: svError(error) })
    }
  }
}
