/**
 * 记忆存储单测：写入去重合并、召回排序、删除后不再召回、promptBlock 渲染。
 * 使用临时目录持久化，验证读写回环。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { MemoryStore, tokenize } from '../src/memory-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-memory-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('remember 去重：同 kind 同文本（标点/空白差异）合并，置信度取高、标签取并集', async () => {
  const store = new MemoryStore(dir)
  const [first] = await store.remember([
    { kind: 'preference', text: '喜欢简洁的中文回答！', tags: ['style'], confidence: 0.7 },
  ], { note: 'manual' })
  assert.ok(first !== undefined)
  const [second] = await store.remember([
    { kind: 'preference', text: '喜欢简洁的中文回答', tags: ['回答'], confidence: 0.5 },
  ], { sessionId: 's1', note: 'auto-extract' })
  assert.ok(second !== undefined)
  assert.equal(second.id, first.id)
  assert.equal(store.list().length, 1)
  assert.ok(second.confidence >= 0.7)
  assert.deepEqual(new Set(second.tags), new Set(['style', '回答']))
})

test('不同 kind 相同文本不合并', async () => {
  const store = new MemoryStore(dir)
  await store.remember([
    { kind: 'fact', text: '住在上海' },
    { kind: 'project', text: '住在上海' },
  ], { note: 'manual' })
  assert.equal(store.list().length, 2)
})

test('recall：命中查询排序在前；空查询返回最近记忆', async () => {
  const store = new MemoryStore(dir)
  await store.remember([
    { kind: 'fact', text: '用户在上海工作，做平台工程', tags: ['地点'] },
    { kind: 'preference', text: '回答保持简洁' },
    { kind: 'person', text: '张三是用户的同事，负责设计' },
  ], { note: 'manual' })
  const hits = store.recall('上海 的工作', 5)
  assert.ok(hits.length >= 1)
  assert.ok(hits[0]!.text.includes('上海'))
  const recent = store.recall('', 5)
  assert.ok(recent.length >= 3)
})

test('删除后不再召回，也不再出现在 promptBlock', async () => {
  const store = new MemoryStore(dir)
  const [entry] = await store.remember([{ kind: 'fact', text: '用户养了一只猫叫橘子' }], { note: 'manual' })
  assert.ok(entry !== undefined)
  assert.ok(store.promptBlock('猫', 10).includes('橘子'))
  assert.equal(await store.remove(entry.id), true)
  assert.equal(store.promptBlock('猫', 10), '')
  assert.equal(store.recall('猫', 10).length, 0)
})

test('update 可改文本与置信度；持久化后重启可读回', async () => {
  const store = new MemoryStore(dir)
  const [entry] = await store.remember([{ kind: 'decision', text: '决定用 DeepSeek 作为默认模型' }], { note: 'manual' })
  assert.ok(entry !== undefined)
  const updated = await store.update(entry.id, { text: '决定用 DeepSeek V4 作为默认模型', confidence: 0.95 })
  assert.ok(updated !== undefined)
  assert.equal(updated.text, '决定用 DeepSeek V4 作为默认模型')

  const reloaded = new MemoryStore(dir)
  await reloaded.load()
  const found = reloaded.list().find(item => item.id === entry.id)
  assert.ok(found !== undefined)
  assert.equal(found.text, '决定用 DeepSeek V4 作为默认模型')
  assert.ok(Math.abs(found.confidence - 0.95) < 1e-9)
})

test('损坏文件不抛异常：按空记忆启动', async () => {
  const { writeFile } = await import('node:fs/promises')
  const store = new MemoryStore(dir)
  // 读取时文件存在且合法；这里直接构造一个新 store 并写入坏文件再读
  const badDir = join(dir, 'bad')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(badDir, { recursive: true })
  await writeFile(join(badDir, 'memory.json'), 'not-json', 'utf8')
  const bad = new MemoryStore(badDir)
  await bad.load()
  assert.equal(bad.list().length, 0)
})

test('tokenize：英文词 + 中文二元组 + 单字', () => {
  const tokens = tokenize('KV Cache 很快')
  assert.ok(tokens.includes('cache'))
  const cjk = tokenize('上海天气')
  assert.ok(cjk.includes('上海') && cjk.includes('海天') && cjk.includes('天气'))
  assert.deepEqual(tokenize('猫'), ['猫'])
})
