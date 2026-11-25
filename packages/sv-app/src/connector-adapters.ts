/**
 * 只读连接器适配器。
 *
 * 每个适配器只拉取最近一段数据并转换成统一事件；不写回任何外部服务。
 * 网络请求全部通过注入的 fetch（生产环境用全局 fetch），便于测试与替换。
 *
 * 支持：
 *  - ICS：Google / Outlook 发布的日历订阅地址（无需 OAuth）；
 *  - RSS / Atom；
 *  - Slack：User / Bot Token，读取频道历史；
 *  - Notion：Integration Token，搜索页面或查询数据库；
 *  - Gmail：Google OAuth refresh token，读取邮件元数据；
 *  - Google Calendar：Google OAuth refresh token，读取未来 30 天日程；
 *  - Outlook：Microsoft Graph refresh token，读取邮件或日历。
 */
import type { Connector, ConnectorEventDraft, ConnectorKind, ConnectorSetting } from './connector-store.ts'
import { CONNECTOR_KIND_LABELS } from './connector-store.ts'

/** 注入的 fetch 形状。 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 一次同步的上下文。 */
export interface SyncContext {
  fetch: FetchLike
  signal: AbortSignal
  now: number
  /** 本次最多取多少条（测试/预览用）；缺省按各适配器默认值。 */
  maxItems?: number
}

/** 同步结果。 */
export interface SyncResult {
  events: ConnectorEventDraft[]
  cursor?: string
  note?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function settingsString(connector: Connector, key: string, fallback = ''): string {
  const value = connector.settings[key]
  return typeof value === 'string' ? value.trim() : fallback
}

function limitOf(context: SyncContext, fallback: number): number {
  return Math.max(1, Math.min(fallback, Math.trunc(context.maxItems ?? fallback)))
}

function sinceOf(connector: Connector, now: number): number {
  const days = Math.max(1, Math.min(30, connector.initialDays || 7))
  return connector.lastSyncAt ?? now - days * DAY_MS
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
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

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  const res = await fetchImpl(url, { ...init, signal })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    parsed = undefined
  }
  if (!res.ok) {
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const error = record.error
    const detail = typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
        ? String((error as { message?: unknown }).message)
        : text.trim().slice(0, 300)
    throw new Error(`${label} 失败：HTTP ${res.status}${detail.length > 0 ? `（${detail}）` : ''}`)
  }
  return parsed as T
}

async function requestText(
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  const res = await fetchImpl(url, { signal })
  if (!res.ok) throw new Error(`${label} 失败：HTTP ${res.status}`)
  return await res.text()
}

/* ── ICS ─────────────────────────────────────────────── */

function unescapeIcs(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function parseIcsDate(value: string): number | undefined {
  const raw = value.trim()
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw)
  if (dateTime !== null) {
    const [, y, mo, d, h, mi, s, z] = dateTime
    const ms = z === 'Z'
      ? Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
  if (dateOnly !== null) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 解析 ICS 中的 VEVENT（不展开 RRULE，只取单次日程）。 */
export function parseIcsEvents(text: string, options: { since: number; now: number; max?: number; sourceUrl?: string }): ConnectorEventDraft[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '')
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)]
  const out: ConnectorEventDraft[] = []
  for (const match of blocks) {
    const body = match[1] ?? ''
    const lines = body.split('\n')
    const get = (name: string): string | undefined => {
      for (const line of lines) {
        if (line.startsWith(`${name}:`)) return line.slice(name.length + 1)
        if (line.startsWith(`${name};`)) {
          const colon = line.indexOf(':')
          if (colon > 0) return line.slice(colon + 1)
        }
      }
      return undefined
    }
    const start = parseIcsDate(get('DTSTART') ?? '')
    if (start === undefined || start < options.since) continue
    const end = parseIcsDate(get('DTEND') ?? get('DURATION') ?? '')
    const summary = unescapeIcs(get('SUMMARY') ?? '').trim() || '（无标题日程）'
    const location = unescapeIcs(get('LOCATION') ?? '').trim()
    const description = unescapeIcs(get('DESCRIPTION') ?? '').trim()
    const uid = (get('UID') ?? '').trim() || `${start}-${summary}`
    const url = ((get('URL') ?? '').trim() || (options.sourceUrl ?? '')).trim()
    const when = end !== undefined
      ? `${new Date(start).toLocaleString('zh-CN')} – ${new Date(end).toLocaleString('zh-CN')}`
      : new Date(start).toLocaleString('zh-CN')
    out.push({
      externalId: uid,
      kind: 'event',
      title: summary,
      body: [`时间：${when}`, ...location.length > 0 ? [`地点：${location}`] : [], ...description.length > 0 ? ['', clip(description, 2000)] : []].join('\n'),
      ...(url.length > 0 ? { url } : {}),
      occurredAt: start,
      key: `ics:${uid}:${start}`,
    })
    if (out.length >= (options.max ?? 30)) break
  }
  return out.sort((a, b) => a.occurredAt - b.occurredAt)
}

