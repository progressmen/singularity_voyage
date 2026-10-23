/**
 * 记忆抽取解析与提醒服务单测。
 * - parseMemoryCandidates：裸 JSON / 围栏 / 对象包裹 / 非法项跳过；
 * - ReminderService：到期任务广播给订阅者并滚动重复任务。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { parseMemoryCandidates } from '../src/memory-extractor.ts'
import { ReminderService } from '../src/reminders.ts'
import { TasksStore } from '../src/tasks-store.ts'

test('parseMemoryCandidates：裸 JSON 数组', () => {
  const out = parseMemoryCandidates('[{"kind":"fact","text":"住在上海","tags":["地点"],"confidence":0.8}]')
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'fact')
  assert.equal(out[0]!.text, '住在上海')
  assert.deepEqual(out[0]!.tags, ['地点'])
})

test('parseMemoryCandidates：Markdown 围栏与对象包裹都接受', () => {
  const fenced = parseMemoryCandidates('```json\n[{"kind":"preference","text":"回答要简洁"}]\n```')
  assert.equal(fenced.length, 1)
  const wrapped = parseMemoryCandidates('{"memories":[{"kind":"decision","text":"用 DeepSeek"}]}')
  assert.equal(wrapped.length, 1)
  assert.equal(wrapped[0]!.kind, 'decision')
})

test('parseMemoryCandidates：非法 kind / 空文本跳过；空数组与垃圾文本返回空', () => {
  const out = parseMemoryCandidates('[{"kind":"nonsense","text":"x"},{"kind":"fact","text":"  "},{"kind":"fact","text":"有效"}]')
  assert.equal(out.length, 1)
  assert.equal(out[0]!.text, '有效')
  assert.deepEqual(parseMemoryCandidates('[]'), [])
  assert.deepEqual(parseMemoryCandidates('模型拒绝输出'), [])
})

test('parseMemoryCandidates：候选数量截断到 8', () => {
  const raw = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ kind: 'fact', text: `事实${i}` })))
  assert.equal(parseMemoryCandidates(raw).length, 8)
})

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-reminders-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('ReminderService：到期任务广播后标记；每日任务滚动下一次', async () => {
  const tasks = new TasksStore(dir)
  const now = Date.now()
  await tasks.create({ title: '一次性提醒', dueAt: now - 1000 })
  await tasks.create({ title: '每日提醒', dueAt: now - 1000, recurrence: 'daily' })

  const warnings: Array<{ event: string; fields: Record<string, string | number> }> = []
  const service = new ReminderService(tasks, (event, fields) => warnings.push({ event, fields }), 1_000_000)
  const events: unknown[] = []
  service.subscribe(event => events.push(event))

  // 直接触发一次扫描（start 会异步扫描，这里同步等待）
  await (service as unknown as { scan(): Promise<void> }).scan()
  assert.equal(events.length, 2)
  assert.equal(store_dueCount(tasks, now), 0)

  // 一次性任务不再触发；每日任务已滚动到未来
  await (service as unknown as { scan(): Promise<void> }).scan()
  assert.equal(events.length, 2)
  assert.equal(warnings.length, 0)
  service.stop()
})

function store_dueCount(store: TasksStore, now: number): number {
  return store.due(now).length
}
