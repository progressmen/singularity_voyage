/**
 * 自动化执行器单测：网页基线/变化、关键词去重、定时任务成功与失败、
 * 收件箱落点与运行历史。fetch 与 prompt 都用桩，不访问网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AutomationService } from '../src/automation-runtime.ts'
import { AutomationStore } from '../src/automation-store.ts'
import { defaultMailConfig } from '../src/config-store.ts'
import { InboxStore } from '../src/inbox-store.ts'

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sv-automation-runtime-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeService(name: string, options: {
  fetchText?: () => string
  runPrompt?: () => Promise<string>
} = {}) {
  const dir = join(root, name)
  const store = new AutomationStore(dir)
  await store.load()
  const inbox = new InboxStore(dir)
  await inbox.load()
  const service = new AutomationService({
    store,
    inbox,
    mail: () => defaultMailConfig(),
    fetchPage: async (url, signal) => {
      if (signal.aborted) throw new Error('已取消')
      return { url, title: '测试页', text: options.fetchText?.() ?? '初始内容' }
    },
    runPrompt: async () => (options.runPrompt === undefined ? '任务结果' : options.runPrompt()),
    log: () => {},
    fetchTimeoutMs: 1_000,
    promptTimeoutMs: 1_000,
  })
  return { store, inbox, service }
}

test('web：首次建立基线，内容不变不提醒，变化后写入收件箱', async () => {
  const { store, inbox, service } = await makeService('web', {
    fetchText: () => currentText,
  })
  let currentText = '第一版内容'
  const entry = await store.create({
    title: '示例网页',
    kind: 'web',
    url: 'https://example.com/page',
    schedule: { kind: 'interval', everyMinutes: 30 },
  })

  const first = await service.runNow(entry.id)
  assert.equal(first.run.status, 'ok')
  assert.match(first.run.summary, /建立基线/)
  assert.equal(inbox.list().length, 0)

  const second = await service.runNow(entry.id)
  assert.equal(second.run.status, 'unchanged')
  assert.equal(inbox.list().length, 0)

  currentText = '第二版内容：价格发生变化'
  const third = await service.runNow(entry.id)
  assert.equal(third.run.status, 'changed')
  assert.match(third.run.summary, /内容发生变化/)
  const items = inbox.list()
  assert.equal(items.length, 1)
  assert.equal(items[0]!.kind, 'automation')
  assert.match(items[0]!.title, /网页变化/)
  assert.match(items[0]!.body, /第二版内容/)
})

test('keyword：首次命中提醒，同一命中不重复，命中集合变化再提醒', async () => {
  const { store, inbox, service } = await makeService('keyword', {
    fetchText: () => currentText,
  })
  let currentText = '价格 100 元'
  const entry = await store.create({
    title: '价格监控',
    kind: 'keyword',
    url: 'https://example.com/price',
    keywords: ['价格', '降息'],
    schedule: { kind: 'interval', everyMinutes: 30 },
  })

  const first = await service.runNow(entry.id)
  assert.equal(first.run.status, 'matched')
  assert.equal(inbox.list().length, 1)
  assert.match(inbox.list()[0]!.title, /关键词命中/)
  assert.match(inbox.list()[0]!.body, /价格/)

  const same = await service.runNow(entry.id)
  assert.equal(same.run.status, 'unchanged')
  assert.equal(inbox.list().length, 1)

  currentText = '只出现了降息'
  const changed = await service.runNow(entry.id)
  assert.equal(changed.run.status, 'matched')
  assert.equal(inbox.list().length, 2)
  assert.match(inbox.list()[0]!.body, /降息/)
})

test('keyword：未命中时不写收件箱，并清除上次命中指纹', async () => {
  const { store, inbox, service } = await makeService('keyword-miss', {
    fetchText: () => currentText,
  })
  let currentText = '价格'
  const entry = await store.create({
    title: '命中后消失',
    kind: 'keyword',
    url: 'https://example.com/price',
    keywords: ['价格'],
    schedule: { kind: 'interval', everyMinutes: 30 },
  })
  await service.runNow(entry.id)
  assert.equal(inbox.list().length, 1)
  currentText = '没有相关词'
  const miss = await service.runNow(entry.id)
  assert.equal(miss.run.status, 'unchanged')
  assert.match(miss.run.summary, /未命中/)
  assert.equal(inbox.list().length, 1)
})

test('prompt：成功时把模型输出写入收件箱', async () => {
  const { store, inbox, service } = await makeService('prompt', {
    runPrompt: async () => '## 今日总结\n\n- 完成两件事',
  })
  const entry = await store.create({
    title: '每日总结',
    kind: 'prompt',
    prompt: '总结今天的进展',
    schedule: { kind: 'daily', at: '08:30' },
  })
  const result = await service.runNow(entry.id)
  assert.equal(result.run.status, 'ok')
  assert.match(result.run.summary, /已生成结果/)
  assert.equal(inbox.list().length, 1)
  assert.equal(inbox.list()[0]!.kind, 'automation')
  assert.match(inbox.list()[0]!.body, /今日总结/)
})

test('prompt：失败时记录 failed 运行，并写入失败收件箱', async () => {
  const { store, inbox, service } = await makeService('prompt-fail', {
    runPrompt: async () => {
      throw new Error('upstream timeout')
    },
  })
  const entry = await store.create({
    title: '会失败的任务',
    kind: 'prompt',
    prompt: '执行失败测试',
    schedule: { kind: 'interval', everyMinutes: 10 },
  })
  const result = await service.runNow(entry.id)
  assert.equal(result.run.status, 'failed')
  assert.match(result.run.error ?? '', /upstream timeout/)
  assert.equal(inbox.list().length, 1)
  assert.match(inbox.list()[0]!.title, /自动化失败/)
})

test('暂停状态下手动运行仍可执行；运行历史可查询', async () => {
  const { store, inbox, service } = await makeService('paused')
  const entry = await store.create({
    title: '手动运行',
    kind: 'prompt',
    prompt: '任意任务',
    schedule: { kind: 'interval', everyMinutes: 10 },
  })
  await store.setEnabled(entry.id, false)
  const result = await service.runNow(entry.id)
  assert.equal(store.get(entry.id)?.enabled, false)
  assert.equal(result.run.status, 'ok')
  assert.equal(inbox.list().length, 1)
  assert.equal(store.listRuns(entry.id).length, 1)
})