/* ── RSS / Atom ──────────────────────────────────────── */

function extractTag(raw: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(raw)
  if (match === null) return ''
  return decodeEntities(match[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 解析 RSS / Atom 条目（标题、链接、摘要与发布时间）。 */
export function parseRssEvents(text: string, now: number, max = 20): ConnectorEventDraft[] {
  const out: ConnectorEventDraft[] = []
  for (const match of text.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const raw = match[0]
    const title = extractTag(raw, 'title') || '(无标题)'
    const link = extractTag(raw, 'link') || /<link[^>]*href="([^"]+)"/i.exec(raw)?.[1]?.trim() || ''
    const id = extractTag(raw, 'guid') || extractTag(raw, 'id') || link || title
    const summary = extractTag(raw, 'description') || extractTag(raw, 'summary') || extractTag(raw, 'content')
    const dateText = extractTag(raw, 'pubDate') || extractTag(raw, 'published') || extractTag(raw, 'updated')
    const parsed = Date.parse(dateText)
    const occurredAt = Number.isFinite(parsed) ? parsed : now
    out.push({
      externalId: id,
      kind: 'post',
      title,
      body: summary || link,
      ...(link.length > 0 ? { url: link } : {}),
      occurredAt,
      key: `rss:${id}`,
    })
    if (out.length >= max) break
  }
  return out.sort((a, b) => b.occurredAt - a.occurredAt)
}

/* ── Slack ───────────────────────────────────────────── */

interface SlackResponse {
  ok?: boolean
  error?: string
  url?: string
  channels?: Array<{ id?: string; name?: string; is_member?: boolean }>
  messages?: Array<{ ts?: string; text?: string; user?: string; subtype?: string }>
  [key: string]: unknown
}

async function slackApi(
  context: SyncContext,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<SlackResponse> {
  // Slack Web API 对多数方法仍以表单编码最稳，避免 JSON body 的兼容性差异。
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value))
  }
  const json = await requestJson<SlackResponse>(
    context.fetch,
    `https://slack.com/api/${method}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    context.signal,
    'Slack',
  )
  if (json.ok !== true) throw new Error(`Slack ${method} 失败：${json.error ?? 'unknown_error'}`)
  return json
}

/** 解析一条 Slack 消息。 */
export function parseSlackMessage(
  channel: { id: string; name: string },
  message: { ts?: string; text?: string; user?: string; subtype?: string },
  workspaceUrl: string,
): ConnectorEventDraft | undefined {
  const ts = message.ts ?? ''
  const text = message.text ?? ''
  if (ts.length === 0 || text.trim().length === 0) return undefined
  if (message.subtype === 'channel_join' || message.subtype === 'channel_leave') return undefined
  const occurredAt = Number(ts) * 1000
  if (!Number.isFinite(occurredAt)) return undefined
  const firstLine = text.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '（无文本）'
  const permalink = workspaceUrl.length > 0
    ? `${workspaceUrl.replace(/\/+$/, '')}archives/${channel.id}/p${ts.replace('.', '')}`
    : undefined
  return {
    externalId: `${channel.id}:${ts}`,
    kind: 'message',
    title: `#${channel.name} · ${clip(firstLine, 120)}`,
    body: [`频道：#${channel.name}`, ...message.user === undefined ? [] : [`发送者：${message.user}`], '', text].join('\n'),
    ...(permalink === undefined ? {} : { url: permalink }),
    ...(message.user === undefined ? {} : { author: message.user }),
    occurredAt,
    key: `slack:${channel.id}:${ts}`,
  }
}

