/**
 * 模型可调用的记忆与待办工具。
 *
 * - memory_search / memory_write：长期记忆的读取与显式写入；
 * - task_create / task_list / task_complete：待办与提醒。
 *
 * 自动记忆抽取不走工具，由 turn 结束后的后台任务完成，避免每轮产生
 * 写入噪音；工具只用于用户明确要求「记住 / 更正」的场景。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AUTOMATION_KINDS,
  AUTOMATION_SCHEDULE_KINDS,
  type Automation,
  type AutomationSchedule,
  type AutomationStore,
} from './automation-store.ts'
import { INBOX_KINDS, inboxView, type InboxKind, type InboxStore } from './inbox-store.ts'
import {
  knowledgeDocSummary,
  type KnowledgeDocSummary,
  type KnowledgeStore,
} from './knowledge-store.ts'
import { fetchUrlPage } from './knowledge-source.ts'
import { MEMORY_KINDS, memoryView, type MemoryEntry, type MemoryStore, type MemoryKind } from './memory-store.ts'
import { TASK_RECURRENCES, taskView, type TaskEntry, type TasksStore } from './tasks-store.ts'

/** 通过终端驱动 GUI 的命令：启动应用、执行 AppleScript、模拟鼠标键盘。 */
const GUI_VIA_TERMINAL: readonly RegExp[] = [
  /\bosascript\b/i,
  /\bcliclick\b/i,
  /\bxdotool\b/i,
  /\bopen\s+(-\S+\s+)*-a\b/i,
  /\bopen\b[^\n]*\.app\b/i,
]

/**
 * 判断一条 shell 命令是否在绕过 computer-use 直接操作桌面。
 * @param command - bash 工具收到的命令文本。
 * @returns 命中时为拒绝原因，否则 undefined。
 */
export function desktopViaTerminalReason(command: string): string | undefined {
  if (!GUI_VIA_TERMINAL.some(pattern => pattern.test(command))) return undefined
  return '启动或控制桌面应用请用 app_launch / screen_observe / computer_* 工具：它们有观察快照校验、虚拟光标与危险操作审批；'
    + '终端里的 open / osascript / cliclick 既看不到界面，也无法被护栏约束。'
}

/**
 * 注册桌面操作护栏：禁止模型用终端绕过 computer-use。
 *
 * 仅拦截「启动应用」与「模拟输入」两类命令；普通 shell 使用不受影响。
 * @param ctx - 插件上下文。
 */
export function registerDesktopGuard(ctx: Context): void {
  ctx.tools.guard(execution => {
    if (!/^(bash|sh|shell|exec|terminal)$/i.test(execution.name)) return undefined
    const args = execution.arguments as { command?: unknown } | undefined
    if (typeof args?.command !== 'string') return undefined
    return desktopViaTerminalReason(args.command)
  })
}

const memorySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', enum: [...MEMORY_KINDS], required: true },
    text: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    confidence: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
  },
} as const

const taskSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    notes: { type: 'string' },
    dueAt: { type: 'number' },
    recurrence: { type: 'string', enum: [...TASK_RECURRENCES], required: true },
    status: { type: 'string', enum: ['pending', 'done', 'cancelled'], required: true },
    createdAt: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
    completedAt: { type: 'number' },
    notifiedAt: { type: 'number' },
    sessionId: { type: 'string' },
  },
} as const

const inboxSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', enum: [...INBOX_KINDS], required: true },
    title: { type: 'string', required: true },
    body: { type: 'string', required: true },
    createdAt: { type: 'number', required: true },
    read: { type: 'boolean', required: true },
    readAt: { type: 'number' },
    sessionId: { type: 'string' },
    taskId: { type: 'string' },
  },
} as const

const knowledgeDocSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    source: { type: 'string', required: true },
    sourceKind: { type: 'string', enum: ['text', 'file', 'url'], required: true },
    chars: { type: 'number', required: true },
    chunks: { type: 'number', required: true },
    createdAt: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
  },
} as const

const knowledgeHitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    source: { type: 'string', required: true },
    sourceKind: { type: 'string', enum: ['text', 'file', 'url'], required: true },
    chunkId: { type: 'string', required: true },
    chunkIndex: { type: 'number', required: true },
    heading: { type: 'string' },
    snippet: { type: 'string', required: true },
    score: { type: 'number', required: true },
  },
} as const

