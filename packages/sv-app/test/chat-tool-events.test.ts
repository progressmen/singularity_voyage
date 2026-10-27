/**
 * ChatManager 工具事件单测：通过注入桩对象直接驱动私有事件处理逻辑，
 * 验证 start/end 按 callId 关联、结果摘要、transcript 条目与 sink 容错。
 * 不创建真实 agent / LLM 连接。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatManager, type SvChatEvent } from '../src/chat.ts'
import type { SessionUsage, TranscriptToolEntry } from '../src/sessions-store.ts'

type AnyRec = {
  sessionId: string
  agent: unknown
  sinks: Set<(event: SvChatEvent) => void>
  status: 'running' | 'idle'
  textBuf: string
  reasoningBuf: string
  pendingTools: Map<string, { name: string; startTs: number; args: string }>
  turnText: string
  turnReasoning: string
  turnTools: TranscriptToolEntry[]
  usage?: SessionUsage
}

function makeChat(llm: Record<string, unknown> = { provider: 'custom', model: 'test-model' }) {
  const ctx = { logger: { info() {}, warn() {}, debug() {}, error() {} } }
  const chat = new ChatManager(ctx as never, { llm } as never, {} as never)
  const rec: AnyRec = {
    sessionId: 's1',
    agent: undefined,
    sinks: new Set(),
    status: 'idle',
    textBuf: '',
    reasoningBuf: '',
    pendingTools: new Map(),
    turnText: '',
    turnReasoning: '',
    turnTools: [],
  }
  ;(chat as unknown as { live: Map<string, AnyRec> }).live.set('s1', rec)
  const events: SvChatEvent[] = []
  rec.sinks.add(event => events.push(event))
  return { chat, rec, events }
}

test('block-end tool-call 产生 start 事件并登记 pendingTools', () => {
  const { chat, rec, events } = makeChat()
  ;(chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void }).onStreamFrame(rec, {
    type: 'chunk',
    chunk: {
      type: 'block-end',
      block: { type: 'tool-call', id: 'c1', name: 'mcp__sv-demo__now', arguments: '{}' },
    },
  })
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { type: 'tool', callId: 'c1', name: 'mcp__sv-demo__now', phase: 'start', args: '{}' })
  assert.equal(rec.pendingTools.get('c1')?.name, 'mcp__sv-demo__now')
})

test('tools/result 与 pending 关联：补全耗时与结果摘要，写入 turnTools', () => {
  const { chat, rec, events } = makeChat()
  rec.pendingTools.set('c1', { name: 'web_search', startTs: Date.now() - 50, args: '{"query":"北京天气"}' })
  ;(chat as unknown as { onToolResult: (rec: AnyRec, exec: unknown, result: unknown) => void }).onToolResult(
    rec,
    { callId: 'c1', name: 'web_search', arguments: '{"query":"北京天气"}' },
    { isError: false, value: { sources: [1, 2] } },
  )

  assert.equal(events.length, 1)
  const event = events[0] as Extract<SvChatEvent, { type: 'tool' }>
  assert.equal(event.phase, 'end')
  assert.equal(event.callId, 'c1')
  assert.equal(event.name, 'web_search')
  assert.equal(event.isError, false)
  assert.equal(event.result, '{"sources":[1,2]}')
  assert.ok((event.durationMs ?? -1) >= 40)

  assert.equal(rec.pendingTools.size, 0)
  assert.equal(rec.turnTools.length, 1)
  assert.equal(rec.turnTools[0].name, 'web_search')
  assert.ok(rec.turnTools[0].isError === undefined)
  assert.ok(rec.turnTools[0].durationMs !== undefined)
})

test('无 pending 的工具结果：name 取 exec，无耗时', () => {
  const { chat, rec, events } = makeChat()
  ;(chat as unknown as { onToolResult: (rec: AnyRec, exec: unknown, result: unknown) => void }).onToolResult(
    rec,
    { callId: 'cx', name: 'web_fetch', arguments: 'http://x' },
    { isError: false, value: 'page' },
  )
  const event = events[0] as Extract<SvChatEvent, { type: 'tool' }>
  assert.equal(event.name, 'web_fetch')
  assert.equal(event.durationMs, undefined)
  assert.equal(event.result, 'page')
})

test('失败结果：result 携带 error 文本，turnTools 标记 isError', () => {
  const { chat, rec, events } = makeChat()
  ;(chat as unknown as { onToolResult: (rec: AnyRec, exec: unknown, result: unknown) => void }).onToolResult(
    rec,
    { callId: 'c2', name: 'web_search', arguments: '{}' },
    { isError: true, error: 'quota exceeded' },
  )
  const event = events[0] as Extract<SvChatEvent, { type: 'tool' }>
  assert.equal(event.isError, true)
  assert.equal(event.result, 'quota exceeded')
  assert.equal(rec.turnTools[0].isError, true)
})

test('transcript 参数摘要截断到 200 字节', () => {
  const { chat, rec } = makeChat()
  const longArgs = 'x'.repeat(500)
  rec.pendingTools.set('c3', { name: 't', startTs: Date.now(), args: longArgs })
  ;(chat as unknown as { onToolResult: (rec: AnyRec, exec: unknown, result: unknown) => void }).onToolResult(
    rec,
    { callId: 'c3', name: 't', arguments: longArgs },
    { isError: false, value: null },
  )
  assert.ok(rec.turnTools[0].args!.length <= 201)
  assert.ok(rec.turnTools[0].args!.endsWith('…'))
})

test('end 帧按轮合并思考与文本；start 帧只清当前消息缓冲', () => {
  const { chat, rec, events } = makeChat()
  const frameApi = (chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void })
  const commit = () => frameApi.onStreamFrame(rec, {
    type: 'end',
    outcome: { kind: 'committed', eventType: 'assistant/message' },
  })

  rec.turnTools.push({ name: 'web_search', durationMs: 5 })
  rec.reasoningBuf = '先查一下天气'
  commit()

  frameApi.onStreamFrame(rec, { type: 'start' })
  assert.equal(rec.textBuf, '')
  assert.equal(rec.reasoningBuf, '')
  assert.equal(rec.turnReasoning, '先查一下天气')
  assert.deepEqual(rec.turnTools, [{ name: 'web_search', durationMs: 5 }])

  rec.textBuf = '最终回答'
  rec.reasoningBuf = '再整理结论'
  commit()

  assert.equal(rec.turnText, '最终回答')
  assert.equal(rec.turnReasoning, '先查一下天气\n\n再整理结论')
  const messages = events.filter(e => e.type === 'message')
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[1], {
    type: 'message',
    text: '最终回答',
    reasoning: '先查一下天气\n\n再整理结论',
  })
})

test('一轮结束只写一条 transcript：思考合并、工具跨消息保留', async () => {
  const { chat, rec } = makeChat()
  const recorded: Array<{ id: string; text: string; reasoning: string; tools: TranscriptToolEntry[] }> = []
  ;(chat as unknown as { sessions: unknown }).sessions = {
    recordUser: async () => {},
    recordAssistant: async (id: string, text: string, reasoning: string, tools: TranscriptToolEntry[]) => {
      recorded.push({ id, text, reasoning, tools })
    },
  }
  let finishIdle: () => void = () => {}
  rec.agent = { followup() {}, whenIdle: () => new Promise<void>(resolve => { finishIdle = resolve }), cancel() {} }

  const iterator = chat.run('s1', '问题')
  await iterator.next() // 首帧 session；此时 whenIdle 已注册

  const frameApi = (chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void })
  const commit = () => frameApi.onStreamFrame(rec, {
    type: 'end',
    outcome: { kind: 'committed', eventType: 'assistant/message' },
  })
  rec.reasoningBuf = '想法一'
  commit()
  frameApi.onStreamFrame(rec, { type: 'start' })
  rec.reasoningBuf = '想法二'
  rec.textBuf = '最终回答'
  rec.turnTools.push({ name: 'web_search', durationMs: 5 })
  commit()

  finishIdle()
  for await (const _event of iterator) { /* 消费到 done */ }
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].id, 's1')
  assert.equal(recorded[0].text, '最终回答')
  assert.equal(recorded[0].reasoning, '想法一\n\n想法二')
  assert.deepEqual(recorded[0].tools, [{ name: 'web_search', durationMs: 5 }])
})


