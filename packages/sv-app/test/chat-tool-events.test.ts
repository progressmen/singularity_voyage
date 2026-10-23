/**
 * ChatManager 工具事件单测：通过注入桩对象直接驱动私有事件处理逻辑，
 * 验证 start/end 按 callId 关联、结果摘要、transcript 条目与 sink 容错。
 * 不创建真实 agent / LLM 连接。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatManager, type SvChatEvent } from '../src/chat.ts'
import type { TranscriptToolEntry } from '../src/sessions-store.ts'

type AnyRec = {
  sessionId: string
  agent: unknown
  sinks: Set<(event: SvChatEvent) => void>
  status: 'running' | 'idle'
  textBuf: string
  reasoningBuf: string
  pendingTools: Map<string, { name: string; startTs: number; args: string }>
  turnTools: TranscriptToolEntry[]
}

function makeChat() {
  const chat = new ChatManager({} as never, {} as never, {} as never)
  const rec: AnyRec = {
    sessionId: 's1',
    agent: undefined,
    sinks: new Set(),
    status: 'idle',
    textBuf: '',
    reasoningBuf: '',
    pendingTools: new Map(),
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

test('start 帧重置本轮文本与工具缓存；end 帧触发 transcript 记录', async () => {
  const { chat, rec, events } = makeChat()
  const recorded: Array<{ id: string; text: string; tools: TranscriptToolEntry[] }> = []
  const sessions = { recordAssistant: async (id: string, text: string, _r: string, tools: TranscriptToolEntry[]) => {
    recorded.push({ id, text, tools })
  } }
  ;(chat as unknown as { sessions: unknown }).sessions = sessions

  const frameApi = (chat as unknown as { onStreamFrame: (rec: AnyRec, frame: unknown) => void })
  rec.turnTools.push({ name: 'leftover' })
  frameApi.onStreamFrame(rec, { type: 'start' })
  assert.deepEqual(rec.turnTools, [])

  rec.textBuf = '最终回答'
  rec.turnTools.push({ name: 'web_search', durationMs: 5 })
  frameApi.onStreamFrame(rec, { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].id, 's1')
  assert.equal(recorded[0].text, '最终回答')
  assert.equal(recorded[0].tools.length, 1)
  assert.equal(events.some(e => e.type === 'message'), true)
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