async function syncSlack(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const token = settingsString(connector, 'token')
  if (token.length === 0) throw new Error('Slack 缺少 token')
  const auth = await slackApi(context, token, 'auth.test', {})
  const workspaceUrl = typeof auth.url === 'string' ? auth.url : ''
  const listing = await slackApi(context, token, 'conversations.list', {
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  })
  const all = (listing.channels ?? []).filter(channel => typeof channel.id === 'string' && typeof channel.name === 'string')
  const requested = settingsString(connector, 'channels')
    .split(/[,，\n]/)
    .map(item => item.trim().replace(/^#/, ''))
    .filter(item => item.length > 0)
  let channels = requested.length > 0
    ? requested.map(name => all.find(channel => channel.id === name || channel.name === name)).filter((channel): channel is NonNullable<typeof channel> => channel !== undefined)
    : all.filter(channel => channel.is_member !== false).slice(0, 10)
  if (channels.length === 0) channels = all.slice(0, 5)
  if (channels.length === 0) throw new Error('Slack 没有可用频道（请确认 token 权限）')

  const since = sinceOf(connector, context.now)
  let cursor: Record<string, string> = {}
  try {
    const parsed: unknown = connector.cursor === undefined ? {} : JSON.parse(connector.cursor)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') cursor[key] = value
      }
    }
  } catch {
    cursor = {}
  }
  const nextCursor: Record<string, string> = { ...cursor }
  const events: ConnectorEventDraft[] = []
  const perChannel = limitOf(context, 50)
  for (const channel of channels) {
    const id = channel.id as string
    const name = channel.name as string
    const oldest = cursor[id] ?? String(Math.floor(since / 1000))
    const history = await slackApi(context, token, 'conversations.history', {
      channel: id,
      oldest,
      limit: perChannel,
      inclusive: false,
    })
    let maxTs = oldest
    for (const message of history.messages ?? []) {
      const event = parseSlackMessage({ id, name }, message, workspaceUrl)
      if (event === undefined) continue
      events.push(event)
      const ts = message.ts ?? ''
      if (ts.length > 0 && Number(ts) > Number(maxTs)) maxTs = ts
    }
    nextCursor[id] = maxTs
  }
  return {
    events: events.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limitOf(context, 100)),
    cursor: JSON.stringify(nextCursor),
    note: `${channels.length} 个频道`,
  }
}

/* ── Notion ──────────────────────────────────────────── */

type NotionRichText = Array<{ plain_text?: string }>

function richTextText(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return (items as NotionRichText).map(item => typeof item?.plain_text === 'string' ? item.plain_text : '').join('').trim()
}

function notionPropertyText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  const type = String(record.type ?? '')
  if (type === 'title') return richTextText(record.title)
  if (type === 'rich_text') return richTextText(record.rich_text)
  if (type === 'select') return typeof (record.select as { name?: unknown } | null)?.name === 'string' ? String((record.select as { name: string }).name) : ''
  if (type === 'status') return typeof (record.status as { name?: unknown } | null)?.name === 'string' ? String((record.status as { name: string }).name) : ''
  if (type === 'multi_select') {
    return Array.isArray(record.multi_select)
      ? record.multi_select.map(item => typeof item?.name === 'string' ? item.name : '').filter(Boolean).join('、')
      : ''
  }
  if (type === 'date') {
    const date = record.date as { start?: unknown; end?: unknown } | null
    if (date === null || date === undefined) return ''
    return [date.start, date.end].filter(value => typeof value === 'string').join(' – ')
  }
  if (type === 'number') return typeof record.number === 'number' ? String(record.number) : ''
  if (type === 'checkbox') return record.checkbox === true ? '是' : '否'
  if (type === 'url' || type === 'email' || type === 'phone_number') return typeof record[type] === 'string' ? String(record[type]) : ''
  if (type === 'people') {
    return Array.isArray(record.people)
      ? record.people.map(person => typeof person?.name === 'string' ? person.name : '').filter(Boolean).join('、')
      : ''
  }
  if (type === 'created_time' || type === 'last_edited_time') return typeof record[type] === 'string' ? String(record[type]) : ''
  return ''
}

