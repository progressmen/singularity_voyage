/**
 * 只读连接器与统一事件流。
 *
 * 连接器定义写 `$DSH_HOME/sv/connectors.json`，抓取到的事件写
 * `connector-events.json`（0600、原子替换）。当前全部是只读接入：
 * 邮件、日历、Slack、Notion、RSS/Atom；不会代表用户发送或修改任何内容。
 *
 * 事件按 `connectorId + key` 去重，最多保留 5000 条；列表按发生时间倒序。
 * 凭据只保存在本机数据目录，列表视图会剔除 token / secret 字段，只返回
 * 「已配置」标记。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 支持的只读连接器类型。 */
export const CONNECTOR_KINDS = ['ics', 'rss', 'slack', 'notion', 'gmail', 'gcal', 'outlook'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** 类型标签。 */
export const CONNECTOR_KIND_LABELS: Record<ConnectorKind, string> = {
  ics: '日历订阅 (ICS)',
  rss: 'RSS / Atom',
  slack: 'Slack',
  notion: 'Notion',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  outlook: 'Outlook (Graph)',
}

/** 事件类型。 */
export const CONNECTOR_EVENT_KINDS = ['message', 'event', 'page', 'post'] as const
export type ConnectorEventKind = (typeof CONNECTOR_EVENT_KINDS)[number]

/** 连接器设置值。 */
export type ConnectorSetting = string | number | boolean

/** 一个只读连接器。 */
export interface Connector {
  id: string
  kind: ConnectorKind
  name: string
  enabled: boolean
  /** 自动同步间隔（分钟）。 */
  everyMinutes: number
  /** 首次同步回溯天数。 */
  initialDays: number
  settings: Record<string, ConnectorSetting>
  /** 增量游标（各适配器自定义，通常是 JSON 字符串）。 */
  cursor?: string
  lastSyncAt?: number
  lastError?: string
  lastAdded?: number
  createdAt: number
  updatedAt: number
}

/** 创建输入。 */
export interface ConnectorCreateInput {
  kind: ConnectorKind
  name: string
  settings: Record<string, unknown>
  everyMinutes?: number
  initialDays?: number
}

/** 适配器产出的原始事件（尚未分配 id / 去重键前缀）。 */
export interface ConnectorEventDraft {
  /** 来源内的稳定 id（Gmail message id、Slack ts、日历 UID 等）。 */
  externalId: string
  kind: ConnectorEventKind
  title: string
  body: string
  url?: string
  author?: string
  occurredAt: number
  /** 去重键（同一连接器内唯一）。 */
  key: string
}

/** 入库后的事件。 */
export interface ConnectorEvent {
  id: string
  connectorId: string
  connectorName: string
  source: ConnectorKind
  externalId: string
  kind: ConnectorEventKind
  title: string
  body: string
  url?: string
  author?: string
  occurredAt: number
  fetchedAt: number
  key: string
  readAt?: number
}

/** 列表脱敏视图。 */
export interface ConnectorView extends Omit<Connector, 'settings' | 'cursor'> {
  settings: Record<string, ConnectorSetting>
  /** 已配置但被隐藏的密钥字段名。 */
  configuredSecrets: string[]
}

const SECRET_KEYS = new Set(['token', 'clientSecret', 'refreshToken', 'password', 'apiKey'])
const KIND_SET = new Set<string>(CONNECTOR_KINDS)
const EVENT_KIND_SET = new Set<string>(CONNECTOR_EVENT_KINDS)
const MAX_CONNECTORS = 30
const MAX_EVENTS = 5000
const MAX_NAME = 80
const MAX_SETTING_KEYS = 30
const MAX_SETTING_STRING = 4000
const MIN_EVERY_MINUTES = 5
const MAX_EVERY_MINUTES = 7 * 24 * 60
const MIN_INITIAL_DAYS = 1
const MAX_INITIAL_DAYS = 30
const MAX_TITLE = 200
const MAX_BODY = 5000
const MAX_URL = 2000

const REQUIRED_SETTINGS: Record<ConnectorKind, readonly string[]> = {
  ics: ['url'],
  rss: ['url'],
  slack: ['token'],
  notion: ['token'],
  gmail: ['clientId', 'clientSecret', 'refreshToken'],
  gcal: ['clientId', 'clientSecret', 'refreshToken'],
  outlook: ['clientId', 'clientSecret', 'refreshToken'],
}

interface ConnectorsFile {
  version: 1
  connectors: Connector[]
}

interface EventsFile {
  version: 1
  events: ConnectorEvent[]
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function isEventKind(value: unknown): value is ConnectorEventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeSettings(value: unknown): Record<string, ConnectorSetting> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('settings 必须是对象')
  const out: Record<string, ConnectorSetting> = {}
  let count = 0
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().slice(0, 40)
    if (key.length === 0) continue
    if (++count > MAX_SETTING_KEYS) throw new Error(`连接器设置项不能超过 ${MAX_SETTING_KEYS} 个`)
    if (typeof rawValue === 'string') out[key] = clip(rawValue.trim(), MAX_SETTING_STRING)
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) out[key] = rawValue
    else if (typeof rawValue === 'boolean') out[key] = rawValue
  }
  return out
}

