/**
 * 会话结束后的记忆抽取。
 *
 * 用一次独立的低温度模型调用，把「用户 + 助手」这一轮对话压缩成少量
 * 可长期复用的记忆候选；失败、超时或输出不可解析时一律返回空数组，
 * 不影响对话主链路。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MEMORY_KINDS, type MemoryCandidate, type MemoryKind } from './memory-store.ts'

/** 抽取输入。 */
export interface MemoryExtractInput {
  userText: string
  assistantText: string
}

/** 单轮对话原文上限（字符）。 */
const MAX_TRANSCRIPT = 6000
/** 单次抽取返回上限。 */
const MAX_CANDIDATES = 8
/** 单次抽取模型调用超时。 */
const EXTRACT_TIMEOUT_MS = 25_000

const KIND_SET = new Set<string>(MEMORY_KINDS)

const SYSTEM_PROMPT = `你是个人助理的记忆抽取器。请从一轮对话中提取值得长期记住的信息。

只提取以下五类：
- fact：关于用户的稳定事实（所在地、职业、设备、习惯等）
- preference：用户明确表达或反复体现的偏好（回答风格、工具选择、忌讳）
- person：与用户有关的人物及其关系
- project：用户正在推进的长期项目、目标或关注领域
- decision：用户明确做出的决定或约定

不要提取：
- 一次性任务细节、临时查询、寒暄
- 助手自己的推测、建议或工具返回的临时数据
- 没有用户依据的结论

输出 JSON 数组，最多 8 条；没有值得记住的内容时输出 []。
每项格式：{"kind":"fact|preference|person|project|decision","text":"...","tags":["..."],"confidence":0.0}
text 用第三人称、完整可独立理解的短句，不超过 80 字。`

/**
 * 解析模型输出为候选记忆；非法项跳过。
 * @param raw - 模型返回的文本（可能带 Markdown 围栏）。
 */
export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed)
  const text = fenced?.[1]?.trim() ?? trimmed
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    try {
      payload = JSON.parse(text.slice(start, end + 1))
    } catch {
      return []
    }
  }
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { memories?: unknown }).memories)
      ? (payload as { memories: unknown[] }).memories
      : []
  const out: MemoryCandidate[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { kind?: unknown; text?: unknown; tags?: unknown; confidence?: unknown }
    if (typeof record.kind !== 'string' || !KIND_SET.has(record.kind)) continue
    if (typeof record.text !== 'string') continue
    const content = record.text.trim()
    if (content.length === 0) continue
    const tags = Array.isArray(record.tags)
      ? record.tags
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map(tag => tag.trim().slice(0, 32))
        .slice(0, 5)
      : []
    const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : undefined
    out.push({
      kind: record.kind as MemoryKind,
      text: content.length <= 500 ? content : content.slice(0, 500),
      ...(tags.length > 0 ? { tags } : {}),
      ...(confidence === undefined ? {} : { confidence }),
    })
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

/**
 * 创建抽取函数。
 * @param ctx - 插件上下文（使用 ctx.llm.stream）。
 * @param route - 当前生效的 provider / model（每次调用时读取）。
 */
export function createMemoryExtractor(
  ctx: Context,
  route: () => { provider: string; model: string },
): (input: MemoryExtractInput) => Promise<MemoryCandidate[]> {
  return async (input: MemoryExtractInput): Promise<MemoryCandidate[]> => {
    const userText = input.userText.trim()
    if (userText.length < 2) return []
    const transcript = clipTranscript(`用户：${userText}\n助手：${input.assistantText.trim()}`)
    const { provider, model } = route()
    let text = ''
    const stream = ctx.llm.stream({
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: transcript }],
          source: { kind: 'user' },
        }),
      ],
      temperature: 0,
      maxTokens: 800,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure.message)
      }
    }
    return parseMemoryCandidates(text)
  }
}

/** 截断过长对话，优先保留用户部分。 */
function clipTranscript(text: string): string {
  return text.length <= MAX_TRANSCRIPT ? text : `${text.slice(0, MAX_TRANSCRIPT)}\n…（已截断）`
}
