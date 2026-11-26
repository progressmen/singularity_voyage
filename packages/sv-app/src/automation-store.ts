/**
 * 自动化定义、调度时间与运行历史。
 *
 * 三类自动化：
 *  - web：定时抓取网页，内容哈希变化时通知；
 *  - keyword：定时抓取网页，命中关键词时通知（同一命中不重复提醒）；
 *  - prompt：定时把一句任务交给隔离 Agent 执行，结果写入收件箱。
 *
 * 调度是本地时区的轻量实现（固定间隔 / 每天 / 每周），与待办提醒一样由
 * 进程内扫描驱动；定义写 `$DSH_HOME/sv/automations.json`，
 * 运行历史写 `automation-runs.json`（都 0600、原子替换）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 自动化类型。 */
export const AUTOMATION_KINDS = ['web', 'keyword', 'prompt', 'rss'] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]

/** 类型的中文标签。 */
export const AUTOMATION_KIND_LABELS: Record<AutomationKind, string> = {
  web: '网页变化',
  keyword: '关键词监控',
  prompt: '定时任务',
  rss: 'RSS 订阅',
}

/** 调度规则。 */
export const AUTOMATION_SCHEDULE_KINDS = ['interval', 'daily', 'weekly'] as const
export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; weekday: number; at: string }

/** 一次运行的结局。 */
export const AUTOMATION_RUN_STATUSES = ['ok', 'unchanged', 'changed', 'matched', 'failed'] as const
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number]

/** 自动化定义。 */
export interface Automation {
  id: string
  title: string
  kind: AutomationKind
  enabled: boolean
  schedule: AutomationSchedule
  /** web / keyword 的目标网页。 */
  url?: string
  /** keyword 的关键词（不区分大小写）。 */
  keywords?: string[]
  /** prompt 的任务描述。 */
  prompt?: string
  /** 命中/完成后是否额外发邮件（需要邮件通道可用）。 */
  email: boolean
  /** 下一次计划运行时间（epoch ms）。 */
  nextRunAt: number
  lastRunAt?: number
  /** 上次运行摘要，页面列表直接展示。 */
  lastSummary?: string
  /** web / keyword 上次抓取内容的哈希。 */
  lastHash?: string
  /** web 上次抓取的纯文本（用于生成变化摘要；截断保存）。 */
  lastText?: string
  /** keyword 上次命中集合的指纹；相同则不重复提醒。 */
  lastMatch?: string
  createdAt: number
  updatedAt: number
}

/** 创建输入。 */
export interface AutomationCreateInput {
  title: string
  kind: AutomationKind
  schedule: AutomationSchedule
  url?: string
  keywords?: string[]
  prompt?: string
  email?: boolean
}

/** 校验后的创建/更新输入：只保留当前类型需要的可选字段。 */
interface NormalizedAutomationInput {
  title: string
  kind: AutomationKind
  schedule: AutomationSchedule
  url?: string
  keywords?: string[]
  prompt?: string
  email: boolean
}

/** 运行记录。 */
export interface AutomationRun {
  id: string
  automationId: string
  title: string
  startedAt: number
  finishedAt: number
  status: AutomationRunStatus
  summary: string
  error?: string
}