function validateSettings(kind: ConnectorKind, settings: Record<string, ConnectorSetting>): void {
  for (const key of REQUIRED_SETTINGS[kind]) {
    const value = settings[key]
    if (value === undefined || String(value).trim().length === 0) throw new Error(`${CONNECTOR_KIND_LABELS[kind]} 缺少 ${key}`)
  }
  if (kind === 'ics' || kind === 'rss') {
    const url = String(settings.url ?? '')
    if (!isHttpUrl(url)) throw new Error('URL 必须是 http(s) 地址')
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 脱敏视图：密钥字段不出现在响应里。 */
export function connectorView(connector: Connector): ConnectorView {
  const settings: Record<string, ConnectorSetting> = {}
  const configuredSecrets: string[] = []
  for (const [key, value] of Object.entries(connector.settings)) {
    if (SECRET_KEYS.has(key)) {
      if (String(value).length > 0) configuredSecrets.push(key)
      continue
    }
    settings[key] = value
  }
  return {
    id: connector.id,
    kind: connector.kind,
    name: connector.name,
    enabled: connector.enabled,
    everyMinutes: connector.everyMinutes,
    initialDays: connector.initialDays,
    settings,
    configuredSecrets,
    ...(connector.lastSyncAt === undefined ? {} : { lastSyncAt: connector.lastSyncAt }),
    ...(connector.lastError === undefined ? {} : { lastError: connector.lastError }),
    ...(connector.lastAdded === undefined ? {} : { lastAdded: connector.lastAdded }),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  }
}

/** 事件视图（只读）。 */
export function connectorEventView(event: ConnectorEvent): ConnectorEvent {
  return { ...event }
}

export class ConnectorStore {
  private connectors = new Map<string, Connector>()
  private events: ConnectorEvent[] = []
  private keys = new Set<string>()
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get connectorsFile(): string {
    return join(this.dir, 'connectors.json')
  }

  private get eventsFile(): string {
    return join(this.dir, 'connector-events.json')
  }

  /** 读取连接器与事件；损坏文件按空集合启动。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.connectorsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ConnectorsFile>
      if (parsed.version === 1 && Array.isArray(parsed.connectors)) {
        this.connectors = new Map()
        for (const item of parsed.connectors) {
          const normalized = sanitizeConnector(item)
          if (normalized !== undefined) this.connectors.set(normalized.id, normalized)
        }
      }
    } catch {
      // 缺失或损坏从空开始
    }
    try {
      const raw = await readFile(this.eventsFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<EventsFile>
      if (parsed.version === 1 && Array.isArray(parsed.events)) {
        this.events = parsed.events
          .map(sanitizeEvent)
          .filter((event): event is ConnectorEvent => event !== undefined)
          .sort((a, b) => b.occurredAt - a.occurredAt)
          .slice(0, MAX_EVENTS)
        this.keys = new Set(this.events.map(event => event.key))
      }
    } catch {
      // 缺失或损坏从空开始
    }
  }

  /** 全部连接器（新建在前）。 */
  listConnectors(): Connector[] {
    return [...this.connectors.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getConnector(id: string): Connector | undefined {
    return this.connectors.get(id)
  }

  /** 创建连接器并返回定义。 */
  async create(input: ConnectorCreateInput): Promise<Connector> {
    if (this.connectors.size >= MAX_CONNECTORS) throw new Error(`连接器数量已达上限（${MAX_CONNECTORS}）`)
    if (!isKind(input.kind)) throw new Error('连接器类型非法')
    const name = clip(input.name.trim() || CONNECTOR_KIND_LABELS[input.kind], MAX_NAME)
    const settings = normalizeSettings(input.settings)
    validateSettings(input.kind, settings)
    const now = Date.now()
    const everyMinutes = clampInt(input.everyMinutes ?? 15, MIN_EVERY_MINUTES, MAX_EVERY_MINUTES)
    const initialDays = clampInt(input.initialDays ?? 7, MIN_INITIAL_DAYS, MAX_INITIAL_DAYS)
    const connector: Connector = {
      id: randomUUID(),
      kind: input.kind,
      name,
      enabled: true,
      everyMinutes,
      initialDays,
      settings,
      createdAt: now,
      updatedAt: now,
    }
    this.connectors.set(connector.id, connector)
    await this.persistConnectors()
    return connector
  }

  /** 暂停/恢复，或调整同步频率。 */
  async update(id: string, patch: { enabled?: boolean; everyMinutes?: number; initialDays?: number; name?: string }): Promise<Connector | undefined> {
    const connector = this.connectors.get(id)
    if (connector === undefined) return undefined
    if (patch.enabled !== undefined) connector.enabled = patch.enabled
    if (patch.everyMinutes !== undefined) {
      connector.everyMinutes = clampInt(patch.everyMinutes, MIN_EVERY_MINUTES, MAX_EVERY_MINUTES)
    }
    if (patch.initialDays !== undefined) {
      connector.initialDays = clampInt(patch.initialDays, MIN_INITIAL_DAYS, MAX_INITIAL_DAYS)
    }
    if (patch.name !== undefined && patch.name.trim().length > 0) connector.name = clip(patch.name.trim(), MAX_NAME)
    connector.updatedAt = Date.now()
    await this.persistConnectors()
    return connector
  }

  /** 删除连接器及其事件。 */
  async remove(id: string): Promise<boolean> {
    if (!this.connectors.delete(id)) return false
    const before = this.events.length
    this.events = this.events.filter(event => event.connectorId !== id)
    this.keys = new Set(this.events.map(event => event.key))
    await this.persistConnectors()
    if (this.events.length !== before) await this.persistEvents()
    return true
  }

  /** 记录一次同步结果（成功或失败）。 */
  async finishSync(id: string, update: { at: number; cursor?: string; error?: string; added?: number }): Promise<Connector | undefined> {
    const connector = this.connectors.get(id)
    if (connector === undefined) return undefined
    connector.lastSyncAt = update.at
    connector.updatedAt = update.at
    if (update.cursor !== undefined) connector.cursor = update.cursor
    if (update.added !== undefined) connector.lastAdded = update.added
    if (update.error === undefined) delete connector.lastError
    else connector.lastError = clip(update.error, 1000)
    await this.persistConnectors()
    return connector
  }

  /** 把适配器事件写入事件流；按 key 去重，返回新增的事件。 */
  async ingest(connector: Connector, drafts: readonly ConnectorEventDraft[], now = Date.now()): Promise<ConnectorEvent[]> {
    const added: ConnectorEvent[] = []
    for (const draft of drafts) {
      const key = `${connector.id}:${draft.key}`
      if (this.keys.has(key)) continue
      this.keys.add(key)
      const event: ConnectorEvent = {
        id: randomUUID(),
        connectorId: connector.id,
        connectorName: connector.name,
        source: connector.kind,
        externalId: clip(draft.externalId, 500),
        kind: isEventKind(draft.kind) ? draft.kind : 'message',
        title: clip(draft.title.trim() || '（无标题）', MAX_TITLE),
        body: clip(draft.body.trim(), MAX_BODY),
        ...(draft.url === undefined || draft.url.length === 0 ? {} : { url: clip(draft.url, MAX_URL) }),
        ...(draft.author === undefined || draft.author.length === 0 ? {} : { author: clip(draft.author, MAX_TITLE) }),
        occurredAt: Number.isFinite(draft.occurredAt) ? draft.occurredAt : now,
        fetchedAt: now,
        key,
      }
      added.push(event)
    }
    if (added.length === 0) return []
    this.events = [...added, ...this.events].sort((a, b) => b.occurredAt - a.occurredAt)
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(MAX_EVENTS)
      this.keys = new Set(this.events.map(event => event.key))
    }
    await this.persistEvents()
    return added
  }

  /** 事件列表：来源 / 未读 / 关键词过滤。 */
  listEvents(options: { source?: ConnectorKind; unreadOnly?: boolean; query?: string; limit?: number } = {}): ConnectorEvent[] {
    let result = this.events
    if (options.source !== undefined) result = result.filter(event => event.source === options.source)
    if (options.unreadOnly === true) result = result.filter(event => event.readAt === undefined)
    const query = (options.query ?? '').trim().toLowerCase()
    if (query.length > 0) {
      result = result.filter(event => `${event.title}\n${event.body}\n${event.author ?? ''}`.toLowerCase().includes(query))
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)))
    return result.slice(0, limit)
  }

  unreadCount(source?: ConnectorKind): number {
    return this.events.reduce((count, event) => {
      if (source !== undefined && event.source !== source) return count
      return count + (event.readAt === undefined ? 1 : 0)
    }, 0)
  }

  /** 标记单条已读。 */
  async markRead(id: string): Promise<ConnectorEvent | undefined> {
    const event = this.events.find(item => item.id === id)
    if (event === undefined || event.readAt !== undefined) return event
    event.readAt = Date.now()
    await this.persistEvents()
    return event
  }

  /** 标记全部已读（可按来源）。 */
  async markAllRead(source?: ConnectorKind): Promise<number> {
    const now = Date.now()
    let count = 0
    for (const event of this.events) {
      if (event.readAt !== undefined) continue
      if (source !== undefined && event.source !== source) continue
      event.readAt = now
      count += 1
    }
    if (count > 0) await this.persistEvents()
    return count
  }

  /** 清空事件流（可按来源）。 */
  async clearEvents(source?: ConnectorKind): Promise<number> {
    const before = this.events.length
    this.events = source === undefined ? [] : this.events.filter(event => event.source !== source)
    this.keys = new Set(this.events.map(event => event.key))
    const removed = before - this.events.length
    if (removed > 0) await this.persistEvents()
    return removed
  }

  /** 清空连接器与事件（恢复/清空用）。 */
  async clear(): Promise<void> {
    this.connectors.clear()
    this.events = []
    this.keys.clear()
    await this.persistConnectors()
    await this.persistEvents()
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private persistConnectors(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: ConnectorsFile = { version: 1, connectors: this.listConnectors() }
      const temp = `${this.connectorsFile}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.connectorsFile)
    })
  }

  private persistEvents(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: EventsFile = { version: 1, events: this.events }
      const temp = `${this.eventsFile}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.eventsFile)
    })
  }
}

