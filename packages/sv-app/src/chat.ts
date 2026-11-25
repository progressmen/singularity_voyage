/**
 * SV 聊天服务：管理 SV 页面驱动的 agent 会话，并把 agent 事件转发为
 * SSE 事件流。
 *
 * - 通过 `ctx.agents.create/resume` 建立无 preset 的 SV 会话（全局工具面：
 *   web_search / web_fetch 等宿主行）；
 * - 在 agent 作用域内订阅 `agent/assistant-stream`、`tools/result`、
 *   `agent/status`，转发给当前挂载的 SSE sink；工具调用按 `callId` 关联
 *   start/end，携带参数与结果摘要（供前端 trace 面板展开）；
 * - 会话自动持久化（由 dsh-base 的 session-persistence-jsonl 负责），
 *   进程重启后按 sessionId resume；同时在 $DSH_HOME/sv 维护索引与
 *   transcript 投影（SessionStore）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { defaultContextWindow } from './config-store.ts'
import type { ConfigStore } from './config-store.ts'
import { SV_PROVIDER_ID } from './llm-adapter.ts'
import { svError, svLog } from './log.ts'
import type { SessionUsage, SvSessionStore, TranscriptToolEntry } from './sessions-store.ts'

/** 转发给页面的 SSE 事件。 */
export type SvChatEvent =
  | { type: 'session'; sessionId: string; images?: readonly ImageAttachmentRef[] }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | {
    type: 'tool'
    callId: string
    name: string
    phase: 'start' | 'end'
    /** start：模型请求参数（JSON 文本，已截断）。 */
    args?: string
    isError?: boolean
    /** end：执行结果摘要（成功 value / 失败 error 的 JSON 文本，已截断）。 */
    result?: string
    durationMs?: number
  }
  | { type: 'message'; text: string; reasoning: string }
  /** 本轮产出的文件（文件工具写入成功后的绝对路径）。 */
  | { type: 'file'; path: string }
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'error'; message: string }
  | { type: 'done' }

/** SSE 载荷截断上限（参数与结果摘要）。 */
const CLIP_BYTES = 2048

/** transcript 工具参数摘要上限。 */
const TRANSCRIPT_ARGS_BYTES = 200

/** 把任意值序列化为可读文本并截断；序列化失败时退化为 String()。 */
function clip(value: unknown, max = CLIP_BYTES): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 把一段文本追加到累计值；空段忽略，段间以空行分隔。 */
function appendBlock(target: string, chunk: string): string {
  const text = chunk.trim()
  if (text.length === 0) return target
  return target.length === 0 ? text : `${target}\n\n${text}`
}

/** 产出文件的内置工具：成功结果里的 path 即绝对路径。 */
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 从工具结果或参数里取出被写入的文件路径。 */
function producedFilePath(name: string, value: unknown, args: string | undefined): string | undefined {
  if (!FILE_TOOLS.has(name)) return undefined
  if (typeof value === 'object' && value !== null) {
    const path = (value as { path?: unknown }).path
    if (typeof path === 'string' && path.length > 0) return path
  }
  if (args !== undefined) {
    try {
      const parsed: unknown = JSON.parse(args)
      if (typeof parsed === 'object' && parsed !== null) {
        const path = (parsed as { file_path?: unknown; path?: unknown }).file_path
          ?? (parsed as { path?: unknown }).path
        if (typeof path === 'string' && path.length > 0) return path
      }
    } catch {
      // 参数不是 JSON（已被截断）：忽略
    }
  }
  return undefined
}

/** 一轮对话结束后的回调输入（用于异步记忆抽取与后台完成通知）。 */
export interface ChatTurnComplete {
  sessionId: string
  userText: string
  assistantText: string
  /** 页面是否仍有 SSE 在监听；false 表示本轮在后台完成。 */
  attended: boolean
}

/** 非 chat.run 触发的轮次（例如宿主定时任务投递回会话）完成后的回调。 */
export interface ChatDetachedTurn {
  sessionId: string
  assistantText: string
}

/** 可选钩子；未提供时 ChatManager 行为不变。 */
export interface ChatHooks {
  onTurnComplete?(input: ChatTurnComplete): void
  onDetachedTurn?(input: ChatDetachedTurn): void
}

