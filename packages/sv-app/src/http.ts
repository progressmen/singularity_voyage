/**
 * /sv 路由：静态前端页面 + JSON API + SSE 聊天流。
 *
 * 全部注册在 `ctx.webServer`（与 dsh 的 /api 传输相互独立；本 profile
 * 默认只绑定 127.0.0.1，局域网部署需要自行加反向代理与鉴权）。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import type { EncodedImageAttachment, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-schedule'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE, type AuthStore, type AuthUser } from './auth.ts'
import type { ChatManager, SvChatEvent } from './chat.ts'
import type { ApprovalCenter } from './approval-center.ts'
import type { AutomationService } from './automation-runtime.ts'
import { previewConnector } from './connector-adapters.ts'
import { CONNECTOR_KINDS, connectorView, type ConnectorKind, type ConnectorStore } from './connector-store.ts'
import type { ConnectorService } from './connector-runtime.ts'
import {
  AUTOMATION_KINDS,
  AUTOMATION_SCHEDULE_KINDS,
  automationView,
  type AutomationCreateInput,
  type AutomationSchedule,
  type AutomationStore,
} from './automation-store.ts'
import {
  clearData,
  createBackup,
  dataStatus,
  DATA_DOMAINS,
  restoreBackup,
  type BackupStores,
  type DataDomain,
} from './backup.ts'
import type { BriefingService } from './briefing.ts'
import type { ConfigStore } from './config-store.ts'
import { INBOX_KINDS, inboxView, type InboxKind, type InboxStore } from './inbox-store.ts'
import {
  defaultKnowledgeTitle,
  knowledgeDocSummary,
  knowledgeDocView,
  MAX_KNOWLEDGE_DOC_CHARS,
  type KnowledgeStore,
} from './knowledge-store.ts'
import { fetchUrlPage } from './knowledge-source.ts'
import { MEMORY_KINDS, memoryView, type MemoryKind, type MemoryPatch, type MemoryStore } from './memory-store.ts'
import { listModelsWithConfig, SV_PROVIDER_ID } from './llm-adapter.ts'
import { svError, svErrorTrace, svLog, svLogDir } from './log.ts'
import type { MailNotifier } from './mail-notifier.ts'
import type { ReminderService, SvReminderEvent } from './reminders.ts'
import { SV_SEARCH_PROVIDER_ID } from './search-provider.ts'
import type { SvSessionStore } from './sessions-store.ts'
import type { SuperAgentEvent, SuperAgentSurface } from './superagent.ts'
import { TASK_RECURRENCES, taskView, type TaskRecurrence, type TaskStatus, type TasksStore } from './tasks-store.ts'

/** `/sv/api/skills` 返回的技能条目（只暴露斜杠菜单需要的元信息）。 */
export interface SvSkillView {
  name: string
  description: string
  whenToUse?: string
  source?: string
  /** 技能指令文件的绝对路径。 */
  path?: string
}

/** `/sv/api/tools` 返回的工具条目。 */
export interface SvToolView {
  name: string
  description: string
}

const WEB_DIR = join(import.meta.dirname, '..', 'web')
/** 单次最多读取的日志尾部字节数，避免大文件占满内存。 */
const LOG_TAIL_BYTES = 8 * 1024 * 1024
/** 合法日志文件名（禁止路径穿越）。 */
const LOG_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.log$/
/** 日志表格单页条数上限。 */
const LOG_PAGE_SIZE_MAX = 200
/** 文件预览单次读取上限，超出部分截断。 */
const FILE_PREVIEW_BYTES = 512 * 1024

type SvLogLevel = 'error' | 'warn' | 'info'

/** 按行内特征粗分级别（sv-app 的输出不带级别前缀）。 */
function classifyLogLine(line: string): SvLogLevel {
  if (/err=|Traceback|EADDRINUSE|ECONNREFUSED|error|failed|failure/i.test(line)) return 'error'
  if (/\bwarn|warning|did not activate|deprecated/i.test(line)) return 'warn'
  return 'info'
}

/** 读取工作区内的文本文件（知识导入用）；二进制与超大文件拒绝。 */
async function readWorkspaceText(raw: string): Promise<{ relativePath: string; name: string; text: string }> {
  if (raw.trim().length === 0) throw new Error('path 不能为空')
  const root = process.cwd()
  const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能导入工作区内的文件')
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error('文件不存在')
  if (!info.isFile()) throw new Error('不是文件')
  if (info.size > MAX_KNOWLEDGE_DOC_CHARS * 2) throw new Error('文件过大（上限约 1MB）')
  const buffer = await readFile(target)
  if (buffer.includes(0)) throw new Error('不支持二进制文件')
  const text = buffer.toString('utf8')
  if (text.length > MAX_KNOWLEDGE_DOC_CHARS) {
    throw new Error(`文件内容过长（上限 ${MAX_KNOWLEDGE_DOC_CHARS} 字符）`)
  }
  return { relativePath: rel, name: basename(target), text }
}

/** 逐行定级；缩进的堆栈续行继承上一条的级别。 */
function classifyLogLines(lines: string[]): { text: string; level: SvLogLevel }[] {
  let previous: SvLogLevel = 'info'
  return lines.map(text => {
    if (!/^\s/.test(text)) previous = classifyLogLine(text)
    return { text, level: previous }
  })
}

/** 读取文件尾部若干字节；从中间截断时丢掉首行残片。 */
async function readTail(path: string, maxBytes: number): Promise<{ text: string; size: number; mtime: number }> {
  const info = await stat(path)
  const start = Math.max(0, info.size - maxBytes)
  const length = info.size - start
  const buffer = Buffer.alloc(length)
  const handle = await open(path, 'r')
  try {
    await handle.read(buffer, 0, length, start)
  } finally {
    await handle.close()
  }
  let text = buffer.toString('utf8')
  if (start > 0) {
    const firstBreak = text.indexOf('\n')
    text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
  }
  return { text, size: info.size, mtime: info.mtimeMs }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const BODY_LIMIT = 1 << 20
/** 聊天请求体上限：4 张 10MB 图片经 base64 膨胀后仍留有余量。 */
const CHAT_BODY_LIMIT = 64 * 1024 * 1024
/** 单条消息最多附带的图片数。 */
const MAX_CHAT_IMAGES = 4
/** 单张图片的编码前体积上限。 */
const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 读取请求头里的指定 Cookie（值按 base64url 令牌使用，无需反转义）。 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return undefined
}

/** 写入登录 Cookie；令牌只保存在 HttpOnly Cookie 中。 */
function setAuthCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    'set-cookie',
    `${AUTH_COOKIE}=${token}; Path=/sv; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`,
  )
}

