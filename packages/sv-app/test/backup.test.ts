/**
 * 数据闭环单测：备份导出、恢复回环、路径/格式校验、按域清空与数据快照。
 * 通过 SV_HOME 指向临时目录，避免触碰真实 $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AutomationStore } from '../src/automation-store.ts'
import {
  clearData,
  createBackup,
  dataStatus,
  restoreBackup,
  type BackupStores,
} from '../src/backup.ts'
import { InboxStore } from '../src/inbox-store.ts'
import { KnowledgeStore } from '../src/knowledge-store.ts'
import { MemoryStore } from '../src/memory-store.ts'
import { SessionStore } from '../src/sessions-store.ts'
import { TasksStore } from '../src/tasks-store.ts'

let root: string
const savedHome = process.env.SV_HOME
let stores: BackupStores

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sv-backup-'))
  process.env.SV_HOME = root
  const sessions = new SessionStore(root)
  stores = {
    memory: new MemoryStore(root),
    tasks: new TasksStore(root),
    inbox: new InboxStore(root),
    knowledge: new KnowledgeStore(root),
    automations: new AutomationStore(root),
    sessions,
  }
  await stores.memory.load()
  await stores.tasks.load()
  await stores.inbox.load()
  await stores.knowledge.load()
  await stores.automations.load()
  await sessions.load()
  await writeFile(join(root, 'config.json'), JSON.stringify({ llm: { apiKey: 'sk-secret' } }), { mode: 0o600 })
})

after(async () => {
  if (savedHome === undefined) delete process.env.SV_HOME
  else process.env.SV_HOME = savedHome
  await rm(root, { recursive: true, force: true })
})

async function populate(): Promise<void> {
  await stores.memory.remember([{ kind: 'fact', text: '住在上海' }], { note: 'manual' })
  await stores.tasks.create({ title: '交材料' })
  await stores.inbox.add({ kind: 'system', title: '测试消息', body: '收件箱正文' })
  await stores.knowledge.ingest({ text: '# 笔记\n\n知识内容', source: 'notes.md' })
  await stores.automations.create({
    title: '示例监控',
    kind: 'web',
    url: 'https://example.com',
    schedule: { kind: 'interval', everyMinutes: 30 },
  })
  await stores.sessions.register('s1')
  await stores.sessions.recordUser('s1', '你好')
  await stores.sessions.recordAssistant('s1', '回复内容', '', [])
  await stores.sessions.recordUsage('s1', {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    totalTokens: 15,
    contextTokens: 10,
    updatedAt: Date.now(),
  })
}

test('createBackup：包含产品数据与会话投影，不包含 config.json 密钥', async () => {
  await populate()
  const bundle = await createBackup()
  assert.equal(bundle.version, 1)
  assert.equal(bundle.app, 'singularity-voyage')
  assert.ok(bundle.files['memory.json'] !== undefined)
  assert.ok(bundle.files['tasks.json'] !== undefined)
  assert.ok(bundle.files['inbox.json'] !== undefined)
  assert.ok(bundle.files['knowledge.json'] !== undefined)
  assert.ok(bundle.files['automations.json'] !== undefined)
  assert.ok(bundle.files['sessions.json'] !== undefined)
  assert.ok(bundle.files['transcripts/s1.jsonl'] !== undefined)
  assert.equal(bundle.files['config.json'], undefined)
  assert.ok(!JSON.stringify(bundle).includes('sk-secret'))
})

test('dataStatus：统计数据量、token 使用与文件清单', async () => {
  const status = await dataStatus(stores)
  assert.equal(status.backend, 'file')
  assert.equal(status.counts.memories, 1)
  assert.equal(status.counts.tasksTotal, 1)
  assert.equal(status.counts.knowledgeDocs, 1)
  assert.equal(status.counts.automations, 1)
  assert.equal(status.counts.sessions, 1)
  assert.equal(status.usage.sessionsWithUsage, 1)
  assert.equal(status.usage.totalTokens, 15)
  assert.ok(status.files.some(file => file.name === 'config.json（含密钥，不备份）' && file.backup === false))
  assert.ok(status.transcripts.count >= 1)
  assert.ok(status.backupBytes > 0)
})

test('restoreBackup：恢复后各 store 回到备份时的状态', async () => {
  const bundle = await createBackup()
  await stores.memory.remember([{ kind: 'fact', text: '新增但未备份' }], { note: 'manual' })
  await stores.tasks.create({ title: '新增任务' })
  await stores.automations.clear()
  await stores.knowledge.clear()

  const result = await restoreBackup(stores, bundle)
  assert.ok(result.files > 0)
  assert.equal(stores.memory.list().length, 1)
  assert.equal(stores.memory.list()[0]!.text, '住在上海')
  assert.equal(stores.tasks.list(false).length, 1)
  assert.equal(stores.knowledge.list().length, 1)
  assert.ok(stores.knowledge.search('知识内容', 3).length > 0)
  assert.equal(stores.automations.list().length, 1)
  assert.equal(stores.sessions.list().length, 1)
  assert.equal((await stores.sessions.messages('s1')).length, 2)
  assert.equal(stores.inbox.list().length, 1)
})

test('restoreBackup：拒绝坏版本、越界路径与非法 JSON', async () => {
  await assert.rejects(() => restoreBackup(stores, { version: 2, files: {} }), /版本/)
  await assert.rejects(() => restoreBackup(stores, { version: 1, files: { '../../evil.json': '{}' } }), /不支持的路径/)
  await assert.rejects(() => restoreBackup(stores, { version: 1, files: { 'memory.json': 'not json' } }), /合法 JSON/)
})

test('clearData：按域清空与全量清空，config.json 不受影响', async () => {
  assert.equal(stores.memory.list().length, 1)
  await clearData(stores, 'memory')
  assert.equal(stores.memory.list().length, 0)
  const memoryFile = JSON.parse(await readFile(join(root, 'memory.json'), 'utf8'))
  assert.equal(memoryFile.memories.length, 0)

  await clearData(stores, 'all')
  assert.equal(stores.memory.list().length, 0)
  assert.equal(stores.tasks.list(true).length, 0)
  assert.equal(stores.inbox.list().length, 0)
  assert.equal(stores.knowledge.list().length, 0)
  assert.equal(stores.automations.list().length, 0)
  assert.equal(stores.sessions.list().length, 0)
  assert.ok((await readFile(join(root, 'config.json'), 'utf8')).includes('sk-secret'))
})
