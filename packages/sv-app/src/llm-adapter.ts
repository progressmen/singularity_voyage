/**
 * SV 自定义 LLM 适配器：任意 OpenAI 兼容端点（DeepSeek、OpenAI、网关、自托管）。
 *
 * 以 Cordis 插件形式注册到 `ctx.llm`（provider 路由 id: `sv-openai`）；
 * token 与端点来自 {@linkcode ConfigStore}，按请求读取，页面保存后立即生效。
 *
 * 实现遵循 dsh-llm 的 StreamChunk 协议：
 * block-start → (text|reasoning)-delta* → block-end → usage → finish。
 */
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SvLlmConfig } from './config-store.ts'

/** 注册到 ctx.llm 的 provider 路由 id。 */
export const SV_PROVIDER_ID = 'sv-openai'

/** 流式空闲看门狗：超过该时长没有任何分片则终止请求。 */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/** 一条 OpenAI chat.completions 线上消息。 */
interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** 线上 tools 声明。 */
interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 从内容块中挑出文本。 */
function textOfBlocks(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      parts.push((block as { text?: unknown }).text as string)
    }
  }
  return parts.join('\n')
}

/** 从内容块中挑出工具调用。 */
function toolCallsOfBlocks(content: readonly unknown[]): WireToolCall[] {
  const out: WireToolCall[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
    if (call.type !== 'tool-call') continue
    out.push({
      id: String(call.id ?? ''),
      type: 'function',
      function: {
        name: String(call.name ?? ''),
        arguments: typeof call.arguments === 'string' && call.arguments.length > 0 ? call.arguments : '{}',
      },
    })
  }
  return out
}

/** 把 harness 消息投影为 OpenAI 兼容 wire 消息（文本 + 工具调用/结果）。 */
function toWireMessages(options: GenerateOptions): WireMessage[] {
  const out: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages as readonly (RequestMessage & { content: readonly unknown[] })[]) {
    const text = textOfBlocks(message.content)
    switch (message.role) {
      case 'system':
      case 'developer':
        out.push({ role: 'system', content: text })
        break
      case 'user':
        out.push({ role: 'user', content: text })
        break
      case 'assistant': {
        const toolCalls = toolCallsOfBlocks(message.content)
        out.push({
          role: 'assistant',
          content: toolCalls.length > 0 && text.length === 0 ? null : text,
          ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        })
        break
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: String((message as RequestMessage & { toolCallId?: unknown }).toolCallId ?? ''),
          content: text,
        })
        break
    }
  }
  return out
}

/** harness 工具声明 → OpenAI tools 字段。 */
function toWireTools(tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined): WireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function statusToCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 400 && status < 500) return 'PROVIDER'
  if (status >= 500) return 'PROVIDER'
  return 'TRANSPORT'
}

async function providerHttpError(res: Response, context: string): Promise<LlmError> {
  let detail = ''
  try {
    const body = await res.text()
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string') detail = parsed.error.message
    } catch {
      detail = body
    }
  } catch {
    // 保留空 detail
  }
  detail = detail.trim().slice(0, 300)
  const retryAfter = res.headers.get('retry-after')
  let providerRetryAfterMs: number | undefined
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) providerRetryAfterMs = seconds * 1000
  }
  return new LlmError(
    `sv-app: ${context} 失败 (HTTP ${res.status})${detail.length > 0 ? `: ${detail}` : ''}`,
    statusToCode(res.status),
    { status: res.status, ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs } },
  )
}

/** 一次非流式 usage 快照。 */
function toUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const u = raw as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    prompt_cache_hit_tokens?: unknown
    prompt_cache_miss_tokens?: unknown
  }
  const input = typeof u.prompt_cache_miss_tokens === 'number'
    ? u.prompt_cache_miss_tokens
    : typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined
  if (input === undefined || output === undefined) return undefined
  const usage: TokenUsage = { inputTokens: input, outputTokens: output }
  if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens
  if (typeof u.prompt_cache_hit_tokens === 'number') usage.cacheReadTokens = u.prompt_cache_hit_tokens
  return usage
}

/** SV 的 OpenAI 兼容适配器。构造参数是“按请求读取当前配置”的回调。 */
export class SvOpenAiCompatAdapter extends LlmAdapter {
  constructor(private readonly options: () => SvLlmConfig) {
    super()
  }

  override providerInfo(): { id: string; name: string } {
    return { id: SV_PROVIDER_ID, name: 'SV OpenAI-Compatible' }
  }

  private requireApiKey(): string {
    const key = this.options().apiKey.trim()
    if (key.length === 0) {
      throw new LlmError(
        'sv-app: 尚未配置 LLM API key；请在 SV 页面（/sv → 设置）填写，或设置环境变量 SV_LLM_API_KEY',
        'INVALID_CREDENTIAL',
      )
    }
    return key
  }

  private chatCompletionsUrl(baseURL: string): string {
    return `${baseURL.replace(/\/+$/, '')}/chat/completions`
  }

