/**
 * Batch A 单测：会话全文检索、会话导出/恢复、RSS 解析、静默时段、
 * 行级变化摘要、用量统计与按域导出。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createBackup } from '../src/backup.ts'
import { diffLines, inQuietHours, parseFeedItems } from '../src/automation-runtime.ts'
import { AutomationStore } from '../src/automation-store.ts'
import { InboxStore } from '../src/inbox-store.ts'
import { KnowledgeStore } from '../src/knowledge-store.ts'
import { MemoryStore } from '../src/memory-store.ts'
import { SessionStore } from '../src/sessions-store.ts'
import { TasksStore } from '../src/tasks-store.ts'
import { UsageStore } from '../src/usage-store.ts'

let root: string
const savedHome = process.env.SV_HOME

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sv-batch-a-'))
  process.env.SV_HOME = root
})

after(async () => {
  if (savedHome === undefined) delete process.env.SV_HOME
  else process.env.SV_HOME = savedHome
  await rm(root, { recursive: true, force: true })
})

test('会话检索：标题与正文命中，片段带上下文', async () => {
  const dir = await mkdtemp(join(root, 'search-'))
  const store = new SessionStore(dir)
  await store.load()
  await store.register('s1')
  await store.recordUser('s1', '如何配置 DeepSeek 模型')
  await store.recordAssistant('s1', '在设置页填写 API key 即可。', '', [])
  await store.register('s2')
  await store.recordUser('s2', '今天天气怎么样')
  await store.recordAssistant('s2', '晴，气温 25 度。', '', [])

  const hits = await store.search('deepseek')
  assert.ok(hits.length >= 1)
  assert.ok(hits.some(hit => hit.sessionId === 's1' && hit.role === 'user' && hit.snippet.includes('DeepSeek')))
  assert.equal(hits.some(hit => hit.sessionId === 's2'), false)

  assert.deepEqual(await store.search('   '), [])
})

test('会话导出/导入：索引与对话记录往返一致', async () => {
  const source = new SessionStore(await mkdtemp(join(root, 'export-a-')))
  await source.load()
  await source.register('a1')
  await source.recordUser('a1', '第一条消息')
  await source.recordAssistant('a1', '第一条回复', '思考', [{ name: 'web_search', args: '{}' }])
  const snapshot = await source.exportAll()
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.transcripts.a1?.length, 2)

  const target = new SessionStore(await mkdtemp(join(root, 'export-b-')))
  await target.load()
  await target.importAll(snapshot)
  assert.equal(target.list().length, 1)
  const restored = await target.messages('a1')
  assert.equal(restored.length, 2)
  assert.equal(restored[1]!.text, '第一条回复')
  assert.equal(restored[1]!.reasoning, '思考')
})

test('RSS 解析：兼容 item/entry、CDATA 与 guid', () => {
  const xml = `<rss><channel>
    <item><title>第一条</title><link>https://example.com/1</link><guid>g1</guid><description><![CDATA[摘要 &amp; 更多]]></description></item>
    <item><title><![CDATA[B & C]]></title><link>https://example.com/2</link></item>
  </channel></rss>`
  const items = parseFeedItems(xml)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.title, '第一条')
  assert.equal(items[0]!.id, 'g1')
  assert.equal(items[1]!.title, 'B & C')
  assert.equal(items[1]!.link, 'https://example.com/2')
})

test('静默时段：支持跨午夜与空配置', () => {
  const base = { paused: false, retryAttempts: 0 }
  assert.equal(inQuietHours({ ...base, quietStart: '22:00', quietEnd: '07:00' }, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inQuietHours({ ...base, quietStart: '22:00', quietEnd: '07:00' }, new Date(2026, 0, 1, 6, 30)), true)
  assert.equal(inQuietHours({ ...base, quietStart: '22:00', quietEnd: '07:00' }, new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(inQuietHours({ ...base, quietStart: '', quietEnd: '' }, new Date(2026, 0, 1, 23, 0)), false)
  assert.equal(inQuietHours({ ...base, quietStart: '09:00', quietEnd: '18:00' }, new Date(2026, 0, 1, 10, 0)), true)
})

test('行级差异：只返回新增/移除的前几条', () => {
  const diff = diffLines('A\nB\nC', 'A\nC\nD\nE')
  assert.deepEqual(diff.added, ['D', 'E'])
  assert.deepEqual(diff.removed, ['B'])
})

test('用量统计：按天/按模型累计并估算费用与预算', async () => {
  const dir = await mkdtemp(join(root, 'usage-'))
  const store = new UsageStore(dir)
  await store.load()
  await store.record('deepseek-chat', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 })
  await store.record('deepseek-chat', { inputTokens: 1000, outputTokens: 500 })

  const snapshot = store.snapshot({ inputPerMillion: 2, outputPerMillion: 8, monthlyTokenBudget: 10_000 })
  assert.equal(snapshot.totals.inputTokens, 2000)
  assert.equal(snapshot.totals.outputTokens, 1000)
  assert.equal(snapshot.totals.cacheReadTokens, 200)
  assert.equal(snapshot.totals.requests, 2)
  assert.equal(snapshot.byModel['deepseek-chat']?.requests, 2)
  // 2000/1M*2 + 1000/1M*8 = 0.004 + 0.008
  assert.equal(snapshot.cost.total, 0.012)
  assert.equal(snapshot.budget.monthTokens, 3000)
  assert.equal(snapshot.budget.exceeded, false)

  const reloaded = new UsageStore(dir)
  await reloaded.load()
  assert.equal(reloaded.snapshot({ inputPerMillion: 0, outputPerMillion: 0, monthlyTokenBudget: 0 }).totals.requests, 2)
})

test('按域导出：sessions 带会话快照，memory 不带会话', async () => {
  // createBackup 固定从 SV_HOME 读取文件，这里让 store 与 SV_HOME 指向同一目录。
  const dir = root
  const sessions = new SessionStore(dir)
  const stores = {
    memory: new MemoryStore(dir),
    tasks: new TasksStore(dir),
    inbox: new InboxStore(dir),
    knowledge: new KnowledgeStore(dir),
    automations: new AutomationStore(dir),
    sessions,
  }
  await stores.memory.load()
  await stores.tasks.load()
  await stores.inbox.load()
  await stores.knowledge.load()
  await stores.automations.load()
  await sessions.load()
  await stores.memory.remember([{ kind: 'fact', text: '住在上海' }], { note: 'manual' })
  await sessions.register('d1')
  await sessions.recordUser('d1', '你好')

  const onlySessions = await createBackup(stores, 'sessions')
  assert.ok(onlySessions.files['sessions.json'] !== undefined)
  assert.equal(onlySessions.files['memory.json'], undefined)
  assert.equal(onlySessions.sessions?.sessions.length, 1)
  assert.equal(onlySessions.sessions?.transcripts.d1?.length, 1)

  const onlyMemory = await createBackup(stores, 'memory')
  assert.ok(onlyMemory.files['memory.json'] !== undefined)
  assert.equal(onlyMemory.files['sessions.json'], undefined)
  assert.equal(onlyMemory.sessions, undefined)

  const full = await createBackup(stores, 'all')
  assert.ok(full.files['memory.json'] !== undefined)
  assert.equal(full.sessions?.sessions.length, 1)
})