/** 解析 Notion 搜索/数据库查询结果。 */
export function parseNotionPages(results: unknown[], now: number): ConnectorEventDraft[] {
  const out: ConnectorEventDraft[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const page = item as Record<string, unknown>
    const id = typeof page.id === 'string' ? page.id : ''
    if (id.length === 0) continue
    const object = String(page.object ?? 'page')
    const properties = typeof page.properties === 'object' && page.properties !== null
      ? page.properties as Record<string, unknown>
      : {}
    let title = ''
    const lines: string[] = []
    for (const [name, value] of Object.entries(properties)) {
      const text = notionPropertyText(value)
      if (text.length === 0) continue
      const type = typeof value === 'object' && value !== null ? String((value as { type?: unknown }).type ?? '') : ''
      if (type === 'title') title = text
      lines.push(`${name}：${text}`)
    }
    if (title.length === 0) {
      const pageTitle = page.title
      title = Array.isArray(pageTitle) ? richTextText(pageTitle) : ''
    }
    if (title.length === 0) title = object === 'database' ? '（未命名数据库）' : '（无标题页面）'
    const edited = typeof page.last_edited_time === 'string' ? Date.parse(page.last_edited_time) : Number.NaN
    const occurredAt = Number.isFinite(edited) ? edited : now
    out.push({
      externalId: id,
      kind: 'page',
      title,
      body: clip(lines.join('\n') || String(page.url ?? ''), 3000),
      ...(typeof page.url === 'string' && page.url.length > 0 ? { url: page.url } : {}),
      occurredAt,
      key: `notion:${id}:${String(page.last_edited_time ?? '')}`,
    })
  }
  return out.sort((a, b) => b.occurredAt - a.occurredAt)
}

async function syncNotion(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const token = settingsString(connector, 'token')
  if (token.length === 0) throw new Error('Notion 缺少 token')
  const databaseId = settingsString(connector, 'databaseId')
  const query = settingsString(connector, 'query')
  const size = limitOf(context, 20)
  const url = databaseId.length > 0
    ? `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`
    : 'https://api.notion.com/v1/search'
  const body = databaseId.length > 0
    ? { page_size: size, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }
    : { page_size: size, sort: { direction: 'descending', timestamp: 'last_edited_time' }, ...(query.length > 0 ? { query } : {}) }
  const json = await requestJson<{ results?: unknown[] }>(
    context.fetch,
    url,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
        'notion-version': '2022-06-28',
      },
      body: JSON.stringify(body),
    },
    context.signal,
    'Notion',
  )
  const events = parseNotionPages(Array.isArray(json.results) ? json.results : [], context.now)
  return { events, note: databaseId.length > 0 ? '数据库查询' : '工作区搜索' }
}

/* ── Google OAuth（Gmail / Calendar） ─────────────────── */

async function googleAccessToken(connector: Connector, context: SyncContext): Promise<string> {
  const clientId = settingsString(connector, 'clientId')
  const clientSecret = settingsString(connector, 'clientSecret')
  const refreshToken = settingsString(connector, 'refreshToken')
  if (clientId.length === 0 || clientSecret.length === 0 || refreshToken.length === 0) {
    throw new Error('Google OAuth 缺少 clientId / clientSecret / refreshToken')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const json = await requestJson<{ access_token?: string; error_description?: string }>(
    context.fetch,
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    context.signal,
    'Google OAuth',
  )
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error(`Google OAuth 未返回 access_token${json.error_description === undefined ? '' : `：${json.error_description}`}`)
  }
  return json.access_token
}

interface GmailHeader { name?: string; value?: string }
interface GmailMessage {
  id?: string
  internalDate?: string
  snippet?: string
  payload?: { headers?: GmailHeader[] }
}