/** 清除登录 Cookie（退出登录或令牌失效时使用）。 */
function clearAuthCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${AUTH_COOKIE}=; Path=/sv; HttpOnly; SameSite=Lax; Max-Age=0`)
}

async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit)
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 解析自动化创建/更新请求体（POST 与 PATCH 共用）。 */
function parseAutomationInput(body: Record<string, unknown>): AutomationCreateInput {
  const kind = String(body.kind ?? '')
  if (!(AUTOMATION_KINDS as readonly string[]).includes(kind)) {
    throw new Error('kind 必须是 web / keyword / prompt / rss')
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (title.length === 0) throw new Error('title 不能为空')
  const scheduleKind = String(body.scheduleKind ?? '')
  if (!(AUTOMATION_SCHEDULE_KINDS as readonly string[]).includes(scheduleKind)) {
    throw new Error('scheduleKind 必须是 interval / daily / weekly')
  }
  const schedule: AutomationSchedule = scheduleKind === 'interval'
    ? { kind: 'interval', everyMinutes: Number(body.everyMinutes) }
    : scheduleKind === 'daily'
      ? { kind: 'daily', at: String(body.at ?? '').trim() }
      : { kind: 'weekly', weekday: Number(body.weekday), at: String(body.at ?? '').trim() }
  let keywords: string[] | undefined
  if (body.keywords !== undefined) {
    if (!Array.isArray(body.keywords)) throw new Error('keywords 必须是字符串数组')
    keywords = body.keywords
      .filter((keyword): keyword is string => typeof keyword === 'string')
      .map(keyword => keyword.trim())
      .filter(keyword => keyword.length > 0)
  }
  if (body.email !== undefined && typeof body.email !== 'boolean') throw new Error('email 必须是布尔值')
  return {
    title,
    kind: kind as (typeof AUTOMATION_KINDS)[number],
    schedule,
    ...(typeof body.url === 'string' && body.url.trim().length > 0 ? { url: body.url.trim() } : {}),
    ...(keywords === undefined ? {} : { keywords }),
    ...(typeof body.prompt === 'string' && body.prompt.trim().length > 0 ? { prompt: body.prompt.trim() } : {}),
    email: body.email === true,
  }
}

/** 解析聊天请求里的图片上传；格式与体积先做快速校验，解码校验交给附件服务。 */
function parseChatImages(value: unknown): EncodedImageAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('images 必须是数组')
  if (value.length > MAX_CHAT_IMAGES) throw new Error(`单次最多 ${MAX_CHAT_IMAGES} 张图片`)
  const out: EncodedImageAttachment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) throw new Error('图片格式非法')
    const record = item as { mediaType?: unknown; data?: unknown; name?: unknown }
    if (typeof record.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(record.mediaType)) {
      throw new Error('仅支持 PNG / JPEG / WebP / GIF 图片')
    }
    if (typeof record.data !== 'string' || record.data.length === 0) throw new Error('图片数据为空')
    // base64 长度换算：4 字符对应 3 字节；先按编码长度预检，避免为超大图分配内存。
    const padding = record.data.endsWith('==') ? 2 : record.data.endsWith('=') ? 1 : 0
    const bytes = Math.floor(record.data.length * 3 / 4) - padding
    if (bytes > MAX_CHAT_IMAGE_BYTES) throw new Error('单张图片不能超过 10MB')
    const name = typeof record.name === 'string' ? record.name.slice(0, 255) : undefined
    out.push({
      mediaType: record.mediaType as ImageMediaType,
      data: record.data,
      ...name === undefined ? {} : { name },
    })
  }
  return out
}

/** 把附件服务的错误码翻译成页面可直接展示的中文提示。 */
function imageErrorMessage(error: unknown): string {
  if (!isAttachmentError(error)) return error instanceof Error ? error.message : String(error)
  switch (error.code) {
    case 'TOO_MANY_IMAGES':
    case 'IMAGES_TOO_LARGE':
      return '图片数量或总大小超出限制'
    case 'IMAGE_TOO_LARGE':
      return '单张图片体积超出限制'
    case 'UNSUPPORTED_IMAGE_TYPE':
    case 'IMAGE_TYPE_MISMATCH':
      return '仅支持 PNG / JPEG / WebP / GIF 图片'
    case 'INVALID_IMAGE':
    case 'INVALID_IMAGE_BASE64':
      return '图片数据无效'
    case 'IMAGE_TOO_MANY_PIXELS':
    case 'IMAGE_DIMENSION_TOO_LARGE':
      return '图片分辨率过大'
    default:
      return `图片处理失败：${error.message}`
  }
}

/** 校验前端回传的图片引用，避免把任意头部值带进响应。 */
function parseImageRef(value: unknown): ImageAttachmentRef {
  if (typeof value !== 'object' || value === null) throw new Error('图片引用非法')
  const record = value as Record<string, unknown>
  const positiveInt = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0
  if (typeof record.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.attachmentId)) {
    throw new Error('图片引用非法')
  }
  if (typeof record.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(record.mediaType)) {
    throw new Error('图片引用非法')
  }
  if (!positiveInt(record.bytes) || !positiveInt(record.width) || !positiveInt(record.height)) {
    throw new Error('图片引用非法')
  }
  const original = record.originalDimensions
  const originalRecord = typeof original === 'object' && original !== null
    ? original as Record<string, unknown>
    : undefined
  const originalWidth = originalRecord?.width
  const originalHeight = originalRecord?.height
  const originalDimensions = positiveInt(originalWidth) && positiveInt(originalHeight)
    ? { width: originalWidth, height: originalHeight }
    : undefined
  return {
    attachmentId: record.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: record.mediaType as ImageMediaType,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
    ...typeof record.name !== 'string' ? {} : { name: record.name },
    ...originalDimensions === undefined ? {} : { originalDimensions },
  }
}

/** 注册 /sv 前缀路由。 */
export function registerSvRoutes(
  ctx: Context,
  chat: ChatManager,
  store: ConfigStore,
  sessions: SvSessionStore,
  memory: MemoryStore,
  tasks: TasksStore,
  inbox: InboxStore,
  knowledge: KnowledgeStore,
  automations: AutomationStore,
  automationService: AutomationService,
  reminders: ReminderService,
  mailer: MailNotifier,
  briefing: BriefingService,
  schedule: Context['schedule'],
  listSkills: () => Promise<SvSkillView[]>,
  listTools: () => Promise<SvToolView[]>,
  superAgent?: SuperAgentSurface,
  dataHooks?: {
    clearSuperAgentHistory?: () => Promise<void>
    restoreSuperAgentHistory?: () => Promise<void>
    /** 本地用量/费用快照（未挂载时数据页不显示费用卡片）。 */
    usageSnapshot?: () => import('./usage-store.ts').UsageSnapshot
  },
  /** 审批与连接器服务；未挂载时对应 API 返回 404。 */
  services?: {
    approvals: ApprovalCenter
    connectors: ConnectorService
    connectorStore: ConnectorStore
  },
  /** 账号与登录态存储；未配置 PostgreSQL 时为 undefined，页面不做登录校验。 */
  auth?: AuthStore,
): void {
  const dataStores: BackupStores = {
    memory,
    tasks,
    inbox,
    knowledge,
    automations,
    sessions,
    ...dataHooks,
    ...services === undefined
      ? {}
      : { approvals: services.approvals, connectors: services.connectorStore },
  }
  const staticCache = new Map<string, { body: Buffer; type: string }>()
  const serveStatic = async (res: ServerResponse, file: string): Promise<void> => {
    let entry = staticCache.get(file)
    if (entry === undefined) {
      const body = await readFile(join(WEB_DIR, file))
      const type = MIME[extname(file)] ?? 'application/octet-stream'
      entry = { body, type }
      staticCache.set(file, entry)
    }
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-cache' })
    res.end(entry.body)
  }

  /** 把 Super-agent 事件流写成 SSE；连接关闭时中止上游。 */
  const pipeSuperAgent = async (
    req: IncomingMessage,
    res: ServerResponse,
    open: (signal: AbortSignal) => AsyncGenerator<SuperAgentEvent>,
  ): Promise<void> => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    let closed = false
    const controller = new AbortController()
    // 客户端断开时 req/res 谁先触发都行；res 的 close 在代理/浏览器中止时更可靠。
    const onClose = (): void => {
      closed = true
      controller.abort()
    }
    req.on('close', onClose)
    res.on('close', onClose)
    const send = (event: unknown): void => {
      if (closed) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    try {
      for await (const event of open(controller.signal)) {
        if (closed) break
        send(event)
      }
    } catch (error) {
      send({ type: 'error', runId: '', message: error instanceof Error ? error.message : String(error) })
      send({ type: 'done' })
    }
    res.end()
  }

  const handleApi = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    // GET /sv/api/state —— 当前配置（脱敏）与模型目录
    if (req.method === 'GET' && path === '/sv/api/state') {
      let models: string[] | null = null
      let modelsError: string | undefined
      try {
        const list = await ctx.llm.listModels(SV_PROVIDER_ID)
        models = list.map(model => model.id).slice(0, 200)
      } catch (error) {
        modelsError = error instanceof Error ? error.message : String(error)
      }
      sendJson(res, 200, {
        provider: SV_PROVIDER_ID,
        searchProvider: SV_SEARCH_PROVIDER_ID,
        // 图片消息依赖宿主层挂载的附件服务；未挂载时前端禁用图片入口。
        attachments: ctx.get('attachments') !== undefined,
        // 未配置 PostgreSQL 时不做登录校验，前端隐藏「退出登录」。
        authEnabled: auth !== undefined,
        ...store.publicState(),
        ...(models === null ? { modelsError } : { models }),
        superAgent: superAgent === undefined
          ? { enabled: false }
          : { enabled: superAgent.enabled, limits: superAgent.limits },
      })
      return
    }

    // GET /sv/api/attachments?ref=<JSON> —— 读取历史消息里的图片附件
    if (req.method === 'GET' && path === '/sv/api/attachments') {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        sendJson(res, 404, { error: '附件服务未启用' })
        return
      }
      let ref: ImageAttachmentRef
      try {
        const raw = new URL(req.url ?? '/', 'http://sv.local').searchParams.get('ref')
        if (raw === null || raw.length === 0 || raw.length > 2048) throw new Error('图片引用非法')
        ref = parseImageRef(JSON.parse(raw))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      try {
        const stored = await attachments.readImage(ref)
        res.writeHead(200, {
          'content-type': stored.ref.mediaType,
          'content-length': stored.data.byteLength,
          // 附件按内容哈希寻址，同一引用永远对应同一份字节。
          'cache-control': 'private, max-age=31536000, immutable',
        })
        res.end(Buffer.from(stored.data))
      } catch (error) {
        ctx.logger.warn(svLog('http', 'attachment_read_failed', {
          attachmentId: ref.attachmentId,
          err: svError(error),
        }))
        sendJson(res, 404, { error: '图片不可用或已丢失' })
      }
      return
    }

    // GET /sv/api/skills —— 可供 / 斜杠菜单选择的用户可调用技能
    if (req.method === 'GET' && path === '/sv/api/skills') {
      try {
        sendJson(res, 200, { skills: await listSkills() })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/tools —— 可供 / 斜杠菜单查看的工具（含 computer-use）
    if (req.method === 'GET' && path === '/sv/api/tools') {
      try {
        sendJson(res, 200, { tools: await listTools() })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/config —— 保存配置（token 缺省不变，空串清除）
    if (req.method === 'POST' && path === '/sv/api/config') {
      try {
        const body = await readJson(req)
        const state = await store.update(body as Parameters<ConfigStore['update']>[0])
        // Super-agent 开关与限额即时应用（不需要重启）
        superAgent?.applyConfig(store.superAgent)
        sendJson(res, 200, state)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/chat —— SSE 聊天流（文本 + 可选图片）
    if (req.method === 'POST' && path === '/sv/api/chat') {
      let sessionId: string | undefined
      let text: string
      let images: ImageAttachmentRef[] = []
      let context: string | undefined
      try {
        const body = await readJson(req, CHAT_BODY_LIMIT)
        const rawSession = body.sessionId
        if (rawSession !== undefined && (typeof rawSession !== 'string' || rawSession.length > 128)) {
          throw new Error('sessionId 非法')
        }
        sessionId = rawSession
        const rawText = body.text
        if (rawText !== undefined && typeof rawText !== 'string') throw new Error('text 必须是字符串')
        if (typeof rawText === 'string' && rawText.length > 100_000) throw new Error('text 过长')
        text = rawText ?? ''
        if (body.context !== undefined) {
          if (typeof body.context !== 'string') throw new Error('context 必须是字符串')
          if (body.context.length > 20_000) throw new Error('context 过长')
          const trimmed = body.context.trim()
          if (trimmed.length > 0) context = trimmed
        }
        const uploads = parseChatImages(body.images)
        if (text.trim().length === 0 && uploads.length === 0) throw new Error('text 和图片不能同时为空')
        if (uploads.length > 0) {
          const attachments = ctx.get('attachments')
          if (attachments === undefined) throw new Error('当前环境未挂载附件服务，暂不支持图片消息')
          const parts = [
            ...text.length > 0 ? [{ type: 'text' as const, text }] : [],
            ...uploads.map(image => ({ type: 'image' as const, ...image })),
          ]
          const admitted = await attachments.admitPromptContent(parts)
          images = admitted.flatMap(part => part.type === 'image' ? [part.attachment] : [])
        }
      } catch (error) {
        sendJson(res, 400, { error: imageErrorMessage(error) })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      let closed = false
      req.on('close', () => {
        closed = true
      })
      const send = (event: SvChatEvent): void => {
        if (closed) return
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      try {
        for await (const event of chat.run(sessionId, text, images, context)) {
          if (closed) break
          send(event)
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        send({ type: 'done' })
      }
      res.end()
      return
    }

    // POST /sv/api/stop —— 中止当前轮次
    if (req.method === 'POST' && path === '/sv/api/stop') {
      try {
        const body = await readJson(req)
        const sessionId = body.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId 不能为空')
        sendJson(res, 200, { stopped: chat.stop(sessionId) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/chat/steer —— 在正在生成的回答中插入一条用户消息
    if (req.method === 'POST' && path === '/sv/api/chat/steer') {
      try {
        const body = await readJson(req)
        const sessionId = body.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId 不能为空')
        const text = body.text
        if (typeof text !== 'string' || text.trim().length === 0) throw new Error('text 不能为空')
        if (text.length > 100_000) throw new Error('text 过长')
        const result = chat.steer(sessionId, text)
        if (!result.ok) {
          sendJson(res, 409, { error: result.error })
          return
        }
        sendJson(res, 200, { steered: true })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/test —— 连通性测试
    if (req.method === 'POST' && path === '/sv/api/test') {
      try {
        const body = await readJson(req)
        const target = body.target
        if (target === 'llm') {
          try {
            // 设置页可以带上未保存的表单值：用当前填写的端点/密钥测试，而不是已保存的生效配置
            const override = typeof body.llm === 'object' && body.llm !== null
              ? body.llm as Record<string, unknown>
              : undefined
            let models: Awaited<ReturnType<typeof listModelsWithConfig>>
            if (override === undefined) {
              models = await ctx.llm.listModels(SV_PROVIDER_ID)
            } else {
              const saved = store.llmConfig(typeof override.id === 'string' ? override.id : undefined)
              const pick = (value: unknown, fallback: string | undefined): string =>
                typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback ?? ''
              const baseURL = pick(override.baseURL, saved?.baseURL ?? store.llm.baseURL).replace(/\/+$/, '')
              if (!/^https?:\/\//i.test(baseURL)) throw new Error('API 根地址必须是 http(s) URL')
              models = await listModelsWithConfig({ baseURL, apiKey: pick(override.apiKey, saved?.apiKey) })
            }
            sendJson(res, 200, { ok: true, models: models.map(model => model.id).slice(0, 50) })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (target === 'search') {
          try {
            const result = await ctx.web.search({ query: 'hello world', maxResults: 1 })
            sendJson(res, 200, { ok: true, count: result.sources.length })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (target === 'mail') {
          try {
            await mailer.sendTest()
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        throw new Error('target 必须是 "llm"、"search" 或 "mail"')
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/sessions —— 会话索引（按最近更新倒序）
    if (req.method === 'GET' && path === '/sv/api/sessions') {
      sendJson(res, 200, { sessions: sessions.list() })
      return
    }

    // GET /sv/api/search?q=&limit= —— 会话全文检索
    if (req.method === 'GET' && path === '/sv/api/search') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const query = (url.searchParams.get('q') ?? '').trim()
      if (query.length === 0) {
        sendJson(res, 200, { hits: [] })
        return
      }
      const rawLimit = Number(url.searchParams.get('limit') ?? '20')
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20
      try {
        sendJson(res, 200, { hits: await sessions.search(query, limit) })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/sessions/:id/messages —— 会话历史（transcript 投影）
    const messagesMatch = /^\/sv\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/messages$/.exec(path)
    if (req.method === 'GET' && messagesMatch !== null) {
      try {
        sendJson(res, 200, { messages: await sessions.messages(messagesMatch[1]!) })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const deleteMatch = /^\/sv\/api\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(path)

    // PATCH /sv/api/sessions/:id —— 重命名
    if (req.method === 'PATCH' && deleteMatch !== null) {
      try {
        const body = await readJson(req)
        const rawTitle = body.title
        if (typeof rawTitle !== 'string') throw new Error('title 必须是字符串')
        const title = rawTitle.trim()
        if (title.length === 0) throw new Error('title 不能为空')
        if (title.length > 60) throw new Error('title 不能超过 60 个字符')
        sendJson(res, 200, { renamed: await sessions.rename(deleteMatch[1]!, title) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // DELETE /sv/api/sessions/:id —— 删除索引条目与 transcript
    if (req.method === 'DELETE' && deleteMatch !== null) {
      try {
        sendJson(res, 200, { deleted: await sessions.remove(deleteMatch[1]!) })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/memories —— 记忆列表（可选 q 过滤）
    if (req.method === 'GET' && path === '/sv/api/memories') {
      const query = new URL(req.url ?? '/', 'http://sv.local').searchParams.get('q') ?? ''
      const list = query.trim().length > 0 ? memory.recall(query, 200) : memory.list()
      sendJson(res, 200, { memories: list.map(memoryView) })
      return
    }

    const memoryMatch = /^\/sv\/api\/memories\/([A-Za-z0-9-]{1,64})$/.exec(path)

    // POST /sv/api/memories —— 手动新增记忆
    if (req.method === 'POST' && path === '/sv/api/memories') {
      try {
        const body = await readJson(req)
        const rawKind = body.kind
        if (typeof rawKind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(rawKind)) {
          throw new Error('kind 必须是 fact / preference / person / project / decision')
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text.length === 0) throw new Error('text 不能为空')
        if (text.length > 500) throw new Error('text 不能超过 500 个字符')
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(tag => tag.length > 0)
          : []
        const [entry] = await memory.remember([{ kind: rawKind as MemoryKind, text, tags }], { note: 'manual' })
        if (entry === undefined) throw new Error('记忆内容为空，未写入')
        sendJson(res, 200, { memory: memoryView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // PATCH /sv/api/memories/:id —— 编辑记忆
    if (req.method === 'PATCH' && memoryMatch !== null) {
      try {
        const body = await readJson(req)
        const patch: MemoryPatch = {}
        if (body.kind !== undefined) {
          if (typeof body.kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(body.kind)) throw new Error('kind 非法')
          patch.kind = body.kind as MemoryKind
        }
        if (body.text !== undefined) {
          if (typeof body.text !== 'string') throw new Error('text 必须是字符串')
          patch.text = body.text
        }
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags)) throw new Error('tags 必须是数组')
          patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string')
        }
        if (body.confidence !== undefined) {
          if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence)) throw new Error('confidence 必须是数字')
          patch.confidence = body.confidence
        }
        const entry = await memory.update(memoryMatch[1]!, patch)
        if (entry === undefined) {
          sendJson(res, 404, { error: '记忆不存在' })
          return
        }
        sendJson(res, 200, { memory: memoryView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // DELETE /sv/api/memories/:id —— 删除记忆
    if (req.method === 'DELETE' && memoryMatch !== null) {
      const deleted = await memory.remove(memoryMatch[1]!)
      sendJson(res, 200, { deleted })
      return
    }

    // GET /sv/api/tasks —— 任务列表
    if (req.method === 'GET' && path === '/sv/api/tasks') {
      const includeDone = new URL(req.url ?? '/', 'http://sv.local').searchParams.get('done') === '1'
      sendJson(res, 200, { tasks: tasks.list(includeDone).map(taskView) })
      return
    }

    // POST /sv/api/tasks —— 创建任务
    if (req.method === 'POST' && path === '/sv/api/tasks') {
      try {
        const body = await readJson(req)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title.length === 0) throw new Error('title 不能为空')
        let dueAt: number | undefined
        if (body.dueAt !== undefined && body.dueAt !== null) {
          const value = typeof body.dueAt === 'number' ? body.dueAt
            : typeof body.dueAt === 'string' ? Date.parse(body.dueAt) : Number.NaN
          if (!Number.isFinite(value)) throw new Error('dueAt 非法')
          dueAt = value
        }
        let recurrence: TaskRecurrence | undefined
        if (body.recurrence !== undefined) {
          if (typeof body.recurrence !== 'string' || !(TASK_RECURRENCES as readonly string[]).includes(body.recurrence)) {
            throw new Error('recurrence 必须是 none / daily / weekly')
          }
          recurrence = body.recurrence as TaskRecurrence
        }
        const entry = await tasks.create({
          title,
          ...(typeof body.notes === 'string' && body.notes.trim().length > 0 ? { notes: body.notes } : {}),
          ...(dueAt === undefined ? {} : { dueAt }),
          ...(recurrence === undefined ? {} : { recurrence }),
        })
        sendJson(res, 200, { task: taskView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const taskMatch = /^\/sv\/api\/tasks\/([A-Za-z0-9-]{1,64})$/.exec(path)

    // PATCH /sv/api/tasks/:id —— 修改任务（title/notes/dueAt/recurrence/status/snoozeMinutes）
    if (req.method === 'PATCH' && taskMatch !== null) {
      try {
        const body = await readJson(req)
        const entry = await tasks.update(taskMatch[1]!, {
          ...(body.title === undefined ? {} : { title: String(body.title) }),
          ...(body.notes === undefined ? {} : { notes: body.notes === null ? null : String(body.notes) }),
          ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt === null ? null : Number(body.dueAt) }),
          ...(body.recurrence === undefined ? {} : { recurrence: body.recurrence as TaskRecurrence }),
          ...(body.status === undefined ? {} : { status: body.status as TaskStatus }),
          ...(body.snoozeMinutes === undefined ? {} : { snoozeMinutes: Number(body.snoozeMinutes) }),
        })
        if (entry === undefined) {
          sendJson(res, 404, { error: '任务不存在' })
          return
        }
        sendJson(res, 200, { task: taskView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // DELETE /sv/api/tasks/:id —— 删除任务
    if (req.method === 'DELETE' && taskMatch !== null) {
      const deleted = await tasks.remove(taskMatch[1]!)
      sendJson(res, 200, { deleted })
      return
    }

    // GET /sv/api/inbox —— 收件箱列表（unread=1 / kind= 过滤）
    if (req.method === 'GET' && path === '/sv/api/inbox') {
      const params = new URL(req.url ?? '/', 'http://sv.local').searchParams
      const rawKind = params.get('kind') ?? ''
      if (rawKind.length > 0 && !(INBOX_KINDS as readonly string[]).includes(rawKind)) {
        sendJson(res, 400, { error: 'kind 必须是 briefing / reminder / agent / system' })
        return
      }
      const rawLimit = params.get('limit')
      const limit = rawLimit === null ? 100 : Math.min(500, Math.max(1, Number(rawLimit) || 100))
      sendJson(res, 200, {
        items: inbox.list({
          unreadOnly: params.get('unread') === '1',
          ...(rawKind.length === 0 ? {} : { kind: rawKind as InboxKind }),
          limit,
        }).map(inboxView),
        unread: inbox.unreadCount(),
      })
      return
    }

    // POST /sv/api/inbox/read-all —— 全部标记已读
    if (req.method === 'POST' && path === '/sv/api/inbox/read-all') {
      const updated = await inbox.markAllRead()
      sendJson(res, 200, { updated, unread: inbox.unreadCount() })
      return
    }

    // POST /sv/api/briefing/run —— 立即生成一份简报（忽略开关与当天去重）
    if (req.method === 'POST' && path === '/sv/api/briefing/run') {
      try {
        const item = await briefing.runNow()
        sendJson(res, 200, { item: inboxView(item), unread: inbox.unreadCount() })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const inboxReadMatch = /^\/sv\/api\/inbox\/([A-Za-z0-9-]{1,64})\/read$/.exec(path)

    // POST /sv/api/inbox/:id/read —— 标记已读/未读
    if (req.method === 'POST' && inboxReadMatch !== null) {
      try {
        const body = await readJson(req)
        const read = body.read === undefined ? true : body.read === true
        const item = await inbox.markRead(inboxReadMatch[1]!, read)
        if (item === undefined) {
          sendJson(res, 404, { error: '收件箱条目不存在' })
          return
        }
        sendJson(res, 200, { item: inboxView(item), unread: inbox.unreadCount() })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const inboxItemMatch = /^\/sv\/api\/inbox\/([A-Za-z0-9-]{1,64})$/.exec(path)

    // DELETE /sv/api/inbox/:id —— 删除条目
    if (req.method === 'DELETE' && inboxItemMatch !== null) {
      const deleted = await inbox.remove(inboxItemMatch[1]!)
      sendJson(res, 200, { deleted, unread: inbox.unreadCount() })
      return
    }

    // GET /sv/api/knowledge —— 知识库文档列表
    if (req.method === 'GET' && path === '/sv/api/knowledge') {
      sendJson(res, 200, {
        docs: knowledge.list().map(knowledgeDocSummary),
        total: knowledge.list().length,
      })
      return
    }

    // GET /sv/api/knowledge/search?q=&limit= —— 检索知识库
    if (req.method === 'GET' && path === '/sv/api/knowledge/search') {
      const params = new URL(req.url ?? '/', 'http://sv.local').searchParams
      const query = (params.get('q') ?? '').trim()
      const rawLimit = params.get('limit')
      const limit = rawLimit === null ? 10 : Math.min(50, Math.max(1, Number(rawLimit) || 10))
      sendJson(res, 200, { hits: query.length === 0 ? [] : knowledge.search(query, limit) })
      return
    }

    // POST /sv/api/knowledge —— 导入文本 / 工作区文件 / 网页
    if (req.method === 'POST' && path === '/sv/api/knowledge') {
      try {
        const body = await readJson(req)
        const rawText = typeof body.text === 'string' ? body.text : ''
        const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
        const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
        const provided = [rawText.trim().length > 0, rawPath.length > 0, rawUrl.length > 0].filter(Boolean).length
        if (provided !== 1) throw new Error('text / path / url 三选一')
        const title = body.title === undefined ? '' : String(body.title).trim()
        const source = body.source === undefined ? '' : String(body.source).trim()

        let text: string
        let resolvedSource: string
        let sourceKind: 'text' | 'file' | 'url'
        let resolvedTitle: string | undefined
        if (rawUrl.length > 0) {
          const page = await fetchUrlPage(ctx, rawUrl, AbortSignal.timeout(30_000))
          text = page.text
          resolvedSource = source || page.url
          sourceKind = 'url'
          resolvedTitle = title || page.title
        } else if (rawPath.length > 0) {
          const file = await readWorkspaceText(rawPath)
          text = file.text
          resolvedSource = source || file.relativePath
          sourceKind = 'file'
          resolvedTitle = title || defaultKnowledgeTitle(file.text, file.name)
        } else {
          text = rawText
          resolvedSource = source || '手动导入'
          sourceKind = 'text'
          resolvedTitle = title || undefined
        }

        const result = await knowledge.ingest({
          text,
          source: resolvedSource,
          sourceKind,
          ...(resolvedTitle === undefined || resolvedTitle.length === 0 ? {} : { title: resolvedTitle }),
        })
        sendJson(res, 200, {
          doc: knowledgeDocSummary(result.doc),
          duplicate: result.duplicate,
        })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const knowledgeMatch = /^\/sv\/api\/knowledge\/([A-Za-z0-9-]{1,64})$/.exec(path)

    // GET /sv/api/knowledge/:id —— 文档详情（含分块）
    if (req.method === 'GET' && knowledgeMatch !== null) {
      const doc = knowledge.get(knowledgeMatch[1]!)
      if (doc === undefined) {
        sendJson(res, 404, { error: '知识文档不存在' })
        return
      }
      sendJson(res, 200, { doc: knowledgeDocView(doc) })
      return
    }

    // DELETE /sv/api/knowledge/:id —— 删除文档
    if (req.method === 'DELETE' && knowledgeMatch !== null) {
      sendJson(res, 200, { deleted: await knowledge.remove(knowledgeMatch[1]!) })
      return
    }

    // GET /sv/api/automations —— 自动化列表 + 最近运行历史 + 全局设置
    if (req.method === 'GET' && path === '/sv/api/automations') {
      sendJson(res, 200, {
        automations: automations.list().map(automationView),
        runs: automations.listRuns(undefined, 50),
        config: { ...store.automations },
      })
      return
    }

    // POST /sv/api/automations/config —— 更新全局设置（暂停 / 静默时段 / 重试）
    if (req.method === 'POST' && path === '/sv/api/automations/config') {
      try {
        const body = await readJson(req)
        const state = await store.update({ automations: body })
        sendJson(res, 200, { config: state.automations })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/automations —— 创建自动化
    if (req.method === 'POST' && path === '/sv/api/automations') {
      try {
        const body = await readJson(req)
        const entry = await automations.create(parseAutomationInput(body))
        sendJson(res, 200, { automation: automationView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const automationRunMatch = /^\/sv\/api\/automations\/([A-Za-z0-9-]{1,64})\/run$/.exec(path)

    // POST /sv/api/automations/:id/run —— 手动运行一次
    if (req.method === 'POST' && automationRunMatch !== null) {
      try {
        const result = await automationService.runNow(automationRunMatch[1]!)
        sendJson(res, 200, { automation: automationView(result.automation), run: result.run })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, message.includes('不存在') ? 404 : 500, { error: message })
      }
      return
    }

    const automationMatch = /^\/sv\/api\/automations\/([A-Za-z0-9-]{1,64})$/.exec(path)

    // PATCH /sv/api/automations/:id —— 修改定义，或仅切换启用状态
    if (req.method === 'PATCH' && automationMatch !== null) {
      try {
        const body = await readJson(req)
        const id = automationMatch[1]!
        if (typeof body.enabled === 'boolean' && Object.keys(body).every(key => key === 'enabled')) {
          const entry = await automations.setEnabled(id, body.enabled)
          if (entry === undefined) {
            sendJson(res, 404, { error: '自动化不存在' })
            return
          }
          sendJson(res, 200, { automation: automationView(entry) })
          return
        }
        const entry = await automations.update(id, parseAutomationInput(body))
        if (entry === undefined) {
          sendJson(res, 404, { error: '自动化不存在' })
          return
        }
        sendJson(res, 200, { automation: automationView(entry) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // DELETE /sv/api/automations/:id —— 删除自动化
    if (req.method === 'DELETE' && automationMatch !== null) {
      sendJson(res, 200, { deleted: await automations.remove(automationMatch[1]!) })
      return
    }

    // GET /sv/api/data —— 数据量、token 使用与服务健康快照
    if (req.method === 'GET' && path === '/sv/api/data') {
      sendJson(res, 200, { status: await dataStatus(dataStores, dataHooks?.usageSnapshot?.()) })
      return
    }

    // GET /sv/api/backup —— 下载 JSON 备份（不含 config.json 密钥；?domain= 按域导出）
    if (req.method === 'GET' && path === '/sv/api/backup') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const rawDomain = (url.searchParams.get('domain') ?? '').trim()
      let domain: DataDomain | undefined
      if (rawDomain.length > 0) {
        if (!(DATA_DOMAINS as readonly string[]).includes(rawDomain)) {
          sendJson(res, 400, { error: 'domain 非法' })
          return
        }
        domain = rawDomain as DataDomain
      }
      const bundle = await createBackup(dataStores, domain)
      const body = `${JSON.stringify(bundle, null, 2)}\n`
      const now = new Date()
      const pad = (value: number): string => String(value).padStart(2, '0')
      const suffix = domain === undefined || domain === 'all' ? 'backup' : `backup-${domain}`
      const filename = `sv-${suffix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    // POST /sv/api/data/restore —— 恢复备份（覆盖当前产品数据）
    if (req.method === 'POST' && path === '/sv/api/data/restore') {
      try {
        const body = await readJson(req, 100 * 1024 * 1024)
        const result = await restoreBackup(dataStores, body)
        ctx.logger.info(svLog('index', 'backup_restored', { files: result.files }))
        sendJson(res, 200, { restored: result.files })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/data/clear —— 按域清空产品数据
    if (req.method === 'POST' && path === '/sv/api/data/clear') {
      try {
        const body = await readJson(req)
        const domain = String(body.domain ?? '')
        if (!(DATA_DOMAINS as readonly string[]).includes(domain)) {
          throw new Error('domain 必须是 memory / tasks / inbox / knowledge / automations / sessions / superagent / approvals / connectors / all')
        }
        await clearData(dataStores, domain as DataDomain)
        ctx.logger.info(svLog('index', 'data_cleared', { domain }))
        sendJson(res, 200, { cleared: domain })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    /* ── 审批中心 ───────────────────────────────────────── */

    if (services !== undefined && req.method === 'GET' && path === '/sv/api/approvals') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const status = url.searchParams.get('status') ?? 'all'
      if (status !== 'all' && status !== 'pending' && status !== 'decided') {
        sendJson(res, 400, { error: 'status 必须是 all / pending / decided' })
        return
      }
      const rawLimit = Number(url.searchParams.get('limit') ?? '100')
      const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 100
      sendJson(res, 200, {
        approvals: services.approvals.list(status, limit),
        pending: services.approvals.pendingCount(),
      })
      return
    }

    if (services !== undefined && req.method === 'POST' && path === '/sv/api/approvals/clear') {
      try {
        await services.approvals.clear()
        sendJson(res, 200, { cleared: true })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const approvalAnswerMatch = /^\/sv\/api\/approvals\/([A-Za-z0-9-]{1,64})\/answer$/.exec(path)
    if (services !== undefined && req.method === 'POST' && approvalAnswerMatch !== null) {
      try {
        const body = await readJson(req)
        const outcome = String(body.outcome ?? '')
        if (outcome !== 'allowed-once' && outcome !== 'rejected') {
          throw new Error('outcome 必须是 allowed-once 或 rejected')
        }
        const record = await services.approvals.answer(approvalAnswerMatch[1]!, outcome)
        sendJson(res, 200, { approval: record, pending: services.approvals.pendingCount() })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    /* ── 只读连接器与事件流 ─────────────────────────────── */

    if (services !== undefined && req.method === 'GET' && path === '/sv/api/connectors') {
      sendJson(res, 200, {
        connectors: services.connectorStore.listConnectors().map(connectorView),
        events: services.connectorStore.listEvents({ limit: 50 }),
        unread: services.connectorStore.unreadCount(),
      })
      return
    }

    if (services !== undefined && req.method === 'POST' && path === '/sv/api/connectors') {
      try {
        const body = await readJson(req)
        const kind = String(body.kind ?? '')
        if (!(CONNECTOR_KINDS as readonly string[]).includes(kind)) throw new Error('连接器类型非法')
        const settings = typeof body.settings === 'object' && body.settings !== null && !Array.isArray(body.settings)
          ? body.settings as Record<string, unknown>
          : {}
        const connector = await services.connectorStore.create({
          kind: kind as ConnectorKind,
          name: typeof body.name === 'string' ? body.name : '',
          settings,
          ...(typeof body.everyMinutes === 'number' ? { everyMinutes: body.everyMinutes } : {}),
          ...(typeof body.initialDays === 'number' ? { initialDays: body.initialDays } : {}),
        })
        sendJson(res, 200, { connector: connectorView(connector) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (services !== undefined && req.method === 'POST' && path === '/sv/api/connectors/test') {
      try {
        const body = await readJson(req)
        const kind = String(body.kind ?? '')
        if (!(CONNECTOR_KINDS as readonly string[]).includes(kind)) throw new Error('连接器类型非法')
        const settings = typeof body.settings === 'object' && body.settings !== null && !Array.isArray(body.settings)
          ? body.settings as Record<string, unknown>
          : {}
        const preview = await previewConnector(kind as ConnectorKind, settings, fetch)
        sendJson(res, 200, { ok: true, ...preview })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (services !== undefined && req.method === 'GET' && path === '/sv/api/connectors/events') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const rawSource = (url.searchParams.get('source') ?? '').trim()
      let source: ConnectorKind | undefined
      if (rawSource.length > 0) {
        if (!(CONNECTOR_KINDS as readonly string[]).includes(rawSource)) {
          sendJson(res, 400, { error: 'source 非法' })
          return
        }
        source = rawSource as ConnectorKind
      }
      const rawLimit = Number(url.searchParams.get('limit') ?? '100')
      const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 100
      sendJson(res, 200, {
        events: services.connectorStore.listEvents({
          ...(source === undefined ? {} : { source }),
          unreadOnly: url.searchParams.get('unread') === '1',
          query: url.searchParams.get('q') ?? '',
          limit,
        }),
        unread: services.connectorStore.unreadCount(source),
      })
      return
    }

    if (services !== undefined && req.method === 'POST' && path === '/sv/api/connectors/events/read-all') {
      try {
        const body = await readJson(req)
        const rawSource = typeof body.source === 'string' ? body.source.trim() : ''
        let source: ConnectorKind | undefined
        if (rawSource.length > 0) {
          if (!(CONNECTOR_KINDS as readonly string[]).includes(rawSource)) throw new Error('source 非法')
          source = rawSource as ConnectorKind
        }
        const count = await services.connectorStore.markAllRead(source)
        sendJson(res, 200, { read: count, unread: services.connectorStore.unreadCount(source) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (services !== undefined && req.method === 'DELETE' && path === '/sv/api/connectors/events') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const rawSource = (url.searchParams.get('source') ?? '').trim()
      let source: ConnectorKind | undefined
      if (rawSource.length > 0) {
        if (!(CONNECTOR_KINDS as readonly string[]).includes(rawSource)) {
          sendJson(res, 400, { error: 'source 非法' })
          return
        }
        source = rawSource as ConnectorKind
      }
      sendJson(res, 200, { removed: await services.connectorStore.clearEvents(source) })
      return
    }

    const connectorEventReadMatch = /^\/sv\/api\/connectors\/events\/([A-Za-z0-9-]{1,64})\/read$/.exec(path)
    if (services !== undefined && req.method === 'POST' && connectorEventReadMatch !== null) {
      const event = await services.connectorStore.markRead(connectorEventReadMatch[1]!)
      sendJson(res, event === undefined ? 404 : 200, event === undefined
        ? { error: '事件不存在' }
        : { event })
      return
    }

    const connectorRunMatch = /^\/sv\/api\/connectors\/([A-Za-z0-9-]{1,64})\/run$/.exec(path)
    if (services !== undefined && req.method === 'POST' && connectorRunMatch !== null) {
      try {
        const result = await services.connectors.runNow(connectorRunMatch[1]!)
        sendJson(res, 200, {
          connector: connectorView(result.connector),
          added: result.added,
          ...(result.note === undefined ? {} : { note: result.note }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, message.includes('不存在') ? 404 : 500, { error: message })
      }
      return
    }

    const connectorMatch = /^\/sv\/api\/connectors\/([A-Za-z0-9-]{1,64})$/.exec(path)
    if (services !== undefined && req.method === 'PATCH' && connectorMatch !== null) {
      try {
        const body = await readJson(req)
        const connector = await services.connectorStore.update(connectorMatch[1]!, {
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(typeof body.everyMinutes === 'number' ? { everyMinutes: body.everyMinutes } : {}),
          ...(typeof body.initialDays === 'number' ? { initialDays: body.initialDays } : {}),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
        })
        if (connector === undefined) {
          sendJson(res, 404, { error: '连接器不存在' })
          return
        }
        sendJson(res, 200, { connector: connectorView(connector) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (services !== undefined && req.method === 'DELETE' && connectorMatch !== null) {
      sendJson(res, 200, { deleted: await services.connectorStore.remove(connectorMatch[1]!) })
      return
    }

    // GET /sv/api/schedules —— 宿主定时任务目录（活动 + 已结束，含会话绑定）
    if (req.method === 'GET' && path === '/sv/api/schedules') {
      try {
        const entries = await schedule.catalog()
        const now = Date.now()
        sendJson(res, 200, {
          schedules: entries.map(entry => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            prompt: entry.prompt,
            scheduledAt: entry.scheduledAt,
            sessionId: entry.sessionId,
            status: entry.status,
            state: entry.status === 'active' && Date.parse(entry.scheduledAt) <= now ? 'overdue' : 'scheduled',
            ...(entry.lastDelivery === undefined ? {} : { lastDelivery: entry.lastDelivery }),
          })),
        })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const scheduleMatch = /^\/sv\/api\/schedules\/([A-Za-z0-9_-]{1,64})$/.exec(path)

    // DELETE /sv/api/schedules/:id —— 删除定时任务（宿主不提供暂停，删除即取消后续投递）
    if (req.method === 'DELETE' && scheduleMatch !== null) {
      try {
        const id = scheduleMatch[1]!
        const entry = (await schedule.catalog()).find(candidate => candidate.id === id)
        if (entry === undefined) {
          sendJson(res, 404, { error: '定时任务不存在' })
          return
        }
        const result = await schedule.delete({ sessionId: entry.sessionId, id: entry.id })
        sendJson(res, 200, { deleted: result.deleted })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/superagent/state —— 运行状态、限额与最近运行
    if (req.method === 'GET' && path === '/sv/api/superagent/state') {
      sendJson(res, 200, superAgent === undefined
        ? { enabled: false, runs: [] }
        : { enabled: superAgent.enabled, limits: superAgent.limits, runs: superAgent.runs() })
      return
    }

    // POST /sv/api/superagent/run —— SSE：拆解 → 并发 Worker → 汇总
    if (req.method === 'POST' && path === '/sv/api/superagent/run') {
      if (superAgent === undefined || !superAgent.enabled) {
        sendJson(res, 404, { error: 'Super-agent 未启用（请在设置页开启）' })
        return
      }
      let goal: string
      let subtasks: string[] | undefined
      try {
        const body = await readJson(req)
        goal = typeof body.goal === 'string' ? body.goal.trim() : ''
        if (goal.length === 0) throw new Error('goal 不能为空')
        if (goal.length > 10_000) throw new Error('goal 过长')
        if (body.subtasks !== undefined) {
          if (!Array.isArray(body.subtasks)) throw new Error('subtasks 必须是字符串数组')
          subtasks = body.subtasks
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(item => item.length > 0)
          if (subtasks.some(item => item.length > 2_000)) throw new Error('单个子任务不能超过 2000 个字符')
          if (subtasks.length > superAgent.limits.maxSubtasks) {
            throw new Error(`子任务不能超过 ${superAgent.limits.maxSubtasks} 个`)
          }
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }

      await pipeSuperAgent(req, res, signal => superAgent.run(goal, subtasks, signal))
      return
    }

    // POST /sv/api/superagent/retry —— 手动重试单个失败的 Worker（SSE）
    if (req.method === 'POST' && path === '/sv/api/superagent/retry') {
      if (superAgent === undefined || !superAgent.enabled) {
        sendJson(res, 404, { error: 'Super-agent 未启用（请在设置页开启）' })
        return
      }
      let runId: string
      let index: number
      try {
        const body = await readJson(req)
        runId = typeof body.runId === 'string' ? body.runId.trim() : ''
        if (runId.length === 0) throw new Error('runId 不能为空')
        if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
          throw new Error('index 必须是非负整数')
        }
        index = body.index
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      await pipeSuperAgent(req, res, signal => superAgent.retry(runId, index, signal))
      return
    }

    // POST /sv/api/superagent/stop —— 中止一轮运行或手动重试
    if (req.method === 'POST' && path === '/sv/api/superagent/stop') {
      if (superAgent === undefined) {
        sendJson(res, 404, { error: 'Super-agent 未启用' })
        return
      }
      try {
        const body = await readJson(req)
        const runId = body.runId
        if (typeof runId !== 'string' || runId.length === 0) throw new Error('runId 不能为空')
        sendJson(res, 200, { stopped: superAgent.stop(runId) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // GET /sv/api/file —— 读取工作区内的文本文件，供右侧文件列表预览
    if (req.method === 'GET' && path === '/sv/api/file') {
      const raw = new URL(req.url ?? '/', 'http://sv.local').searchParams.get('path') ?? ''
      if (raw.trim().length === 0) {
        sendJson(res, 400, { error: 'path 不能为空' })
        return
      }
      const root = process.cwd()
      const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        sendJson(res, 403, { error: '只能预览工作区内的文件' })
        return
      }
      let info
      try {
        info = await stat(target)
      } catch {
        sendJson(res, 404, { error: '文件不存在' })
        return
      }
      if (!info.isFile()) {
        sendJson(res, 400, { error: '不是文件' })
        return
      }
      const length = Math.min(info.size, FILE_PREVIEW_BYTES)
      const buffer = Buffer.alloc(length)
      const handle = await open(target, 'r')
      try {
        await handle.read(buffer, 0, length, 0)
      } finally {
        await handle.close()
      }
      const truncated = info.size > FILE_PREVIEW_BYTES
      const binary = buffer.includes(0)
      if (binary) {
        sendJson(res, 200, {
          path: target, name: basename(target), size: info.size, mtime: info.mtimeMs, binary: true,
        })
        return
      }
      let text = buffer.toString('utf8')
      if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1)
      sendJson(res, 200, {
        path: target,
        name: basename(target),
        size: info.size,
        mtime: info.mtimeMs,
        text,
        truncated,
      })
      return
    }

    // GET /sv/api/logs —— 分页读取 logs/ 下按天分割的日志（默认最新文件）
    if (req.method === 'GET' && path === '/sv/api/logs') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const level = url.searchParams.get('level') ?? ''
      if (level !== '' && level !== 'error' && level !== 'warn' && level !== 'info') {
        sendJson(res, 400, { error: 'level 必须是 error / warn / info' })
        return
      }
      const keyword = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const rawPage = Number(url.searchParams.get('page') ?? '1')
      const page = Number.isFinite(rawPage) ? Math.max(Math.trunc(rawPage), 1) : 1
      const rawPageSize = Number(url.searchParams.get('pageSize') ?? '50')
      const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(Math.max(Math.trunc(rawPageSize), 1), LOG_PAGE_SIZE_MAX)
        : 50

      // 可选的日志文件清单（logs/*.log，按修改时间倒序，最新的在最前）
      const logDir = svLogDir()
      let files: { name: string; size: number; mtime: number }[] = []
      try {
        const names = (await readdir(logDir)).filter(name => LOG_FILE_RE.test(name))
        files = await Promise.all(names.map(async name => {
          const info = await stat(join(logDir, name))
          return { name, size: info.size, mtime: info.mtimeMs }
        }))
        files.sort((a, b) => b.mtime - a.mtime)
      } catch {
        // 日志目录不存在：按无文件处理
      }

      // 未指定文件时默认最新的那个（按天分割后即当天文件）
      const requested = url.searchParams.get('file')
      const file = requested !== null && requested.length > 0 ? requested : files[0]?.name ?? 'sv.log'
      if (!LOG_FILE_RE.test(file)) {
        sendJson(res, 400, { error: 'file 非法' })
        return
      }

      let tail: Awaited<ReturnType<typeof readTail>>
      try {
        tail = await readTail(join(logDir, file), LOG_TAIL_BYTES)
      } catch {
        sendJson(res, 200, {
          files, file, exists: false, lines: [], total: 0, matched: 0, page, pageSize, truncated: false,
        })
        return
      }

      const all = classifyLogLines(tail.text.split('\n').filter(line => line.trim().length > 0))
      const matched = all.filter(line => {
        if (keyword.length > 0 && !line.text.toLowerCase().includes(keyword)) return false
        if (level.length > 0 && line.level !== level) return false
        return true
      })
      // 新的在前：表格第一页就是最新日志
      matched.reverse()
      const start = (page - 1) * pageSize
      sendJson(res, 200, {
        files,
        file,
        exists: true,
        size: tail.size,
        mtime: tail.mtime,
        total: all.length,
        matched: matched.length,
        page,
        pageSize,
        truncated: tail.size > LOG_TAIL_BYTES,
        lines: matched.slice(start, start + pageSize),
      })
      return
    }

    // GET /sv/api/events —— 提醒、收件箱、审批与连接器 SSE 流
    if (req.method === 'GET' && path === '/sv/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      res.write(': connected\n\n')
      const unsubscribeReminders = reminders.subscribe((event: SvReminderEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
      const unsubscribeInbox = inbox.subscribe(event => {
        res.write(`data: ${JSON.stringify({ type: 'inbox', ...event })}\n\n`)
      })
      // 页面在线才等待审批；最后一个页面关闭时待处理审批会被取消。
      const detachApproval = services?.approvals.attachViewer()
      const unsubscribeApprovals = services?.approvals.subscribe(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
      const unsubscribeConnectors = services?.connectors.subscribe(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
      res.on('close', () => {
        unsubscribeReminders()
        unsubscribeInbox()
        unsubscribeApprovals?.()
        unsubscribeConnectors?.()
        detachApproval?.()
      })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  /** 登录相关接口：/sv/api/auth/{state,setup,login,logout}（无需登录态）。 */
  const handleAuthApi = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const method = req.method ?? 'GET'
    if (auth === undefined) {
      if (method === 'GET' && path === '/sv/api/auth/state') {
        // 未配置 PostgreSQL：登录未启用，前端直接进入主页面。
        sendJson(res, 200, { authEnabled: false, authenticated: true, needsSetup: false })
      } else {
        sendJson(res, 503, { error: '未配置 PostgreSQL，登录未启用' })
      }
      return
    }

    if (method === 'GET' && path === '/sv/api/auth/state') {
      const token = readCookie(req.headers.cookie, AUTH_COOKIE)
      const user = token === undefined ? undefined : await auth.sessionUser(token).catch(() => undefined)
      let needsSetup = false
      try {
        needsSetup = !(await auth.hasUsers())
      } catch {
        // 数据库暂不可用时不暴露内部错误，按普通登录表单处理。
      }
      sendJson(res, 200, {
        authEnabled: true,
        authenticated: user !== undefined,
        needsSetup,
        ...(user === undefined ? {} : { username: user.username }),
      })
      return
    }

    if (method === 'POST' && path === '/sv/api/auth/setup') {
      if (await auth.hasUsers()) {
        sendJson(res, 409, { error: '账号已存在，请直接登录' })
        return
      }
      const body = await readJson(req)
      const username = typeof body.username === 'string' ? body.username : ''
      const password = typeof body.password === 'string' ? body.password : ''
      let user: AuthUser
      try {
        user = await auth.createUser(username, password)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const token = await auth.createSession(user.id)
      setAuthCookie(res, token)
      sendJson(res, 200, { ok: true, username: user.username })
      return
    }

    if (method === 'POST' && path === '/sv/api/auth/login') {
      const body = await readJson(req)
      const username = typeof body.username === 'string' ? body.username : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const user = await auth.verifyCredentials(username, password)
      if (user === undefined) {
        sendJson(res, 401, { error: '账号或密码错误' })
        return
      }
      const token = await auth.createSession(user.id)
      setAuthCookie(res, token)
      sendJson(res, 200, { ok: true, username: user.username })
      return
    }

    if (method === 'POST' && path === '/sv/api/auth/logout') {
      const token = readCookie(req.headers.cookie, AUTH_COOKIE)
      if (token !== undefined) await auth.deleteSession(token).catch(() => {})
      clearAuthCookie(res)
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  const route: WebRoute = {
    kind: 'prefix',
    path: '/sv',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const path = url.pathname
      const startedTs = Date.now()
      try {
        // 登录态校验：页面与业务 API 需要有效会话；静态资源放行（登录页自身也要加载）。
        const pagePath = path === '/sv' || path === '/sv/' || path === '/sv/login' || path === '/sv/login.html'
        const apiPath = path.startsWith('/sv/api/')
        const needsSession = pagePath || (apiPath && !path.startsWith('/sv/api/auth/'))
        const token = needsSession ? readCookie(req.headers.cookie, AUTH_COOKIE) : undefined
        const user = auth !== undefined && token !== undefined
          ? await auth.sessionUser(token).catch(() => undefined)
          : undefined

        if (req.method === 'GET' && (path === '/sv/login' || path === '/sv/login.html')) {
          // 已登录用户访问登录页时直接回到主页面。
          if (auth !== undefined && user !== undefined) {
            res.writeHead(302, { location: '/sv/' })
            res.end()
            return
          }
          await serveStatic(res, 'login.html')
          return
        }
        if (path.startsWith('/sv/api/auth/')) {
          await handleAuthApi(req, res, path)
          return
        }
        if (req.method === 'GET' && (path === '/sv' || path === '/sv/')) {
          if (auth !== undefined && user === undefined) {
            res.writeHead(302, { location: '/sv/login' })
            res.end()
            return
          }
          await serveStatic(res, 'index.html')
          return
        }
        if (apiPath) {
          if (auth !== undefined && user === undefined) {
            sendJson(res, 401, { error: '未登录' })
            return
          }
          await handleApi(req, res, path)
          return
        }
        if (req.method === 'GET' && path === '/sv/app.js') {
          await serveStatic(res, 'app.js')
          return
        }
        if (req.method === 'GET' && path === '/sv/trace.js') {
          await serveStatic(res, 'trace.js')
          return
        }
        if (req.method === 'GET' && path === '/sv/markdown.js') {
          await serveStatic(res, 'markdown.js')
          return
        }
        if (req.method === 'GET' && path === '/sv/app.css') {
          await serveStatic(res, 'app.css')
          return
        }
        if (req.method === 'GET' && path === '/sv/icon.png') {
          await serveStatic(res, 'icon.png')
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      } catch (error) {
        ctx.logger.error(svLog('http', 'request_failed', {
          method: req.method ?? 'unknown',
          path,
          err: svError(error),
        }))
        ctx.logger.debug(svLog('http', 'request_failed_trace', { path, stack: svErrorTrace(error) }))
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.end()
      } finally {
        // 每次网页 API 请求记一行；日志轮询自身不记，避免自我放大。
        if (path.startsWith('/sv/api/') && path !== '/sv/api/logs') {
          const status = res.statusCode
          const fields = {
            method: req.method ?? 'GET',
            path,
            status,
            durationMs: Date.now() - startedTs,
          }
          if (status >= 400) ctx.logger.warn(svLog('http', 'request', fields))
          else ctx.logger.info(svLog('http', 'request', fields))
        }
      }
    },
  }

  ctx.webServer.register(route)

  // dsh 官方 Web UI 已禁用（web-runtime disabled）；根路径重定向到自建页面。
  ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler: async (_req, res) => {
      res.writeHead(302, { location: '/sv/' })
      res.end()
    },
  })
}
