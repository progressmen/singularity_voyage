/**
 * 个人知识库单测：切块、导入去重、检索与来源、删除后不再召回、持久化。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  chunkKnowledgeText,
  defaultKnowledgeTitle,
  KnowledgeStore,
} from '../src/knowledge-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-knowledge-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('chunkKnowledgeText：按 Markdown 标题与段落切块，保留所属标题', () => {
  const text = [
    '# 退休规划',
    '',
    '目标是在 60 岁退休，需要准备足够的现金流。',
    '',
    '## 投资',
    '',
    '长期持有指数基金，控制回撤。',
  ].join('\n')
  const chunks = chunkKnowledgeText(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.heading, '退休规划')
  assert.match(chunks[0]!.text, /60 岁退休/)
  assert.equal(chunks[1]!.heading, '投资')
  assert.match(chunks[1]!.text, /指数基金/)
})

test('chunkKnowledgeText：超长段落按句读切分成多块', () => {
  const sentence = '这是一句用于测试知识切块的较长句子。'
  const text = sentence.repeat(120)
  const chunks = chunkKnowledgeText(text)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.text.length <= 1000, `chunk too long: ${chunk.text.length}`)
})

test('defaultKnowledgeTitle：标题优先，其次首行，最后来源', () => {
  assert.equal(defaultKnowledgeTitle('# 项目复盘\n\n正文', 'notes.md'), '项目复盘')
  assert.equal(defaultKnowledgeTitle('第一行内容\n第二行', 'notes.md'), '第一行内容')
  assert.equal(defaultKnowledgeTitle('', 'notes.md'), 'notes.md')
})

test('ingest/search：导入后可检索，命中带 docId、来源与片段', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  const result = await store.ingest({ text: '# 退休规划\n\n目标是在 60 岁退休。\n\n## 投资\n\n长期持有指数基金。', source: 'notes/retire.md', sourceKind: 'file' })
  assert.equal(result.duplicate, false)
  assert.equal(result.doc.title, '退休规划')
  assert.equal(store.list().length, 1)

  const hits = store.search('指数基金', 3)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.docId, result.doc.id)
  assert.equal(hits[0]!.title, '退休规划')
  assert.equal(hits[0]!.source, 'notes/retire.md')
  assert.equal(hits[0]!.heading, '投资')
  assert.match(hits[0]!.snippet, /指数基金/)
  assert.ok(hits[0]!.score > 0)

  const english = await store.ingest({ text: 'DeepSeek harness notes about agent loops.', source: 'notes/agent.md' })
  assert.equal(store.search('agent loop', 5)[0]?.docId, english.doc.id)
})

test('ingest：相同正文命中已有文档并更新标题/来源，不重复新增', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  const first = await store.ingest({ text: '# 旧标题\n\n同一份正文。', source: 'a.md' })
  assert.equal(first.duplicate, false)
  const second = await store.ingest({ text: '# 新标题\n\n同一份正文。', source: 'b.md' })
  // 标题行不同，哈希不同，按不同文档处理
  assert.equal(second.duplicate, false)
  assert.equal(store.list().length, 4)

  const same = await store.ingest({ text: '完全相同的正文内容。', source: 'x.md' })
  const again = await store.ingest({ text: '完全相同的正文内容。', source: 'y.md' })
  assert.equal(same.duplicate, false)
  assert.equal(again.duplicate, true)
  assert.equal(again.doc.id, same.doc.id)
  assert.equal(again.doc.source, 'y.md')
  assert.equal(store.list().length, 5)
})

test('promptBlock：只注入相关片段，带 [K1] 与来源；无命中返回空串', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  const block = store.promptBlock('指数基金', 2)
  assert.match(block, /## 个人知识/)
  assert.match(block, /\[K1\]/)
  assert.match(block, /notes\/retire\.md/)
  assert.equal(store.promptBlock('zzzznotfound', 2), '')
})

test('remove：删除后检索与 promptBlock 都不再命中', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  const target = store.list().find(doc => doc.source === 'notes/retire.md')
  assert.ok(target !== undefined)
  assert.equal(await store.remove(target.id), true)
  assert.equal(store.search('指数基金', 3).length, 0)
  assert.equal(store.promptBlock('指数基金'), '')
  assert.equal(await store.remove(target.id), false)
})

test('持久化：重启后文档、分块与检索索引仍在', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  const reloaded = new KnowledgeStore(dir)
  await reloaded.load()
  assert.equal(reloaded.list().length, store.list().length)
  assert.ok(reloaded.search('agent loop', 3).length > 0)
  const detail = reloaded.get(store.list()[0]!.id)
  assert.ok(detail !== undefined)
  assert.ok(detail.chunks.length > 0)
})

test('ingest：空内容与超长内容拒绝写入', async () => {
  const store = new KnowledgeStore(dir)
  await store.load()
  await assert.rejects(() => store.ingest({ text: '   ' }), /不能为空/)
  await assert.rejects(() => store.ingest({ text: 'x'.repeat(500_001) }), /过长/)
})
