/**
 * 审批中心与只读连接器的单测：存储、脱敏、去重、解析器与一次同步。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ApprovalCenter } from '../src/approval-center.ts'
import { ApprovalStore } from '../src/approval-store.ts'
import {
  parseGmailMessage,
  parseGoogleCalendarEvents,
  parseGraphDate,
  parseIcsEvents,
  parseNotionPages,
  parseOutlookEvents,
  parseOutlookMessages,
  parseRssEvents,
  parseSlackMessage,
  type FetchLike,
} from '../src/connector-adapters.ts'
import { ConnectorService } from '../src/connector-runtime.ts'
import { ConnectorStore, connectorView, type ConnectorEventDraft } from '../src/connector-store.ts'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('审批存储：新增、结束、重启后仍可审计', async () => {
  const dir = await tempDir('sv-approval-')
  const store = new ApprovalStore(dir)
  await store.load()
  const record = await store.add({ toolName: 'bash', sessionId: 's1', reason: '需要写入工作区外' })
  assert.equal(store.pendingCount(), 1)
  const decided = await store.decide(record.id, 'allowed-once', 'user')
  assert.equal(decided?.outcome, 'allowed-once')
  assert.equal(store.pendingCount(), 0)

  const reloaded = new ApprovalStore(dir)
  await reloaded.load()
  assert.equal(reloaded.list('decided').length, 1)
  assert.equal(reloaded.list('decided')[0]?.reason, '需要写入工作区外')
})

test('审批中心：没有页面在线时 fail-closed', async () => {
  const store = new ApprovalStore(await tempDir('sv-approval-none-'))
  await store.load()
  const center = new ApprovalCenter(store, { timeoutMs: 50 })
  const outcome = await center.request({ agent: { id: 's1' }, toolName: 'bash' })
  assert.equal(outcome, 'unavailable')
  assert.equal(store.list('decided')[0]?.decidedBy, 'no-answerer')
})

test('审批中心：页面在线时可以批准，且只放行一次', async () => {
  const store = new ApprovalStore(await tempDir('sv-approval-allow-'))
  await store.load()
  const center = new ApprovalCenter(store, { timeoutMs: 2000 })
  const detach = center.attachViewer()
  try {
    const pending = center.request({ agent: { id: 's1' }, toolName: 'bash', reason: '安装依赖' })
    for (let attempt = 0; attempt < 50 && center.pendingCount() === 0; attempt += 1) await sleep(2)
    // pending 记录先落盘、再登记等待器；等一个微任务让 request 完成登记。
    await sleep(5)
    const record = center.list('pending')[0]
    assert.ok(record !== undefined)
    await center.answer(record.id, 'allowed-once')
    assert.equal(await pending, 'allowed-once')
    assert.equal(store.list('decided')[0]?.decidedBy, 'user')
  } finally {
    detach()
  }
})

test('审批中心：超时结束为 cancelled', async () => {
  const store = new ApprovalStore(await tempDir('sv-approval-timeout-'))
  await store.load()
  const center = new ApprovalCenter(store, { timeoutMs: 30 })
  const detach = center.attachViewer()
  try {
    const outcome = await center.request({ agent: { id: 's1' }, toolName: 'fs' })
    assert.equal(outcome, 'cancelled')
    assert.equal(store.list('decided')[0]?.decidedBy, 'timeout')
  } finally {
    detach()
  }
})

test('连接器存储：创建、脱敏、事件去重与持久化', async () => {
  const dir = await tempDir('sv-connector-')
  const store = new ConnectorStore(dir)
  await store.load()
  const connector = await store.create({
    kind: 'ics',
    name: '工作日历',
    settings: { url: 'https://example.com/calendar.ics' },
  })
  const view = connectorView(connector)
  assert.equal(view.settings.url, 'https://example.com/calendar.ics')
  assert.deepEqual(view.configuredSecrets, [])

  const slack = await store.create({
    kind: 'slack',
    name: 'Slack',
    settings: { token: 'xoxp-secret', channels: '#general' },
  })
  const slackView = connectorView(slack)
  assert.equal(Object.hasOwn(slackView.settings, 'token'), false)
  assert.deepEqual(slackView.configuredSecrets, ['token'])

  const draft: ConnectorEventDraft = {
    externalId: 'evt-1',
    kind: 'event',
    title: '周会',
    body: '讨论进度',
    occurredAt: 1_800_000_000_000,
    key: 'ics:evt-1',
  }
  assert.equal((await store.ingest(connector, [draft, draft])).length, 1)
  assert.equal((await store.ingest(connector, [draft])).length, 0)
  assert.equal(store.listEvents().length, 1)
  await store.markAllRead()
  assert.equal(store.unreadCount(), 0)

  const reloaded = new ConnectorStore(dir)
  await reloaded.load()
  assert.equal(reloaded.listConnectors().length, 2)
  assert.equal(reloaded.listEvents().length, 1)
})

test('解析器：ICS 过滤旧日程并保留时间/地点', () => {
  const start = new Date(Date.now() + 86_400_000)
  const stamp = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-1',
    `DTSTART:${stamp}`,
    `DTEND:${stamp}`,
    'SUMMARY:周会',
    'LOCATION:会议室',
    'DESCRIPTION:讨论进度',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:evt-old',
    'DTSTART:20200101T090000Z',
    'SUMMARY:旧日程',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n')
  const events = parseIcsEvents(text, { since: Date.now() - 7 * 86_400_000, now: Date.now(), sourceUrl: 'https://example.com/cal.ics' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.title, '周会')
  assert.match(events[0]?.body ?? '', /会议室/)
  assert.equal(events[0]?.url, 'https://example.com/cal.ics')
})

test('解析器：RSS 保留发布时间与链接', () => {
  const text = '<rss><channel><item><title>A</title><link>https://example.com/a</link><guid>g1</guid><pubDate>Tue, 25 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>'
  const events = parseRssEvents(text, Date.now())
  assert.equal(events.length, 1)
  assert.equal(events[0]?.title, 'A')
  assert.equal(events[0]?.url, 'https://example.com/a')
  assert.equal(events[0]?.occurredAt, Date.parse('Tue, 25 Nov 2026 09:00:00 GMT'))
})

test('解析器：Slack / Gmail / Google Calendar', () => {
  const slack = parseSlackMessage(
    { id: 'C1', name: 'general' },
    { ts: '1800000000.000200', text: '大家好\n今天发版', user: 'U1' },
    'https://acme.slack.com/',
  )
  assert.equal(slack?.title, '#general · 大家好')
  assert.match(slack?.body ?? '', /今天发版/)
  assert.equal(slack?.author, 'U1')
  assert.match(slack?.url ?? '', /archives\/C1/)

  const gmail = parseGmailMessage({
    id: 'm1',
    internalDate: '1800000000000',
    snippet: '请查收报价',
    payload: {
      headers: [
        { name: 'Subject', value: '报价' },
        { name: 'From', value: 'Dana <dana@example.com>' },
      ],
    },
  }, Date.now())
  assert.equal(gmail?.title, '报价')
  assert.equal(gmail?.occurredAt, 1_800_000_000_000)
  assert.match(gmail?.body ?? '', /请查收报价/)

  const calendar = parseGoogleCalendarEvents([{
    id: 'g1',
    summary: '产品评审',
    description: '评审 v2',
    location: '线上',
    htmlLink: 'https://calendar.example.com/g1',
    start: { dateTime: '2026-11-26T09:00:00+08:00' },
    end: { dateTime: '2026-11-26T10:00:00+08:00' },
    organizer: { displayName: 'Dana' },
  }])
  assert.equal(calendar.length, 1)
  assert.equal(calendar[0]?.title, '产品评审')
  assert.equal(calendar[0]?.author, 'Dana')
  assert.match(calendar[0]?.body ?? '', /线上/)
})

test('解析器：Notion / Outlook 与 Graph 日期', () => {
  const notion = parseNotionPages([{
    id: 'p1',
    object: 'page',
    url: 'https://notion.so/p1',
    last_edited_time: '2026-11-25T08:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Acme 项目' }] },
      Status: { type: 'select', select: { name: '进行中' } },
    },
  }], Date.now())
  assert.equal(notion.length, 1)
  assert.equal(notion[0]?.title, 'Acme 项目')
  assert.match(notion[0]?.body ?? '', /进行中/)

  assert.equal(parseGraphDate('2026-11-25T09:00:00.0000000'), Date.parse('2026-11-25T09:00:00.000'))

  const mail = parseOutlookMessages([{
    id: 'om1',
    subject: '合同',
    receivedDateTime: '2026-11-25T09:00:00Z',
    webLink: 'https://outlook.example.com/om1',
    bodyPreview: '请审阅',
    from: { emailAddress: { name: 'Dana', address: 'dana@example.com' } },
  }], Date.now())
  assert.equal(mail[0]?.title, '合同')
  assert.equal(mail[0]?.author, 'Dana')

  const events = parseOutlookEvents([{
    id: 'oe1',
    subject: '周会',
    start: { dateTime: '2026-11-26T10:00:00.0000000' },
    end: { dateTime: '2026-11-26T11:00:00.0000000' },
    location: { displayName: '会议室' },
    organizer: { emailAddress: { name: 'Dana' } },
  }], Date.now())
  assert.equal(events[0]?.title, '周会')
  assert.match(events[0]?.body ?? '', /会议室/)
})

test('连接器运行时：用假 fetch 完成一次 ICS 同步并去重', async () => {
  const dir = await tempDir('sv-connector-run-')
  const store = new ConnectorStore(dir)
  await store.load()
  const connector = await store.create({
    kind: 'ics',
    name: '工作日历',
    settings: { url: 'https://example.com/calendar.ics' },
  })
  const start = new Date(Date.now() + 86_400_000)
  const stamp = start.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:runtime-1',
    `DTSTART:${stamp}`,
    'SUMMARY:运行时同步',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n')
  const fakeFetch: FetchLike = async (input) => {
    if (String(input).includes('calendar.ics')) {
      return new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar' } })
    }
    return new Response('not found', { status: 404 })
  }
  const service = new ConnectorService({
    store,
    fetchImpl: fakeFetch,
    log: () => undefined,
    now: () => Date.now(),
  })
  const result = await service.runNow(connector.id)
  assert.equal(result.added, 1)
  assert.equal(store.listEvents().length, 1)
  const again = await service.runNow(connector.id)
  assert.equal(again.added, 0)
  assert.equal(store.listEvents().length, 1)
  assert.equal(store.getConnector(connector.id)?.lastError, undefined)
})