/** 工具返回的记忆视图（不暴露内部 source 细节以外的字段）。 */
function memoryToolView(entry: MemoryEntry): {
  id: string
  kind: MemoryKind
  text: string
  tags: string[]
  confidence: number
  updatedAt: number
} {
  const view = memoryView(entry)
  return {
    id: view.id,
    kind: view.kind,
    text: view.text,
    tags: view.tags,
    confidence: view.confidence,
    updatedAt: view.updatedAt,
  }
}

/** 工具返回的任务视图。 */
function taskToolView(entry: TaskEntry): ReturnType<typeof taskView> {
  return taskView(entry)
}

/** 解析模型给出的 ISO 8601 时间；空值表示无截止时间。 */
function parseDueAt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new Error('due_at 必须是 ISO 8601 时间，并带时区，例如 2026-10-23T10:00:00+08:00')
  }
  return ms
}

/** 注册记忆工具。 */
export function registerMemoryTools(ctx: Context, memory: MemoryStore): void {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '检索用户的长期记忆（事实、偏好、人物、项目、决定）。当需要回忆用户背景或此前约定时调用。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词或当前问题' },
      limit: { type: 'integer', description: '返回条数上限，默认 6' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: { type: 'array', items: memorySchema, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const limit = args.limit === undefined ? 6 : Math.min(20, Math.max(1, Math.trunc(args.limit)))
      return { memories: memory.recall(args.query, limit).map(memoryToolView) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: '写入或更正一条长期记忆。仅当用户明确要求记住、或明确纠正此前记忆时调用；临时信息不要写入。',
    parameters: {
      kind: { type: 'string', enum: MEMORY_KINDS, required: true, description: '记忆类型' },
      text: { type: 'string', required: true, description: '完整、可独立理解的一句话' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      confidence: { type: 'number', description: '0–1，默认 0.9' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memorySchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const [entry] = await memory.remember([{
        kind: args.kind as MemoryKind,
        text: args.text,
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
      }], {
        note: 'manual',
        ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
      })
      if (entry === undefined) throw new Error('记忆内容为空，未写入')
      return { memory: memoryToolView(entry) }
    },
  }))
}

/** 注册待办工具。 */
export function registerTaskTools(ctx: Context, tasks: TasksStore): void {  ctx.tools.register(defineTool({
    name: 'task_create',
    description: '创建一条待办清单项（可勾选完成、支持页面与邮件提醒）。用于长期跟踪「要做的事」；如果用户要在某个时间点被提醒并让助手届时继续处理，改用 schedule_create。',
    parameters: {
      title: { type: 'string', required: true, description: '要做什么（不超过 120 字）' },
      notes: { type: 'string', description: '可选备注' },
      due_at: { type: 'string', description: '提醒时间（ISO 8601，带时区）；不填表示无截止时间' },
      recurrence: { type: 'string', enum: TASK_RECURRENCES, description: '重复规则：none / daily / weekly' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { ...taskSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const dueAt = parseDueAt(args.due_at)
      const task = await tasks.create({
        title: args.title,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(dueAt === undefined ? {} : { dueAt }),
        ...(args.recurrence === undefined ? {} : { recurrence: args.recurrence }),
        ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
      })
      return { task: taskToolView(task) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_list',
    description: '列出用户的待办与提醒（未完成在前）。回答「今天有什么要做」时先调用它。',
    parameters: {
      include_done: { type: 'boolean', description: '是否包含已完成任务，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tasks: { type: 'array', items: taskSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { tasks: tasks.list(args.include_done === true).map(taskToolView) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'task_complete',
    description: '把一条待办标记为完成。用户说「做完了 / 完成了」时调用。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { task: { ...taskSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const task = await tasks.complete(args.id)
      if (task === undefined) throw new Error(`任务不存在：${args.id}`)
      return { task: taskToolView(task) }
    },
  }))
}

/** 注册收件箱读取工具。 */
export function registerInboxTools(ctx: Context, inbox: InboxStore): void {
  ctx.tools.register(defineTool({
    name: 'inbox_list',
    description: '读取收件箱中的每日简报、到期提醒与后台任务结果。用户问「今天的简报说了什么」「有什么新消息」时调用。',
    parameters: {
      unread_only: { type: 'boolean', description: '只看未读，默认 false' },
      kind: { type: 'string', enum: INBOX_KINDS, description: '按类型过滤：briefing / reminder / agent / system' },
      limit: { type: 'integer', description: '返回条数上限，默认 10，最多 50' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: inboxSchema, required: true },
          unread: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const limit = args.limit === undefined ? 10 : Math.min(50, Math.max(1, Math.trunc(args.limit)))
      return {
        items: inbox.list({
          unreadOnly: args.unread_only === true,
          ...(args.kind === undefined ? {} : { kind: args.kind as InboxKind }),
          limit,
        }).map(inboxView),
        unread: inbox.unreadCount(),
      }
    },
  }))
}

/** 注册知识库工具。 */
export function registerKnowledgeTools(ctx: Context, knowledge: KnowledgeStore): void {
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: '在个人知识库中检索笔记、导入的文件与网页，返回可直接引用的片段与来源。回答涉及用户自己的资料时先调用它。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词或当前问题' },
      limit: { type: 'integer', description: '返回条数上限，默认 5，最多 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: { type: 'array', items: knowledgeHitSchema, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const limit = args.limit === undefined ? 5 : Math.min(20, Math.max(1, Math.trunc(args.limit)))
      return { hits: knowledge.search(args.query, limit) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_ingest',
    description: '把一段文字或一个网页 URL 写入个人知识库。用户说「记住这份资料 / 导入这篇文章」时调用；普通偏好与事实用 memory_write，不要混用。',
    parameters: {
      text: { type: 'string', description: '要导入的 Markdown / 纯文本；与 url 二选一' },
      url: { type: 'string', description: '网页地址（http/https）；与 text 二选一' },
      title: { type: 'string', description: '可选标题；不填时自动取首行标题' },
      source: { type: 'string', description: '可选来源说明（网页导入时默认用 URL）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          doc: { ...knowledgeDocSchema, required: true },
          duplicate: { type: 'boolean', required: true },
          chunkCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const hasText = typeof args.text === 'string' && args.text.trim().length > 0
      const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0
      if (!hasText && !hasUrl) throw new Error('text 与 url 至少提供一个')
      if (hasText && hasUrl) throw new Error('text 与 url 只能提供一个')
      let text: string
      let source: string | undefined
      let sourceKind: 'text' | 'url'
      let title: string | undefined
      if (hasUrl) {
        const page = await fetchUrlPage(ctx, args.url!.trim(), exec.signal)
        text = page.text
        source = args.source?.trim() || page.url
        sourceKind = 'url'
        title = args.title?.trim() || page.title
      } else {
        text = args.text!
        source = args.source?.trim() || '手动导入'
        sourceKind = 'text'
        title = args.title?.trim()
      }
      const result = await knowledge.ingest({
        text,
        ...(title === undefined || title.length === 0 ? {} : { title }),
        ...(source === undefined ? {} : { source }),
        sourceKind,
      })
      const doc: KnowledgeDocSummary = knowledgeDocSummary(result.doc)
      return { doc, duplicate: result.duplicate, chunkCount: result.doc.chunks.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_list',
    description: '列出个人知识库里的文档（标题、来源、字数、分块数）。用户问「知识库里有什么」时调用。',
    parameters: {
      limit: { type: 'integer', description: '返回条数上限，默认 20，最多 100' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docs: { type: 'array', items: knowledgeDocSchema, required: true },
          total: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const limit = args.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(args.limit)))
      const docs: KnowledgeDocSummary[] = knowledge.list().slice(0, limit).map(knowledgeDocSummary)
      return { docs, total: knowledge.list().length }
    },
  }))
}

const automationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    kind: { type: 'string', enum: [...AUTOMATION_KINDS], required: true },
    enabled: { type: 'boolean', required: true },
    email: { type: 'boolean', required: true },
    scheduleKind: { type: 'string', enum: [...AUTOMATION_SCHEDULE_KINDS], required: true },
    everyMinutes: { type: 'number' },
    at: { type: 'string' },
    weekday: { type: 'number' },
    url: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    nextRunAt: { type: 'number', required: true },
    lastRunAt: { type: 'number' },
    lastSummary: { type: 'string' },
    createdAt: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
  },
} as const

/** 工具返回的扁平调度视图（模型比嵌套联合更好读）。 */
function automationToolView(entry: Automation): {
  id: string
  title: string
  kind: Automation['kind']
  enabled: boolean
  email: boolean
  scheduleKind: AutomationSchedule['kind']
  everyMinutes?: number
  at?: string
  weekday?: number
  url?: string
  keywords?: string[]
  prompt?: string
  nextRunAt: number
  lastRunAt?: number
  lastSummary?: string
  createdAt: number
  updatedAt: number
} {
  const schedule = entry.schedule
  return {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    enabled: entry.enabled,
    email: entry.email,
    scheduleKind: schedule.kind,
    ...schedule.kind === 'interval' ? { everyMinutes: schedule.everyMinutes } : {},
    ...schedule.kind === 'daily' ? { at: schedule.at } : {},
    ...schedule.kind === 'weekly' ? { weekday: schedule.weekday, at: schedule.at } : {},
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.keywords === undefined ? {} : { keywords: entry.keywords }),
    ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
    nextRunAt: entry.nextRunAt,
    ...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
    ...(entry.lastSummary === undefined ? {} : { lastSummary: entry.lastSummary }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/** 注册自动化工具。 */
export function registerAutomationTools(ctx: Context, automations: AutomationStore): void {
  ctx.tools.register(defineTool({
    name: 'automation_create',
    description: '创建定时自动化。kind=web 监控网页变化；kind=keyword 监控网页关键词命中；kind=prompt 定时执行一段任务并把结果放进收件箱。用户说「每天监控这个网页」「有 XX 关键词就提醒我」「每天早上总结…」时调用。',
    parameters: {
      kind: { type: 'string', enum: AUTOMATION_KINDS, required: true, description: '自动化类型' },
      title: { type: 'string', required: true, description: '标题（不超过 120 字）' },
      schedule_kind: { type: 'string', enum: AUTOMATION_SCHEDULE_KINDS, required: true, description: '调度：interval 固定间隔 / daily 每天 / weekly 每周' },
      every_minutes: { type: 'integer', description: 'interval 时的间隔分钟数（至少 1）' },
      at: { type: 'string', description: 'daily / weekly 时的运行时间（HH:mm，如 08:30）' },
      weekday: { type: 'integer', description: 'weekly 时的星期：0=周日 … 6=周六' },
      url: { type: 'string', description: 'web / keyword 的监控网页 URL（http/https）' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'keyword 时的关键词（最多 10 个）' },
      prompt: { type: 'string', description: 'prompt 时的任务描述；执行者看不到当前对话，请写完整、自包含' },
      email: { type: 'boolean', description: '命中/完成时是否额外发邮件，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { automation: { ...automationSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const schedule: AutomationSchedule = args.schedule_kind === 'interval'
        ? { kind: 'interval', everyMinutes: args.every_minutes ?? 0 }
        : args.schedule_kind === 'daily'
          ? { kind: 'daily', at: args.at ?? '' }
          : { kind: 'weekly', weekday: args.weekday ?? -1, at: args.at ?? '' }
      const entry = await automations.create({
        title: args.title,
        kind: args.kind,
        schedule,
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.keywords === undefined ? {} : { keywords: args.keywords }),
        ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        ...(args.email === undefined ? {} : { email: args.email }),
      })
      return { automation: automationToolView(entry) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_list',
    description: '列出用户的自动化任务（含下次运行时间、上次结果与暂停状态）。用户问「我有哪些自动化」时调用。',
    parameters: {
      limit: { type: 'integer', description: '返回条数上限，默认 20，最多 100' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          automations: { type: 'array', items: automationSchema, required: true },
          total: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const limit = args.limit === undefined ? 20 : Math.min(100, Math.max(1, Math.trunc(args.limit)))
      return {
        automations: automations.list().slice(0, limit).map(automationToolView),
        total: automations.list().length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_pause',
    description: '暂停或恢复一个自动化任务。用户说「先停掉这个监控 / 恢复监控」时调用。',
    parameters: {
      id: { type: 'string', required: true, description: '自动化 id' },
      paused: { type: 'boolean', description: 'true 暂停，false 恢复；默认 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { automation: { ...automationSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const paused = args.paused !== false
      const entry = await automations.setEnabled(args.id, !paused)
      if (entry === undefined) throw new Error(`自动化不存在：${args.id}`)
      return { automation: automationToolView(entry) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'automation_delete',
    description: '删除一个自动化任务及其运行历史。用户明确要求删除时调用。',
    parameters: {
      id: { type: 'string', required: true, description: '自动化 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { deleted: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { deleted: await automations.remove(args.id) }
    },
  }))
}