/** 页面与工具共用的视图。 */
export function automationView(entry: Automation): {
  id: string
  title: string
  kind: AutomationKind
  enabled: boolean
  schedule: AutomationSchedule
  url?: string
  keywords?: string[]
  prompt?: string
  email: boolean
  nextRunAt: number
  lastRunAt?: number
  lastSummary?: string
  createdAt: number
  updatedAt: number
} {
  return {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    enabled: entry.enabled,
    schedule: { ...entry.schedule },
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.keywords === undefined ? {} : { keywords: [...entry.keywords] }),
    ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
    email: entry.email,
    nextRunAt: entry.nextRunAt,
    ...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
    ...(entry.lastSummary === undefined ? {} : { lastSummary: entry.lastSummary }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_TITLE = 120
const MAX_URL = 2000
const MAX_PROMPT = 5000
const MAX_KEYWORDS = 10
const MAX_KEYWORD = 64
const MAX_AUTOMATIONS = 100
const MAX_RUNS = 500
const MAX_SUMMARY = 800
/** 上次抓取文本的保留上限（用于变化摘要）。 */
const MAX_TEXT_SNAPSHOT = 4000
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 7 * 24 * 60

const KIND_SET = new Set<string>(AUTOMATION_KINDS)
const STATUS_SET = new Set<string>(AUTOMATION_RUN_STATUSES)

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isKind(value: unknown): value is AutomationKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 某天的 HH:mm 对应当地时间戳。 */
function atTime(base: Date, at: string): number {
  const [hours, minutes] = at.split(':').map(value => Number(value))
  const date = new Date(base)
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  return date.getTime()
}

/** 严格晚于 from 的下一次运行时间（本地时区）。 */
export function nextRunAt(schedule: AutomationSchedule, from: number): number {
  if (schedule.kind === 'interval') return from + schedule.everyMinutes * 60_000
  if (schedule.kind === 'daily') {
    const today = atTime(new Date(from), schedule.at)
    if (today > from) return today
    const tomorrow = new Date(from)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return atTime(tomorrow, schedule.at)
  }
  const target = ((schedule.weekday % 7) + 7) % 7
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(from)
    day.setDate(day.getDate() + offset)
    const candidate = atTime(day, schedule.at)
    if (day.getDay() === target && candidate > from) return candidate
  }
  // 理论上不会走到这里（8 天内必然包含目标星期）
  return from + 7 * 24 * 60 * 60 * 1000
}

/** 校验并规范化调度规则；非法返回 undefined。 */
export function normalizeSchedule(value: AutomationSchedule): AutomationSchedule {
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.everyMinutes)
      || value.everyMinutes < MIN_INTERVAL_MINUTES
      || value.everyMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`间隔必须是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 的整数分钟`)
    }
    return { kind: 'interval', everyMinutes: value.everyMinutes }
  }
  if (value.kind === 'daily') {
    if (!TIME_RE.test(value.at)) throw new Error('每天运行时间必须是 HH:mm（如 08:30）')
    return { kind: 'daily', at: value.at }
  }
  if (value.kind === 'weekly') {
    if (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6) {
      throw new Error('每周运行必须指定星期（0=周日 … 6=周六）')
    }
    if (!TIME_RE.test(value.at)) throw new Error('每周运行时间必须是 HH:mm（如 08:30）')
    return { kind: 'weekly', weekday: value.weekday, at: value.at }
  }
  throw new Error('调度规则非法')
}

/** 校验并规范化创建/更新输入；与类型无关的字段会被丢弃。 */
function normalizeAutomationInput(input: AutomationCreateInput): NormalizedAutomationInput {
  const title = input.title.trim()
  if (title.length === 0) throw new Error('自动化标题不能为空')
  if (!isKind(input.kind)) throw new Error('自动化类型非法')
  const schedule = normalizeSchedule(input.schedule)
  const url = input.url?.trim()
  const keywords = input.keywords?.map(keyword => keyword.trim()).filter(keyword => keyword.length > 0)
  const prompt = input.prompt?.trim()

  if (input.kind === 'web' || input.kind === 'keyword' || input.kind === 'rss') {
    if (url === undefined || url.length === 0) throw new Error('监控网页必须提供 URL')
    if (url.length > MAX_URL) throw new Error('URL 过长')
    if (!isHttpUrl(url)) throw new Error('URL 必须是 http(s) 地址')
  } else if (url !== undefined && url.length > MAX_URL) {
    throw new Error('URL 过长')
  }
  if (input.kind === 'keyword') {
    if (keywords === undefined || keywords.length === 0) throw new Error('关键词监控至少提供一个关键词')
    if (keywords.length > MAX_KEYWORDS) throw new Error(`关键词最多 ${MAX_KEYWORDS} 个`)
    if (keywords.some(keyword => keyword.length > MAX_KEYWORD)) throw new Error(`单个关键词不能超过 ${MAX_KEYWORD} 字符`)
  }
  if (input.kind === 'prompt') {
    if (prompt === undefined || prompt.length === 0) throw new Error('定时任务必须填写任务描述')
    if (prompt.length > MAX_PROMPT) throw new Error(`任务描述不能超过 ${MAX_PROMPT} 字符`)
  }

  return {
    title: clip(title, MAX_TITLE),
    kind: input.kind,
    schedule,
    ...(input.kind === 'web' || input.kind === 'keyword' || input.kind === 'rss'
      ? url === undefined ? {} : { url }
      : {}),
    ...(input.kind === 'keyword' && keywords !== undefined ? { keywords: [...new Set(keywords)] } : {}),
    ...(input.kind === 'prompt' && prompt !== undefined ? { prompt } : {}),
    email: input.email === true,
  }
}

interface AutomationsFile {
  version: 1
  automations: Automation[]
}

interface RunsFile {
  version: 1
  runs: AutomationRun[]
}

export class AutomationStore {
  private entries = new Map<string, Automation>()
  private runs: AutomationRun[] = []
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get automationsFile(): string {
    return join(this.dir, 'automations.json')
  }

  private get runsFile(): string {
    return join(this.dir, 'automation-runs.json')
  }