function sanitizeConnector(value: unknown): Connector | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Connector>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (!isKind(record.kind)) return undefined
  if (typeof record.name !== 'string' || record.name.trim().length === 0) return undefined
  let settings: Record<string, ConnectorSetting>
  try {
    settings = normalizeSettings(record.settings)
  } catch {
    return undefined
  }
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
  return {
    id: record.id,
    kind: record.kind,
    name: clip(record.name.trim(), MAX_NAME),
    enabled: record.enabled !== false,
    everyMinutes: clampInt(typeof record.everyMinutes === 'number' ? record.everyMinutes : 15, MIN_EVERY_MINUTES, MAX_EVERY_MINUTES),
    initialDays: clampInt(typeof record.initialDays === 'number' ? record.initialDays : 7, MIN_INITIAL_DAYS, MAX_INITIAL_DAYS),
    settings,
    ...(typeof record.cursor === 'string' && record.cursor.length > 0 ? { cursor: record.cursor } : {}),
    ...(typeof record.lastSyncAt === 'number' && Number.isFinite(record.lastSyncAt) ? { lastSyncAt: record.lastSyncAt } : {}),
    ...(typeof record.lastError === 'string' && record.lastError.length > 0 ? { lastError: clip(record.lastError, 1000) } : {}),
    ...(typeof record.lastAdded === 'number' && Number.isFinite(record.lastAdded) ? { lastAdded: record.lastAdded } : {}),
    createdAt,
    updatedAt,
  }
}