/** 解析 Gmail messages.get 的元数据。 */
export function parseGmailMessage(message: GmailMessage, now: number): ConnectorEventDraft | undefined {
  const id = message.id ?? ''
  if (id.length === 0) return undefined
  const headers = message.payload?.headers ?? []
  const header = (name: string): string => {
    const found = headers.find(item => String(item.name ?? '').toLowerCase() === name.toLowerCase())
    return String(found?.value ?? '').trim()
  }
  const internal = Number(message.internalDate)
  const occurredAt = Number.isFinite(internal) && internal > 0 ? internal : now
  const subject = header('Subject') || '(无主题)'
  const from = header('From')
  return {
    externalId: id,
    kind: 'message',
    title: subject,
    body: [`发件人：${from || '未知'}`, '', clip(message.snippet ?? '', 2000)].join('\n'),
    ...(from.length > 0 ? { author: from } : {}),
    url: `https://mail.google.com/mail/u/0/#all/${id}`,
    occurredAt,
    key: `gmail:${id}`,
  }
}

async function syncGmail(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const token = await googleAccessToken(connector, context)
  const since = sinceOf(connector, context.now)
  const userQuery = settingsString(connector, 'query')
  const parts = [...userQuery.length > 0 ? [`(${userQuery})`] : [], `after:${Math.floor(since / 1000)}`]
  const max = limitOf(context, 20)
  const list = await requestJson<{ messages?: Array<{ id?: string }> }>(
    context.fetch,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(parts.join(' '))}`,
    { headers: { authorization: `Bearer ${token}` } },
    context.signal,
    'Gmail',
  )
  const ids = (list.messages ?? []).map(message => message.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  const events: ConnectorEventDraft[] = []
  let cursor = 0
  for (const id of ids.slice(0, max)) {
    const message = await requestJson<GmailMessage>(
      context.fetch,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { authorization: `Bearer ${token}` } },
      context.signal,
      'Gmail 邮件',
    )
    const event = parseGmailMessage(message, context.now)
    if (event === undefined) continue
    events.push(event)
    cursor = Math.max(cursor, event.occurredAt)
  }
  return {
    events: events.sort((a, b) => b.occurredAt - a.occurredAt),
    ...(cursor > 0 ? { cursor: String(cursor) } : {}),
    note: `${events.length} 封邮件`,
  }
}

interface GoogleCalendarEvent {
  id?: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  status?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  organizer?: { displayName?: string; email?: string }
}

function googleEventStart(event: GoogleCalendarEvent): number | undefined {
  const raw = event.start?.dateTime ?? event.start?.date
  if (raw === undefined) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 解析 Google Calendar events.list。 */
export function parseGoogleCalendarEvents(items: GoogleCalendarEvent[]): ConnectorEventDraft[] {
  const out: ConnectorEventDraft[] = []
  for (const item of items) {
    if (item.status === 'cancelled') continue
    const start = googleEventStart(item)
    if (start === undefined) continue
    const id = item.id ?? `${start}-${item.summary ?? ''}`
    const endRaw = item.end?.dateTime ?? item.end?.date
    const end = endRaw === undefined ? undefined : Date.parse(endRaw)
    const when = Number.isFinite(end)
      ? `${new Date(start).toLocaleString('zh-CN')} – ${new Date(end as number).toLocaleString('zh-CN')}`
      : new Date(start).toLocaleString('zh-CN')
    const organizer = item.organizer?.displayName ?? item.organizer?.email ?? ''
    out.push({
      externalId: id,
      kind: 'event',
      title: item.summary ?? '（无标题日程）',
      body: [`时间：${when}`, ...item.location === undefined ? [] : [`地点：${item.location}`], ...(item.description ?? '').length > 0 ? ['', clip(item.description ?? '', 2000)] : []].join('\n'),
      ...(item.htmlLink === undefined ? {} : { url: item.htmlLink }),
      ...(organizer.length === 0 ? {} : { author: organizer }),
      occurredAt: start,
      key: `gcal:${id}:${start}`,
    })
  }
  return out.sort((a, b) => a.occurredAt - b.occurredAt)
}

async function syncGoogleCalendar(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const token = await googleAccessToken(connector, context)
  const calendarId = settingsString(connector, 'calendarId', 'primary')
  const max = limitOf(context, 25)
  const timeMin = new Date(Math.max(sinceOf(connector, context.now), context.now - DAY_MS)).toISOString()
  const timeMax = new Date(context.now + 30 * DAY_MS).toISOString()
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?singleEvents=true&orderBy=startTime&maxResults=${max}`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
  const json = await requestJson<{ items?: GoogleCalendarEvent[] }>(
    context.fetch,
    url,
    { headers: { authorization: `Bearer ${token}` } },
    context.signal,
    'Google Calendar',
  )
  const events = parseGoogleCalendarEvents(json.items ?? [])
  return { events, cursor: String(context.now), note: `${events.length} 个日程` }
}

