/**
 * ChatManager 后台轮次收尾单测：不创建真实 agent，直接驱动 finishDetachedTurn，
 * 验证 transcript / token 落盘与 onDetachedTurn 回调。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatManager } from '../src/chat.ts'
import type { SessionUsage } from '../src/sessions-store.ts'

interface RecLike {
  sessionId: string
  agent: unknown
  sinks: Set<unknown>
  status: 'idle'
  textBuf: string
  reasoningBuf: string
  pendingTools: Map<string, unknown>
  turnText: string
  turnReasoning: string
  turnTools: unknown[]
  turnStartTs: number
  turnUserChars: number
  usage?: SessionUsage
}

function makeChat() {
  const calls: string[] = []
  const hooks: Array<{ sessionId: string; assistantText: string }> = []
  const logger = { info() {}, warn() {}, debug() {}, error() {} }
  const sessions = {
    recordAssistant: async (id: string, text: string) => {
      calls.push(`assistant:${id}:${text}`)
    },
    recordUsage: async (id: string) => {
      calls.push(`usage:${id}`)
    },
  }
  const chat = new ChatManager(
    { logger } as never,
    { llm: { model: 'test-model' } } as never,
    sessions as never,
    { onDetachedTurn: input => hooks.push(input) },
  )
  const makeRec = (text: string, usage?: SessionUsage): RecLike => ({
    sessionId: 's1',
    agent: {},
    sinks: new Set(),
    status: 'idle',
    textBuf: '',
    reasoningBuf: '',
    pendingTools: new Map(),
    turnText: text,
    turnReasoning: '思考',
    turnTools: [{ name: 'task_list' }],
    turnStartTs: Date.now() - 1000,
    turnUserChars: 0,
    ...(usage === undefined ? {} : { usage }),
  })
  return { chat, calls, hooks, makeRec }
}

test('finishDetachedTurn：写 transcript 与 token 统计，并回调 onDetachedTurn', () => {
  const { chat, calls, hooks, makeRec } = makeChat()
  const rec = makeRec('定时任务已完成', {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    totalTokens: 15,
    contextTokens: 10,
    updatedAt: Date.now(),
  })
  ;(chat as unknown as { finishDetachedTurn(rec: RecLike): void }).finishDetachedTurn(rec)
  assert.equal(hooks.length, 1)
  assert.deepEqual(hooks[0], { sessionId: 's1', assistantText: '定时任务已完成' })
  assert.equal(calls.length, 2)
  assert.match(calls[0]!, /^assistant:s1:定时任务已完成$/)
  assert.equal(calls[1], 'usage:s1')
})

test('finishDetachedTurn：没有文本输出时不写 transcript、不回调', () => {
  const { chat, calls, hooks, makeRec } = makeChat()
  const rec = makeRec('   ')
  ;(chat as unknown as { finishDetachedTurn(rec: RecLike): void }).finishDetachedTurn(rec)
  assert.equal(hooks.length, 0)
  assert.equal(calls.length, 0)
})
