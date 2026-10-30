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
import { defineTool } from '@deepseek-ai/dsh-tools'
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
export function registerTaskTools(ctx: Context, tasks: TasksStore): void {
  ctx.tools.register(defineTool({
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