/* ── Outlook / Microsoft Graph ───────────────────────── */

async function microsoftAccessToken(connector: Connector, context: SyncContext): Promise<string> {
  const tenant = settingsString(connector, 'tenantId', 'common') || 'common'
  const clientId = settingsString(connector, 'clientId')
  const clientSecret = settingsString(connector, 'clientSecret')
  const refreshToken = settingsString(connector, 'refreshToken')
  if (clientId.length === 0 || clientSecret.length === 0 || refreshToken.length === 0) {
    throw new Error('Outlook OAuth 缺少 clientId / clientSecret / refreshToken')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/.default offline_access',
  })
  const json = await requestJson<{ access_token?: string; error_description?: string }>(
    context.fetch,
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    context.signal,
    'Microsoft OAuth',
  )
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error(`Microsoft OAuth 未返回 access_token${json.error_description === undefined ? '' : `：${json.error_description}`}`)
  }
  return json.access_token
}

interface GraphMessage {
  id?: string
  subject?: string
  receivedDateTime?: string
  webLink?: string
  bodyPreview?: string
  from?: { emailAddress?: { name?: string; address?: string } }
}

interface GraphEvent {
  id?: string
  subject?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  webLink?: string
  bodyPreview?: string
  location?: { displayName?: string }
  organizer?: { emailAddress?: { name?: string; address?: string } }
}