  override async listModels(_provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const config = this.options()
    const apiKey = this.requireApiKey()
    let res: Response
    try {
      res = await fetch(`${config.baseURL.replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${apiKey}`, ...attributionHeaders() },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      throw new LlmError(`sv-app: 拉取模型列表失败: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error })
    }
    if (!res.ok) throw await providerHttpError(res, '拉取模型列表')
    const json = await res.json() as { data?: unknown }
    const entries = Array.isArray(json.data) ? json.data : []
    const models: LlmModelInfo[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) continue
      const name = (entry as { name?: unknown }).name
      models.push({ provider: SV_PROVIDER_ID, id, name: typeof name === 'string' && name.length > 0 ? name : id })
    }
    return models
  }

  override async resolveModel(
    _provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const config = this.options()
    if (model.trim().length === 0) throw new LlmError('sv-app: 模型 id 不能为空', 'UNKNOWN_MODEL')
    return {
      provider: SV_PROVIDER_ID,
      id: model,
      name: model,
      ...config.contextWindow === undefined ? {} : { context: { contextWindow: config.contextWindow } },
      ...config.maxTokens === undefined ? {} : { defaultMaxTokens: config.maxTokens },
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const config = this.options()
    const apiKey = this.requireApiKey()

    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])

    let timedOut = false
    let idleTimer: NodeJS.Timeout | undefined
    const pulse = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('sv-app: LLM 流式空闲超时'))
      }, STREAM_IDLE_TIMEOUT_MS)
    }

    try {
      pulse()
      const wireTools = toWireTools(options.tools)
      const body: Record<string, unknown> = {
        model: options.model,
        messages: toWireMessages(options),
        stream: true,
        stream_options: { include_usage: true },
        ...wireTools === undefined ? {} : { tools: wireTools, tool_choice: 'auto' },
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
      }
      const res = await fetch(this.chatCompletionsUrl(config.baseURL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      })
      if (!res.ok) throw await providerHttpError(res, '模型请求')
      if (res.body === null) throw new LlmError('sv-app: 模型响应没有 body', 'TRANSPORT')

      let textOpen = false
      let textBuf = ''
      let reasoningOpen = false
      let reasoningBuf = ''
      /** 线上 tool_calls 的 index → 已累积的调用。 */
      const toolBlocks = new Map<number, { index: number; id: string; name: string; args: string }>()
      let usage: TokenUsage | undefined
      let finish: FinishReason | undefined
      let sawDone = false

      const wire = Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>)
      const decoder = new TextDecoder()
      let carry = ''

      // handlePayload 同步填充 pending；外层循环按行 drain。
      const pending: StreamChunk[] = []

      // handlePayload 的 pending 声明已在前文；此处移除重复声明。
      const handlePayload = (payload: unknown): void => {
        if (typeof payload !== 'object' || payload === null) return
        const json = payload as {
          choices?: unknown
          usage?: unknown
        }
        const usageChunk = toUsage(json.usage)
        if (usageChunk !== undefined) usage = usageChunk
        const choices = Array.isArray(json.choices) ? json.choices : []
        const choice = choices[0]
        if (typeof choice !== 'object' || choice === null) return
        const { delta, finish_reason: finishReason } = choice as {
          delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }
          finish_reason?: unknown
        }
        const reasoningDelta = typeof delta?.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta?.reasoning === 'string' ? delta.reasoning : undefined
        if (reasoningDelta !== undefined && reasoningDelta.length > 0) {
          if (!reasoningOpen) {
            reasoningOpen = true
            pending.push({ type: 'block-start', index: 1, blockType: 'reasoning' })
          }
          reasoningBuf += reasoningDelta
          pending.push({ type: 'reasoning-delta', index: 1, text: reasoningDelta })
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          if (!textOpen) {
            textOpen = true
            pending.push({ type: 'block-start', index: 0, blockType: 'text' })
          }
          textBuf += delta.content
          pending.push({ type: 'text-delta', index: 0, text: delta.content })
        }
        const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
        for (const raw of toolDeltas) {
          if (typeof raw !== 'object' || raw === null) continue
          const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
          const slot = typeof call.index === 'number' && Number.isInteger(call.index) ? call.index : 0
          const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
          const name = typeof call.function?.name === 'string' && call.function.name.length > 0
            ? call.function.name
            : undefined
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          let state = toolBlocks.get(slot)
          if (state === undefined) {
            state = { index: 2 + slot, id: id ?? `call-${slot}`, name: name ?? '', args: '' }
            toolBlocks.set(slot, state)
            pending.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
          } else if (id !== undefined) {
            state.id = id
          }
          if (name !== undefined) state.name = name
          state.args += argumentsDelta
          pending.push({
            type: 'tool-call-delta',
            index: state.index,
            id: ToolCallId(state.id),
            ...name === undefined ? {} : { name },
            argumentsDelta,
          })
        }
        if (typeof finishReason === 'string' && finishReason.length > 0) {
          finish = finishReason === 'length'
            ? { kind: 'max-tokens' }
            : finishReason === 'tool_calls' ? { kind: 'tool-calls' } : { kind: 'stop' }
        }
      }

      outer: for await (const chunk of wire) {
        pulse()
        carry += decoder.decode(chunk as Uint8Array, { stream: true })
        let newlineAt: number
        while ((newlineAt = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, newlineAt).replace(/\r$/, '')
          carry = carry.slice(newlineAt + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data.length === 0) continue
          if (data === '[DONE]') {
            sawDone = true
            break outer
          }
          try {
            handlePayload(JSON.parse(data))
          } catch {
            // 跳过无法解析的行
          }
        }
        for (const item of pending.splice(0)) yield item
      }
      for (const item of pending.splice(0)) yield item

      if (!sawDone && signal.aborted) {
        throw new LlmError('sv-app: 模型请求被中止', 'ABORTED')
      }

      if (reasoningOpen) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoningBuf } }
      if (textOpen) yield { type: 'block-end', index: 0, block: { type: 'text', text: textBuf } }
      for (const state of [...toolBlocks.values()].sort((a, b) => a.index - b.index)) {
        yield {
          type: 'block-end',
          index: state.index,
          block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.args },
        }
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
    } catch (error) {
      if (timedOut) throw new LlmError('sv-app: LLM 流式空闲超时', 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError('sv-app: 模型请求被中止', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(`sv-app: 模型请求失败: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error })
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
  }
}
