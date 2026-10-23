/**
 * /sv 路由：静态前端页面 + JSON API + SSE 聊天流。
 *
 * 全部注册在 `ctx.webServer`（与 dsh 的 /api 传输相互独立；本 profile
 * 默认只绑定 127.0.0.1，局域网部署需要自行加反向代理与鉴权）。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ChatManager, SvChatEvent } from './chat.ts'
import type { ConfigStore } from './config-store.ts'
import { MEMORY_KINDS, memoryView, type MemoryKind, type MemoryPatch, type MemoryStore } from './memory-store.ts'
import { SV_PROVIDER_ID } from './llm-adapter.ts'
import { svError, svErrorTrace, svLog } from './log.ts'
import type { MailNotifier } from './mail-notifier.ts'
import type { ReminderService, SvReminderEvent } from './reminders.ts'
import { SV_SEARCH_PROVIDER_ID } from './search-provider.ts'
import type { SvSessionStore } from './sessions-store.ts'
import { TASK_RECURRENCES, taskView, type TaskRecurrence, type TaskStatus, type TasksStore } from './tasks-store.ts'

const WEB_DIR = join(import.meta.dirname, '..', 'web')
/** 项目日志目录（仓库根 logs/，由 start.sh 的重定向写入）。 */
const LOG_DIR = join(WEB_DIR, '..', '..', '..', 'logs')
/** 单次最多读取的日志尾部字节数，避免大文件占满内存。 */
const LOG_TAIL_BYTES = 512 * 1024
/** 合法日志文件名（禁止路径穿越）。 */
const LOG_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.log$/
/** 日志接口返回的条目上限。 */
const LOG_LIMIT_MAX = 2000

type SvLogLevel = 'error' | 'warn' | 'info'

/** 按行内特征粗分级别（sv-app 的输出不带级别前缀）。 */
function classifyLogLine(line: string): SvLogLevel {
  if (/err=|Traceback|EADDRINUSE|ECONNREFUSED|error|failed|failure/i.test(line)) return 'error'
  if (/\bwarn|warning|did not activate|deprecated/i.test(line)) return 'warn'
  return 'info'
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

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 注册 /sv 前缀路由。 */
export function registerSvRoutes(
  ctx: Context,
  chat: ChatManager,
  store: ConfigStore,
  sessions: SvSessionStore,
  memory: MemoryStore,
  tasks: TasksStore,
  reminders: ReminderService,
  mailer: MailNotifier,
): void {
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
        ...store.publicState(),
        ...(models === null ? { modelsError } : { models }),
      })
      return
    }

    // POST /sv/api/config —— 保存配置（token 缺省不变，空串清除）
    if (req.method === 'POST' && path === '/sv/api/config') {
      try {
        const body = await readJson(req)
        const state = await store.update(body as Parameters<ConfigStore['update']>[0])
        sendJson(res, 200, state)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // POST /sv/api/chat —— SSE 聊天流
    if (req.method === 'POST' && path === '/sv/api/chat') {
      let sessionId: string | undefined
      let text: string
      try {
        const body = await readJson(req)
        const rawSession = body.sessionId
        if (rawSession !== undefined && (typeof rawSession !== 'string' || rawSession.length > 128)) {
          throw new Error('sessionId 非法')
        }
        sessionId = rawSession
        const rawText = body.text
        if (typeof rawText !== 'string' || rawText.trim().length === 0) throw new Error('text 不能为空')
        if (rawText.length > 100_000) throw new Error('text 过长')
        text = rawText
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
        for await (const event of chat.run(sessionId, text)) {
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

    // POST /sv/api/test —— 连通性测试
    if (req.method === 'POST' && path === '/sv/api/test') {
      try {
        const body = await readJson(req)
        const target = body.target
        if (target === 'llm') {
          try {
            const models = await ctx.llm.listModels(SV_PROVIDER_ID)
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

    // GET /sv/api/logs —— 读取项目 logs/ 下的日志（默认 sv.log 尾部）
    if (req.method === 'GET' && path === '/sv/api/logs') {
      const url = new URL(req.url ?? '/', 'http://sv.local')
      const file = url.searchParams.get('file') ?? 'sv.log'
      if (!LOG_FILE_RE.test(file)) {
        sendJson(res, 400, { error: 'file 非法' })
        return
      }
      const level = url.searchParams.get('level') ?? ''
      if (level !== '' && level !== 'error' && level !== 'warn' && level !== 'info') {
        sendJson(res, 400, { error: 'level 必须是 error / warn / info' })
        return
      }
      const keyword = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const rawLimit = Number(url.searchParams.get('limit') ?? '500')
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), LOG_LIMIT_MAX) : 500

      // 可选的日志文件清单（logs/*.log，按修改时间倒序）
      let files: { name: string; size: number; mtime: number }[] = []
      try {
        const names = (await readdir(LOG_DIR)).filter(name => LOG_FILE_RE.test(name))
        files = await Promise.all(names.map(async name => {
          const info = await stat(join(LOG_DIR, name))
          return { name, size: info.size, mtime: info.mtimeMs }
        }))
        files.sort((a, b) => b.mtime - a.mtime)
      } catch {
        // 日志目录不存在：按无文件处理
      }

      let tail: Awaited<ReturnType<typeof readTail>>
      try {
        tail = await readTail(join(LOG_DIR, file), LOG_TAIL_BYTES)
      } catch {
        sendJson(res, 200, { files, file, exists: false, lines: [], total: 0, matched: 0, truncated: false })
        return
      }

      const all = classifyLogLines(tail.text.split('\n').filter(line => line.trim().length > 0))
      const matched = all.filter(line => {
        if (keyword.length > 0 && !line.text.toLowerCase().includes(keyword)) return false
        if (level.length > 0 && line.level !== level) return false
        return true
      })
      sendJson(res, 200, {
        files,
        file,
        exists: true,
        size: tail.size,
        mtime: tail.mtime,
        total: all.length,
        matched: matched.length,
        truncated: tail.size > LOG_TAIL_BYTES,
        lines: matched.slice(-limit),
      })
      return
    }

    // GET /sv/api/events —— 提醒 SSE 流
    if (req.method === 'GET' && path === '/sv/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      res.write(': connected\n\n')
      const unsubscribe = reminders.subscribe((event: SvReminderEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      })
      req.on('close', unsubscribe)
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
        if (req.method === 'GET' && (path === '/sv' || path === '/sv/')) {
          await serveStatic(res, 'index.html')
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
        if (req.method === 'GET' && path === '/sv/app.css') {
          await serveStatic(res, 'app.css')
          return
        }
        if (req.method === 'GET' && path === '/sv/icon.png') {
          await serveStatic(res, 'icon.png')
          return
        }
        if (path.startsWith('/sv/api/')) {
          await handleApi(req, res, path)
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