function sanitizeEvent(value: unknown): ConnectorEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<ConnectorEvent>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.connectorId !== 'string' || record.connectorId.length === 0) return undefined
  if (!isKind(record.source)) return undefined
  if (!isEventKind(record.kind)) return undefined
  if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined
  if (typeof record.key !== 'string' || record.key.length === 0) return undefined
  return {
    id: record.id,
    connectorId: record.connectorId,
    connectorName: typeof record.connectorName === 'string' && record.connectorName.length > 0 ? clip(record.connectorName, MAX_NAME) : CONNECTOR_KIND_LABELS[record.source],
    source: record.source,
    externalId: typeof record.externalId === 'string' ? clip(record.externalId, 500) : '',
    kind: record.kind,
    title: clip(record.title.trim(), MAX_TITLE),
    body: typeof record.body === 'string' ? clip(record.body, MAX_BODY) : '',
    ...(typeof record.url === 'string' && record.url.length > 0 ? { url: clip(record.url, MAX_URL) } : {}),
    ...(typeof record.author === 'string' && record.author.length > 0 ? { author: clip(record.author, MAX_TITLE) } : {}),
    occurredAt: typeof record.occurredAt === 'number' && Number.isFinite(record.occurredAt) ? record.occurredAt : Date.now(),
    fetchedAt: typeof record.fetchedAt === 'number' && Number.isFinite(record.fetchedAt) ? record.fetchedAt : Date.now(),
    key: record.key,
    ...(typeof record.readAt === 'number' && Number.isFinite(record.readAt) ? { readAt: record.readAt } : {}),
  }
}