  /** 读取定义与运行历史；损坏文件按空集合启动。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.automationsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AutomationsFile>
      if (parsed.version === 1 && Array.isArray(parsed.automations)) {
        this.entries = new Map()
        for (const item of parsed.automations) {
          const normalized = sanitizeAutomation(item)
          if (normalized !== undefined) this.entries.set(normalized.id, normalized)
        }
      }
    } catch {
      // 缺失或损坏从空开始
    }
    try {
      const raw = await readFile(this.runsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RunsFile>
      if (parsed.version === 1 && Array.isArray(parsed.runs)) {
        this.runs = parsed.runs
          .map(run => sanitizeRun(run))
          .filter((run): run is AutomationRun => run !== undefined)
          .sort((a, b) => b.finishedAt - a.finishedAt)
          .slice(0, MAX_RUNS)
      }
    } catch {
      // 缺失或损坏从空开始
    }
  }

  /** 全部自动化（新建在前）。 */
  list(): Automation[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Automation | undefined {
    return this.entries.get(id)
  }

  /** 创建自动化；nextRunAt 从当前时刻计算。 */
  async create(input: AutomationCreateInput): Promise<Automation> {
    if (this.entries.size >= MAX_AUTOMATIONS) throw new Error(`自动化数量已达上限（${MAX_AUTOMATIONS}）`)
    const normalized = normalizeAutomationInput(input)
    const now = Date.now()
    const entry: Automation = {
      id: randomUUID(),
      ...normalized,
      enabled: true,
      nextRunAt: nextRunAt(normalized.schedule, now),
      createdAt: now,
      updatedAt: now,
    }
    this.entries.set(entry.id, entry)
    await this.persistAutomations()
    return entry
  }

  /**
   * 修改自动化定义：保留启用状态与运行历史，按新调度重排下次运行。
   * 类型、URL 或关键词变化时清空旧指纹，避免用旧基线上报变化。
   */
  async update(id: string, input: AutomationCreateInput): Promise<Automation | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    const normalized = normalizeAutomationInput(input)
    const now = Date.now()
    const previousKind = entry.kind
    const previousUrl = entry.url
    const previousKeywords = entry.keywords?.join('\u0000') ?? ''
    const previousSchedule = entry.schedule
    const nextKeywords = normalized.keywords?.join('\u0000') ?? ''
    const targetChanged = previousKind !== normalized.kind
      || previousUrl !== normalized.url
      || previousKeywords !== nextKeywords
    const scheduleChanged = JSON.stringify(previousSchedule) !== JSON.stringify(normalized.schedule)

    entry.title = normalized.title
    entry.kind = normalized.kind
    entry.schedule = normalized.schedule
    entry.email = normalized.email
    delete entry.url
    delete entry.keywords
    delete entry.prompt
    if (normalized.url !== undefined) entry.url = normalized.url
    if (normalized.keywords !== undefined) entry.keywords = normalized.keywords
    if (normalized.prompt !== undefined) entry.prompt = normalized.prompt
    if (targetChanged) {
      delete entry.lastHash
      delete entry.lastText
      delete entry.lastMatch
    }
    if (scheduleChanged || entry.nextRunAt <= now) {
      entry.nextRunAt = nextRunAt(normalized.schedule, now)
    }
    entry.updatedAt = now
    await this.persistAutomations()
    return entry
  }