/** 一个活跃 SV 会话的运行时记录。 */
interface LiveSession {
  sessionId: string
  agent: Agent
  sinks: Set<(event: SvChatEvent) => void>
  status: 'running' | 'idle'
  /** 当前 assistant 消息的文本缓冲（start 帧清空）。 */
  textBuf: string
  /** 当前 assistant 消息的思考缓冲（start 帧清空）。 */
  reasoningBuf: string
  /** callId → 工具开始信息（name / 起始时间 / 参数摘要）。 */
  pendingTools: Map<string, { name: string; startTs: number; args: string }>
  /** 本轮（用户消息 → agent 空闲）累计的 assistant 文本。 */
  turnText: string
  /** 本轮累计的思考过程；多条 assistant 消息之间以空行合并。 */
  turnReasoning: string
  /** 本轮完成的工具摘要（跨多条 assistant 消息，供 transcript）。 */
  turnTools: TranscriptToolEntry[]
  /** 本轮开始时间（ms），用于日志里的耗时。 */
  turnStartTs: number
  /** 本轮用户输入字符数（日志只记长度，不记正文）。 */
  turnUserChars: number
  /** 创建/恢复得到的句柄；切换模型时用于销毁旧的 agent。 */
  handle?: AgentHandle
  /** 当前 agent 创建时使用的模型 id。 */
  modelId?: string
  /** 会话累计 token 统计与上下文占用（resume 时从索引恢复）。 */
  usage?: SessionUsage
  /** 是否有 chat.run 正在消费本轮（区分页面发起与宿主投递）。 */
  runActive?: boolean
  /** 非 chat.run 启动的轮次（例如定时任务投递）是否正在进行。 */
  detachedTurn?: boolean
}

