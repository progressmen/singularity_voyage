/**
 * 待办存储与提醒扫描单测：到期判断、一次性任务不重复提醒、重复任务滚动、
 * 顺延与完成、promptBlock 内容。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { TasksStore } from '../src/tasks-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-tasks-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('due：到期未提醒的任务命中；未到期与已提醒的不命中', async () => {
  const store = new TasksStore(dir)
  const now = Date.now()
  await store.create({ title: '已到期未提醒', dueAt: now - 1000 })
  await store.create({ title: '未到期', dueAt: now + 60_000 })
  const pending = await store.create({ title: '无时间' })
  assert.ok(pending !== undefined)
  const due = store.due(now)
  assert.equal(due.length, 1)
  assert.equal(due[0]!.title, '已到期未提醒')
})

test('markNotified：一次性任务只提醒一次；每日任务滚动到下一个未来时点', async () => {
  const store = new TasksStore(dir)
  const now = Date.now()
  const once = await store.create({ title: '一次性', dueAt: now - 1000 })
  assert.ok(once !== undefined)
  const updatedOnce = await store.markNotified(once.id, now)
  assert.ok(updatedOnce !== undefined)
  assert.equal(store.due(now).filter(task => task.id === once.id).length, 0)

  const daily = await store.create({ title: '每日站会', dueAt: now - 60_000, recurrence: 'daily' })
  assert.ok(daily !== undefined)
  const updatedDaily = await store.markNotified(daily.id, now)
  assert.ok(updatedDaily !== undefined)
  assert.ok(updatedDaily.dueAt !== undefined && updatedDaily.dueAt > now)
  // 滚动后不再到期，直到下一次时间到
  assert.equal(store.due(now).filter(task => task.id === daily.id).length, 0)
})

test('complete 与 snooze：完成后从待办消失；顺延重置为新到期', async () => {
  const store = new TasksStore(dir)
  const now = Date.now()
  const task = await store.create({ title: '交材料', dueAt: now - 1000 })
  assert.ok(task !== undefined)
  assert.equal(store.due(now).length >= 1, true)

  const snoozed = await store.update(task.id, { snoozeMinutes: 10 })
  assert.ok(snoozed !== undefined)
  assert.ok(snoozed.dueAt !== undefined && snoozed.dueAt > now)
  assert.equal(store.due(now).filter(item => item.id === task.id).length, 0)

  const done = await store.complete(task.id)
  assert.ok(done !== undefined)
  assert.equal(done.status, 'done')
  assert.equal(store.list(false).find(item => item.id === task.id), undefined)
})

test('list 排序：未完成按截止时间在前，已完成在后', async () => {
  const store = new TasksStore(dir)
  const now = Date.now()
  await store.create({ title: '无截止' })
  await store.create({ title: '早截止', dueAt: now + 1000 })
  await store.create({ title: '晚截止', dueAt: now + 60_000 })
  const done = await store.create({ title: '已完成' })
  assert.ok(done !== undefined)
  await store.complete(done.id)
  const list = store.list(true)
  assert.equal(list[0]!.title, '早截止')
  assert.equal(list[1]!.title, '晚截止')
  assert.equal(list[list.length - 1]!.title, '已完成')
})

test('promptBlock 包含当前时间与未完成任务；完成的不出现', async () => {
  const store = new TasksStore(dir)
  await store.create({ title: '写周报', dueAt: Date.now() + 3600_000 })
  const done = await store.create({ title: '买咖啡' })
  assert.ok(done !== undefined)
  await store.complete(done.id)
  const block = store.promptBlock()
  assert.ok(block.includes('待办与提醒'))
  assert.ok(block.includes('写周报'))
  assert.ok(!block.includes('买咖啡'))
})

test('持久化回环：重启后任务与状态保留', async () => {
  const store = new TasksStore(dir)
  const task = await store.create({ title: '持久化验证', dueAt: Date.now() + 1000, recurrence: 'weekly' })
  assert.ok(task !== undefined)
  const reloaded = new TasksStore(dir)
  await reloaded.load()
  const found = reloaded.get(task.id)
  assert.ok(found !== undefined)
  assert.equal(found.title, '持久化验证')
  assert.equal(found.recurrence, 'weekly')
  assert.ok(found.dueAt !== undefined)
})
