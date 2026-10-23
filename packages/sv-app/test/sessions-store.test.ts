/**
 * SessionStore 单测：索引、transcript 投影、损坏容错与路径穿越防护。
 * 使用临时目录，不触碰真实 $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { SessionStore } from '../src/sessions-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-sessions-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('register / recordUser / recordAssistant 维护索引与标题', async () => {
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s1')
  assert.equal(store.has('s1'), true)

  await store.recordUser('s1', '帮我查一下天气', 1000)
  await store.recordAssistant('s1', '北京今天晴。', '思考中', [
    { name: 'web_search', args: '{"query":"北京天气"}', durationMs: 120 },
  ], 2000)

  const list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 's1')
  assert.equal(list[0].title, '帮我查一下天气')
  assert.equal(list[0].turns, 1)

  const messages = await store.messages('s1')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].reasoning, '思考中')
  assert.deepEqual(messages[1].tools, [{ name: 'web_search', args: '{"query":"北京天气"}', durationMs: 120 }])
})

test('recordUser 只在首条用户消息时设置标题', async () => {
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s2')
  await store.recordUser('s2', '第一条', 10)
  await store.recordUser('s2', '第二条', 20)
  assert.equal(store.list().find(s => s.id === 's2')?.title, '第一条')
})

test('未知会话返回空 transcript；非法 id 不落盘（防路径穿越）', async () => {
  const store = new SessionStore(dir)
  assert.deepEqual(await store.messages('no-such-id'), [])
  assert.deepEqual(await store.messages('../../etc/passwd'), [])

  await store.register('../evil')
  await store.recordUser('../evil', 'x')
  assert.deepEqual(await store.messages('../evil'), [])
  await store.remove('../evil')
})

test('remove 删除索引与 transcript 文件', async () => {
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s3')
  await store.recordUser('s3', 'hello', 1)
  const file = join(dir, 'transcripts', 's3.jsonl')
  await readFile(file, 'utf8') // 存在
  assert.equal(await store.remove('s3'), true)
  await assert.rejects(() => readFile(file, 'utf8'))
  assert.equal(await store.remove('s3'), false)
  assert.deepEqual(await store.messages('s3'), [])
})

test('load 从磁盘恢复索引；损坏索引按空处理', async () => {
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s4')
  await store.recordUser('s4', '恢复测试', 5)

  const store2 = new SessionStore(dir)
  await store2.load()
  const entry = store2.list().find(s => s.id === 's4')
  assert.ok(entry)
  assert.equal(entry.title, '恢复测试')

  await writeFile(join(dir, 'sessions.json'), '{broken', 'utf8')
  const store3 = new SessionStore(dir)
  await store3.load()
  assert.deepEqual(store3.list(), [])
})

test('recordUser 串行化：并发写入不交错', async () => {
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s5')
  await Promise.all([
    store.recordUser('s5', 'a', 1),
    store.recordUser('s5', 'b', 2),
    store.recordUser('s5', 'c', 3),
  ])
  const messages = await store.messages('s5')
  assert.equal(messages.length, 3)
  const raw = await readFile(join(dir, 'transcripts', 's5.jsonl'), 'utf8')
  assert.equal(raw.trimEnd().split('\n').length, 3)
})