  /** 暂停/恢复；恢复时若已错过计划时间，从当前时刻重排，不补跑多次。 */
  async setEnabled(id: string, enabled: boolean): Promise<Automation | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    const now = Date.now()
    entry.enabled = enabled
    if (enabled && entry.nextRunAt <= now) entry.nextRunAt = nextRunAt(entry.schedule, now)
    entry.updatedAt = now
    await this.persistAutomations()
    return entry
  }

  /**
   * 记录一次运行：推进 lastRunAt / nextRunAt，并按需更新对比指纹。
   * @param hash - undefined 保持原值；null 清除；字符串写入。
   * @param match - 同上，用于关键词命中指纹。
   * @param text - web 变化对比用的上次文本快照；undefined 保持原值。
   */
  async finishRun(
    id: string,
    update: { at: number; summary: string; hash?: string | null; match?: string | null; text?: string | null },
  ): Promise<Automation | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    entry.lastRunAt = update.at
    entry.lastSummary = clip(update.summary, MAX_SUMMARY)
    entry.nextRunAt = nextRunAt(entry.schedule, update.at)
    entry.updatedAt = update.at
    if (update.hash !== undefined) {
      if (update.hash === null) delete entry.lastHash
      else entry.lastHash = update.hash
    }
    if (update.match !== undefined) {
      if (update.match === null) delete entry.lastMatch
      else entry.lastMatch = update.match
    }
    if (update.text !== undefined) {
      if (update.text === null) delete entry.lastText
      else entry.lastText = clip(update.text, MAX_TEXT_SNAPSHOT)
    }
    await this.persistAutomations()
    return entry
  }

  /** 删除自动化及其运行历史；未知 id 返回 false。 */
  async remove(id: string): Promise<boolean> {
    if (!this.entries.delete(id)) return false
    const before = this.runs.length
    this.runs = this.runs.filter(run => run.automationId !== id)
    await this.persistAutomations()
    if (this.runs.length !== before) await this.persistRuns()
    return true
  }

  /** 清空全部自动化与运行历史（隐私清空与恢复用）。 */
  async clear(): Promise<void> {
    this.entries.clear()
    this.runs = []
    await this.persistAutomations()
    await this.persistRuns()
  }

  /** 追加一条运行记录；历史总量上限 500。 */
  async recordRun(input: Omit<AutomationRun, 'id'>): Promise<AutomationRun> {
    const run: AutomationRun = { id: randomUUID(), ...input }
    this.runs.unshift(run)
    if (this.runs.length > MAX_RUNS) this.runs.splice(MAX_RUNS)
    await this.persistRuns()
    return run
  }

  /** 运行历史（按结束时间倒序）。 */
  listRuns(automationId?: string, limit = 30): AutomationRun[] {
    const filtered = automationId === undefined ? this.runs : this.runs.filter(run => run.automationId === automationId)
    return filtered.slice(0, Math.min(MAX_RUNS, Math.max(1, Math.trunc(limit))))
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persistAutomations(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: AutomationsFile = { version: 1, automations: this.list() }
      const temp = `${this.automationsFile}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.automationsFile)
    })
  }

  private async persistRuns(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: RunsFile = { version: 1, runs: this.runs }
      const temp = `${this.runsFile}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.runsFile)
    })
  }
}

function sanitizeAutomation(value: unknown): Automation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Automation>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined
  if (!isKind(record.kind)) return undefined
  let schedule: AutomationSchedule
  try {
    schedule = normalizeSchedule(record.schedule as AutomationSchedule)
  } catch {
    return undefined
  }
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
  const next = typeof record.nextRunAt === 'number' && Number.isFinite(record.nextRunAt)
    ? record.nextRunAt
    : nextRunAt(schedule, Date.now())
  const url = typeof record.url === 'string' && record.url.length > 0 ? record.url : undefined
  const keywords = Array.isArray(record.keywords)
    ? record.keywords.filter((keyword): keyword is string => typeof keyword === 'string' && keyword.length > 0).slice(0, MAX_KEYWORDS)
    : undefined
  return {
    id: record.id,
    title: clip(record.title.trim(), MAX_TITLE),
    kind: record.kind,
    enabled: record.enabled !== false,
    schedule,
    ...(url === undefined ? {} : { url }),
    ...(keywords === undefined || keywords.length === 0 ? {} : { keywords }),
    ...(typeof record.prompt === 'string' && record.prompt.length > 0 ? { prompt: clip(record.prompt, MAX_PROMPT) } : {}),
    email: record.email === true,
    nextRunAt: next,
    ...(typeof record.lastRunAt === 'number' && Number.isFinite(record.lastRunAt) ? { lastRunAt: record.lastRunAt } : {}),
    ...(typeof record.lastSummary === 'string' && record.lastSummary.length > 0 ? { lastSummary: clip(record.lastSummary, MAX_SUMMARY) } : {}),
    ...(typeof record.lastHash === 'string' && record.lastHash.length > 0 ? { lastHash: record.lastHash } : {}),
    ...(typeof record.lastText === 'string' && record.lastText.length > 0 ? { lastText: clip(record.lastText, MAX_TEXT_SNAPSHOT) } : {}),
    ...(typeof record.lastMatch === 'string' && record.lastMatch.length > 0 ? { lastMatch: record.lastMatch } : {}),
    createdAt,
    updatedAt,
  }
}

function sanitizeRun(value: unknown): AutomationRun | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<AutomationRun>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.automationId !== 'string' || record.automationId.length === 0) return undefined
  if (!isRunStatus(record.status)) return undefined
  const startedAt = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : Date.now()
  const finishedAt = typeof record.finishedAt === 'number' && Number.isFinite(record.finishedAt) ? record.finishedAt : startedAt
  return {
    id: record.id,
    automationId: record.automationId,
    title: typeof record.title === 'string' && record.title.length > 0 ? clip(record.title, MAX_TITLE) : '自动化',
    startedAt,
    finishedAt,
    status: record.status,
    summary: typeof record.summary === 'string' ? clip(record.summary, MAX_SUMMARY) : '',
    ...(typeof record.error === 'string' && record.error.length > 0 ? { error: clip(record.error, MAX_SUMMARY) } : {}),
  }
}