export class ChatManager {
  private readonly live = new Map<string, LiveSession>()
  /** sessionId → 最近一次用户输入（供 Prompt 记忆召回）。 */
  private readonly latestUser = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly store: ConfigStore,
    private readonly sessions: SvSessionStore,
    private readonly hooks: ChatHooks = {},
  ) {}

  /** 最近一次用户输入；未知会话返回空串。 */
  latestUserText(sessionId: string | undefined): string {
    if (sessionId === undefined) return ''
    return this.latestUser.get(sessionId) ?? ''
  }

  private agentOptions(): { provider: string; model: string } {
    return { provider: SV_PROVIDER_ID, model: this.store.llm.model }
  }

  /** 在 agent 作用域内挂接事件转发（create 与 resume 共用）。 */
  private wire(agentCtx: Context, rec: LiveSession): void {
    agentCtx.on('agent/status', ({ status }) => {
      rec.status = status
      this.emit(rec, { type: 'status', status })
      // chat.run 发起的轮次由 run 的 whenIdle 统一收尾；这里只处理宿主
      // 直接投递到会话的轮次（例如定时任务到点后的继续处理）。
      if (rec.runActive === true) return
      if (status === 'running') {
        this.resetTurn(rec)
        rec.detachedTurn = true
        return
      }
      if (status === 'idle' && rec.detachedTurn === true) {
        rec.detachedTurn = false
        // 等当前 dispatch 收尾，确保 assistant/end 的 commit 已写入 turnText。
        setTimeout(() => this.finishDetachedTurn(rec), 0)
      }
    })
    agentCtx.on('agent/assistant-stream', ({ frame }) => {
      this.onStreamFrame(rec, frame)
    })
    agentCtx.on('tools/result', (exec, result) => {
      this.onToolResult(rec, exec, result)
    })
  }

  /** 工具执行结束：按 callId 关联开始信息，产出 end 事件与 transcript 摘要。 */
  private onToolResult(rec: LiveSession, exec: ToolExecution, result: ToolExecutionResult): void {
    const callId = String(exec.callId)
    const pending = rec.pendingTools.get(callId)
    rec.pendingTools.delete(callId)
    const name = pending?.name ?? exec.name
    const args = pending?.args ?? clip(exec.arguments, TRANSCRIPT_ARGS_BYTES)
    const durationMs = pending === undefined ? undefined : Date.now() - pending.startTs
    this.logToolCall(rec.sessionId, name, args, result.isError, durationMs)
    const payload = result.isError ? result.error : result.value
    this.emit(rec, {
      type: 'tool',
      callId,
      name,
      phase: 'end',
      isError: result.isError,
      ...(payload === undefined ? {} : { result: clip(payload) }),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    if (!result.isError) {
      const path = producedFilePath(name, result.value, args)
      if (path !== undefined) this.emit(rec, { type: 'file', path })
    }
    rec.turnTools.push({
      name,
      args: clip(args, TRANSCRIPT_ARGS_BYTES),
      ...(result.isError ? { isError: true } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
  }

  /**
   * 记录一次工具调用：分型（内置 / MCP / 技能），参数只留一行摘要，不落结果正文。
   * @param sessionId - 所属会话。
   * @param name - 工具名（MCP 形如 `mcp__server__tool`）。
   * @param args - 参数原文（会被压成单行并截断）。
   * @param isError - 是否失败。
   * @param durationMs - 执行耗时。
   */
  private logToolCall(
    sessionId: string,
    name: string,
    args: string,
    isError: boolean,
    durationMs: number | undefined,
  ): void {
    const summary = args.replace(/\s+/g, ' ').trim().slice(0, 60)
    const fields: Record<string, string | number | boolean> = { sessionId }
    if (name === 'skill') {
      fields.kind = 'skill'
      fields.name = name
    } else if (name.startsWith('mcp__')) {
      const [server, ...rest] = name.slice('mcp__'.length).split('__')
      fields.kind = 'mcp'
      fields.server = server ?? 'unknown'
      fields.name = rest.join('__')
    } else {
      fields.kind = 'tool'
      fields.name = name
    }
    if (summary.length > 0) fields.args = summary
    fields.ok = !isError
    if (durationMs !== undefined) fields.durationMs = durationMs
    if (isError) this.ctx.logger.warn(svLog('tool', 'tool_call', fields))
    else this.ctx.logger.info(svLog('tool', 'tool_call', fields))
  }

  private emit(rec: LiveSession, event: SvChatEvent): void {
    for (const sink of rec.sinks) {
      try {
        sink(event)
      } catch {
        // 单个 sink 故障不影响其他 sink 与 agent 本身
      }
    }
  }

  /** 清空一轮的累计缓冲（用户发起与宿主投递的轮次共用）。 */
  private resetTurn(rec: LiveSession): void {
    rec.turnStartTs = Date.now()
    rec.turnUserChars = 0
    rec.textBuf = ''
    rec.reasoningBuf = ''
    rec.turnText = ''
    rec.turnReasoning = ''
    rec.turnTools = []
    rec.pendingTools.clear()
  }

  /**
   * 收尾一个宿主投递的轮次：写入 transcript / token 统计，并通知订阅方
   * （用于收件箱记录「定时任务已完成」）。没有文本输出时只跳过通知。
   */
  private finishDetachedTurn(rec: LiveSession): void {
    const assistantText = rec.turnText
    if (assistantText.trim().length === 0) return
    this.ctx.logger.info(svLog('chat', 'turn_completed', {
      sessionId: rec.sessionId,
      model: this.store.llm.model,
      userChars: 0,
      replyChars: assistantText.length,
      tools: rec.turnTools.length,
      durationMs: rec.turnStartTs === 0 ? 0 : Date.now() - rec.turnStartTs,
      source: 'host',
    }))
    void this.sessions.recordAssistant(rec.sessionId, rec.turnText, rec.turnReasoning, rec.turnTools)
      .catch(error => {
        this.ctx.logger.warn(svLog('chat', 'transcript_record_failed', {
          sessionId: rec.sessionId,
          err: svError(error),
        }))
      })
    if (rec.usage !== undefined) {
      void this.sessions.recordUsage(rec.sessionId, rec.usage).catch(error => {
        this.ctx.logger.warn(svLog('chat', 'usage_record_failed', {
          sessionId: rec.sessionId,
          err: svError(error),
        }))
      })
    }
    try {
      this.hooks.onDetachedTurn?.({ sessionId: rec.sessionId, assistantText })
    } catch (error) {
      this.ctx.logger.warn(svLog('chat', 'turn_hook_failed', {
        sessionId: rec.sessionId,
        err: svError(error),
      }))
    }
  }

  /** 当前会话的上下文窗口：设置页配置优先，否则按供应商预设估算。 */
  private contextWindow(): number | undefined {
    const configured = this.store.llm.contextWindow
    if (configured !== undefined && configured > 0) return configured
    return defaultContextWindow(this.store.llm.provider)
  }

  /**
   * 累计一次模型请求的 token 统计并推送快照。
   * 上下文占用取本次请求的 prompt 总量（非缓存输入 + 缓存读写），
   * 与 dsh 的 TokenUsage 口径一致（各计数互不包含）。
   */
  private accumulateUsage(rec: LiveSession, usage: TokenUsage): void {
    const prev = rec.usage
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    // provider 未给 total 时按「prompt + completion」口径自行合成
    const total = usage.totalTokens ?? usage.inputTokens + cacheRead + cacheWrite + usage.outputTokens
    const contextWindow = this.contextWindow()
    rec.usage = {
      inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + cacheRead,
      totalTokens: (prev?.totalTokens ?? 0) + total,
      contextTokens: usage.inputTokens + cacheRead + cacheWrite,
      ...contextWindow === undefined ? {} : { contextWindow },
      updatedAt: Date.now(),
    }
    this.emit(rec, { type: 'usage', usage: rec.usage })
  }

  private onStreamFrame(rec: LiveSession, frame: AssistantStreamFrame): void {
    switch (frame.type) {
      case 'start':
        // 只清当前消息缓冲；本轮累计（文本 / 思考 / 工具）跨消息保留
        rec.textBuf = ''
        rec.reasoningBuf = ''
        break
      case 'chunk': {
        const chunk = frame.chunk
        if (chunk.type === 'text-delta') {
          rec.textBuf += chunk.text
          this.emit(rec, { type: 'text-delta', text: chunk.text })
        } else if (chunk.type === 'reasoning-delta') {
          rec.reasoningBuf += chunk.text
          this.emit(rec, { type: 'reasoning-delta', text: chunk.text })
        } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const callId = String(chunk.block.id)
          const args = clip(chunk.block.arguments)
          rec.pendingTools.set(callId, { name: chunk.block.name, startTs: Date.now(), args })
          this.emit(rec, { type: 'tool', callId, name: chunk.block.name, phase: 'start', args })
        } else if (chunk.type === 'usage') {
          this.accumulateUsage(rec, chunk.usage)
        } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          this.ctx.logger.warn(svLog('chat', 'turn_failed', {
            sessionId: rec.sessionId,
            model: this.store.llm.model,
            durationMs: rec.turnStartTs === 0 ? 0 : Date.now() - rec.turnStartTs,
            err: chunk.reason.failure.message,
          }))
          this.emit(rec, { type: 'error', message: chunk.reason.failure.message })
        }
        break
      }
      case 'end':
        if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') {
          // 一轮可能有多条 assistant 消息（工具调用前后各一条）：
          // 按轮累计文本与思考，页面只看到一段合并后的 assistant 消息。
          rec.turnText = appendBlock(rec.turnText, rec.textBuf)
          rec.turnReasoning = appendBlock(rec.turnReasoning, rec.reasoningBuf)
          this.emit(rec, { type: 'message', text: rec.turnText, reasoning: rec.turnReasoning })
        }
        break
    }
  }

  /** 取得（或创建/恢复）一个 SV 会话。 */
  async ensure(requested?: string): Promise<string> {
    const newRec = (sessionId: string): LiveSession => {
      // resume 时沿用已持久化的累计统计，避免重启后从 0 重新计
      const usage = this.sessions.list().find(entry => entry.id === sessionId)?.usage
      return {
        sessionId,
        agent: undefined as unknown as Agent,
        sinks: new Set(),
        status: 'idle',
        textBuf: '',
        reasoningBuf: '',
        pendingTools: new Map(),
        turnText: '',
        turnReasoning: '',
        turnTools: [],
        turnStartTs: 0,
        turnUserChars: 0,
        ...usage === undefined ? {} : { usage },
      }
    }
    if (requested !== undefined && requested.length > 0) {
      const existing = this.live.get(requested)
      if (existing !== undefined) {
        // 模型在页面切换后，空闲会话销毁旧 agent，下一条消息按新模型 resume；
        // 正在生成时保持旧模型跑完本轮，避免中途断开。
        if (existing.modelId === undefined || existing.modelId === this.store.llm.model || existing.status === 'running') {
          return requested
        }
        await this.retire(existing)
      }
      try {
        const rec = newRec(requested)
        rec.modelId = this.store.llm.model
        const handle: AgentHandle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(requested),
          agentOptions: this.agentOptions(),
          setup: agentCtx => {
            this.wire(agentCtx, rec)
          },
        })
        rec.agent = handle.agent
        rec.handle = handle
        this.live.set(requested, rec)
        void this.sessions.register(requested).catch(() => {})
        this.ctx.logger.info(svLog('chat', 'session_resumed', { sessionId: requested }))
        return requested
      } catch (error) {
        this.ctx.logger.warn(svLog('chat', 'session_resume_failed', {
          sessionId: requested,
          err: svError(error),
        }))
      }
    }
    const sessionId = randomUUID()
    const rec = newRec(sessionId)
    rec.modelId = this.store.llm.model
    const handle: AgentHandle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      agentOptions: this.agentOptions(),
      setup: agentCtx => {
        this.wire(agentCtx, rec)
      },
    })
    rec.agent = handle.agent
    rec.handle = handle
    this.live.set(sessionId, rec)
    void this.sessions.register(sessionId).catch(() => {})
    this.ctx.logger.info(svLog('chat', 'session_created', {
      sessionId,
      model: this.store.llm.model,
    }))
    return sessionId
  }

  /** 销毁一个空闲会话的 agent（保留会话数据，下条消息按新模型 resume）。 */
  private async retire(rec: LiveSession): Promise<void> {
    const handle = rec.handle
    delete rec.handle
    this.live.delete(rec.sessionId)
    if (handle === undefined) return
    try {
      await handle.dispose()
      this.ctx.logger.info(svLog('chat', 'session_model_switched', { sessionId: rec.sessionId, model: this.store.llm.model }))
    } catch (error) {
      this.ctx.logger.warn(svLog('chat', 'session_retire_failed', {
        sessionId: rec.sessionId,
        err: svError(error),
      }))
    }
  }

  /** 当前会话状态；未知会话返回 idle。 */
  status(sessionId: string): 'running' | 'idle' {
    return this.live.get(sessionId)?.status ?? 'idle'
  }

  /** 中止当前轮次。 */
  stop(sessionId: string): boolean {
    const rec = this.live.get(sessionId)
    if (rec === undefined) return false
    rec.agent.cancel({ kind: 'user' })
    return true
  }

  /**
   * 在一轮正在生成的回答中插入一条用户消息（steer）。
   * 消息在 agent 的下一个 step 边界被消费，不中止当前轮次；
   * 空闲或没有 SSE 订阅者时拒绝，避免消息在无人接收时开启新轮。
   */
  steer(sessionId: string, text: string): { ok: true } | { ok: false; error: string } {
    const rec = this.live.get(sessionId)
    if (rec === undefined) return { ok: false, error: '会话不存在或已结束' }
    if (rec.status !== 'running' || rec.sinks.size === 0) {
      return { ok: false, error: '当前没有正在生成的回答' }
    }
    try {
      rec.agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.latestUser.set(sessionId, text)
    rec.turnUserChars += text.length
    void this.sessions.recordUser(sessionId, text).catch(() => {})
    return { ok: true }
  }

  /**
   * 发送一条用户消息并流式产出事件，直到 agent 空闲。
   * @param requested - 客户端持有的会话 id（可空）。
   * @param text - 用户输入文本；图片消息可以为空串。
   * @param images - 已通过附件服务准入的图片引用，按用户选择顺序排列。
   * @param context - 可选的上文注入（编辑重发 / 重新生成的分支上下文），
   *   只进入模型输入，不写入 transcript，也不作为会话标题。
   */
  async *run(
    requested: string | undefined,
    text: string,
    images: readonly ImageAttachmentRef[] = [],
    context?: string,
  ): AsyncGenerator<SvChatEvent> {
    const sessionId = await this.ensure(requested)
    const rec = this.live.get(sessionId)
    if (rec === undefined) {
      yield { type: 'error', message: 'sv-app: 会话初始化失败' }
      yield { type: 'done' }
      return
    }
    this.latestUser.set(sessionId, text)
    this.resetTurn(rec)
    rec.runActive = true
    rec.turnUserChars = text.length
    void this.sessions.recordUser(sessionId, text).catch(() => {})

    const queue: SvChatEvent[] = []
    let wake: (() => void) | undefined
    let finished = false
    const push = (event: SvChatEvent): void => {
      queue.push(event)
      wake?.()
    }

    push({ type: 'session', sessionId, ...images.length === 0 ? {} : { images } })
    rec.sinks.add(push)

    const content: ContentBlock[] = []
    const prefix = context?.trim()
    if (prefix !== undefined && prefix.length > 0) {
      content.push({ type: 'text', text: `以下是此前的对话，供你理解上下文：\n\n${prefix}\n\n---\n\n${text}` })
    } else if (text.length > 0) {
      content.push({ type: 'text', text })
    }
    for (const image of images) content.push({ type: 'image', attachment: image })

    let followupError: string | undefined
    try {
      rec.agent.followup(createUserMessage({
        content,
        source: { kind: 'user' },
      }))
    } catch (error) {
      followupError = error instanceof Error ? error.message : String(error)
    }
    if (followupError !== undefined) {
      this.ctx.logger.warn(svLog('chat', 'turn_failed', {
        sessionId,
        model: this.store.llm.model,
        durationMs: rec.turnStartTs === 0 ? 0 : Date.now() - rec.turnStartTs,
        err: followupError,
      }))
      push({ type: 'error', message: `sv-app: 消息投递失败: ${followupError}` })
      push({ type: 'done' })
    } else {
      void rec.agent.whenIdle().then(
        () => {
          const assistantText = rec.turnText
          if (assistantText.trim().length > 0) {
            try {
              // 页面已关闭时 sinks 为空：本轮在后台完成，需要进收件箱。
              this.hooks.onTurnComplete?.({ sessionId, userText: text, assistantText, attended: rec.sinks.size > 0 })
            } catch (error) {
              this.ctx.logger.warn(svLog('chat', 'turn_hook_failed', { sessionId, err: svError(error) }))
            }
          }
          // 只记元信息（长度、耗时、工具数），不落问答正文。
          this.ctx.logger.info(svLog('chat', 'turn_completed', {
            sessionId,
            model: this.store.llm.model,
            userChars: rec.turnUserChars,
            replyChars: rec.turnText.length,
            tools: rec.turnTools.length,
            durationMs: rec.turnStartTs === 0 ? 0 : Date.now() - rec.turnStartTs,
          }))
          // 一轮只落一条 transcript：多条 assistant 消息的思考合并，工具跨消息保留。
          if (rec.turnText.length > 0 || rec.turnReasoning.length > 0 || rec.turnTools.length > 0) {
            void this.sessions.recordAssistant(sessionId, rec.turnText, rec.turnReasoning, rec.turnTools)
              .catch(error => {
                this.ctx.logger.warn(svLog('chat', 'transcript_record_failed', {
                  sessionId,
                  err: svError(error),
                }))
              })
          }
          // token 统计按轮落盘，供历史会话与重启后的顶栏展示
          if (rec.usage !== undefined) {
            void this.sessions.recordUsage(sessionId, rec.usage).catch(error => {
              this.ctx.logger.warn(svLog('chat', 'usage_record_failed', {
                sessionId,
                err: svError(error),
              }))
            })
          }
          push({ type: 'done' })
          finished = true
          wake?.()
        },
        (error: unknown) => {
          push({ type: 'error', message: `sv-app: agent 结束异常: ${error instanceof Error ? error.message : String(error)}` })
          push({ type: 'done' })
          finished = true
          wake?.()
        },
      )
    }

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!
        if (finished) break
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    } finally {
      rec.sinks.delete(push)
      rec.runActive = false
    }
  }
}
