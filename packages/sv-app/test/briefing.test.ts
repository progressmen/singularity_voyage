/**
 * 每日简报单测：触发时间判断、回落模板、Prompt 输入，以及服务端生成链路。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  BriefingService,
  buildBriefingPrompt,
  fallbackBrief,
  localDayKey,
  shouldRunBriefing,
  type BriefingInput,
} from '../src/briefing.ts'
import { defaultMailConfig } from '../src/config-store.ts'
import { InboxStore } from '../src/inbox-store.ts'
import { TasksStore } from '../src/tasks-store.ts'
import type { SvSessionStore } from '../src/sessions-store.ts'

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-briefing-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('shouldRunBriefing：未到点、当天已生成时不触发；到点且未生成时触发', () => {
  const now = new Date(2026, 10, 25, 8, 30, 0)
  assert.equal(shouldRunBriefing(new Date(2026, 10, 25, 8, 0, 0), '08:30', undefined), false)
  assert.equal(shouldRunBriefing(now, '08:30', localDayKey(now)), false)
  assert.equal(shouldRunBriefing(now, '08:30', '2026-11-24'), true)
  assert.equal(shouldRunBriefing(now, '', undefined), false)
  assert.equal(shouldRunBriefing(now, 'bad', undefined), false)
})

function makeInput(now: number): BriefingInput {
  return {
    now,
    pending: [
      {
        id: 't1',
        title: '交材料',
        recurrence: 'none',
        status: 'pending',
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
        dueAt: now - 3_600_000,
      },
      {
        id: 't2',
        title: '下午站会',
        recurrence: 'daily',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        dueAt: now + 3_600_000,
      },
    ],
    yesterday: [{ title: '整理周报', updatedAt: now - 12 * 3_600_000, excerpt: '已完成大纲' }],
    unread: [{ kind: 'reminder', title: '待办提醒：交材料' }],
    unreadCount: 1,
  }
}

test('fallbackBrief：包含逾期、昨日进展与未读数量', () => {
  const now = Date.now()
  const body = fallbackBrief(makeInput(now))
  assert.match(body, /## 今日重点/)
  assert.match(body, /交材料/)
  assert.match(body, /\[逾期\]/)
  assert.match(body, /整理周报：已完成大纲/)
  assert.match(body, /## 需要关注/)
  assert.match(body, /收件箱有 1 条未读/)
})

test('buildBriefingPrompt：把事实整理成模型输入', () => {
  const now = Date.now()
  const prompt = buildBriefingPrompt(makeInput(now))
  assert.match(prompt, /待办（未完成 2 项，其中逾期 1 项）/)
  assert.match(prompt, /交材料/)
  assert.match(prompt, /昨日对话（1 个会话）/)
  assert.match(prompt, /未读收件箱（1 条）/)
})

test('runNow：使用模型输出写入收件箱并记录简报日期', async () => {
  const inbox = new InboxStore(dir)
  await inbox.load()
  const tasks = new TasksStore(dir)
  await tasks.load()
  await tasks.create({ title: '交材料', dueAt: Date.now() - 60_000 })
  const emptySessions = {
    list: () => [],
    messages: async () => [],
  } as unknown as SvSessionStore
  let seen = ''
  const service = new BriefingService({
    config: () => ({ enabled: true, time: '08:30', email: false }),
    mail: () => defaultMailConfig(),
    tasks,
    sessions: emptySessions,
    inbox,
    generate: async input => {
      seen = buildBriefingPrompt(input)
      return '## 今日重点\n- 交材料已逾期'
    },
    log: () => {},
  })
  const item = await service.runNow()
  assert.equal(item.kind, 'briefing')
  assert.match(item.title, /每日简报/)
  assert.match(item.body, /交材料已逾期/)
  assert.match(seen, /交材料/)
  assert.equal(inbox.lastBriefDay(), localDayKey(new Date()))
  assert.equal(inbox.list({ kind: 'briefing' }).length, 1)
})

test('runNow：模型失败时回落到模板，仍然写入收件箱', async () => {
  const inbox = new InboxStore(dir)
  await inbox.load()
  const tasks = new TasksStore(dir)
  await tasks.load()
  await tasks.create({ title: '写复盘', dueAt: Date.now() - 60_000 })
  const service = new BriefingService({
    config: () => ({ enabled: true, time: '08:30', email: false }),
    mail: () => defaultMailConfig(),
    tasks,
    sessions: { list: () => [], messages: async () => [] } as unknown as SvSessionStore,
    inbox,
    generate: async () => {
      throw new Error('upstream timeout')
    },
    log: () => {},
  })
  const item = await service.runNow()
  assert.match(item.body, /写复盘/)
  assert.match(item.body, /\[逾期\]/)
})

test('collect：历史简报不计入简报的「未读收件箱」', async () => {
  const nested = join(dir, 'noref')
  const inbox = new InboxStore(nested)
  await inbox.load()
  await inbox.add({ kind: 'briefing', title: '昨天的简报', body: '旧内容' })
  await inbox.add({ kind: 'reminder', title: '交材料', body: '到期提醒' })
  const tasks = new TasksStore(nested)
  await tasks.load()
  let seen = ''
  const service = new BriefingService({
    config: () => ({ enabled: true, time: '08:30', email: false }),
    mail: () => defaultMailConfig(),
    tasks,
    sessions: { list: () => [], messages: async () => [] } as unknown as SvSessionStore,
    inbox,
    generate: async input => {
      seen = buildBriefingPrompt(input)
      return '## 今日重点\n暂无'
    },
    log: () => {},
  })
  await service.runNow()
  assert.match(seen, /交材料/)
  assert.doesNotMatch(seen, /昨天的简报/)
})
