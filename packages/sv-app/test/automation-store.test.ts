/**
 * 自动化存储与调度单测：下次运行时间、创建校验、暂停/恢复、运行收尾、历史与持久化。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AutomationStore, nextRunAt, normalizeSchedule } from '../src/automation-store.ts'

let dir: string
const DAY_MS = 24 * 60 * 60 * 1000

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-automation-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('nextRunAt：固定间隔从当前时刻顺延', () => {
  const from = new Date(2026, 10, 25, 10, 0, 0).getTime()
  assert.equal(nextRunAt({ kind: 'interval', everyMinutes: 15 }, from), from + 15 * 60_000)
})

test('nextRunAt：每天在时间点前返回今天，过后返回明天', () => {
  const before = new Date(2026, 10, 25, 8, 0, 0).getTime()
  const afterTime = new Date(2026, 10, 25, 10, 0, 0).getTime()
  const today = nextRunAt({ kind: 'daily', at: '09:00' }, before)
  assert.equal(new Date(today).getHours(), 9)
  assert.ok(today - before < DAY_MS)
  const tomorrow = nextRunAt({ kind: 'daily', at: '09:00' }, afterTime)
  assert.ok(tomorrow - afterTime > DAY_MS - 2 * 60 * 60 * 1000)
  assert.equal(new Date(tomorrow).getHours(), 9)
})

test('nextRunAt：每周命中目标星期，当天已过则顺延一周', () => {
  const from = new Date(2026, 10, 25, 8, 0, 0).getTime()
  const weekday = new Date(from).getDay()
  const later = nextRunAt({ kind: 'weekly', weekday, at: '09:00' }, from)
  assert.ok(later > from && later - from < DAY_MS)
  const earlier = nextRunAt({ kind: 'weekly', weekday, at: '07:00' }, from)
  assert.ok(earlier - from > 6 * DAY_MS)
})

test('nextRunAt：非法时间与时区格式拒绝', () => {
  assert.throws(() => normalizeSchedule({ kind: 'daily', at: '9:00' }), /HH:mm/)
  assert.throws(() => normalizeSchedule({ kind: 'weekly', weekday: 7, at: '09:00' }), /星期/)
})

test('create：按类型校验必填字段', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  await assert.rejects(() => store.create({
    title: '网页',
    kind: 'web',
    schedule: { kind: 'interval', everyMinutes: 10 },
  }), /URL/)
  await assert.rejects(() => store.create({
    title: '关键词',
    kind: 'keyword',
    url: 'https://example.com',
    schedule: { kind: 'interval', everyMinutes: 10 },
    keywords: [],
  }), /关键词/)
  await assert.rejects(() => store.create({
    title: '任务',
    kind: 'prompt',
    schedule: { kind: 'interval', everyMinutes: 10 },
  }), /任务描述/)
  await assert.rejects(() => store.create({
    title: '间隔非法',
    kind: 'web',
    url: 'https://example.com',
    schedule: { kind: 'interval', everyMinutes: 0 },
  }), /间隔/)
})

test('create：nextRunAt 在未来，列表按新建在前', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const now = Date.now()
  const first = await store.create({
    title: '监控一',
    kind: 'web',
    url: 'https://example.com',
    schedule: { kind: 'interval', everyMinutes: 30 },
  })
  const second = await store.create({
    title: '关键词二',
    kind: 'keyword',
    url: 'https://example.org',
    keywords: ['价格'],
    schedule: { kind: 'daily', at: '08:30' },
  })
  assert.ok(first.nextRunAt > now)
  assert.equal(store.list()[0]!.id, second.id)
  assert.equal(store.list().length, 2)
})

test('update：修改类型与调度，清理旧目标字段并保留运行历史', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const entry = await store.create({
    title: '待修改',
    kind: 'web',
    url: 'https://example.com/before',
    schedule: { kind: 'interval', everyMinutes: 10 },
  })
  await store.finishRun(entry.id, { at: Date.now(), summary: '基线', hash: 'abc', text: 'old' })
  const updated = await store.update(entry.id, {
    title: '已修改',
    kind: 'prompt',
    schedule: { kind: 'daily', at: '08:30' },
    prompt: '生成科技日报',
    email: true,
  })
  assert.ok(updated !== undefined)
  assert.equal(updated.title, '已修改')
  assert.equal(updated.kind, 'prompt')
  assert.equal(updated.prompt, '生成科技日报')
  assert.equal(updated.url, undefined)
  assert.equal(updated.email, true)
  assert.equal(updated.schedule.kind, 'daily')
  assert.equal(updated.lastSummary, '基线')
  assert.ok(updated.nextRunAt > Date.now())
  assert.equal(await store.update('missing-id', {
    title: '不存在',
    kind: 'prompt',
    schedule: { kind: 'daily', at: '08:30' },
    prompt: 'x',
  }), undefined)
})

test('setEnabled：暂停不推进时间，恢复时重排未来时间', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const entry = store.list()[0]!
  await store.setEnabled(entry.id, false)
  assert.equal(store.get(entry.id)?.enabled, false)
  const before = store.get(entry.id)!.nextRunAt
  await store.setEnabled(entry.id, true)
  assert.equal(store.get(entry.id)?.enabled, true)
  assert.equal(store.get(entry.id)?.nextRunAt, before)
})

test('finishRun：推进 lastRunAt / nextRunAt，写入摘要与指纹', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const entry = store.list()[0]!
  const at = Date.now()
  const updated = await store.finishRun(entry.id, { at, summary: '内容变化', hash: 'abc' })
  assert.ok(updated !== undefined)
  assert.equal(updated.lastRunAt, at)
  assert.equal(updated.lastSummary, '内容变化')
  assert.ok(updated.nextRunAt > at)
})

test('recordRun/listRuns：按结束时间倒序，删除自动化时清理历史', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const entry = store.list()[0]!
  await store.recordRun({
    automationId: entry.id,
    title: entry.title,
    startedAt: 1,
    finishedAt: 1,
    status: 'ok',
    summary: '第一次',
  })
  await store.recordRun({
    automationId: entry.id,
    title: entry.title,
    startedAt: 2,
    finishedAt: 2,
    status: 'failed',
    summary: '第二次',
    error: 'boom',
  })
  const runs = store.listRuns(entry.id)
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.summary, '第二次')
  assert.equal(runs[1]!.summary, '第一次')
  assert.equal(await store.remove(entry.id), true)
  assert.equal(store.listRuns(entry.id).length, 0)
})

test('持久化：重启后定义与运行历史仍在', async () => {
  const store = new AutomationStore(dir)
  await store.load()
  const before = store.list().length
  const runs = store.listRuns().length
  const reloaded = new AutomationStore(dir)
  await reloaded.load()
  assert.equal(reloaded.list().length, before)
  assert.equal(reloaded.listRuns().length, runs)
})