/** 解析 Graph 的 7 位小数时间（JS Date.parse 只稳定支持 3 位）。 */
export function parseGraphDate(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 解析 Outlook 邮件。 */
export function parseOutlookMessages(items: GraphMessage[], now: number): ConnectorEventDraft[] {
  const out: ConnectorEventDraft[] = []
  for (const item of items) {
    const id = item.id ?? ''
    if (id.length === 0) continue
    const occurredAt = parseGraphDate(item.receivedDateTime) ?? now
    const author = item.from?.emailAddress?.name ?? item.from?.emailAddress?.address ?? ''
    out.push({
      externalId: id,
      kind: 'message',
      title: item.subject ?? '(无主题)',
      body: [`发件人：${author || '未知'}`, '', clip(item.bodyPreview ?? '', 2000)].join('\n'),
      ...(author.length === 0 ? {} : { author }),
      ...(item.webLink === undefined ? {} : { url: item.webLink }),
      occurredAt,
      key: `outlook:mail:${id}`,
    })
  }
  return out.sort((a, b) => b.occurredAt - a.occurredAt)
}

/** 解析 Outlook 日历事件。 */
export function parseOutlookEvents(items: GraphEvent[], now: number): ConnectorEventDraft[] {
  const out: ConnectorEventDraft[] = []
  for (const item of items) {
    const id = item.id ?? ''
    if (id.length === 0) continue
    const start = parseGraphDate(item.start?.dateTime) ?? now
    const end = parseGraphDate(item.end?.dateTime)
    const when = end === undefined
      ? new Date(start).toLocaleString('zh-CN')
      : `${new Date(start).toLocaleString('zh-CN')} – ${new Date(end).toLocaleString('zh-CN')}`
    const organizer = item.organizer?.emailAddress?.name ?? item.organizer?.emailAddress?.address ?? ''
    out.push({
      externalId: id,
      kind: 'event',
      title: item.subject ?? '（无标题日程）',
      body: [`时间：${when}`, ...item.location?.displayName === undefined ? [] : [`地点：${item.location.displayName}`], ...(item.bodyPreview ?? '').length > 0 ? ['', clip(item.bodyPreview ?? '', 2000)] : []].join('\n'),
      ...(item.webLink === undefined ? {} : { url: item.webLink }),
      ...(organizer.length === 0 ? {} : { author: organizer }),
      occurredAt: start,
      key: `outlook:calendar:${id}:${start}`,
    })
  }
  return out.sort((a, b) => a.occurredAt - b.occurredAt)
}

async function syncOutlook(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const token = await microsoftAccessToken(connector, context)
  const resource = settingsString(connector, 'resource', 'mail') === 'calendar' ? 'calendar' : 'mail'
  const since = new Date(sinceOf(connector, context.now)).toISOString()
  const max = limitOf(context, 20)
  const headers = { authorization: `Bearer ${token}` }
  if (resource === 'calendar') {
    const url = 'https://graph.microsoft.com/v1.0/me/events'
      + `?$top=${max}&$orderby=start/dateTime&$select=id,subject,start,end,webLink,bodyPreview,organizer,location`
      + `&$filter=${encodeURIComponent(`start/dateTime ge '${since}'`)}`
    const json = await requestJson<{ value?: GraphEvent[] }>(context.fetch, url, { headers }, context.signal, 'Outlook 日历')
    const events = parseOutlookEvents(json.value ?? [], context.now)
    return { events, cursor: String(context.now), note: `${events.length} 个日程` }
  }
  const url = 'https://graph.microsoft.com/v1.0/me/messages'
    + `?$top=${max}&$orderby=${encodeURIComponent('receivedDateTime desc')}&$select=id,subject,from,receivedDateTime,webLink,bodyPreview`
    + `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`
  const json = await requestJson<{ value?: GraphMessage[] }>(context.fetch, url, { headers }, context.signal, 'Outlook 邮件')
  const events = parseOutlookMessages(json.value ?? [], context.now)
  let cursor = 0
  for (const event of events) cursor = Math.max(cursor, event.occurredAt)
  return { events, ...(cursor > 0 ? { cursor: String(cursor) } : {}), note: `${events.length} 封邮件` }
}

/* ── 调度入口 ────────────────────────────────────────── */

/** 按连接器类型执行一次只读同步。 */
export async function syncConnector(connector: Connector, context: SyncContext): Promise<SyncResult> {
  const since = sinceOf(connector, context.now)
  const max = limitOf(context, 30)
  switch (connector.kind) {
    case 'ics': {
      const url = settingsString(connector, 'url')
      const text = await requestText(context.fetch, url, context.signal, 'ICS')
      return { events: parseIcsEvents(text, { since, now: context.now, max, sourceUrl: url }), note: 'ICS 日历' }
    }
    case 'rss': {
      const url = settingsString(connector, 'url')
      const text = await requestText(context.fetch, url, context.signal, 'RSS')
      return { events: parseRssEvents(text, context.now, max), note: 'RSS / Atom' }
    }
    case 'slack':
      return await syncSlack(connector, context)
    case 'notion':
      return await syncNotion(connector, { ...context, maxItems: max })
    case 'gmail':
      return await syncGmail(connector, context)
    case 'gcal':
      return await syncGoogleCalendar(connector, context)
    case 'outlook':
      return await syncOutlook(connector, context)
    default:
      throw new Error(`不支持的连接器类型：${String(connector.kind)}`)
  }
}

/** 设置页「测试」：用给定设置拉取一次（最多 1 条），返回数量与首条标题。 */
export async function previewConnector(
  kind: ConnectorKind,
  settings: Record<string, unknown>,
  fetchImpl: FetchLike,
  now = Date.now(),
): Promise<{ count: number; title?: string; note?: string }> {
  const normalizedSettings: Record<string, ConnectorSetting> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string') normalizedSettings[key] = value.trim()
    else if (typeof value === 'number' && Number.isFinite(value)) normalizedSettings[key] = value
    else if (typeof value === 'boolean') normalizedSettings[key] = value
  }
  const connector: Connector = {
    id: 'preview',
    kind,
    name: CONNECTOR_KIND_LABELS[kind],
    enabled: true,
    everyMinutes: 15,
    initialDays: 7,
    settings: normalizedSettings,
    createdAt: now,
    updatedAt: now,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('连接器测试超时')), 20_000)
  timer.unref?.()
  try {
    const result = await syncConnector(connector, { fetch: fetchImpl, signal: controller.signal, now, maxItems: 1 })
    return {
      count: result.events.length,
      ...(result.events[0] === undefined ? {} : { title: result.events[0].title }),
      ...(result.note === undefined ? {} : { note: result.note }),
    }
  } finally {
    clearTimeout(timer)
  }
}