test('usage 帧累计 token 统计并推送上下文占用', () => {
  const { chat, rec, events } = makeChat()
  const frameApi = (chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void })
  const usageFrame = (usage: unknown) => frameApi.onStreamFrame(rec, {
    type: 'chunk',
    chunk: { type: 'usage', usage },
  })

  usageFrame({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, totalTokens: 150 })
  assert.equal(rec.usage?.inputTokens, 100)
  assert.equal(rec.usage?.outputTokens, 20)
  assert.equal(rec.usage?.cacheReadTokens, 30)
  assert.equal(rec.usage?.totalTokens, 150)
  // 上下文占用 = 非缓存输入 + 缓存命中
  assert.equal(rec.usage?.contextTokens, 130)
  // custom 供应商不猜窗口
  assert.equal(rec.usage?.contextWindow, undefined)

  // 第二次请求未给 total：按 prompt + completion 自行合成
  usageFrame({ inputTokens: 50, outputTokens: 10 })
  assert.equal(rec.usage?.inputTokens, 150)
  assert.equal(rec.usage?.outputTokens, 30)
  assert.equal(rec.usage?.cacheReadTokens, 30)
  assert.equal(rec.usage?.totalTokens, 210)
  assert.equal(rec.usage?.contextTokens, 50)

  const last = events[events.length - 1] as Extract<SvChatEvent, { type: 'usage' }>
  assert.equal(last.type, 'usage')
  assert.deepEqual(last.usage, rec.usage)
})

test('上下文窗口：设置值优先，否则用供应商预设', () => {
  const preset = makeChat({ provider: 'deepseek', model: 'deepseek-chat' })
  ;(preset.chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void }).onStreamFrame(preset.rec, {
    type: 'chunk',
    chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } },
  })
  assert.equal(preset.rec.usage?.contextWindow, 1_000_000)

  const configured = makeChat({ provider: 'deepseek', model: 'deepseek-chat', contextWindow: 32_768 })
  ;(configured.chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void }).onStreamFrame(configured.rec, {
    type: 'chunk',
    chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } },
  })
  assert.equal(configured.rec.usage?.contextWindow, 32_768)
})

test('单个 sink 抛错不影响其他 sink', () => {
  const { chat, rec } = makeChat()
  const good: SvChatEvent[] = []
  rec.sinks.add(() => { throw new Error('bad sink') })
  rec.sinks.add(event => good.push(event))
  ;(chat as unknown as { onToolResult: (rec: AnyRec, exec: unknown, result: unknown) => void }).onToolResult(
    rec,
    { callId: 'c9', name: 't', arguments: '' },
    { isError: false, value: 1 },
  )
  assert.equal(good.length, 1)
})
