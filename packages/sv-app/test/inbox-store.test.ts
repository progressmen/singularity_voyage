/**
 * 收件箱存储单测：新增/过滤/未读计数/已读/全部已读/删除/持久化/简报日期。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { InboxStore } from '../src/inbox-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-inbox-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('add/list：按时间倒序，未读计数随新增增长', async () => {
  const store = new InboxStore(dir)
  await store.load()
  const first = await store.add({ kind: 'briefing', title: '今日简报', body: '## 今日重点' })
  const second = await store.add({ kind: 'reminder', title: '交材料', body: '到期时间：10:00' })
  const items = store.list()
  assert.equal(items.length, 2)
  assert.equal(items[0]!.id, second.id)
  assert.equal(items[1]!.id, first.id)
  assert.equal(store.unreadCount(), 2)
})

test('list：按类型与未读过滤', async () => {
  const store = new InboxStore(dir)
  await store.load()
  const reminder = store.list().find(item => item.kind === 'reminder')
  assert.ok(reminder !== undefined)
  assert.equal(store.list({ kind: 'reminder' }).length, 1)
  await store.markRead(reminder.id)
  assert.equal(store.list({ unreadOnly: true }).length, 1)
  assert.equal(store.unreadCount(), 1)
})

test('markRead/markAllRead：已读时间只写一次，全部已读后未读归零', async () => {
  const store = new InboxStore(dir)
  await store.load()
  const unread = store.list({ unreadOnly: true })
  assert.equal(unread.length, 1)
  const item = unread[0]!
  const first = await store.markRead(item.id)
  assert.ok(first !== undefined)
  assert.ok(first.readAt !== undefined)
  const again = await store.markRead(item.id)
  assert.ok(again !== undefined)
  assert.equal(again.readAt, first.readAt)
  assert.equal(store.unreadCount(), 0)

  await store.add({ kind: 'system', title: '系统消息', body: '' })
  assert.equal(store.unreadCount(), 1)
  assert.equal(await store.markAllRead(), 1)
  assert.equal(store.unreadCount(), 0)
})

test('markRead(false)：重新变回未读', async () => {
  const store = new InboxStore(dir)
  await store.load()
  const item = store.list()[0]!
  await store.markRead(item.id, false)
  assert.equal(store.unreadCount(), 1)
})

test('remove：删除后未读数同步下降', async () => {
  const store = new InboxStore(dir)
  await store.load()
  const item = store.list({ unreadOnly: true })[0]!
  assert.equal(await store.remove(item.id), true)
  assert.equal(store.unreadCount(), 0)
  assert.equal(await store.remove(item.id), false)
})

test('持久化：重启后条目、已读状态与简报日期仍在', async () => {
  const store = new InboxStore(dir)
  await store.load()
  await store.markBriefDay('2026-11-25')
  const reloaded = new InboxStore(dir)
  await reloaded.load()
  assert.equal(reloaded.list().length, store.list().length)
  assert.equal(reloaded.lastBriefDay(), '2026-11-25')
  for (const item of store.list()) {
    const copy = reloaded.get(item.id)
    assert.ok(copy !== undefined)
    assert.equal(copy.readAt !== undefined, item.readAt !== undefined)
  }
})

test('add：空标题拒绝写入', async () => {
  const store = new InboxStore(dir)
  await store.load()
  await assert.rejects(() => store.add({ kind: 'system', title: '   ', body: 'x' }), /标题不能为空/)
})
